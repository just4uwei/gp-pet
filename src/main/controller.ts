/**
 * 应用编排：把窗口、托盘、皮肤、免打扰状态、数据层串起来（docs/02 §2）。
 *
 * M1：数据层（Scheduler / MarketData / Registry）已接入，Engine 与 AlertDispatcher 仍未实现。
 * 因此桌宠状态只由「免打扰 / 是否开市 / 数据源是否全挂」决定，绝不出现 EXCITED / ALERT
 * —— 那两态必须由真实信号驱动（M2/M3），提前点亮就是假信号。
 */

import { app } from 'electron'
import { join } from 'node:path'
import type {
  AppSettings,
  EngineStatus,
  PetSkinView,
  PetState,
  ProviderHealth,
  Rect,
  WatchItem,
} from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import type { DataLayer } from './data-layer'
import { log } from './logging'
import { resourcesRoot, resUrl } from './resources'
import { DEFAULT_SETTINGS } from './settings/schema'
import { loadSkin, type SkinSource } from './skin/loader'
import { isQuiet, quietUntil, type QuietPreset } from './util/quiet'
import { WindowManager } from './windows/WindowManager'

/**
 * 出厂皮肤目录名。真正的取值来自 AppSettings.skin，而 SettingsStore 属 M1 —— 在此之前用常量。
 *
 * 美术资源是外包件，不在仓库里手搓（CLAUDE.md）—— 所以 resources/pet/default/ 眼下是空目录，
 * 启动会一路回退到内置占位皮肤。这条回退路径是常态而非异常，必须保持可用。
 * 交付方把 28 个文件（docs/09 §8）放进 resources/pet/default/ 即可自动生效，不需要改代码。
 */
const DEFAULT_SKIN_ID = 'default'

export class AppController {
  private readonly windows = new WindowManager()
  private skin: PetSkinView
  private quietUntilAt: number | null = null
  /** 渲染层上报的命中区，仅用于诊断；真正的判定在渲染层完成（docs/06 §2.2） */
  private reportedHitRects: Rect[] = []
  private data: DataLayer | null = null

  constructor() {
    this.skin = this.loadSkin(DEFAULT_SKIN_ID)
  }

