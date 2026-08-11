/**
 * 九个动画的分镜（docs/09 §3 契约 + §4 表达契约）。
 *
 * frames / fps / loop / minHold 是**跨皮肤契约**，不得按形象调整（§5），
 * 所以它们写在这里并由 build 脚本直接写进 skin.json —— 手抄一遍就会有抄错的一天。
 *
 * 每个动画上方的注释写明它兑现了 §4 的哪几条「必需元素」，
 * 便于后续改分镜时知道哪一帧动不得。
 */

import { Grid } from '../../lib/grid.mjs'
import { drawCat, drawWhiskers, rightPaw } from './character.mjs'
import { C, desaturate } from './palette.mjs'
import { drawFlag, drawNoSignal, drawSleepZ, drawSparkles } from './props.mjs'

/** §3 的动画清单，逐字对应 */
export const CONTRACT = {
  idle: { frames: 8, fps: 8, loop: true },
  blink: { frames: 4, fps: 12, loop: false },
  look: { frames: 10, fps: 8, loop: false },
  watching: { frames: 6, fps: 8, loop: true },
  excited: { frames: 12, fps: 12, loop: false, minHold: 3000 },
  alert: { frames: 10, fps: 10, loop: false, minHold: 3000 },
  sleepy: { frames: 6, fps: 4, loop: true },
  offline: { frames: 4, fps: 4, loop: true },
  shush: { frames: 6, fps: 10, loop: false, minHold: 1200 },
}

/** 静止基准姿态。blink / look / shush 的首帧必须与它逐像素一致（A12） */
const REST = { breath: 0, tail: 0, ears: 'normal', eyes: 'open', mouth: 'neutral' }

const at = (list, i) => list[i % list.length]

const SPEC = {
  // 呼吸周期 下沉→回位→下沉→回位；尾巴 8 帧一循环，与呼吸的 4 帧不同周期（§4.1 必需元素）
  idle: (i) => ({ pose: { ...REST, breath: at([0, 1, 1, 0, 0, 1, 1, 0], i), tail: i / 8 } }),

  // 主体零位移，只有眼部变化（§4.2 动作预算）
  blink: (i) => ({ pose: { ...REST, eyes: at(['open', 'half', 'closed', 'open'], i) } }),

  // 仅头部横向偏移 ≤2px，躯干与尾巴静止（§4.3 必需元素）
  look: (i) => ({ pose: { ...REST, headDx: at([0, -1, -2, -2, -1, 0, 1, 2, 1, 0], i) } }),

  // 前倾 1px + 耳朵竖起 + 睁大 = 与 idle 一眼可区分的「专注」；呼吸幅度小于 idle（§4.4）
  watching: (i) => ({
    pose: {
      ...REST,
      ears: 'perk',
      eyes: 'wide',
      headDy: 1,
      headDx: at([0, 1, 1, 0, -1, 0], i),
      breath: at([0, 0, 1, 0, 0, 0], i),
      tail: i / 6,
    },
  }),

  // 蓄力下沉 +2 → 跃起 → 峰值 −3 → 落地 → 回稳；离地 5 帧（要求 ≥4）
  // 金色星芒在峰值（f5/f6）之后出现，末帧之前消失（§4.5 必需元素）
  excited: (i) => {
    const dy = at([0, 1, 2, 1, -1, -3, -3, -2, -1, 0, 1, 0], i)
    const sparkle = i >= 7 && i <= 10
    return {
      pose: {
        ...REST,
        dy,
        ears: i >= 4 && i <= 9 ? 'perk' : 'normal',
        eyes: i >= 4 && i <= 9 ? 'happy' : 'open',
        mouth: i >= 3 && i <= 9 ? 'smile' : 'neutral',
        tail: i / 11,
      },
      props: sparkle ? (g) => drawSparkles(g, dy, i) : null,
    }
  },

  // 整体零位移（基线不得动，否则破坏 A8）；戒备特征是压耳 + 眯眼，与 watching 的竖耳睁眼相反
  // 小旗第 2 帧出现并持续到末帧，且逐帧摆动 ≥1px（§4.6 必需元素）
  alert: (i) => {
    const pose = {
      ...REST,
      ears: 'flat',
      eyes: 'narrow',
      pawUp: at([0, 0.5, 1, 1, 1, 1, 1, 1, 1, 1], i),
      pawLift: 12,
    }
    return {
      pose,
      props:
        i >= 1
          ? (g) => drawFlag(g, rightPaw(pose, 0), 0, at([0, 0, 1, 0, 1, 0, 1, 0, 1, 0], i))
          : null,
    }
  },

  // 低头 → 保持 → 点头 → 回抬 → 打哈欠；相邻帧位移 ≤1px（4fps 下大位移会明显卡顿）
  sleepy: (i) => ({
    pose: {
      ...REST,
      ears: 'droop',
      eyes: 'closed',
      headDy: at([2, 2, 3, 3, 2, 2], i),
      mouth: at(['neutral', 'neutral', 'neutral', 'neutral', 'open', 'neutral'], i),
      tail: at([0, 0.1, 0.2, 0.3, 0.4, 0.5], i),
    },
    symbols: (g) => drawSleepZ(g, at([0, -1, -2, -3, -2, -1], i)),
  }),

  // 同一套形体换色，不重画（§4.8）：姿态四帧完全相同，只有断线图标明灭
  // 眼睛保持睁开：闭眼会和 sleepy 撞车，而「离线」的语义是「醒着但看不到数据」，
  // 不是「在睡觉」。区分靠灰调 + 垮耳 + 断线图标三者叠加
  offline: (i) => ({
    pose: { ...REST, ears: 'droop' },
    symbols: i < 2 ? (g) => drawNoSignal(g) : null,
    offline: true,
  }),

  // 首帧必须与 idle 首帧一致；第 3 帧前定格「安静」手势；禁止任何提示元素（§4.9）
  // 爪子要抬到下巴附近才读得出「嘘」；alert 的举旗只抬到胸口，两者共用参数但幅度不同
  shush: (i) => ({
    pose: {
      ...REST,
      pawUp: at([0, 0.5, 1, 1, 0.9, 1], i),
      pawLift: 24,
      mouth: i >= 2 ? 'shush' : 'neutral',
      eyes: i >= 3 ? 'half' : 'open',
    },
  }),
}

/**
 * 渲染一帧。绘制顺序是有讲究的，集中在这里才不会画错：
 *   主体 → 道具（与主体共用深色描边）→ 描边 → 须（描边后画，免得被包成粗黑棒）
 *   → 离线换色 → 脱离主体的符号（自带浅色外圈，不参与上面的描边）
 */
export function renderFrame(name, index) {
  const spec = SPEC[name]
  if (!spec) throw new Error(`未知动画：${name}`)
  const { pose, props, symbols, offline } = spec(index)

  const g = new Grid(100, 100)
  drawCat(g, pose)
  if (props) props(g)
  g.outline(C.outline)
  drawWhiskers(g, { headDx: pose.headDx ?? 0, headDy: pose.headDy ?? 0 }, pose.dy ?? 0)
  if (offline) desaturate(g)
  if (symbols) symbols(g)
  return g
}

export function renderAnimation(name) {
  const { frames } = CONTRACT[name]
  return Array.from({ length: frames }, (_, i) => renderFrame(name, i))
}
