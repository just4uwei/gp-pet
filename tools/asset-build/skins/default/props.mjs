/**
 * 提示元素与脱离主体的符号。
 *
 * 两类东西的画法不同，区别来自 docs/09：
 *   - **道具**（机会星芒、风险小旗）在描边之前画，跟主体共用同一个深色描边，读起来属于同一个形象
 *   - **符号**（睡意 Z、无信号图标）在描边之后画，自带**浅色外圈** ——
 *     §4.7/§4.8 明确要求：深色壁纸上纯深色小图标会整块消失
 *
 * §7.1 的红线在这里：不得出现涨跌箭头、K 线、收益曲线、百分比、数字、货币符号。
 * 所以「机会」用星芒、「风险」用小旗，都是氛围隐喻，不承诺任何方向或收益。
 */

import { Grid } from '../../lib/grid.mjs'
import { C } from './palette.mjs'

/** 四角星芒：机会提示（§1.3 金黄色系） */
function star(g, cx, cy, r, outer, inner) {
  for (let dy = -r; dy <= r; dy++) {
    const t = 1 - Math.abs(dy) / r
    const half = Math.round(t * t * r)
    g.hLine(cx - half, cx + half, cy + dy, outer)
  }
  for (let dx = -r; dx <= r; dx++) {
    const t = 1 - Math.abs(dx) / r
    const half = Math.round(t * t * r)
    for (let k = -half; k <= half; k++) g.set(cx + dx, cy + k, outer)
  }
  g.ellipse(cx, cy, r * 0.34, r * 0.34, inner)
}

/** §4.5：机会提示元素，出现在空中峰值之后、消失在末帧之前 */
export function drawSparkles(g, dy, phase) {
  const wobble = phase % 2 === 0 ? 0 : 1
  star(g, 24, 34 + dy - wobble, 5, C.chanceGold, C.chanceGoldLight)
  star(g, 76, 29 + dy + wobble, 6, C.chanceGold, C.chanceGoldLight)
  star(g, 30, 18 + dy + wobble, 3, C.chanceGoldLight, C.chanceGoldLight)
}

/**
 * §4.6：风险提示元素。docs/06 §3 把 ALERT 描述为「警惕、举旗」，这里就照做 ——
 * 小旗是纯氛围道具，不像箭头那样暗示方向，也不像感叹号那样过度惊悚。
 * sway ≥ 1px 的持续摆动是硬要求：静态截图之外也要能被注意到。
 */
export function drawFlag(g, paw, dy, sway) {
  // 杆的上端定在 y≈52：再往上就会压到颊部（颊部下沿 y=50），
  // 旗杆横穿脸颊会让整帧读起来很脏。下端跟着抬起的爪子走，才像「举」而不是「插」。
  const topX = 74
  const topY = 52 + dy

  g.capsule(paw.x, paw.y, topX, topY, 1.4, C.furDeep)

  const tipX = topX + 12 + sway
  g.triangle([topX, topY], [tipX, topY + 5 - sway], [topX, topY + 10], C.riskAmber)
  g.triangle([topX + 1, topY + 2], [tipX - 5, topY + 5 - sway], [topX + 1, topY + 8], C.riskAmberLight)
}

/**
 * 在已描边的画面上盖一个「浅色外圈 + 深色字形」的符号。
 * 先扩一圈浅色再落字形，两步顺序不能反 —— 反了会把字形自己糊掉。
 */
function stampSymbol(g, draw, glyphColor, ringColor) {
  const scratch = new Grid(g.width, g.height)
  draw(scratch)

  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (scratch.get(x, y) !== 0) continue
      let adjacent = false
      for (let ny = -1; ny <= 1 && !adjacent; ny++) {
        for (let nx = -1; nx <= 1; nx++) {
          if (scratch.get(x + nx, y + ny) !== 0) {
            adjacent = true
            break
          }
        }
      }
      if (adjacent) g.set(x, y, ringColor)
    }
  }

  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (scratch.get(x, y) !== 0) g.set(x, y, glyphColor)
    }
  }
}

/** §4.7：睡意符号，须有上浮或明灭变化 */
export function drawSleepZ(g, rise) {
  const cx = 77
  const cy = 24 + rise
  stampSymbol(
    g,
    (s) => {
      s.hLine(cx - 5, cx + 5, cy - 6, 1)
      s.hLine(cx - 5, cx + 5, cy - 5, 1)
      s.line(cx + 5, cy - 5, cx - 5, cy + 5, 1)
      s.line(cx + 4, cy - 5, cx - 5, cy + 4, 1)
      s.hLine(cx - 5, cx + 5, cy + 5, 1)
      s.hLine(cx - 5, cx + 5, cy + 6, 1)
    },
    C.outline,
    C.offlineLightest
  )
}

/** §4.8：无信号图标。灰调之后仍须可辨，所以同样带浅色外圈 */
export function drawNoSignal(g) {
  const cx = 76
  const cy = 26
  stampSymbol(
    g,
    (s) => {
      s.ellipse(cx, cy, 8, 8, 1)
      s.ellipse(cx, cy, 5.5, 5.5, 0)
      s.line(cx - 5, cy - 5, cx + 5, cy + 5, 1)
      s.line(cx - 5, cy - 4, cx + 4, cy + 5, 1)
    },
    C.outline,
    C.offlineLightest
  )
}
