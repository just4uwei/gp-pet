/**
 * 常驻置顶的悬浮窗口 —— 零干扰契约 C1/C2/C3/C10 的落点（docs/06 §1、§2.1、§2.2）。
 *
 * 这个类里的每一处配置都对应一条硬性验收项，改动前先看 docs/06 §1：
 *   focusable: false        → C1 永不抢焦点（结构性保证，不是运行时小心翼翼）
 *   setIgnoreMouseEvents    → C2 非本体区域鼠标事件穿透
 *   skipTaskbar: true       → C3 不出现在任务栏与 Alt-Tab
 *   show: false + showInactive() → 首次出现也不得夺取焦点
 *
 * **只剩悬浮条这一种形态**（2026-08-13 起）：桌宠形态与整套皮肤系统已移除，
 * 于是这里不再有形态分支，尺寸与渲染入口都是常量。零干扰契约的落点一个没变 ——
 * 上面那四条以及拖拽增量、边缘吸附、多屏校验本来就与「窗口里画什么」无关。
 *
 * IPC 通道名仍是 `pet:*`（`pet:setInteractive`、`pet:dragBy`…）：改通道名要同步动
 * preload、ipc-types 与渲染入口，而没有任何功能收益。**通道名是历史，形态是现状。**
 */

import { BrowserWindow, screen } from 'electron'
import { hardenWindow, loadRoute, PRELOAD_PATH } from './load-route'
import { bottomRightOf, ensureVisible, snapToEdge, type Bounds } from '../util/geometry'

/**
 * 悬浮条的窗口尺寸。**窗口即本体**：没有留白，于是 C2 只剩四个圆角需要穿透
 * （见渲染层上报的命中区）。
 *
 * 300 是量出来的，不是拍的：一条要同时放下
 * 「状态点 + 名称 + 价格 + 涨跌 + 方向标注 + 信号条数」，240 会把最右边的方向标注裁掉半个字
 * —— 而在「减少动态效果」的系统上跑马灯不滚，那半个字就是**永久**裁掉的（2026-08-13 实测）。
 */
export const OVERLAY_SIZE = { width: 300, height: 38 }

/**
 * 光标离开轮询的间隔。**只在鼠标压着条子时才跑**，所以它不违反 C7（休市零开销）。
 * 250ms 是「跑马灯恢复得够快」与「别白转」之间的取舍 —— 人眼分辨不出这点延迟。
 */
const POINTER_POLL_MS = 250

/**
 * 收到最后一次 `dragBy` 之后多久才恢复光标轮询。
 * 比 `POINTER_POLL_MS` 大一档，保证一次拖拽里至少跳过一个轮询周期。
 */
const DRAG_GRACE_MS = 400

export class OverlayWindow {
  private readonly win: BrowserWindow
  /** 当前是否关闭了点击穿透。缓存一份避免每次 mousemove 都跨进程重复设置 */
  private interactive = false
  /** 光标离开的轮询句柄。非 null 即正在盯（见 watchPointer） */
  private pointerTimer: ReturnType<typeof setInterval> | null = null
  /** 这个时刻之前不做光标裁决 —— 拖拽期间窗口会短暂追不上光标（见 dragBy） */
  private draggingUntil = 0
  /** 主进程裁定「光标已离开」时回调，由装配层接到 `push:overlayPointer` 上 */
  onPointerOut?: () => void
  /** 标称尺寸（DIP）。每次移动都按它把宽高重申一遍，见 `moveTo` */
  private readonly size = OVERLAY_SIZE

