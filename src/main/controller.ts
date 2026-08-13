/**
 * 应用编排：把窗口、托盘、免打扰状态、数据层与**提醒分发**串起来（docs/02 §2）。
 *
 * 常驻悬浮窗口只有一种形态：悬浮条。IPC 通道名仍是 `pet:*`（见 OverlayWindow 头注释）。
 *
 * ## M3 起，信号有了第二个出口
 *
 * M2 时信号的唯一出口是面板列表，状态点只由「免打扰 / 是否开市 / 数据源是否全挂」决定。
 * 现在 `onSignals()` 会把评估结果交给 `AlertService` —— 四道闸门（防抖 / 冷却 / 频率上限 /
 * 免打扰）之后才轮到气泡与状态点。**闸门仍然是唯一的点亮路径**：
 * 这里不允许出现「顺手把状态点点亮一下」的旁路，那等于绕过闸门直接骚扰用户。
 *
 * 免打扰在这一层聚合（`quietVerdict()`）：手动截止时间 + 静默时段 + 锁屏 + 系统态探测。
 * 判定本身是纯函数（alerts/dnd.ts），这里只负责把四个输入凑齐。
 */

import { app, powerMonitor } from 'electron'
import type {
  AlertRecord,
  AppSettings,
  ConfigTransferResult,
  EngineStatus,
  PetState,
  PositionView,
  ProviderHealth,
  Rect,
  SignalEvidence,
  SignalRecord,
  WatchItem,
} from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import { createAlertService, type AlertService, type AlertSink } from './alerts/service'
import type { QuoteView } from './alerts/candidates'
import { resolveQuiet, type QuietVerdict } from './alerts/dnd'
import { createNotificationStateProbe, type NotificationStateProbe } from './alerts/notification-state'
import type { DataLayer } from './data-layer'
import type { SignalOutcome } from './engine'
import { log } from './logging'
import type { TickContext } from './scheduler'
import type { WatchEntry } from './storage/repositories/watchlist'
import { DEFAULT_SETTINGS } from './settings/schema'
import {
  applyConfigBundle,
  buildConfigBundle,
  parseConfigBundle,
  serializeConfigBundle,
  type ConfigWatchEntry,
} from './settings/transfer'
import {
  appVersion,
  askOpenPath,
  askSavePath,
  confirmOverwrite,
  readJsonFile,
  writeTextFile,
} from './settings/transfer-io'
import { isQuiet, quietUntil, type QuietPreset } from './util/quiet'
import { WindowManager } from './windows/WindowManager'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 仓储的 WatchEntry → 导出文件里的一行。isST 不落文件：它是从名称推出来的，会随摘帽变 */
function toConfigWatchEntry(entry: WatchEntry): ConfigWatchEntry {
  const row: ConfigWatchEntry = {
    code: entry.profile.code,
    name: entry.profile.name,
    market: entry.profile.market,
    board: entry.profile.board,
    group: entry.group,
    sortOrder: entry.sortOrder,
    createdAt: entry.createdAt,
  }
  if (entry.profile.industry !== undefined) row.industry = entry.profile.industry
  return row
}

export class AppController {
  private readonly windows = new WindowManager()
  private quietUntilAt: number | null = null
  /** 渲染层上报的命中区，仅用于诊断；真正的判定在渲染层完成（docs/06 §2.2） */
  private reportedHitRects: Rect[] = []
  private data: DataLayer | null = null

  /** 提醒分发。数据层就绪前为 null —— 那时也没有信号可发 */
  private alerts: AlertService | null = null
  private readonly probe: NotificationStateProbe
  /** 锁屏 / 会话断开（docs/05 §4.4）。powerMonitor 是事件式的，这里只存最后一次结论 */
  private screenLocked = false
  private unread = 0
  /** 状态点高优先级状态的回落定时器（最短驻留 3s，而 tick 每 30s 才来一次） */
  private petFallbackTimer: NodeJS.Timeout | null = null

  constructor() {
    this.probe = createNotificationStateProbe({ log })
    powerMonitor.on('lock-screen', () => this.setScreenLocked(true))
    powerMonitor.on('unlock-screen', () => this.setScreenLocked(false))
  }

  private setScreenLocked(locked: boolean): void {
    if (this.screenLocked === locked) return
    this.screenLocked = locked
    this.onStateChanged()
  }

