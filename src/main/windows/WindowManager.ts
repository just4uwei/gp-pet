/**
 * 窗口生命周期与推送目标的唯一持有者（docs/02 §2）。
 *
 * Bubble 窗口**懒加载**：第一条 L2 提醒到来时才创建（见 BubbleWindow）。
 * 休市时一个提醒都没有，提前挂一个空的常驻置顶窗口只会白占 C7 的开销预算。
 */

import { screen, type BrowserWindow } from 'electron'
import type { AlertPayload, AppearanceForm, IpcPushMap } from '@shared/ipc-types'
import { broadcast } from '../ipc/router'
import { BubbleWindow } from './BubbleWindow'
import { PanelWindow } from './PanelWindow'
import { OverlayWindow } from './OverlayWindow'

export class WindowManager {
  private overlay: OverlayWindow | null = null
  private readonly panel = new PanelWindow()
  private readonly bubble = new BubbleWindow()
  private onDisplayChange: (() => void) | null = null

  createOverlay(form: AppearanceForm): OverlayWindow {
    if (!this.overlay) {
      this.overlay = new OverlayWindow(form)
      if (!this.onDisplayChange) {
        this.onDisplayChange = () => this.overlay?.revalidatePosition()
        // 拔插外接屏 / 改分辨率后，存下来的坐标可能落在不存在的区域（docs/06 §4）
        screen.on('display-added', this.onDisplayChange)
        screen.on('display-removed', this.onDisplayChange)
        screen.on('display-metrics-changed', this.onDisplayChange)
      }
    }
    return this.overlay
  }

  /**
   * 切换形态：销毁旧窗口、按新形态重建。
   *
   * 不复用同一个 BrowserWindow 去 `setSize` + `loadURL`：两种形态的尺寸差 6 倍，
   * 而且换渲染入口要重走一遍 preload 与 CSP —— 重建比原地改干净，
   * 代价只是位置回到右下角（形态都换了，位置重置是可以接受的）。
   * 显示器监听不重注册（回调只认 `this.overlay`，重建后自动指向新窗口）。
   */
  setOverlayForm(form: AppearanceForm): OverlayWindow {
    if (this.overlay?.form === form) return this.overlay
    const wasHidden = this.overlay !== null && !this.overlay.isVisible()
    this.overlay?.destroy()
    this.overlay = null
    const next = this.createOverlay(form)
    // C9：切形态不该把用户手动隐藏的窗口重新弹出来
    if (wasHidden) next.setVisible(false)
    return next
  }

  get overlayWindow(): OverlayWindow | null {
    return this.overlay
  }

  get panelWindow(): PanelWindow {
    return this.panel
  }

  /**
   * 弹一个气泡（L2+）。锚点取悬浮窗口当前位置 ——
   * 用户把条子拖到哪，气泡就跟到哪；条子被隐藏（C9）时退到主屏右下角，仍然要弹。
   */
  showBubble(payload: AlertPayload): void {
    const anchor = this.overlay?.isVisible() === true ? this.overlay.browserWindow.getBounds() : null
    this.bubble.show(payload, anchor)
  }

  hideBubble(): void {
    this.bubble.hide()
  }

  private get targets(): (BrowserWindow | null)[] {
    return [this.overlay?.browserWindow ?? null, this.panel.browserWindow]
  }

  push<K extends keyof IpcPushMap>(channel: K, payload: IpcPushMap[K]): void {
    broadcast(this.targets, channel, payload)
  }

  /** C10：进程退出前主动销毁，不留残影置顶窗口 */
  destroyAll(): void {
    if (this.onDisplayChange) {
      screen.off('display-added', this.onDisplayChange)
      screen.off('display-removed', this.onDisplayChange)
      screen.off('display-metrics-changed', this.onDisplayChange)
      this.onDisplayChange = null
    }
    this.overlay?.destroy()
    this.overlay = null
    this.bubble.destroy()
    this.panel.destroy()
  }
}
