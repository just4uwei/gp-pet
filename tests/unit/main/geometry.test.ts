import { describe, expect, it } from 'vitest'
import {
  bottomRightOf,
  ensureVisible,
  snapToEdge,
  SNAP_THRESHOLD_PX,
  type Bounds,
} from '@main/util/geometry'

const PET: Pick<Bounds, 'width' | 'height'> = { width: 220, height: 220 }

/** 主屏：1920×1080，底部 40px 任务栏 */
const PRIMARY: Bounds = { x: 0, y: 0, width: 1920, height: 1040 }
/** 左侧外接屏：坐标为负，这是 Windows 多显示器最常见的布局 */
const LEFT: Bounds = { x: -1920, y: 0, width: 1920, height: 1080 }

describe('snapToEdge', () => {
  it('阈值内吸附到边缘', () => {
    const win = { x: 12, y: 500, ...PET }
    expect(snapToEdge(win, PRIMARY)).toEqual({ x: 0, y: 500 })
  })

  it('阈值外原地不动', () => {
    const win = { x: SNAP_THRESHOLD_PX + 1, y: 500, ...PET }
    expect(snapToEdge(win, PRIMARY)).toEqual({ x: SNAP_THRESHOLD_PX + 1, y: 500 })
  })

  it('右下角两个轴同时吸附，且贴的是工作区而非屏幕（不被任务栏盖住）', () => {
    const win = { x: 1920 - 220 - 5, y: 1040 - 220 - 5, ...PET }
    expect(snapToEdge(win, PRIMARY)).toEqual({ x: 1700, y: 820 })
  })

  it('负坐标的副屏同样成立', () => {
    const win = { x: -1920 + 8, y: 8, ...PET }
    expect(snapToEdge(win, LEFT)).toEqual({ x: -1920, y: 0 })
  })

  it('两边同时落在阈值内时取更近的一侧，不来回横跳', () => {
    // 工作区比窗口宽不了多少的极端情形（例如缩到很窄的分屏）
    const narrow: Bounds = { x: 0, y: 0, width: 240, height: 1040 }
    expect(snapToEdge({ x: 4, y: 500, ...PET }, narrow).x).toBe(0)
    expect(snapToEdge({ x: 16, y: 500, ...PET }, narrow).x).toBe(20)
  })
})

describe('ensureVisible', () => {
  it('中心点在某个工作区内则保持不动', () => {
    const win = { x: 800, y: 400, ...PET }
    expect(ensureVisible(win, [PRIMARY, LEFT], PRIMARY)).toEqual({ x: 800, y: 400 })
  })

  it('副屏被拔掉后回落到主屏右下角', () => {
    const onDetached = { x: -1500, y: 300, ...PET }
    expect(ensureVisible(onDetached, [PRIMARY], PRIMARY)).toEqual(bottomRightOf(PRIMARY, PET))
  })

  it('分辨率调小后越界的位置同样被回收', () => {
    const shrunk: Bounds = { x: 0, y: 0, width: 1280, height: 680 }
    const win = { x: 1700, y: 820, ...PET }
    expect(ensureVisible(win, [shrunk], shrunk)).toEqual(bottomRightOf(shrunk, PET))
  })

  it('只露出一角等同于不可见 —— 中心点判据不留模糊地带', () => {
    const barelyVisible = { x: 1920 - 20, y: 500, ...PET }
    expect(ensureVisible(barelyVisible, [PRIMARY], PRIMARY)).toEqual(bottomRightOf(PRIMARY, PET))
  })
})

describe('bottomRightOf', () => {
  it('留出默认边距，且贴的是工作区', () => {
    expect(bottomRightOf(PRIMARY, PET)).toEqual({ x: 1920 - 220 - 24, y: 1040 - 220 - 24 })
  })
})