  /**
   * 接入数据层。装配是异步的（要开库、要初始化 undici），所以不放构造函数里
   * —— 窗口与托盘必须先起来：数据层装配失败时用户至少还能看到悬浮条和托盘菜单。
   */
  attachDataLayer(layer: DataLayer): void {
    this.data = layer

    this.alerts = createAlertService({
      repo: layer.storage.alerts,
      sink: this.alertSink(),
      settings: () => layer.settings.get(),
      quiet: () => this.quietVerdict(),
      quotes: () => this.quoteViews(),
      nameOf: (code) => layer.storage.watchlist.get(code)?.profile.name ?? code,
      log,
    })
    this.unread = layer.storage.alerts.unreadCount()
  }

  /** 渠道执行端（docs/05 §3 的三档表现）。AlertService 只认这个接口，不认识窗口与托盘 */
  private alertSink(): AlertSink {
    return {
      bubble: (payload) => this.windows.showBubble(payload),
      unread: (count) => {
        this.unread = count
        this.onChange?.()
      },
      petState: (nextChangeAt) => {
        this.pushPetState()
        this.schedulePetFallback(nextChangeAt)
      },
    }
  }

  /**
   * 高优先级状态的回落重推。
   *
   * 状态机是时间驱动的（3s 最短驻留），而 tick 每 30s 才来一次 —— 不补这一下，
   * 一个 3s 的状态会挂满半分钟，看起来像卡住了。
   */
  private schedulePetFallback(at: number | null): void {
    if (this.petFallbackTimer) {
      clearTimeout(this.petFallbackTimer)
      this.petFallbackTimer = null
    }
    if (at === null) return
    const delay = Math.max(50, at - Date.now())
    this.petFallbackTimer = setTimeout(() => {
      this.petFallbackTimer = null
      this.pushPetState()
      // 回落到 WATCHING 之后还有一档要回落到 IDLE，链式安排下一次
      this.schedulePetFallback(this.alerts?.pet.nextChangeAt(Date.now()) ?? null)
    }, delay)
  }

  /** 气泡里的现价/涨跌用最新快照，拿不到就由 candidates.ts 退回 K 线收盘价 */
  private quoteViews(): ReadonlyMap<SecCode, QuoteView> {
    const map = new Map<SecCode, QuoteView>()
    for (const tick of this.data?.quoteTicks() ?? []) {
      map.set(tick.code, { last: tick.last, changePct: tick.changePct })
    }
    return map
  }

  get dataLayer(): DataLayer | null {
    return this.data
  }

  // ── 数据层投影（供 IPC handler 使用） ─────────────────────────────

  watchlist(): WatchItem[] {
    return this.data?.watchlist.list() ?? []
  }

  async addWatch(code: string, group?: string): Promise<WatchItem> {
    const layer = this.requireData()
    const item = group === undefined
      ? await layer.watchlist.add(code)
      : await layer.watchlist.add(code, group)
    // 新加的这只还没有任何日线与快照，立刻跑一轮把它补上，而不是等下一个 tick
    void this.refreshData()
    this.onStateChanged()
    return item
  }

  removeWatch(code: SecCode): void {
    this.requireData().watchlist.remove(code)
    this.onStateChanged()
  }

  reorderWatch(codes: SecCode[]): void {
    this.requireData().watchlist.reorder(codes)
  }

  positions(): PositionView[] {
    return this.data?.storage.positions.list() ?? []
  }

  setPosition(code: SecCode, shares: number, cost: number): void {
    if (!Number.isFinite(shares) || shares <= 0) throw new Error('持股数必须是正数')
    if (!Number.isFinite(cost) || cost <= 0) throw new Error('成本价必须是正数')
    // 成本价是**不复权**真实成交价（docs/03 §2.3）：拿前复权价算止损会在除权后凭空触发一次卖出
    this.requireData().storage.positions.set(code, shares, cost, Date.now())
    this.onStateChanged()
  }

  clearPosition(code: SecCode): void {
    this.requireData().storage.positions.clear(code)
    this.onStateChanged()
  }

  getSettings(): AppSettings {
    return this.data?.settings.get() ?? this.fallbackSettings()
  }

