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

import { app, powerMonitor, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AboutInfo,
  AiConfigPatch,
  AiConfigView,
  AiExplainRecord,
  AiExplainStart,
  AiTestResult,
  AlertRecord,
  AppSettings,
  ConfigTransferResult,
  DailyBar,
  DailyReport,
  EngineStatus,
  IntradaySeries,
  MaintenanceResult,
  ParamRow,
  PetState,
  PositionView,
  ProviderHealth,
  Rect,
  ReportNoteView,
  ShadowSummary,
  ShadowTradeView,
  SignalEvidence,
  SignalRecord,
  TradeDraft,
  TradeLedger,
  TradePreview,
  TradeView,
  WatchItem,
  WatchPointDraft,
  WatchPointView,
} from '@shared/ipc-types'
import type { Candle, Position, SecCode, Snapshot, TradeDate } from '@core/types'
import { DEFAULT_PARAMS, engineVersionOf, withSensitivity } from '@core/params'
import { sma } from '@core/indicators/series'
import {
  AI_CONFIG_FILE,
  AI_REPORT_PROMPT,
  AI_REPORT_USER_SUFFIX,
  AI_SYSTEM_PROMPT,
  AI_USER_SUFFIX,
  AiConfigStore,
  buildSignalContext,
  createAiClient,
  createAiService,
  createUndiciAiTransport,
  electronSecretCrypto,
  renderContext,
  renderReportContext,
  type AiHistorySink,
  type AiService,
} from './ai'
import { electronAutoLaunchDeps, syncAutoLaunch } from './auto-launch'
import { createAlertService, type AlertService, type AlertSink } from './alerts/service'
import type { QuoteView } from './alerts/candidates'
import { resolveQuiet, type QuietVerdict } from './alerts/dnd'
import { createNotificationStateProbe, type NotificationStateProbe } from './alerts/notification-state'
import type { DataLayer } from './data-layer'
import type { SignalOutcome } from './engine'
import { log } from './logging'
import { shanghaiTime, type TickContext } from './scheduler'
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
  askDirectory,
  askOpenPath,
  askSavePath,
  confirmDestructive,
  confirmOverwrite,
  readJsonFile,
  writeTextFile,
} from './settings/transfer-io'
import { paramRows } from './settings/params-view'
import { isReportTarget, reportDateOf } from '@shared/ai-target'
import { buildDailyReport } from './report/build'
import { reportFactDigest } from './report/digest'
import {
  DEFAULT_SHADOW_CAPITAL,
  emptyShadowSummary,
  summarize,
  toTradeView,
} from './shadow'
import { BACKUP_DIR_NAME, DEFAULT_BACKUP_POLICY, backupNow } from './storage/backup'
import { SHADOW_KEYS } from './storage/repositories/shadow'
import { pruneAll, vacuum } from './storage/retention'
import { isQuiet, quietUntil, type QuietPreset } from './util/quiet'
import { evaluateWatchPoints, type WatchHit } from './watch/evaluate'
import { isWatchMetric } from './watch/metrics'
import { applyTrade, isTradeError, replayTrades } from './trades/ledger'
import type { TradeRow } from './storage/repositories/trade'
import type { WatchPointRow } from './storage/repositories/watch'
import { WindowManager } from './windows/WindowManager'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 观察点默认有效期。20 个交易日 ≈ 四周，按自然日折算给足余量 */
const DEFAULT_WATCH_DAYS = 28

/**
 * 落库行 → 渲染层视图。
 *
 * `staleEngineVersion` 只对**指标类**给：换过灵敏度之后 rsi 周期一类的东西变了，
 * 同一个阈值不再是同一件事。而 PRICE 是不复权现价，与引擎参数无关，不该报警。
 */
function toWatchPointView(
  row: WatchPointRow,
  currentEngineVersion: string,
  nameOf: (code: SecCode) => string
): WatchPointView {
  const view: WatchPointView = {
    id: row.id,
    code: row.code,
    name: nameOf(row.code),
    signalId: row.signalId,
    source: row.source,
    metric: row.metric,
    op: row.op,
    threshold: row.threshold,
    meaning: row.meaning,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status,
  }
  if (row.note !== undefined) view.note = row.note
  if (row.verdict !== undefined) view.verdict = row.verdict
  if (row.verdictText !== undefined) view.verdictText = row.verdictText
  if (row.hitAt !== undefined) view.hitAt = row.hitAt
  if (row.hitValue !== undefined) view.hitValue = row.hitValue
  if (row.metric !== 'PRICE' && row.engineVersion !== currentEngineVersion) {
    view.staleEngineVersion = row.engineVersion
  }
  return view
}

/**
 * 成交流水的落库行 → 渲染层视图。
 * 名字里带 Log 是为了与 `shadow` 那边的 `toTradeView`（影子成交）区分 ——
 * 两者都叫「成交」，但一个是用户真金白银的账本，一个是模拟盘的绩效记录。
 */
function toTradeLogView(row: TradeRow): TradeView {
  const view: TradeView = {
    id: row.id,
    code: row.code,
    side: row.side,
    tradedAt: row.tradedAt,
    price: row.price,
    shares: row.shares,
    fee: row.fee,
  }
  if (row.realized !== undefined) view.realized = row.realized
  if (row.note !== undefined) view.note = row.note
  return view
}

