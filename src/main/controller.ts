/**
 * 应用编排：把窗口、托盘、皮肤、免打扰状态串起来（docs/02 §2）。
 *
 * 骨架阶段这里还没有 Scheduler / MarketData / Engine / AlertDispatcher，
 * 桌宠状态只由「是否免打扰」决定 —— 这是刻意的：M0 不允许出现任何假信号，
 * 免得把「界面动起来了」误当成「引擎跑起来了」。
 */

import { app } from 'electron'
import { join } from 'node:path'
import type { EngineStatus, PetSkinView, PetState, Rect } from '@shared/ipc-types'
import { log } from './logging'
import { resourcesRoot, resUrl } from './resources'
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

  constructor() {
    this.skin = this.loadSkin(DEFAULT_SKIN_ID)
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
    // 骨架阶段只有两态。OFFLINE / WATCHING / EXCITED / ALERT 由引擎与提醒层驱动（M2 / M3）
    return this.quiet ? 'SLEEPY' : 'IDLE'
  }

  engineStatus(): EngineStatus {
    return {
      session: 'CLOSED', // 交易时段状态机属 M1
      lastTickAt: 0,
      watchCount: 0,
      unreadAlerts: 0,
      doNotDisturb: this.quiet,
      offline: true, // 骨架阶段还没有数据源，如实报离线而不是假装在线
    }
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
    this.windows.destroyAll()
  }
}
