import { describe, expect, it } from 'vitest'
import { hitTest } from '@shared/hit-test'
import type { Rect } from '@shared/ipc-types'

/**
 * 命中判定是 C2「非本体区域鼠标事件穿透」的唯一判据（docs/06 §1、§2.2）。
 * 判错的方向不对称：
 *   漏判（本体被判成透明）→ 桌宠点不动，用户能立刻发现并重试
 *   误判（透明区被判成本体）→ 悄悄吃掉下层应用的点击，用户不知道点击去哪了
 * 所以这里对「边界外侧」的用例比「边界内侧」更严。
 */
describe('hitTest', () => {
  const rects: Rect[] = [
    { x: 86, y: 14, w: 28, h: 30 }, // 头
    { x: 80, y: 44, w: 40, h: 76 }, // 躯干
  ]

  it('落在任一矩形内即命中', () => {
    expect(hitTest(rects, 100, 20)).toBe(true)
    expect(hitTest(rects, 100, 80)).toBe(true)
  })

  it('矩形之外一律不命中', () => {
    expect(hitTest(rects, 0, 0)).toBe(false)
    expect(hitTest(rects, 199, 199)).toBe(false)
    // 两个矩形横向不同宽，头部左侧外缘在躯干范围内 —— 这一带最容易写错
    expect(hitTest(rects, 82, 20)).toBe(false)
    expect(hitTest(rects, 82, 60)).toBe(true)
  })

  it('左上边界含、右下边界不含，相邻矩形不会重复计入', () => {
    expect(hitTest(rects, 86, 14)).toBe(true) // 左上角在内
    expect(hitTest(rects, 114, 14)).toBe(false) // x = x+w 在外
    expect(hitTest(rects, 100, 44)).toBe(true) // 头部 y = y+h 在外，但躯干在这里接住
    expect(hitTest(rects, 120, 44)).toBe(false) // 两个矩形的右外侧都不含
  })

  it('按 canvas 在窗口内的偏移平移判定', () => {
    // 窗口 220、canvas 200 → 偏移 10（docs/06 §2.1）
    expect(hitTest(rects, 100, 20, 10, 10)).toBe(false)
    expect(hitTest(rects, 110, 30, 10, 10)).toBe(true)
  })

  it('空命中区一律穿透', () => {
    expect(hitTest([], 100, 100)).toBe(false)
  })

  it('零面积矩形不命中，不会因浮点比较意外吃掉一个点', () => {
    expect(hitTest([{ x: 10, y: 10, w: 0, h: 0 }], 10, 10)).toBe(false)
  })
})