  constructor() {
    const size = this.size
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
    loadRoute(this.win, 'bar')

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
   * **像素级**判定必须在渲染层做：主进程只知道窗口矩形，不知道四个圆角
   * （Electron 只有窗口级的 setIgnoreMouseEvents，没有像素级命中测试，docs/06 §2.2）。
   *
   * 但「离开」这件事渲染层判不准 —— 见 `watchPointer()`。
   */
  setInteractive(interactive: boolean): void {
    if (!this.alive || interactive === this.interactive) return
    this.interactive = interactive
    if (interactive) {
      this.win.setIgnoreMouseEvents(false)
      this.watchPointer()
    } else {
      this.win.setIgnoreMouseEvents(true, { forward: true })
      this.stopWatchingPointer()
      this.onPointerOut?.()
    }
  }

  /**
   * 光标离开的裁决者（2026-08-14 加）。
   *
   * ## 为什么渲染层判不了「离开」
   *
   * 命中判定跑在 `mousemove` 上，而**鼠标移出窗口之后就没有 mousemove 了** ——
   * 最后收到的那一次坐标仍然落在本体内。于是渲染层认为鼠标还在条子上。
   * `document` 上的 `mouseleave` 本来是兜底，但在这个
   * `focusable: false` + `setIgnoreMouseEvents` 的窗口上并不可靠。
   *
   * 后果有两个，一个显眼一个不显眼：
   *   * 显眼：「悬停暂停跑马灯」永久卡在暂停态，而条子是常驻的，用户没办法解掉；
   *   * 不显眼：窗口停在**可交互**状态，把下层应用那一小块的点击吃掉 —— **C2 被破**，
   *     而用户只会觉得「那个位置有时候点不动」。
   *
   * 所以改由主进程按**真实光标位置**裁决：只在 interactive 期间轮询（离开即停），
   * 一次比较两个数，代价可以忽略（C7 说的是休市零开销，而这只在鼠标压着条子时跑）。
   */
  private watchPointer(): void {
    if (this.pointerTimer !== null) return
    this.pointerTimer = setInterval(() => {
      if (!this.alive) return this.stopWatchingPointer()
      if (Date.now() < this.draggingUntil) return
      const cursor = screen.getCursorScreenPoint()
      const b = this.win.getBounds()
      const outside =
        cursor.x < b.x || cursor.x >= b.x + b.width || cursor.y < b.y || cursor.y >= b.y + b.height
      // 只管「离开」：进入与圆角那几个像素仍然归渲染层的命中判定
      if (outside) this.setInteractive(false)
    }, POINTER_POLL_MS)
    // 别让这个计时器拖住退出
    this.pointerTimer.unref?.()
  }

  private stopWatchingPointer(): void {
    if (this.pointerTimer === null) return
    clearInterval(this.pointerTimer)
    this.pointerTimer = null
  }

  /**
   * 只改位置，**但每次都把标称宽高一起写回**。
   *
   * 不能用 `setPosition`：在缩放比不是 100% 的显示器上（Windows 上 125% / 150% 是常态），
   * Electron 会把当前 bounds 在 DIP 与物理像素之间来回换算，两个方向都按「包住」
   * 取整（ScaleToEnclosingRect）—— 于是一次「只挪位置」的调用也可能把宽高各撑大 1px。
   * 一次拖拽会发出几百次 `dragBy`，条子因此越拖越大；而渲染层挂载时算出的命中区
   * 还是出厂的 300×38，盖不住撑大后的窗口，鼠标压在窗口上却判成穿透，
   * 表现就是「拖完之后点什么都没反应」。把宽高显式写回常量即可截断这个累积。
   */
  private moveTo(x: number, y: number): void {
    this.win.setBounds({ x: Math.round(x), y: Math.round(y), ...this.size })
  }

  /** 拖拽增量（屏幕像素）。渲染层用 screenX/screenY 求差，窗口跟着走也不会累积误差 */
  dragBy(dx: number, dy: number): void {
    if (!this.alive) return
    // 拖拽期间让光标轮询闭嘴：甩得快时窗口会短暂追不上光标，那一瞬间轮询会判成
    // 「离开」→ 关掉可交互 → 渲染层再也收不到 mouseup → 拖拽卡死在按下状态
    this.draggingUntil = Date.now() + DRAG_GRACE_MS
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

  /** C9：托盘菜单「隐藏悬浮条」后只保留托盘，功能不减 */
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
    // 先停轮询：窗口销毁后再触发一次会去读已销毁窗口的 bounds
    this.stopWatchingPointer()
    if (this.alive) this.win.destroy()
  }
}
