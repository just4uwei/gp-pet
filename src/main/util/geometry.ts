/**
 * 桌宠窗口的位置计算 —— 纯函数，不碰 Electron。
 *
 * 抽出来的理由：多显示器与 DPI 是最容易「在我机器上是对的」的一类逻辑，
 * 而 screen API 无法在单元测试里构造。把判据做成纯函数，用例就能覆盖拔插外接屏、
 * 分辨率变化、工作区被任务栏挤压这些真实场景（docs/06 §4）。
 */

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** docs/06 §4：松手时若靠近屏幕边缘（< 30px）则吸附 */
export const SNAP_THRESHOLD_PX = 30

/** 桌宠距屏幕边缘的默认留白 */
export const DEFAULT_MARGIN_PX = 24

/**
 * 边缘吸附。四条边各自独立判定 —— 落在角上时两个轴都会吸附。
 * @param work 该显示器的工作区（已扣除任务栏）
 */
export function snapToEdge(
  win: Bounds,
  work: Bounds,
  threshold: number = SNAP_THRESHOLD_PX
): { x: number; y: number } {
  const leftGap = win.x - work.x
  const rightGap = work.x + work.width - (win.x + win.width)
  const topGap = win.y - work.y
  const bottomGap = work.y + work.height - (win.y + win.height)

  let x = win.x
  let y = win.y

  // 左右取更近的一侧，避免窗口比工作区还宽时两边同时命中而反复横跳
  if (leftGap < threshold || rightGap < threshold) {
    x = leftGap <= rightGap ? work.x : work.x + work.width - win.width
  }
  if (topGap < threshold || bottomGap < threshold) {
    y = topGap <= bottomGap ? work.y : work.y + work.height - win.height
  }

  return { x, y }
}

function centerOf(b: Bounds): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

function contains(b: Bounds, p: { x: number; y: number }): boolean {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
}

/** 主屏右下角。显示器拓扑变化导致坐标失效时的落点（docs/06 §4） */
export function bottomRightOf(work: Bounds, size: { width: number; height: number }, margin = DEFAULT_MARGIN_PX): { x: number; y: number } {
  return {
    x: work.x + work.width - size.width - margin,
    y: work.y + work.height - size.height - margin,
  }
}

/**
 * 校验存储的位置在当前显示器拓扑下是否仍可见；越界则回落到主屏右下角。
 *
 * 判据取「窗口中心点落在某个工作区内」而非「有任意重叠」：
 * 只露出一角的桌宠等同于不可见，但用重叠面积做判据会引入一个需要标定的阈值 ——
 * 中心点判据没有可调参数，行为可预测。
 */
export function ensureVisible(
  win: Bounds,
  workAreas: readonly Bounds[],
  primaryWork: Bounds,
  margin = DEFAULT_MARGIN_PX
): { x: number; y: number } {
  const center = centerOf(win)
  for (const area of workAreas) {
    if (contains(area, center)) return { x: win.x, y: win.y }
  }
  return bottomRightOf(primaryWork, win, margin)
}