  patchSettings(patch: Partial<AppSettings>): AppSettings {
    const layer = this.requireData()
    const next = layer.settings.patch(patch)
    layer.applySettings(next)
    this.onStateChanged()
    return next
  }

  providerHealth(): ProviderHealth[] {
    return this.data?.health() ?? []
  }

  // ── 个人配置导入导出 ──────────────────────────────────────────────
  //
  // 「个人配置」只有三样：设置、自选（含分组与排序）、手工录入的持仓 —— 详见
  // settings/transfer.ts 的头注释。两个方法都**不抛错**：取消、文件读坏、版本太新
  // 都是用户能看懂的正常结局，走返回值报回面板，比让渲染层去解析 Electron 包过的
  // Error 字符串好。真正的意外也收进 FAILED，面板会把原文显示出来（docs/02 §7）。

  async exportConfig(): Promise<ConfigTransferResult> {
    try {
      const layer = this.requireData()
      const now = Date.now()
      const path = await askSavePath(this.windows.panelWindow.browserWindow, now)
      if (path === null) return { status: 'CANCELED', warnings: [] }

      const bundle = buildConfigBundle({
        settings: layer.settings.get(),
        watchlist: layer.storage.watchlist.list().map(toConfigWatchEntry),
        positions: layer.storage.positions.list().map((held) => ({
          code: held.code,
          shares: held.shares,
          cost: held.cost,
          peakPrice: held.peakPrice,
          openedAt: held.openedAt,
        })),
        now,
        appVersion: appVersion(),
      })
      writeTextFile(path, serializeConfigBundle(bundle))

      return {
        status: 'DONE',
        path,
        counts: { watchlist: bundle.watchlist.length, positions: bundle.positions.length },
        warnings: [],
      }
    } catch (error) {
      log.warn('[config] 导出失败：', error)
      return { status: 'FAILED', warnings: [], error: messageOf(error) }
    }
  }

  async importConfig(): Promise<ConfigTransferResult> {
    try {
      const layer = this.requireData()
      const win = this.windows.panelWindow.browserWindow
      const path = await askOpenPath(win)
      if (path === null) return { status: 'CANCELED', warnings: [] }

      const { bundle, warnings } = parseConfigBundle(readJsonFile(path))
      const confirmed = await confirmOverwrite(win, {
        incomingWatch: bundle.watchlist.length,
        incomingPositions: bundle.positions.length,
        currentWatch: layer.storage.watchlist.count(),
        currentPositions: layer.storage.positions.codes().size,
      })
      // 取消了也要把 warnings 带回去：用户可能正是看到「12 行被丢弃」才决定不导的
      if (!confirmed) return { status: 'CANCELED', path, warnings }

      // 整份放进一个事务：自选清了一半、持仓还是旧的，比什么都没做糟得多
      const applied = layer.storage.db.transaction(() =>
        applyConfigBundle(bundle, {
          watchlist: layer.storage.watchlist,
          positions: layer.storage.positions,
        })
      )
      // 设置走 patchSettings 而不是直接写 store：轮询间隔、灵敏度等要立刻作用到数据层
      this.patchSettings(bundle.settings)
      // 新导入的自选一根日线都没有，立刻补一轮，别让用户对着一屏「—」等 30 秒
      void this.refreshData()
      this.onStateChanged()

      return {
        status: 'DONE',
        path,
        counts: { watchlist: applied.watchlist, positions: applied.positions },
        removed: { watchlist: applied.removedWatchlist, positions: applied.removedPositions },
        warnings,
      }
    } catch (error) {
      log.warn('[config] 导入失败：', error)
      return { status: 'FAILED', warnings: [], error: messageOf(error) }
    }
  }

  // ── 信号（M2）─────────────────────────────────────────────────────

  signalHistory(query: { code?: SecCode; from?: number; to?: number; limit?: number }): SignalRecord[] {
    // 数据层没起来时返回空列表而不是抛错：面板要能把「数据层未就绪」那条横幅画出来
    return this.data?.signalHistory(query) ?? []
  }

  explainSignal(id: string): SignalEvidence {
    const evidence = this.requireData().explainSignal(id)
    if (!evidence) throw new Error('该信号已不在库中（可能已被保留策略裁剪）')
    return evidence
  }