  /**
   * 接入数据层。装配是异步的（要开库、要初始化 undici），所以不放构造函数里
   * —— 窗口与托盘必须先起来：数据层装配失败时用户至少还能看到桌宠和托盘菜单。
   */
  attachDataLayer(layer: DataLayer): void {
    this.data = layer
    // 皮肤取值这时才有设置可依（此前用常量），换皮肤要重载一次
    const skinId = layer.settings.get().skin
    if (skinId && skinId !== this.skin.id) this.skin = this.loadSkin(skinId)
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

  setPosition(code: SecCode, shares: number, cost: number): void {
    this.requireData().storage.positions.set(code, shares, cost, Date.now())
  }

  clearPosition(code: SecCode): void {
    this.requireData().storage.positions.clear(code)
  }

  getSettings(): AppSettings {
    return this.data?.settings.get() ?? this.fallbackSettings()
  }

  patchSettings(patch: Partial<AppSettings>): AppSettings {
    const layer = this.requireData()
    const next = layer.settings.patch(patch)
    layer.applySettings(next)
    if (next.skin !== this.skin.id) {
      this.skin = this.loadSkin(next.skin)
      // 皮肤换了要让渲染层重取：pet:getSkin 是 invoke，只能靠状态推送触发它再问一次
      this.windows.push('push:petState', this.petState)
    }
    this.onStateChanged()
    return next
  }

  providerHealth(): ProviderHealth[] {
    return this.data?.health() ?? []
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

  private requireData(): DataLayer {
    if (!this.data) throw new Error('数据层尚未就绪，请稍后重试')
    return this.data
  }

  private fallbackSettings(): AppSettings {
    // 数据层没起来时不该让设置面板整个报错，返回默认值先把界面画出来。
    // 但**不允许**写入 —— patchSettings 走 requireData() 会明确抛错，
    // 免得用户改了设置以为存下了
    return { ...DEFAULT_SETTINGS, skin: this.skin.id }
  }

  private loadSkin(id: string): PetSkinView {
    // M4 再加入用户皮肤源（%APPDATA%/gp-pet/skins，同名覆盖内置，见 docs/06 §5）。
    // 那需要给 res:// 增加第二个 host，因为用户目录不在 resources/ 内。
    const sources: SkinSource[] = [
      { dir: join(resourcesRoot(), 'pet', id), urlBase: resUrl(`pet/${id}`) },
    ]
    // 校验失败只写日志 + 面板提示，不弹窗（docs/06 §5）
    return loadSkin(id, sources, (reason) => log.warn('[skin]', reason))
  }

  get currentSkin(): PetSkinView {
    return this.skin
  }

  start(): void {
    this.windows.createPet()
    this.pushPetState()
  }

  // ── 窗口 ──────────────────────────────────────────────────────────

  togglePanel(): void {
    this.windows.panelWindow.toggle()
  }

  showPanel(): void {
    this.windows.panelWindow.show()
  }

  get petVisible(): boolean {
    return this.windows.petWindow?.isVisible() ?? false
  }

  /** C9：隐藏桌宠后只保留托盘，功能不减 */
  setPetVisible(visible: boolean): void {
    this.windows.petWindow?.setVisible(visible)
    this.onStateChanged()
  }

  setPetInteractive(interactive: boolean): void {
    this.windows.petWindow?.setInteractive(interactive)
  }

  dragPetBy(dx: number, dy: number): void {
    this.windows.petWindow?.dragBy(dx, dy)
  }

  endPetDrag(): void {
    this.windows.petWindow?.dragEnd()
  }

  setHitRects(rects: Rect[]): void {
    this.reportedHitRects = rects
  }

  get hitRects(): Rect[] {
    return this.reportedHitRects
  }

  // ── 免打扰 ────────────────────────────────────────────────────────

  get quiet(): boolean {
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

  /** C8：双击桌宠一键静默/解除 */
  toggleQuiet(): number | null {
    this.setQuietUntil(this.quiet ? null : quietUntil(Date.now(), 'untilClose'))
    return this.quietUntilAt
  }

  // ── 状态推送 ──────────────────────────────────────────────────────

  private get petState(): PetState {
    // 优先级见 docs/06 §3：OFFLINE > … > IDLE > SLEEPY。
    // WATCHING / EXCITED / ALERT 由真实信号驱动（M2 / M3），M1 一律不点亮。
    const status = this.data?.status()
    if (status?.offline === true) return 'OFFLINE'
    if (this.quiet) return 'SLEEPY'
    if (!status) return 'IDLE'
    return status.session === 'CLOSED' || status.session === 'LUNCH_BREAK' ? 'SLEEPY' : 'IDLE'
  }

  engineStatus(): EngineStatus {
    const status = this.data?.status()
    const base: EngineStatus = {
      session: status?.session ?? 'CLOSED',
      lastTickAt: status?.lastTickAt ?? 0,
      watchCount: status?.watchCount ?? 0,
      // 提醒层属 M3，未读数暂时如实为 0，而不是编一个数字
      unreadAlerts: 0,
      doNotDisturb: this.quiet,
      // 数据层还没起来时如实报离线，不假装在线
      offline: status?.offline ?? true,
    }
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

  revalidatePetPosition(): void {
    this.windows.petWindow?.revalidatePosition()
  }

  quit(): void {
    app.quit()
  }

  /** 由 before-quit 调用。与 quit() 分开，是为了让 OS 关机等非菜单路径也能走到清理 */
  dispose(): void {
    // 先停调度再关库：反过来会让正在写库的那一轮 tick 撞上已关闭的连接
    this.data?.dispose()
    this.data = null
    this.windows.destroyAll()
  }
}
