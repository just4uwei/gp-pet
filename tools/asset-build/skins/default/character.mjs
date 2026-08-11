/**
 * 「小猫」形象绘制（逻辑坐标 100×100，docs/09 §2.2 定位）。
 *
 * 定位约束（本文件所有坐标都必须服从）：
 *   镜像轴 x = 50 · 基线（最低填充行）y = 94，描边落到 95
 *   耳尖填充 y = 8，描边到 7 → 含描边高度 89（要求 85–92）
 *   主体宽度含描边 ≈ 56（要求 ≤ 60）
 *
 * 基线是硬约束：除 excited 外任何动画都不得改变 BASE_Y，
 * 差 1 px 就会让桌宠在待机时「抖脚」——那是最容易被用户看见的缺陷（§2.2）。
 * 所以呼吸做成「上半身压缩」而不是「整体上下弹」。
 */

import { C } from './palette.mjs'

const MIRROR = 50
const BASE_Y = 94

/** 关于镜像轴取对称点 */
const mx = (x) => MIRROR * 2 - x

function drawTail(g, dy, phase) {
  // 尾巴是 idle 的次级摆动来源（§4.1 必需元素：与呼吸不同周期的摆动）
  const sway = Math.sin(phase * Math.PI * 2)
  const tipX = 75 + sway * 1.6
  const tipY = 66 + sway * 1.2
  g.capsule(63, 86 + dy, 70, 83 + dy, 3.4, C.furMid)
  g.capsule(70, 83 + dy, 74, 74 + dy, 3.2, C.furMid)
  g.capsule(74, 74 + dy, tipX, tipY + dy, 3, C.furMid)
  // 尾环：虎斑特征，同时让摆动在低帧率下也看得出来
  g.capsule(72.5, 79 + dy, 74, 76 + dy, 2.6, C.furDeep)
  g.capsule(tipX, tipY + dy, tipX - 0.5, tipY + 2 + dy, 2.4, C.furLight)
}

function drawEar(g, side, dy, mode) {
  // mode: normal | perk（专注竖起）| droop（困倦垂下）| flat（戒备后压）
  const lift = mode === 'perk' ? -2 : 0
  const s = (x) => (side === 'L' ? x : mx(x))

  let outer
  let inner
  if (mode === 'droop') {
    outer = [
      [s(30), 30 + dy],
      [s(30), 16 + dy],
      [s(48), 24 + dy],
    ]
    inner = [
      [s(33), 27 + dy],
      [s(33), 20 + dy],
      [s(43), 24 + dy],
    ]
  } else if (mode === 'flat') {
    outer = [
      [s(29), 32 + dy],
      [s(27), 20 + dy],
      [s(47), 26 + dy],
    ]
    inner = [
      [s(32), 29 + dy],
      [s(31), 23 + dy],
      [s(42), 26 + dy],
    ]
  } else {
    outer = [
      [s(30), 30 + dy],
      [s(37), 8 + lift + dy],
      [s(48), 23 + dy],
    ]
    inner = [
      [s(34), 26 + dy],
      [s(37.5), 14 + lift + dy],
      [s(44), 22 + dy],
    ]
  }
  g.triangle(outer[0], outer[1], outer[2], C.furBase)
  g.triangle(inner[0], inner[1], inner[2], C.nosePink)
}

function drawEye(g, cx, cy, state) {
  if (state === 'closed') {
    // 「‿」放松闭眼
    g.line(cx - 4, cy - 1, cx - 1, cy + 2, C.outline)
    g.line(cx - 1, cy + 2, cx + 1, cy + 2, C.outline)
    g.line(cx + 1, cy + 2, cx + 4, cy - 1, C.outline)
    g.line(cx - 4, cy - 2, cx - 1, cy + 1, C.outline)
    g.line(cx + 1, cy + 1, cx + 4, cy - 2, C.outline)
    return
  }
  if (state === 'happy') {
    // 「^」正向情绪峰值（§4.5 必需元素）
    g.line(cx - 4, cy + 2, cx, cy - 3, C.outline)
    g.line(cx, cy - 3, cx + 4, cy + 2, C.outline)
    g.line(cx - 4, cy + 3, cx, cy - 2, C.outline)
    g.line(cx, cy - 2, cx + 4, cy + 3, C.outline)
    return
  }

  const rx = state === 'wide' ? 5 : 4.5
  const ry = state === 'wide' ? 6.5 : 5.5
  g.ellipse(cx, cy, rx, ry, C.outline)
  g.ellipse(cx, cy + 0.5, rx - 1.5, ry - 1.5, C.eyeIris)
  g.ellipse(cx, cy + 0.5, state === 'wide' ? 1.6 : 2.2, state === 'wide' ? 2.6 : 3.2, C.outline)
  g.rect(cx - 3, cy - 3, 2, 2, C.furLight)

  if (state === 'half' || state === 'narrow') {
    // 上眼睑压下来。narrow 压得更多，做出「戒备」而不是「困」
    const lidTo = state === 'half' ? cy : cy - 1
    for (let y = cy - ry - 1; y <= lidTo; y++) g.hLine(cx - rx - 1, cx + rx + 1, y, C.furBase)
    g.line(cx - rx, lidTo + 1, cx + rx, lidTo + 1, C.outline)
  }
}