  /** 用户点「刷新」或新加自选后：跑一轮 tick。失败只记日志，不弹窗 */
  async refreshData(): Promise<void> {
    if (!this.data) return
    try {
      await this.data.refreshNow()
    } catch (error) {
      log.warn('[refresh] 手动刷新失败：', error)
    }
  }

  /** 数据层每轮取数后由 data-layer 回调 */
  onQuotes(): void {
    if (!this.data) return
    this.windows.push('push:quoteTick', this.data.quoteTicks())
    this.pushPetState()
    this.onChange?.()
  }

  /**
   * 引擎每轮跑完后由 data-layer 回调 —— **提醒分发的入口**（docs/05 §4）。
   *
   * 两件事：① 把评估结果交给 AlertService 过四道闸门；② 让面板重新拉一次信号列表
   * （借 push:engineStatus 触发，与 M2 同一做法）。
   *
   * `debounce` 只在连续竞价时段开：防抖的语义是「连续 N 个 tick 成立」，
   * 而收盘确认轮与盘后只跑一次，等第二个 tick 等不到（docs/05 §4.1）。
   */
  onSignals(ctx?: TickContext, outcomes?: readonly SignalOutcome[]): void {
    if (!this.data) return
    if (this.alerts && ctx && outcomes) {
      try {
        const debounce = ctx.session === 'CONTINUOUS_AM' || ctx.session === 'CONTINUOUS_PM'
        const summary = this.alerts.handle(outcomes, { at: ctx.at, debounce })
        if (summary.decisions.length > 0) {
          log.info(`[alert] ${ctx.date} ${ctx.session}：发出 ${summary.delivered} 条，静默 ${summary.suppressed} 条`)
        }
      } catch (error) {
        // 提醒挂了不该连带把面板刷新也吃掉：行情与信号仍要能看（docs/02 §7）
        log.warn('[alert] 分发失败：', error)
      }
    }
    this.windows.push('push:engineStatus', this.engineStatus())
  }

  // ── 提醒（M3）─────────────────────────────────────────────────────

  alertHistory(query: { code?: SecCode; from?: number; to?: number; limit?: number }): AlertRecord[] {
    return this.alerts?.history(query) ?? []
  }

  /** 空数组 = 全部已读（用户打开提醒日志即视为看过） */
  markAlertsRead(ids: string[]): number {
    return this.alerts?.markRead(ids, Date.now()) ?? 0
  }

  get unreadAlerts(): number {
    return this.unread
  }

  private requireData(): DataLayer {
    if (!this.data) throw new Error('数据层尚未就绪，请稍后重试')
    return this.data
  }

  private fallbackSettings(): AppSettings {
    // 数据层没起来时不该让设置面板整个报错，返回默认值先把界面画出来。
    // 但**不允许**写入 —— patchSettings 走 requireData() 会明确抛错，
    // 免得用户改了设置以为存下了
    return { ...DEFAULT_SETTINGS }
  }

  start(): void {
    this.windows.createOverlay()
    this.pushPetState()
  }

  // ── 窗口 ──────────────────────────────────────────────────────────

  togglePanel(): void {
    this.windows.panelWindow.toggle()
  }

  showPanel(): void {
    this.windows.panelWindow.show()
  }

  get overlayVisible(): boolean {
    return this.windows.overlayWindow?.isVisible() ?? false
  }

  /** C9：隐藏悬浮条后只保留托盘，功能不减 */
  setOverlayVisible(visible: boolean): void {
    this.windows.overlayWindow?.setVisible(visible)
    this.onStateChanged()
  }

  setOverlayInteractive(interactive: boolean): void {
    this.windows.overlayWindow?.setInteractive(interactive)
  }

  dragOverlayBy(dx: number, dy: number): void {
    this.windows.overlayWindow?.dragBy(dx, dy)
  }

  endOverlayDrag(): void {
    this.windows.overlayWindow?.dragEnd()
  }

  setHitRects(rects: Rect[]): void {
    this.reportedHitRects = rects
  }

  get hitRects(): Rect[] {
    return this.reportedHitRects
  }

  // ── 免打扰 ────────────────────────────────────────────────────────

