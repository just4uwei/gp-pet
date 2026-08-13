/**
 * 窗口生命周期与推送目标的唯一持有者（docs/02 §2）。
 *
 * Bubble 窗口属 M3（提醒层），此处暂不创建 —— 骨架阶段没有可提醒的内容，
 * 提前把空气泡窗口挂上去只会多一个常驻置顶窗口，与 C7「休市零开销」相悖。
 */

import { screen, type BrowserWindow } from 'electron'
import type { AppearanceForm, IpcPushMap } from '@shared/ipc-types'
import { broadcast } from '../ipc/router'
import { PanelWindow } from './PanelWindow'
import { OverlayWindow } from './OverlayWindow'

export class WindowManager {
  private overlay: OverlayWindow | null = null
  private readonly panel = new PanelWindow()
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
    this.panel.destroy()
  }
}