function drawMouth(g, cx, cy, mode) {
  if (mode === 'open') {
    // 打哈欠
    g.ellipse(cx, cy + 4, 4, 4.5, C.outline)
    g.ellipse(cx, cy + 4.5, 2.4, 2.8, C.nosePink)
    return
  }
  if (mode === 'shush') {
    g.hLine(cx - 3, cx + 3, cy + 2, C.outline)
    return
  }
  const spread = mode === 'smile' ? 4 : 3
  g.line(cx, cy, cx, cy + 2, C.outline)
  g.line(cx, cy + 2, cx - spread, cy + (mode === 'smile' ? 3 : 1), C.outline)
  g.line(cx, cy + 2, cx + spread, cy + (mode === 'smile' ? 3 : 1), C.outline)
}

function drawHead(g, o, dy) {
  const hx = MIRROR + o.headDx
  const hy = 36 + o.headDy + dy

  drawEar(g, 'L', o.headDy + dy, o.ears)
  drawEar(g, 'R', o.headDy + dy, o.ears)

  // 颊部先画，让头部轮廓有「圆脸」的外扩
  g.ellipse(hx - 16, hy + 8, 7, 6, C.furBase)
  g.ellipse(hx + 16, hy + 8, 7, 6, C.furBase)
  g.ellipse(hx, hy, 21, 18, C.furBase)

  // 额头虎斑：三道短竖纹，用暗部色而非描边色（§2.4 部件分界用浅色）。
  // 位置压到 hy-13 而不是贴着头顶边缘，否则会读成一撮刘海
  for (const dx of [-5, 0, 5]) g.rect(hx + dx, hy - 13, 1, 4, C.furDeep)

  // 口鼻浅色块
  g.ellipse(hx, hy + 9, 9.5, 6, C.furLight)

  drawEye(g, hx - 9, hy - 2, o.eyes)
  drawEye(g, hx + 9, hy - 2, o.eyes)

  g.triangle([hx - 3, hy + 4], [hx + 3, hy + 4], [hx, hy + 8], C.nosePink)
  drawMouth(g, hx, hy + 8, o.mouth)
}

/** 描边之后才画的须 —— 免得被描边包成 3 px 粗的黑棒 */
function drawWhiskers(g, o, dy) {
  const hx = MIRROR + o.headDx
  const hy = 36 + o.headDy + dy
  // 起点压进剪影内 1–2 px，须才不会看着像浮在脸旁边的两撇线
  for (const side of [-1, 1]) {
    g.line(hx + side * 17, hy + 6, hx + side * 26, hy + 3, C.outline)
    g.line(hx + side * 17, hy + 10, hx + side * 26, hy + 11, C.outline)
  }
}

/** 抬起的右前爪落点。alert 与 shush 抬的高度不同，所以幅度由姿态给，不写死 */
export function rightPaw(o, dy) {
  const lift = o.pawUp * (o.pawLift ?? 10)
  return { x: 57 - o.pawUp * 3, y: 79 - lift + dy }
}

function drawBody(g, o, dy) {
  // 上半身。它的顶端（y≈49）必须压进头部椭圆的底端（y≈54）——
  // 两者一旦脱开，剪影就成了「浮在球上的一颗头」，这是第一版最明显的缺陷
  g.ellipse(MIRROR, 63 + o.breath + dy, 15.5, 14, C.furBase)

  // 后半身：基线由前爪决定，这里刻意收到 92，让爪子露出 2px 的剪影
  g.ellipse(MIRROR, 77 + dy, 19, 15, C.furBase)

  // 前腿。抬起的一侧用于 shush 手势与 alert 举旗
  const paw = rightPaw(o, dy)
  g.capsule(43, 79 + dy, 43, 90 + dy, 4.2, C.furBase)
  if (o.pawUp > 0) {
    g.capsule(57, 80 + dy, paw.x, paw.y, 4, C.furBase)
    g.ellipse(paw.x, paw.y - 1, 4.5, 4, C.furLight)
  } else {
    g.capsule(57, 79 + dy, 57, 90 + dy, 4.2, C.furBase)
  }

  // 胸口浅色块
  g.ellipse(MIRROR, 66 + o.breath + dy, 8.5, 9, C.furLight)

  // 腿脚分界与肉垫：用暗部色而非描边色，免得把剪影切碎（§2.4）
  g.ellipse(43, 91.5 + dy, 5.5, 3, C.furLight)
  g.line(38, 88 + dy, 48, 88 + dy, C.furMid)
  if (o.pawUp === 0) {
    g.ellipse(57, 91.5 + dy, 5.5, 3, C.furLight)
    g.line(52, 88 + dy, 62, 88 + dy, C.furMid)
  }
}

export const DEFAULT_POSE = {
  dy: 0,
  breath: 0,
  headDx: 0,
  headDy: 0,
  ears: 'normal',
  eyes: 'open',
  mouth: 'neutral',
  tail: 0,
  pawUp: 0,
  pawLift: 10,
}

/**
 * 画出一帧小猫（不含描边、不含道具与符号）。
 * 描边、须、道具、符号的先后顺序由 frame.mjs 统一编排 —— 顺序本身是有讲究的，
 * 集中在一处才不会画错。
 */
export function drawCat(g, pose) {
  const o = { ...DEFAULT_POSE, ...pose }
  const dy = o.dy

  drawTail(g, dy, o.tail)
  drawBody(g, o, dy)
  drawHead(g, o, dy)
  return o
}

export { BASE_Y, MIRROR, drawWhiskers }
