/**
 * 常驻置顶的悬浮窗口 —— 零干扰契约 C1/C2/C3/C10 的落点（docs/06 §1、§2.1、§2.2）。
 *
 * 这个类里的每一处配置都对应一条硬性验收项，改动前先看 docs/06 §1：
 *   focusable: false        → C1 永不抢焦点（结构性保证，不是运行时小心翼翼）
 *   setIgnoreMouseEvents    → C2 非本体区域鼠标事件穿透
 *   skipTaskbar: true       → C3 不出现在任务栏与 Alt-Tab
 *   show: false + showInactive() → 首次出现也不得夺取焦点
 *
 * **两种形态共用这一个类**（2026-08-13）：出厂默认是「悬浮条」（`BAR`），
 * 桌宠（`PET`）退为可切换形态。形态之间**只差窗口尺寸与渲染入口** ——
 * 上面那四条以及拖拽增量、边缘吸附、多屏校验全部与「窗口里画什么」无关，
 * 所以换形态不需要重新实现、也不需要重新论证零干扰契约。
 *
 * IPC 通道名仍是 `pet:*`（`pet:setInteractive`、`pet:dragBy`…）：改通道名要同步动
 * preload、ipc-types 与两个渲染入口，而没有任何功能收益。**通道名是历史,形态是现状。**
 */

import { BrowserWindow, screen } from 'electron'
import type { AppearanceForm } from '@shared/ipc-types'
import { hardenWindow, loadRoute, PRELOAD_PATH, type RendererRoute } from './load-route'
import { bottomRightOf, ensureVisible, snapToEdge, type Bounds } from '../util/geometry'

/**
 * 各形态的窗口尺寸。
 *
 * `PET` 的 220 比皮肤 canvas（200）大一圈，给道具与跃起留余量（docs/09 §2.2）。
 * `BAR` 则是**窗口即本体**：没有留白，于是 C2 只剩四个圆角需要穿透（见渲染层上报的命中区）。
 */
export const OVERLAY_SIZE: Record<AppearanceForm, { width: number; height: number }> = {
  PET: { width: 220, height: 220 },
  BAR: { width: 240, height: 38 },
}

const ROUTE: Record<AppearanceForm, RendererRoute> = { PET: 'pet', BAR: 'bar' }

export class OverlayWindow {
  private readonly win: BrowserWindow
  /** 当前是否关闭了点击穿透。缓存一份避免每次 mousemove 都跨进程重复设置 */
  private interactive = false
  /** 形态的标称尺寸（DIP）。每次移动都按它把宽高重申一遍，见 `moveTo` */
  private readonly size: { width: number; height: number }

  constructor(readonly form: AppearanceForm) {
    const size = OVERLAY_SIZE[form]
    this.size = size
    const primary = screen.getPrimaryDisplay()
    const origin = bottomRightOf(primary.workArea, size)

    this.win = new BrowserWindow({
      ...size,
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
    loadRoute(this.win, ROUTE[form])

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
   * 判定在渲染层做是因为主进程拿不到「鼠标是否压在本体上」这个信息 ——
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

  /**
   * 只改位置，**但每次都把标称宽高一起写回**。
   *
   * 不能用 `setPosition`：在缩放比不是 100% 的显示器上（Windows 上 125% / 150% 是常态），
   * Electron 会把当前 bounds 在 DIP 与物理像素之间来回换算，两个方向都按「包住」
   * 取整（ScaleToEnclosingRect）—— 于是一次「只挪位置」的调用也可能把宽高各撑大 1px。
   * 一次拖拽会发出几百次 `dragBy`，条子因此越拖越大；而渲染层挂载时算出的命中区
   * 还是 240×38，盖不住撑大后的窗口，鼠标压在窗口上却判成穿透，
   * 表现就是「拖完之后点什么都没反应」。把宽高显式写回常量即可截断这个累积。
   */
  private moveTo(x: number, y: number): void {
    this.win.setBounds({ x: Math.round(x), y: Math.round(y), ...this.size })
  }

  /** 拖拽增量（屏幕像素）。渲染层用 screenX/screenY 求差，窗口跟着走也不会累积误差 */
  dragBy(dx: number, dy: number): void {
    if (!this.alive) return
    const [x, y] = this.win.getPosition()
    this.moveTo((x ?? 0) + dx, (y ?? 0) + dy)
  }

  /** 松手：边缘吸附 + 越界回收（docs/06 §4） */
  dragEnd(): void {
    if (!this.alive) return
    // 宽高取标称值而非 getBounds()：万一之前已经被撑大过，吸附不该照着那个坏尺寸算
    const [x, y] = this.win.getPosition()
    const bounds: Bounds = { x: x ?? 0, y: y ?? 0, ...this.size }
    const nearest = screen.getDisplayMatching(bounds)
    const snapped = snapToEdge(bounds, nearest.workArea)
    const visible = ensureVisible(
      { ...bounds, ...snapped },
      screen.getAllDisplays().map((d) => d.workArea),
      screen.getPrimaryDisplay().workArea
    )
    this.moveTo(visible.x, visible.y)
  }

  /** 显示器拓扑变化后重新校验位置（拔插外接屏、改分辨率） */
  revalidatePosition(): void {
    this.dragEnd()
  }

  /** C9：托盘菜单「隐藏」后只保留托盘，功能不减 */
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
