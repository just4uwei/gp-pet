/**
 * 桌宠窗口 —— 零干扰契约 C1/C2/C3/C10 的落点（docs/06 §1、§2.1、§2.2）。
 *
 * 这个类里的每一处配置都对应一条硬性验收项，改动前先看 docs/06 §1：
 *   focusable: false        → C1 永不抢焦点（结构性保证，不是运行时小心翼翼）
 *   setIgnoreMouseEvents    → C2 非本体区域鼠标事件穿透
 *   skipTaskbar: true       → C3 不出现在任务栏与 Alt-Tab
 *   show: false + showInactive() → 首次出现也不得夺取焦点
 */

import { BrowserWindow, screen } from 'electron'
import { hardenWindow, loadRoute, PRELOAD_PATH } from './load-route'
import { bottomRightOf, ensureVisible, snapToEdge, type Bounds } from '../util/geometry'

/** docs/06 §2.1。比皮肤 canvas（200）大一圈，给道具与跃起留余量（docs/09 §2.2） */
export const PET_WINDOW_SIZE = { width: 220, height: 220 } as const

export class PetWindow {
  private readonly win: BrowserWindow
  /** 当前是否关闭了点击穿透。缓存一份避免每次 mousemove 都跨进程重复设置 */
  private interactive = false

  constructor() {
    const primary = screen.getPrimaryDisplay()
    const origin = bottomRightOf(primary.workArea, PET_WINDOW_SIZE)

    this.win = new BrowserWindow({
      ...PET_WINDOW_SIZE,
      x: origin.x,
      y: origin.y,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false, // ← C1 的根本保证，不得改动
      hasShadow: false,
      show: false, // 就绪后用 showInactive()
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 'screen-saver' 层级：高于普通置顶窗口，但仍低于全屏独占应用（docs/06 §2.1）
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.setVisibleOnAllWorkspaces(true)

    // 默认穿透。forward: true 让窗口仍能收到 mousemove 用于命中判定（docs/06 §2.2）
    this.win.setIgnoreMouseEvents(true, { forward: true })

    hardenWindow(this.win)
    loadRoute(this.win, 'pet')

    this.win.once('ready-to-show', () => {
      // 必须是 showInactive：show() 会抢焦点，直接违反 C1
      this.win.showInactive()
    })
  }

  get browserWindow(): BrowserWindow {
    return this.win
  }

  private get alive(): boolean {
    return !this.win.isDestroyed()
  }

  /**
   * 渲染层完成命中判定后调用。
   * 判定在渲染层做是因为主进程拿不到「鼠标是否压在桌宠本体上」这个信息 ——
   * Electron 只有窗口级的 setIgnoreMouseEvents，没有像素级命中测试（docs/06 §2.2）。
   */
  setInteractive(interactive: boolean): void {
    if (!this.alive || interactive === this.interactive) return
    this.interactive = interactive
    if (interactive) {
      this.win.setIgnoreMouseEvents(false)
    } else {
      this.win.setIgnoreMouseEvents(true, { forward: true })
    }
  }

  /** 拖拽增量（屏幕像素）。渲染层用 screenX/screenY 求差，窗口跟着走也不会累积误差 */
  dragBy(dx: number, dy: number): void {
    if (!this.alive) return
    const [x, y] = this.win.getPosition()
    this.win.setPosition(Math.round((x ?? 0) + dx), Math.round((y ?? 0) + dy))
  }

  /** 松手：边缘吸附 + 越界回收（docs/06 §4） */
  dragEnd(): void {
    if (!this.alive) return
    const bounds: Bounds = this.win.getBounds()
    const nearest = screen.getDisplayMatching(bounds)
    const snapped = snapToEdge(bounds, nearest.workArea)
    const visible = ensureVisible(
      { ...bounds, ...snapped },
      screen.getAllDisplays().map((d) => d.workArea),
      screen.getPrimaryDisplay().workArea
    )
    this.win.setPosition(visible.x, visible.y)
  }

  /** 显示器拓扑变化后重新校验位置（拔插外接屏、改分辨率） */
  revalidatePosition(): void {
    this.dragEnd()
  }

  /** C9：托盘菜单「隐藏桌宠」后只保留托盘，功能不减 */
  setVisible(visible: boolean): void {
    if (!this.alive) return
    if (visible) {
      this.win.showInactive()
    } else {
      this.win.hide()
    }
  }

  isVisible(): boolean {
    return this.alive && this.win.isVisible()
  }

  destroy(): void {
    if (this.alive) this.win.destroy()
  }
}
