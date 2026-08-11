/**
 * 矩形命中判定 —— 点击穿透（docs/06 C2）的判据。
 *
 * 放在 shared 而非 renderer，是因为主进程在验收脚本与测试里也要用同一份判据；
 * 这里必须是纯函数，不得引入任何运行时依赖。
 *
 * 精度取舍见 docs/06 §2.2：首版用矩形近似，皮肤系统预留 alpha 掩码（方案 2）的接口。
 * 命中区宁可少覆盖也不要多覆盖 —— 多覆盖会吞掉本该穿透的点击，而 C2 是底线。
 */

import type { Rect } from './ipc-types'

/**
 * 判断窗口内坐标 (x, y) 是否落在任一命中区内。
 *
 * @param rects  命中区，坐标相对皮肤 canvas 左上角
 * @param x      窗口内 CSS 像素坐标
 * @param y      窗口内 CSS 像素坐标
 * @param offsetX canvas 在窗口内的左上角偏移（窗口通常比 canvas 大，见 docs/06 §2.1：窗口 220、canvas 200）
 * @param offsetY 同上
 */
export function hitTest(
  rects: readonly Rect[],
  x: number,
  y: number,
  offsetX = 0,
  offsetY = 0
): boolean {
  const cx = x - offsetX
  const cy = y - offsetY
  for (const r of rects) {
    if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) return true
  }
  return false
}
