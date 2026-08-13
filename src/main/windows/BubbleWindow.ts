/**
 * 气泡窗口（docs/06 §2.3、C1/C2/C5/C6）。
 *
 * 与 Overlay 同一套零干扰配置，外加**两条只属于气泡的硬约束**：
 *
 * 1. **完全不可点击**：`setIgnoreMouseEvents(true)` 常开，而且 `forward: false` ——
 *    气泡不需要命中判定，连 mousemove 都不必收。可点击的气泡会诱使用户去关它，
 *    那本身就是打断（docs/06 §2.3）。要看详情请点悬浮条打开面板。
 * 2. **自己会消失**（C6）：`AUTO_HIDE_MS` 后淡出，不需要任何用户操作。
 *    新气泡会替换旧的并重置计时，不排队 —— 排队意味着用户要看着一串过时的提醒轮播。
 *
 * **懒加载**：第一条 L2 提醒到来时才创建。休市时一个提醒都没有，
 * 提前挂一个空的常驻置顶窗口只会白占 C7 的开销预算。
 */

import { BrowserWindow, screen } from 'electron'
import type { AlertPayload } from '@shared/ipc-types'
import { push } from '../ipc/router'
import { anchorAbove, bottomRightOf, type Bounds } from '../util/geometry'
import { hardenWindow, loadRoute, PRELOAD_PATH } from './load-route'

export const BUBBLE_SIZE = { width: 300, height: 116 }

/** C6：6s 后自动淡出。渲染层的淡出动画时长包含在内，这里多给一点余量再 hide */
export const AUTO_HIDE_MS = 6_000
const FADE_OUT_MS = 260

export class BubbleWindow {
  private win: BrowserWindow | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private ready = false
  /** 窗口还没 ready-to-show 时先存着，就绪后立刻补发 —— 首条提醒不该因为懒加载而丢 */
  private pending: AlertPayload | null = null

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const win = new BrowserWindow({
      ...BUBBLE_SIZE,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false, // ← C1，与 Overlay 同一条底线
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true)
    // forward: false —— 气泡不做命中判定，鼠标事件一律穿透（docs/06 §2.3）
    win.setIgnoreMouseEvents(true)

    hardenWindow(win)
    loadRoute(win, 'bubble')

    win.once('ready-to-show', () => {
      this.ready = true
      const pending = this.pending
      this.pending = null
      if (pending) this.show(pending, this.lastAnchor)
    })

    this.win = win
    this.ready = false
    return win
  }

  private lastAnchor: Bounds | null = null

  /**
   * 显示一条提醒。
   * @param anchor 悬浮窗口的位置；null 时落在主屏右下角（悬浮窗口被隐藏时仍要能弹）
   */
  show(payload: AlertPayload, anchor: Bounds | null): void {
    this.lastAnchor = anchor
    const win = this.ensure()
    if (!this.ready) {
      this.pending = payload
      return
    }

    this.place(win, anchor)
    push(win, 'push:alert', payload)
    // showInactive 而非 show：抢焦点会直接违反 C1
    if (!win.isVisible()) win.showInactive()

    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => this.hide(), AUTO_HIDE_MS + FADE_OUT_MS)
  }

  private place(win: BrowserWindow, anchor: Bounds | null): void {
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()
    const work = display.workArea
    const origin = anchor ? anchorAbove(anchor, BUBBLE_SIZE, work) : bottomRightOf(work, BUBBLE_SIZE)
    win.setPosition(Math.round(origin.x), Math.round(origin.y))
  }

  hide(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (this.win && !this.win.isDestroyed()) this.win.hide()
  }

  get browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  /** C10：退出前销毁，不留残影置顶窗口 */
  destroy(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = false
    this.pending = null
  }
}