  /**
   * 免打扰的聚合结论（docs/05 §4.4）：手动 / 静默时段 / 锁屏 / 全屏 · 演示 · 专注助手。
   *
   * 顺带**触发一次后台探测**：系统态探测要起一个 PowerShell 子进程，不能同步等，
   * 所以这里读的是缓存值、并顺手让它去刷新下一次。一轮 tick 30s、缓存 15s，
   * 于是每轮都会拿到一个不超过一轮陈旧的值 —— 见 alerts/notification-state.ts。
   */
  private quietVerdict(): QuietVerdict {
    const settings = this.getSettings()
    this.probe.refresh()
    return resolveQuiet({
      now: Date.now(),
      manualUntil: this.quietUntilAt,
      quietHours: settings.quietHours,
      respectFullscreen: settings.respectFullscreen,
      notificationState: this.probe.current(),
      locked: this.screenLocked,
    })
  }

  /** 任一来源成立即为真。托盘图标、状态点低调态、面板横幅都看这个 */
  get quiet(): boolean {
    return this.quietVerdict().quiet
  }

  /** 用户自己按下去的那个开关。托盘菜单的「解除免打扰」只管得着它 */
  get manualQuiet(): boolean {
    return isQuiet(this.quietUntilAt, Date.now())
  }

  get quietUntilTs(): number | null {
    return this.quietUntilAt
  }

  setQuietUntil(until: number | null): void {
    this.quietUntilAt = until
    this.onStateChanged()
  }

  setQuietPreset(preset: QuietPreset): void {
    this.setQuietUntil(quietUntil(Date.now(), preset))
  }

  // ── 状态推送 ──────────────────────────────────────────────────────

  /**
   * 数据层给的「底」状态：OFFLINE / SLEEPY（休市或免打扰）/ IDLE（盘中无事）。
   * WATCHING / EXCITED / ALERT 由**过了四道闸门的提醒**叠加上去（见 PetStateMachine）。
   */
  private baseState(quiet: boolean): PetState {
    const status = this.data?.status()
    if (status?.offline === true) return 'OFFLINE'
    if (quiet) return 'SLEEPY'
    if (!status) return 'IDLE'
    return status.session === 'CLOSED' || status.session === 'LUNCH_BREAK' ? 'SLEEPY' : 'IDLE'
  }

  private get petState(): PetState {
    // 优先级见 docs/06 §3：OFFLINE > ALERT > EXCITED > WATCHING > IDLE > SLEEPY
    const base = this.baseState(this.quiet)
    return this.alerts?.pet.resolve(base, Date.now()) ?? base
  }

  engineStatus(): EngineStatus {
    const status = this.data?.status()
    const verdict = this.quietVerdict()
    const base: EngineStatus = {
      session: status?.session ?? 'CLOSED',
      lastTickAt: status?.lastTickAt ?? 0,
      watchCount: status?.watchCount ?? 0,
      unreadAlerts: this.unread,
      doNotDisturb: verdict.quiet,
      // 数据层还没起来时如实报离线，不假装在线
      offline: status?.offline ?? true,
    }
    if (verdict.reason !== undefined) base.doNotDisturbReason = verdict.reason
    if (status?.calendarUncertain === true) base.calendarUncertain = true
    if (status?.stale === true) base.stale = true
    return base
  }

  private pushPetState(): void {
    this.windows.push('push:petState', this.petState)
    this.windows.push('push:engineStatus', this.engineStatus())
  }

  /** 状态变化时通知外部（托盘图标、菜单勾选态） */
  onChange: (() => void) | null = null

  private onStateChanged(): void {
    this.pushPetState()
    this.onChange?.()
  }

  revalidateOverlayPosition(): void {
    this.windows.overlayWindow?.revalidatePosition()
  }

  quit(): void {
    app.quit()
  }

  /** 由 before-quit 调用。与 quit() 分开，是为了让 OS 关机等非菜单路径也能走到清理 */
  dispose(): void {
    if (this.petFallbackTimer) {
      clearTimeout(this.petFallbackTimer)
      this.petFallbackTimer = null
    }
    powerMonitor.removeAllListeners('lock-screen')
    powerMonitor.removeAllListeners('unlock-screen')
    // 先停调度再关库：反过来会让正在写库的那一轮 tick 撞上已关闭的连接
    this.data?.dispose()
    this.data = null
    this.alerts = null
    this.windows.destroyAll()
  }
}
