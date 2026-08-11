/**
 * 极简色点、托盘图标、应用图标（docs/09 §6）。
 *
 * 托盘图标**按尺寸单独排布**（§6.2）：16×16 与 32×32 各画一版，
 * 取「最具辨识度的局部」= 猫头。绝不由全身图降采样 —— 像素画降采样必糊。
 * 48/64 由这两版整数倍最近邻放大得到：放大是无损的，被禁止的是缩小。
 */

import { Grid } from '../../lib/grid.mjs'
import { C, desaturate } from './palette.mjs'

/**
 * §6.1 极简模式色点：跨皮肤统一，帧序固定为
 * SLEEPY, IDLE, WATCHING, EXCITED, ALERT, OFFLINE（渲染层按 PetState 索引取帧）。
 */
const DOT_FRAMES = [
  { fill: C.offlineDark, stroke: C.dotSleepyStroke, marker: null },
  { fill: C.furLight, stroke: C.outline, marker: null },
  { fill: C.dotWatching, stroke: C.outline, marker: null },
  { fill: C.chanceGold, stroke: C.outline, marker: 'up' },
  { fill: C.riskAmber, stroke: C.outline, marker: 'down' },
  { fill: C.dotOffline, stroke: C.outline, marker: 'slash' },
]

export function minimalFrames() {
  return DOT_FRAMES.map(({ fill, stroke, marker }) => {
    const g = new Grid(32, 32)
    g.ellipse(15.5, 15.5, 14, 14, stroke)
    g.ellipse(15.5, 15.5, 12.6, 12.6, fill)

    // 形状标记是给色觉障碍用户的冗余线索（§6.1 与 §9.3 Q1）
    if (marker === 'up') {
      g.triangle([15.5, 9], [22, 20], [9, 20], stroke)
    } else if (marker === 'down') {
      g.triangle([15.5, 22], [22, 11], [9, 11], stroke)
    } else if (marker === 'slash') {
      g.line(9, 22, 22, 9, stroke)
      g.line(10, 22, 22, 10, stroke)
      g.line(9, 21, 21, 9, stroke)
    }
    return g
  })
}

/**
 * 16×16 猫头，**逐像素点阵**而非几何图元 + 自动描边。
 *
 * 为什么特殊对待：16 px 下椭圆与三角的栅格化会把耳朵压成两个方块缺口，
 * 描边算法还会在下巴底下留一个孤立的深色像素。这个尺寸没有近似的余地，
 * 只能一个像素一个像素排 —— 也正是 §6.2「必须在 16×16 上单独排布」的本意。
 *
 * 图例：# 描边 · B 主体毛色 · L 浅色口鼻 · P 内耳粉 · D 暗部（嘴）
 */
const HEAD_16 = [
  '................',
  '................',
  '....#......#....',
  '...#B#....#B#...',
  '..#BPB#..#BPB#..',
  '.#BBPBBBBBBPBB#.',
  '.#BBBBBBBBBBBB#.',
  '.#BB##BBBB##BB#.',
  '.#BB##BBBB##BB#.',
  '.#BBBBBPPBBBBB#.',
  '.#BBBLLLLLLBBB#.',
  '..#BLLLDDLLLB#..',
  '...#BBBBBBBB#...',
  '....########....',
  '................',
  '................',
]

const LEGEND = { '#': C.outline, B: C.furBase, L: C.furLight, P: C.nosePink, D: C.furDeep }

export function trayHead16() {
  const g = new Grid(16, 16)
  HEAD_16.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = LEGEND[row[x]]
      if (color !== undefined) g.set(x, y, color)
    }
  })
  return g
}

/** 32×32 猫头，同样原生排布而非把 16×16 放大 —— 32 下能多给出条纹与口鼻 */
export function trayHead32() {
  const g = new Grid(32, 32)
  g.triangle([4, 17], [8, 3], [16, 14], C.furBase)
  g.triangle([27, 17], [23, 3], [15, 14], C.furBase)
  g.ellipse(15.5, 19, 11.5, 9.5, C.furBase)
  g.triangle([7, 15], [9, 6], [14, 14], C.nosePink)
  g.triangle([24, 15], [22, 6], [17, 14], C.nosePink)
  for (const dx of [-3, 0, 3]) g.rect(15 + dx, 11, 1, 3, C.furDeep)
  g.ellipse(15.5, 22, 6, 4, C.furLight)
  g.ellipse(10.5, 17.5, 2.5, 3, C.outline)
  g.ellipse(20.5, 17.5, 2.5, 3, C.outline)
  g.set(10, 16, C.furLight)
  g.set(20, 16, C.furLight)
  g.triangle([14, 21], [17, 21], [15.5, 23], C.nosePink)
  g.line(15.5, 23, 15.5, 25, C.outline)
  g.line(15.5, 25, 13, 26, C.outline)
  g.line(15.5, 25, 18, 26, C.outline)
  g.outline(C.outline)
  return g
}

export function muted(grid) {
  return desaturate(grid.clone())
}