/** 数据层未就绪时报的引擎版本：出厂参数的那一个（此时也确实还没有别的） */
const DEFAULT_PARAMS_VERSION = engineVersionOf()

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

  /**
   * AI 解读（P2）。**不依赖数据层** —— 设置页要能在数据层装配失败时照常配置。
   * 真正解读时才需要信号，那一步走 `requireData()`。
   */
  private aiStore: AiConfigStore | null = null
  private ai: AiService | null = null

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
    const repo = this.data?.storage.positions
    if (!repo) return []
    return repo.list().map((held) => this.toPositionView(held.code, held))
  }

  /**
   * 持仓 → 视图。**把止损确认一起带上** —— 那是用户主动关掉了一个安全提醒的凭据，
   * 界面上不显示的话，他日后只会觉得「跌了这么多怎么没提醒我」。
   */
  private toPositionView(code: SecCode, held: Position): PositionView {
    const ack = this.data?.storage.positions.stopAck(code) ?? null
    return {
      code: held.code,
      shares: held.shares,
      cost: held.cost,
      peakPrice: held.peakPrice,
      openedAt: held.openedAt,
      // exactOptionalPropertyTypes：没确认过就不要这个键
      ...(ack === null ? {} : { stopAck: ack }),
    }
  }

  /**
   * 用户确认「接受这一段亏损」。
   *
   * **不弹系统模态框**：这与「删掉花过钱的解读」不同 —— 它是可逆的（随时 clearStop），
   * 而且确认动作本身发生在一个把代价写清楚的内联表单里
   * （「跌到这个价之前，不会再因为亏损提醒你」）。
   *
   * 校验刻意只有两条：正数、且**低于现价**。不校验「必须低于成本」——
   * 一只已经涨回成本上方的票，用户想把止损线抬到成本之上是完全合理的诉求。
   */
  acceptLoss(code: SecCode, stopFloor: number): PositionView | null {
    const layer = this.requireData()
    if (!Number.isFinite(stopFloor) || stopFloor <= 0) throw new Error('止损线必须是正数')

    const held = layer.storage.positions.get(code)
    if (!held) throw new Error('这只票没有持仓记录')

    const price = layer.market.snapshotOf(code)?.last
    if (price !== undefined && stopFloor >= price) {
      // 设在现价之上等于「立刻触发」—— 那不是用户想要的「接受这一段」，
      // 而且他下一轮就会收到一条一模一样的提醒，看起来像确认没生效
      throw new Error(`止损线要低于现价 ${price}，否则下一轮就会立刻触发`)
    }

    const lossPct = held.cost > 0 && price !== undefined ? ((price - held.cost) / held.cost) * 100 : 0
    layer.storage.positions.acceptLoss(code, stopFloor, lossPct, Date.now())
    log.info(
      `[risk] ${code} 用户确认接受 ${lossPct.toFixed(1)}% 的亏损，止损线顺延到 ${stopFloor}`
    )
    this.onStateChanged()
    const updated = layer.storage.positions.get(code)
    return updated ? this.toPositionView(code, updated) : null
  }

  /** 撤销确认，回到按 `risk.stopLossPct` 的出厂行为 */
  clearStopFloor(code: SecCode): PositionView | null {
    const layer = this.requireData()
    layer.storage.positions.clearStop(code)
    log.info(`[risk] ${code} 撤销止损确认，回到按百分比判定`)
    this.onStateChanged()
    const updated = layer.storage.positions.get(code)
    return updated ? this.toPositionView(code, updated) : null
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
    const previous = layer.settings.get()
    const next = layer.settings.patch(patch)
    layer.applySettings(next)
    // 开机自启要落到系统里，不能只存进 JSON —— 一个改了不生效的开关比没有更糟。
    // 只在真的变了时才同步：无条件写会覆盖用户在「任务管理器 → 启动」里的手动禁用
    if (next.autoLaunch !== previous.autoLaunch) {
      syncAutoLaunch(next.autoLaunch, electronAutoLaunchDeps(log))
    }
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
          // 导入的持仓补一笔期初建仓，让账本与持仓从导入那一刻起就对得上
          // （与 007 迁移做的是同一件事）
          trades: {
            removeByCode: (code) => layer.storage.trades.removeByCode(code as SecCode),
            seedOpening: (input) =>
              layer.storage.trades.insert({
                id: randomUUID(),
                code: input.code as SecCode,
                side: 'OPENING',
                tradedAt: input.at,
                price: input.cost,
                shares: input.shares,
                // 0 不是「没有手续费」，是「不知道」—— 导出文件里从来没有过费用
                fee: 0,
                note: '导入配置时按持仓补的期初建仓，手续费未知',
                createdAt: Date.now(),
              }),
          },
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

  // ── 影子运行（M4，docs/07 §2.3）───────────────────────────────────
  //
  // 面板只读这两条 + 一条重置。推进不在这里：它挂在 tick 上（engine/tick.ts），
  // 因为「一个交易日推进一次」是数据层的节奏，不是 UI 的。

  shadowSummary(): ShadowSummary {
    const layer = this.data
    if (!layer) return emptyShadowSummary(DEFAULT_PARAMS_VERSION)
    const meta = layer.storage.meta
    const recorded = meta.get(SHADOW_KEYS.engineVersion)
    const current = layer.signals.engineVersion
    return summarize({
      startedAt: meta.getNumber(SHADOW_KEYS.startedAt),
      startedDate: meta.get(SHADOW_KEYS.startedDate),
      startCapital: meta.getNumber(SHADOW_KEYS.startCapital) ?? DEFAULT_SHADOW_CAPITAL,
      equity: layer.storage.shadow.equity(),
      trades: layer.storage.shadow.trades(),
      positions: layer.storage.shadow.positions(),
      orders: layer.storage.shadow.orders(),
      skippedNoCash: meta.getNumber(SHADOW_KEYS.skippedNoCash) ?? 0,
      limitBlocked: meta.getNumber(SHADOW_KEYS.limitBlocked) ?? 0,
      engineVersion: current,
      // 只有「记过、且不一致」才算暂停。从未记过（还没开始）不是暂停
      stalledEngineVersion: recorded !== null && recorded !== current ? recorded : null,
      now: Date.now(),
    })
  }

  shadowTrades(limit = 50): ShadowTradeView[] {
    const layer = this.data
    if (!layer) return []
    return layer.storage.shadow
      .trades(limit)
      .map((trade) => toTradeView(trade, layer.storage.watchlist.get(trade.code)?.profile.name ?? trade.code))
      .reverse()
  }

  /**
   * 清空影子账本并重新开始。**走系统确认框** —— 丢掉的是一段无法重建的前向记录，
   * 不该是一个点了就没的按钮（历史 K 线补出来的那个叫回测，见 ShadowRepo.reset）。
   */
  async resetShadow(): Promise<MaintenanceResult> {
    try {
      const layer = this.requireData()
      const summary = this.shadowSummary()
      const confirmed = await confirmDestructive(this.windows.panelWindow.browserWindow, {
        title: '重新开始影子运行',
        message: '清空模拟持仓与绩效记录，从下一个交易日重新累积？',
        detail:
          `将丢弃 ${summary.bars} 个交易日、${summary.entries.count} 次模拟建仓的记录。\n\n` +
          '这段记录是前向累积的，删掉之后无法重建 —— 用历史行情补出来的是回测，不是影子运行。',
        confirmLabel: '清空并重新开始',
      })
      if (!confirmed) return { status: 'CANCELED', message: '已取消，影子记录未改动' }
      layer.shadow.reset()
      this.onStateChanged()
      return { status: 'DONE', message: '影子记录已清空，将在下一个交易日重新开始累积' }
    } catch (error) {
      log.warn('[shadow] 重置失败：', error)
      return { status: 'FAILED', message: '重置失败', error: messageOf(error) }
    }
  }

  // ── 数据维护（M4 设置页）──────────────────────────────────────────

  /** 只读参数表。摊的是**当前生效的**参数集（含灵敏度换档后的值），不是硬编码的出厂值 */
  paramRows(): ParamRow[] {
    return paramRows(withSensitivity(this.getSettings().sensitivity))
  }

  about(): AboutInfo {
    const layer = this.data
    return {
      appVersion: appVersion(),
      electronVersion: process.versions.electron ?? '未知',
      engineVersion: layer?.signals.engineVersion ?? DEFAULT_PARAMS_VERSION,
      schemaVersion: layer?.storage.db.schemaVersion ?? 0,
      dataDir: layer?.paths.dataDir ?? app.getPath('userData'),
      logDir: app.getPath('logs'),
      backupDir: layer?.paths.backupDir ?? join(app.getPath('userData'), BACKUP_DIR_NAME),
    }
  }

  backupDatabase(): MaintenanceResult {
    try {
      const layer = this.requireData()
      const result = backupNow(
        layer.storage.db,
        layer.paths.backupDir,
        Date.now(),
        DEFAULT_BACKUP_POLICY,
        (m) => log.info(m)
      )
      return {
        status: 'DONE',
        message: `已备份 ${(result.bytes / 1024 / 1024).toFixed(1)} MB（保留最近 ${DEFAULT_BACKUP_POLICY.keep} 份）`,
        path: result.path,
      }
    } catch (error) {
      // 手动备份失败必须把原因显示出来：同一分钟内点两次会撞「文件已存在」，
      // 而那是用户自己能理解并绕开的
      log.warn('[backup] 手动备份失败：', error)
      return { status: 'FAILED', message: '备份失败', error: messageOf(error) }
    }
  }

  /**
   * 清缓存。**动的只有派生物**：指标缓存 + 到期裁剪 + VACUUM。
   *
   * 不动 K 线（重拉要花掉几百个请求）、不动自选与持仓（那是用户输入）、
   * **不动影子账本**（那是无法重建的前向记录）。「清缓存」在别的软件里常常
   * 顺手把一切都清掉 —— 这里刻意窄，因为这三样里有两样删了就回不来。
   */
  clearCache(): MaintenanceResult {
    try {
      const layer = this.requireData()
      const indicators = layer.storage.indicators.purgeOtherVersions('')
      const pruned = pruneAll(layer.storage.db, Date.now())
      vacuum(layer.storage.db)
      const parts = [
        `指标缓存 ${indicators} 条`,
        pruned.signalDeleted > 0 ? `过期信号 ${pruned.signalDeleted} 条` : null,
        pruned.alertDeleted > 0 ? `过期提醒 ${pruned.alertDeleted} 条` : null,
        pruned.healthDeleted > 0 ? `健康度 ${pruned.healthDeleted} 条` : null,
      ].filter((part): part is string => part !== null)
      return {
        status: 'DONE',
        message: `已清理 ${parts.join('、')}，并整理了数据库。K 线、自选、持仓与影子记录未受影响`,
      }
    } catch (error) {
      log.warn('[cache] 清缓存失败：', error)
      return { status: 'FAILED', message: '清缓存失败', error: messageOf(error) }
    }
  }

  /**
   * 换数据目录。**只写设置、不搬库**，需要重启才生效。
   *
   * 为什么不当场搬：`market.db` 是启动时打开的单连接，中途换目录要么复制整库
   * 要么重开连接并重建全部仓储 —— 而这条路上任何一步失败都会让用户处在
   * 「一半数据在旧目录、一半在新目录」的状态。提示重启笨一点，但不会丢数据。
   * 旧目录里的文件**不删**：用户可以自己搬过去，也可以改回来。
   */
  async chooseDataDir(): Promise<MaintenanceResult> {
    try {
      const current = this.about().dataDir
      const picked = await askDirectory(this.windows.panelWindow.browserWindow, current)
      if (picked === null) return { status: 'CANCELED', message: '已取消，数据目录未改动' }
      if (picked === current) return { status: 'CANCELED', message: '选的就是当前目录，未改动' }
      this.patchSettings({ dataDir: picked })
      return {
        status: 'DONE',
        message: '数据目录已保存，重启后生效。旧目录里的文件没有动，需要的话请手工搬过去',
        path: picked,
        needsRestart: true,
      }
    } catch (error) {
      log.warn('[settings] 选择数据目录失败：', error)
      return { status: 'FAILED', message: '选择数据目录失败', error: messageOf(error) }
    }
  }

  revealPath(which: 'data' | 'logs' | 'backups'): void {
    const info = this.about()
    const target =
      which === 'logs' ? info.logDir : which === 'backups' ? info.backupDir : info.dataDir
    // 目录可能还不存在（一次都没备份过）—— 先建再开，否则 openPath 静默失败
    mkdirSync(target, { recursive: true })
    void shell.openPath(target)
  }

  // ── 信号（M2）─────────────────────────────────────────────────────

  signalHistory(query: { code?: SecCode; from?: number; to?: number; limit?: number; perCode?: number }): SignalRecord[] {
    // 数据层没起来时返回空列表而不是抛错：面板要能把「数据层未就绪」那条横幅画出来
    return this.data?.signalHistory(query) ?? []
  }

  explainSignal(id: string): SignalEvidence {
    const evidence = this.requireData().explainSignal(id)
    if (!evidence) throw new Error('该信号已不在库中（可能已被保留策略裁剪）')
    return evidence
  }

  // ── 日 K 与成交流水（007_trade_log.sql）───────────────────────────

  /**
   * 日 K（抽屉「行情」页）。**不复权**价格 + 两条**展示用** MA。
   *
   * 为什么不复权：价格轴要与用户的成交价、持仓成本、券商 App 上的数字对得上。
   * 代价是除权日会跳空，两条 MA 也跟着跳 —— **如实呈现，不做接续**（渲染层标一行小字）。
   * 引擎用的那两条 MA 是前复权算的，与这里不是同一条线，不要拿去互相校对。
   */
  dailyBars(query: { code: SecCode; limit?: number }): DailyBar[] {
    const layer = this.data
    if (!layer) return []
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 60), 1), 500)
    // 多取 60 根只为把 MA60 预热出来，最后再切回 limit 根 ——
    // 不预热的话前 59 根的 MA 全是 null，图上那两条线会从中间才开始
    const candles = layer.storage.klines.recent(query.code, limit + 60)
    if (candles.length === 0) return []

    const closes = candles.map((c) => c.close)
    const ma20 = sma(closes, 20)
    const ma60 = sma(closes, 60)
    return candles.slice(-limit).map((candle, i) => {
      const index = candles.length - Math.min(limit, candles.length) + i
      return {
        date: candle.date,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        ma20: ma20[index] ?? null,
        ma60: ma60[index] ?? null,
      }
    })
  }

  /** 某只票的账本视图。汇总在这一层算，渲染层不再实现一遍口径 */
  tradeLedger(code: SecCode): TradeLedger {
    const layer = this.data
    if (!layer) return { code, trades: [], realizedTotal: 0, feeTotal: 0, position: null }
    const rows = layer.storage.trades.listByCode(code)
    return {
      code,
      // 仓储只出升序（重放要的顺序），展示要新的在上 —— 在这里翻一次，别让两边各记一半
      trades: [...rows].reverse().map(toTradeLogView),
      realizedTotal: layer.storage.trades.sumRealized(code),
      feeTotal: layer.storage.trades.sumFees(code),
      position: layer.storage.positions.get(code) ?? null,
    }
  }

  /**
   * 录入前试算。**与 `addTrade` 走同一个 `applyTrade`** —— 表单里显示的
   * 「录入后会变成什么样」必须与真的存进去的结果逐位相同，否则用户两个数都不会信。
   */
  previewTrade(draft: TradeDraft): TradePreview {
    const empty = { fee: 0, amount: 0, position: null, realized: null }
    const layer = this.data
    if (!layer) return { ...empty, error: '数据层还没就绪' }

    const current = layer.storage.positions.get(draft.code)
    const outcome = applyTrade(
      current ? { shares: current.shares, cost: current.cost } : null,
      { side: draft.side, price: draft.price, shares: draft.shares }
    )
    if (isTradeError(outcome)) return { ...empty, error: outcome.error }
    return {
      fee: outcome.fee,
      amount: draft.price * Math.trunc(draft.shares),
      position: outcome.position,
      realized: outcome.realized,
    }
  }

  /**
   * 录一笔成交：追加流水 + 按加权平均更新持仓。
   *
   * 记账规则在 `trades/ledger.ts`，**与表单里的试算是同一个函数** ——
   * 两处各算一遍必然分叉，而症状是「表单说成本会变成 12.34，存完变成 12.31」。
   *
   * 落库包在一个事务里：流水写进去了但持仓没更新，账就永远对不上了。
   */
  addTrade(draft: TradeDraft): TradeLedger {
    const layer = this.requireData()
    const code = draft.code
    if (!layer.storage.watchlist.get(code)) throw new Error('这只股票不在自选里，先添加再录成交')

    const current = layer.storage.positions.get(code)
    const outcome = applyTrade(
      current ? { shares: current.shares, cost: current.cost } : null,
      { side: draft.side, price: draft.price, shares: draft.shares }
    )
    if (isTradeError(outcome)) throw new Error(outcome.error)

    const now = Date.now()
    const tradedAt = draft.tradedAt ?? now
    layer.storage.db.transaction(() => {
      layer.storage.trades.insert({
        id: randomUUID(),
        code,
        side: draft.side,
        tradedAt,
        price: draft.price,
        shares: Math.trunc(draft.shares),
        fee: outcome.fee,
        ...(outcome.realized === null ? {} : { realized: outcome.realized }),
        ...(draft.note === undefined || draft.note === '' ? {} : { note: draft.note.slice(0, 200) }),
        createdAt: now,
      })
      if (outcome.position === null) {
        layer.storage.positions.clear(code)
      } else {
        layer.storage.positions.set(code, outcome.position.shares, outcome.position.cost, current?.openedAt ?? tradedAt)
        // 买入之后持有期最高价至少是成本价：不补这一下，移动止损会拿一个比成本还低的
        // peak 去算回撤（docs/05 §2.3）
        layer.storage.positions.bumpPeak(code, Math.max(outcome.position.cost, draft.price))
      }
    })

    log.info(`[trade] ${code} ${draft.side} ${draft.shares}股 @${draft.price}（费 ${outcome.fee}）`)
    this.onStateChanged()
    return this.tradeLedger(code)
  }

  /**
   * 删一笔（录错了）：删掉之后**按剩余流水重放重建持仓**。
   *
   * 不做反向增量回滚：卖出不改成本价，所以没有可逆信息 ——「买 → 卖 → 又买」这种序列上
   * 反算是回不到正确成本的。重放的前提是期初那一笔已经补上了（007 迁移做的事）。
   */
  removeTrade(id: string): TradeLedger {
    const layer = this.requireData()
    const row = layer.storage.trades.get(id)
    if (!row) throw new Error('这笔成交已经不在了')

    const code = row.code
    layer.storage.db.transaction(() => {
      layer.storage.trades.remove(id)
      const rebuilt = replayTrades(layer.storage.trades.listByCode(code))
      const openedAt = layer.storage.positions.get(code)?.openedAt ?? row.tradedAt
      if (rebuilt === null) layer.storage.positions.clear(code)
      else layer.storage.positions.set(code, rebuilt.shares, rebuilt.cost, openedAt)
    })

    log.info(`[trade] ${code} 删掉一笔 ${row.side} ${row.shares}股 @${row.price}，已按剩余流水重建持仓`)
    this.onStateChanged()
    return this.tradeLedger(code)
  }

  /**
   * 当日分时（抽屉「行情」页那张图）。**会发一次网络请求**，带 30s 缓存，
   * 拉不到时由数据层退回本机留痕 —— 取舍规则在 engine/intraday.ts。
   *
   * 数据层没起来时返回空序列而不是抛错 —— 与 `signalHistory` 同一条：
   * 一张图画不出来不该让整个面板报错。空序列在渲染层有自己的说法
   * （「今天还没有分时数据」），而那句话恰好是真的。
   */
  intradaySeries(query: { code: SecCode; from: number; to?: number }): Promise<IntradaySeries> {
    return (
      this.data?.intradaySeries(query) ??
      Promise.resolve({
        code: query.code,
        tradeDate: null,
        source: 'LOCAL' as const,
        preClose: null,
        points: [],
      })
    )
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
    // 观察点先判：命中的要跟着这一轮一起过闸门（见 candidates.ts 的 watchHitAlert）
    const watchHits = ctx && outcomes ? this.evaluateWatchPoints(ctx, outcomes) : []

    if (this.alerts && ctx && outcomes) {
      try {
        const debounce = ctx.session === 'CONTINUOUS_AM' || ctx.session === 'CONTINUOUS_PM'
        const summary = this.alerts.handle(outcomes, { at: ctx.at, debounce, watchHits })
        if (summary.decisions.length > 0) {
          log.info(`[alert] ${ctx.date} ${ctx.session}：发出 ${summary.delivered} 条，静默 ${summary.suppressed} 条`)
        }
      } catch (error) {
        // 提醒挂了不该连带把面板刷新也吃掉：行情与信号仍要能看（docs/02 §7）
        log.warn('[alert] 分发失败：', error)
      }
    }

    /*
      日内做T建议（core/risk/intraday-t.ts）。**每轮都推，没有就推空数组** ——
      它的时效只有几十分钟，只在「有」的时候推会让早上那条建议一直挂到收盘，
      而用户没有任何办法看出它已经过期。

      它刻意**不经过 AlertService**：不进 alert_log、不点状态点、不发气泡。
      状态点仍然只由四道闸门点亮（docs/05 §4），这一条不是提醒，是面板上的一个标注。
    */
    this.windows.push(
      'push:intradayT',
      (outcomes ?? []).flatMap((outcome) => {
        const advice = outcome.evaluation.gated.tTrade
        if (!advice) return []
        return [{ code: outcome.evaluation.code, name: outcome.name, ...advice }]
      })
    )

    this.windows.push('push:engineStatus', this.engineStatus())
  }

  // ── 观察点（P2 续）────────────────────────────────────────────────
  //
  // **它不是策略参数。** 观察点是用户自己拥有的一次性盯盘条件（AI 建议 → 人确认），
  // 判定是一次纯比较、不涉及模型；命中后走**正常的四道闸门**。
  // 边界与理由见 storage/migrations/003_watch.sql 的头注释。

  /**
   * 判一轮观察点，落库状态，返回命中的（交给 AlertService 一起过闸门）。
   *
   * 判定挂在引擎跑完之后 —— 那一刻 `evaluation.candle` + `indicators` + 最新报价都在手上。
   * 引擎在竞价时段之外返回空数组，所以观察点只在盘中被判，这是对的。
   */
  private evaluateWatchPoints(ctx: TickContext, outcomes: readonly SignalOutcome[]): WatchHit[] {
    const layer = this.data
    if (!layer) return []
    try {
      const repo = layer.storage.watchPoints
      const points = repo.active()
      if (points.length === 0) return []

      const result = evaluateWatchPoints({
        points,
        outcomes,
        quotes: this.quoteViews(),
        at: ctx.at,
      })

      // markHit 带 `status = 'ACTIVE'` 条件，是幂等闸门：盘后会跑好几轮，
      // 少了它同一个观察点会被反复记成命中
      const hits = result.hits.filter((hit) => repo.markHit(hit.point.id, ctx.at, hit.value))
      for (const point of result.expired) {
        if (repo.markExpired(point.id)) {
          // 过期**不发气泡**：到期未兑现是个结论，但一天几十条「你那个猜错了」是骚扰
          log.info(`[watch] ${point.code} 观察点到期未命中（${point.metric} ${point.op} ${point.threshold}）`)
        }
      }
      for (const hit of hits) {
        log.info(`[watch] ${hit.point.code} 命中：${hit.point.metric} ${hit.point.op} ${hit.point.threshold}，实际 ${hit.value}`)
      }
      return hits
    } catch (error) {
      // 观察点判定挂了不该连带把提醒与面板吃掉（docs/02 §7）
      log.warn('[watch] 判定失败：', error)
      return []
    }
  }

  watchPoints(query: { status?: WatchPointView['status']; limit?: number } = {}): WatchPointView[] {
    const layer = this.data
    if (!layer) return []
    const current = layer.signals.engineVersion
    return layer.storage.watchPoints.list(query).map((row) => toWatchPointView(row, current, (code) =>
      layer.storage.watchlist.get(code)?.profile.name ?? code
    ))
  }

  /** 新建。数值一律是**用户确认过**的 —— 模型的建议只走到表单预填那一步 */
  createWatchPoint(draft: WatchPointDraft): WatchPointView {
    const layer = this.requireData()
    if (!isWatchMetric(draft.metric)) throw new Error(`不支持盯这个指标：${draft.metric}`)
    if (!Number.isFinite(draft.threshold)) throw new Error('阈值必须是一个数')

    const evidence = layer.explainSignal(draft.signalId)
    if (!evidence) throw new Error('来源信号已不在库中，无法挂观察点')
    const record = layer.signalHistory({ limit: 500 }).find((row) => row.id === draft.signalId)
    if (!record) throw new Error('来源信号已不在最近的记录里')

    const now = Date.now()
    const days = Math.min(Math.max(Math.trunc(draft.days ?? DEFAULT_WATCH_DAYS), 1), 365)
    const row = {
      id: randomUUID(),
      code: record.code,
      signalId: draft.signalId,
      source: draft.edited === true ? ('USER_EDITED' as const) : ('AI_SUGGESTED' as const),
      metric: draft.metric,
      op: draft.op,
      threshold: draft.threshold,
      meaning: draft.meaning,
      ...(draft.note === undefined || draft.note === '' ? {} : { note: draft.note.slice(0, 500) }),
      // 方向结论：表单里可选可改。**归不了类就没有**，这里不做任何猜测式补全 ——
      // 猜出来的方向会以「用户确认过」的身份留在观察点列表上（005_watch_verdict.sql）
      ...(draft.verdict === undefined ? {} : { verdict: draft.verdict }),
      ...(draft.verdictText === undefined || draft.verdictText === ''
        ? {}
        : { verdictText: draft.verdictText.slice(0, 40) }),
      engineVersion: layer.signals.engineVersion,
      createdAt: now,
      expiresAt: now + days * 24 * 60 * 60 * 1000,
      status: 'ACTIVE' as const,
    }
    layer.storage.watchPoints.insert(row)
    log.info(`[watch] 新增：${row.code} ${row.metric} ${row.op} ${row.threshold}（${days} 天，${row.source}）`)
    this.onStateChanged()
    return toWatchPointView(row, layer.signals.engineVersion, () => record.name)
  }

  /**
   * 用户点「不盯了」：**二次确认之后真删这一行**。
   *
   * 为什么是删而不是改成 CANCELED：一条被主动放弃的观察点不构成结论
   * —— 与「到期未命中」不同（那个答的是「当时那个判断没兑现」，有信息），
   * 「我不想盯了」只会把列表越攒越长。
   *
   * 为什么确认框走**系统模态框**而不是页面里的一个二次点击：删掉之后
   * 「当时押了什么」这条记录就找不回来了，与清空影子账本、覆盖导入同一类操作
   * （见 resetShadow / confirmOverwrite）。默认按钮是「取消」，
   * 这个框可能在用户没看清的情况下被回车掉。
   *
   * 返回 false = 用户取消，什么都没动。
   */
  async removeWatchPoint(id: string): Promise<boolean> {
    const layer = this.requireData()
    const row = layer.storage.watchPoints.get(id)
    // 已经不在了：当成删成功，别为一个「本来就想让它消失」的东西弹错误
    if (!row) return true

    const name = layer.storage.watchlist.get(row.code)?.profile.name ?? row.code
    const arrow = row.op === 'LTE' ? '≤' : '≥'
    const confirmed = await confirmDestructive(this.windows.panelWindow.browserWindow, {
      title: '移除观察点',
      message: `不再盯 ${name} 的「${row.metric} ${arrow} ${row.threshold}」？`,
      detail:
        '这一行会被直接删掉，不是标记成已取消 —— 当时为什么设它、判断的是什么方向，' +
        '都一并消失，找不回来。\n\n' +
        '如果只是想让它自然结束，可以什么都不做：到期未命中会留一条「没兑现」的记录，' +
        '那本身也是一个结论。',
      confirmLabel: '移除',
    })
    if (!confirmed) return false

    layer.storage.watchPoints.remove(id)
    log.info(`[watch] 移除：${row.code} ${row.metric} ${row.op} ${row.threshold}`)
    this.onStateChanged()
    return true
  }

  // ── 提醒（M3）─────────────────────────────────────────────────────

  alertHistory(query: { code?: SecCode; from?: number; to?: number; limit?: number }): AlertRecord[] {
    return this.alerts?.history(query) ?? []
  }

  /** 空数组 = 全部已读（用户打开提醒日志即视为看过） */
  markAlertsRead(ids: string[]): number {
    return this.alerts?.markRead(ids, Date.now()) ?? 0
  }

  /**
   * 已经存在的日报评价。**纯读，不发起任何模型请求。**
   *
   * `stale` 由事实层指纹比出来（`report/digest.ts`）：一段基于盘中版写的评价，
   * 在日线补齐、日报定稿之后可能已经与屏幕上的数字对不上 —— 而它读起来完全正常。
   * 这与「stale 快照必须灰显」是同一条纪律：不假装，也不让用户自己去发现。
   */
  reportNote(): ReportNoteView | null {
    const layer = this.data
    if (!layer) return null
    const report = this.dailyReport()
    if (!report) return null
    const row = layer.storage.reportNotes.latestOf(report.date)
    if (!row) return null
    return {
      tradeDate: row.tradeDate,
      text: row.text,
      createdAt: row.createdAt,
      model: row.model,
      stale: row.factDigest !== reportFactDigest(report),
    }
  }

  // ── 收盘日报 ──────────────────────────────────────────────────
  //
  // **这一层只凑数据，不做判断** —— 判据全在 `report/build.ts`（纯函数，有用例）。
  // 日报不是提醒：不进 alert_log、不点状态点、不弹气泡，出口只有面板那个页签。

  /**
   * 最近一个交易日的日报。
   *
   * **刻意只做「最近一个交易日」，不支持翻历史。** `position` 表是**当前**状态，
   * 拿它去算三天前那天的浮盈亏会得到一个错的数，而错的方式用户看不出来。
   * 要做历史得先用 `trades/ledger.ts` 的 `replayTrades` 重建那一天的持仓，单独排期。
   */
  dailyReport(): DailyReport | null {
    const layer = this.data
    if (!layer) return null

    // 「最近一个交易日」取**库里最新的那根日线**，不取本机日期：
    // 周末与节假日打开时，本机的「今天」根本没有行情
    const items = layer.watchlist.list()
    const dates = items
      .map((item) => layer.storage.klines.lastDate(item.code))
      .filter((d): d is TradeDate => d !== null)
    // 一根日线都没有时退到本机日期 —— 那时报告里全是「—」，而那正是实情
    const date = dates.sort().at(-1) ?? shanghaiTime(Date.now()).date

    const bars = new Map<SecCode, { day: Candle; prev?: Candle }>()
    for (const item of items) {
      // 要两根：涨跌幅与振幅的分母是**昨收**，而 Candle 里没有这一列
      const pair = layer.storage.klines.recentThrough(item.code, date, 2)
      const day = pair.at(-1)
      // 末根不是那一天 → 这只当天没有收盘线（停牌 / 数据没到），交给快照那条退路
      if (!day || day.date !== date) continue
      const prev = pair.length >= 2 ? pair[pair.length - 2] : undefined
      bars.set(item.code, prev ? { day, prev } : { day })
    }

    const snapshots = new Map<SecCode, Snapshot>()
    for (const item of items) {
      const snapshot = layer.market.snapshotOf(item.code)
      if (snapshot) snapshots.set(item.code, snapshot)
    }

    const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime()
    return buildDailyReport({
      date,
      at: Date.now(),
      items,
      bars,
      snapshots,
      // 含被硬抑制的：面板要能回答「它为什么没提醒我」（docs/05 §4）
      signals: layer.signalHistory({ from: dayStart, limit: 500, perCode: 50 }),
      positions: this.positions(),
      watchPoints: this.watchPoints({ limit: 500 }),
      alerts: this.alertHistory({ from: dayStart, limit: 500 }),
      stopLossPct: DEFAULT_PARAMS.risk.stopLossPct,
      dayStart,
    })
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
    this.startAi()
  }

  // ── AI 解读（P2，docs/08 §后续）─────────────────────────────────────
  //
  // 三条必须守住的边界：
  //   ① **只读的解释层**：结果不回流到信号、闸门、状态点或影子运行。
  //      这里绝不调用 pushPetState()，那会开一条绕过四道闸门的旁路。
  //   ② **key 不进 AppSettings**：ai.json 与 settings.json 并列，都留在**默认**
  //      用户数据目录（不跟 dataDir 走）—— 配置改坏了得找得回来。
  //   ③ **不复用 net/http.ts**：那个限流器与行情取数共用（全局并发 4），
  //      一次 40 秒的 LLM 调用挂上去会把盘中每 30 秒一轮的 tick 饿死。

  private startAi(): void {
    const file = join(app.getPath('userData'), AI_CONFIG_FILE)
    const store = new AiConfigStore(file, electronSecretCrypto(), (m) => log.info(m))
    const view = store.load()
    this.aiStore = store

    for (const item of view.repaired) log.warn(`[ai] ${item}`)
    // 启动时打一行状态。加密可用性是这块唯一「装不上就整块用不了」的前提，
    // 而它在不同 OS / 会话下会变 —— 不打这一行，用户只会看到「保存了没反应」
    log.info(
      `[ai] 就绪：${view.enabled ? '已启用' : '未启用'}，` +
        `${view.hasKey ? '已配置 key' : '无 key'}，凭据加密${view.encryptionAvailable ? '可用' : '不可用'}`
    )

    this.ai = createAiService({
      store,
      client: createAiClient(createUndiciAiTransport(store.config().timeoutMs)),
      emit: (chunk) => this.windows.push('push:aiChunk', chunk),
      buildUserMessage: (id) => this.aiUserMessage(id),
      // 两个任务两套提示词：解释一条信号 vs 做一整天的横向观察（见 ai/prompt.ts）
      promptFor: (id) =>
        isReportTarget(id)
          ? { system: AI_REPORT_PROMPT, userSuffix: AI_REPORT_USER_SUFFIX }
          : { system: AI_SYSTEM_PROMPT, userSuffix: AI_USER_SUFFIX },
      history: this.aiHistorySink(),
      log: { info: (m) => log.info(m), warn: (m, e) => log.warn(m, e) },
    })
  }

  /**
   * AI 解读的落库口（008_ai_explain.sql）。
   *
   * **信号快照在这一层补齐**，不在 service 里：service 只知道 signalId 与正文，
   * 让它去认识 `SignalRecord` 的形状就等于把存储的事推进那一层。
   *
   * 两处 `this.data?.` 都是可选链：数据层没起来时 AI 仍然要能用，
   * 只是那几条不进历史 —— 而不是整块报错。
   */
  private aiHistorySink(): AiHistorySink {
    return {
      latest: (id) => {
        const date = reportDateOf(id)
        // 日报走 report_note（一天一条）；信号走 ai_explain。两张表的形状差得远，
        // 硬塞进一张会往 NOT NULL 的信号列里填假值（010 的头注释记着这一条）
        if (date !== null) return this.data?.storage.reportNotes.latestOf(date)?.text
        return this.data?.storage.aiExplains.latestOf(id)?.text
      },

      save: ({ signalId, text, startedAt, finishedAt }) => {
        const layer = this.data
        if (!layer) return

        const reportDate = reportDateOf(signalId)
        if (reportDate !== null) {
          const report = this.dailyReport()
          if (!report) return
          const config = this.aiStore?.config()
          layer.storage.reportNotes.upsert({
            tradeDate: reportDate,
            createdAt: startedAt,
            elapsedMs: Math.max(0, finishedAt - startedAt),
            text,
            model: config?.model ?? '未知',
            protocol: config?.protocol ?? 'openai',
            // 这段评价是对着**哪一版事实**写的。定稿之后据它提示「基于盘中数据」
            factDigest: reportFactDigest(report),
          })
          return
        }
        // 与 aiUserMessage 同一条查法：一条信号的 id 唯一，倒查最近 500 条即可
        const record = layer.signalHistory({ limit: 500 }).find((row) => row.id === signalId)
        if (!record) {
          // 信号已经被裁剪掉了 —— 存了也没有上下文可写，而没有上下文的一段正文
          // 在历史列表里是读不懂的（正是 008 那张表冗余存快照要防的）
          log.warn(`[ai] ${signalId} 解读完成但找不到原信号，未存入历史`)
          return
        }
        const config = this.aiStore?.config()
        layer.storage.aiExplains.insert({
          id: randomUUID(),
          signalId,
          code: record.code,
          createdAt: startedAt,
          elapsedMs: Math.max(0, finishedAt - startedAt),
          text,
          model: config?.model ?? '未知',
          protocol: config?.protocol ?? 'openai',
          direction: record.direction,
          stage: record.stage,
          score: record.score,
          ...(Number.isFinite(record.priceAt) ? { priceAt: record.priceAt } : {}),
          signalAt: record.createdAt,
        })
      },
    }
  }

  /**
   * 把一次请求摊成发给模型的正文。拿不到东西就抛错 —— 让 service 报成一次失败。
   *
   * 两种目标（`shared/ai-target.ts`）：`report:<date>` 是一整天的日报，其余是一条信号。
   */
  private aiUserMessage(id: string): string {
    if (isReportTarget(id)) return this.aiReportMessage(id)
    return this.aiSignalMessage(id)
  }

  /**
   * 日报的上下文。**发的是已经算好的事实层**（`DailyReport`），不是原始 K 线 ——
   * 再发一遍只会烧 token，并给模型一个用别的口径重算、报出与界面不一致的数字的机会。
   */
  private aiReportMessage(id: string): string {
    const layer = this.requireData()
    const report = this.dailyReport()
    if (!report) throw new Error('日报尚未就绪')
    const date = reportDateOf(id)
    if (date !== null && date !== report.date) {
      // 请求的是别的一天，而这里只算得出最近一个交易日（见 dailyReport 的头注释）
      throw new Error(`只能评价最近一个交易日（${report.date}）`)
    }
    return renderReportContext({
      report,
      params: this.paramRows(),
      engineVersion: layer.signals.engineVersion,
      at: new Date(report.at).toLocaleString('zh-CN'),
    })
  }

  /** 把一条信号摊成发给模型的正文。拿不到信号就抛错 —— 让 service 报成一次失败 */
  private aiSignalMessage(signalId: string): string {
    const layer = this.requireData()
    const evidence = layer.explainSignal(signalId)
    if (!evidence) throw new Error('该信号已不在库中（可能已被保留策略裁剪）')

    // signal:history 按时间倒查即可：一条信号的 id 是唯一的，
    // 这里不新开一条按 id 查的仓储方法（那要动 storage 接口，收益不抵成本）
    const record = layer.signalHistory({ limit: 500 }).find((row) => row.id === signalId)
    if (!record) throw new Error('该信号已不在最近的记录里')

    const alert = this.alertHistory({ code: record.code, limit: 200 }).find(
      (row) => row.signalId === signalId
    )
    const position = layer.storage.positions.list().find((held) => held.code === record.code)

    const context = buildSignalContext({
      record,
      evidence,
      ...(alert === undefined
        ? {}
        : {
            gate: {
              delivered: alert.channels.length > 0,
              ...(alert.reason === undefined ? {} : { reason: alert.reason }),
            },
          }),
      ...(position === undefined ? {} : { position }),
      params: this.paramRows(),
      engineVersion: layer.signals.engineVersion,
      at: new Date(record.createdAt).toLocaleString('zh-CN'),
    })
    return renderContext(context)
  }

  aiConfig(): AiConfigView {
    if (!this.aiStore) throw new Error('AI 模块尚未就绪')
    return this.aiStore.view()
  }

  setAiConfig(patch: AiConfigPatch): AiConfigView {
    if (!this.aiStore) throw new Error('AI 模块尚未就绪')
    const view = this.aiStore.patch(patch)
    // 超时改了要让下一次请求用上新值：客户端持有的 transport 是按超时构造的
    this.ai = createAiService({
      store: this.aiStore,
      client: createAiClient(createUndiciAiTransport(this.aiStore.config().timeoutMs)),
      emit: (chunk) => this.windows.push('push:aiChunk', chunk),
      buildUserMessage: (signalId) => this.aiUserMessage(signalId),
      history: this.aiHistorySink(),
      log: { info: (m) => log.info(m), warn: (m, e) => log.warn(m, e) },
    })
    return view
  }

  async testAi(): Promise<AiTestResult> {
    if (!this.ai) return { ok: false, message: 'AI 模块尚未就绪' }
    return this.ai.test()
  }

  explainWithAi(signalId: string, force = false): AiExplainStart {
    if (!this.ai) throw new Error('AI 模块尚未就绪')
    return this.ai.explain(signalId, force)
  }

  cancelAi(requestId: string): void {
    this.ai?.cancel(requestId)
  }

  /** 这只票的全部历史解读，新的在上。数据层没起来时给空数组，不抛错 */
  aiHistory(query: { code: SecCode; limit?: number }): AiExplainRecord[] {
    const rows = this.data?.storage.aiExplains.listByCode(query.code, query.limit ?? 100) ?? []
    return rows.map((row) => ({ ...row }))
  }

  /**
   * 用户手动删一条解读。**这是删除的唯一入口** —— `retention.ts` 一行都不碰这张表。
   *
   * 与 `removeWatchPoint` 同一条：删之前弹**系统模态框**。删掉的是花过钱的东西，
   * 而重新生成还要再花一次 —— 页面里一个二次点击挡不住误操作。
   * 返回 false = 用户取消，什么都没动。
   */
  async removeAiExplain(id: string): Promise<boolean> {
    const layer = this.requireData()
    const rows = layer.storage.aiExplains
    const target = rows.get(id)
    // 已经不在了：当成删成功，别为一个「本来就想让它消失」的东西弹错误
    if (!target) return true

    const confirmed = await confirmDestructive(this.windows.panelWindow.browserWindow, {
      title: '删除这条 AI 解读',
      message: `删掉 ${target.code} 在 ${new Date(target.createdAt).toLocaleString('zh-CN')} 那次解读？`,
      detail:
        '这一行会被直接删掉，找不回来。它是花过钱的 —— 想再看到同样的内容，' +
        '得对同一条信号重新生成一次，而那会再调用一次模型接口。',
      confirmLabel: '删除',
    })
    if (!confirmed) return false

    rows.remove(id)
    log.info(`[ai] 删除历史解读 ${id}`)
    return true
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
    // null = 一个校时样本都没取到，这时**不带这个字段** —— 带个 0 出去会被读成「已校准，偏差为零」
    if (status?.clock.offsetMs != null) base.clockOffsetMs = status.clock.offsetMs
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

  /** 主动取一次校时样本（休眠唤醒后）。数据层没起来时静默跳过 */
  async syncClock(): Promise<void> {
    await this.data?.syncClock()
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
    // 在跑的 AI 请求要断掉，否则 undici 的连接会把进程吊住几十秒
    this.ai?.dispose()
    this.ai = null
    // 先停调度再关库：反过来会让正在写库的那一轮 tick 撞上已关闭的连接
    this.data?.dispose()
    this.data = null
    this.alerts = null
    this.windows.destroyAll()
  }
}
