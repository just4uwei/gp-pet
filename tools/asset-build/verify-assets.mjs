/**
 * 美术资源自动验收（docs/09 §9.1 的 A1–A13）。
 *
 *   node tools/asset-build/verify-assets.mjs [skinName]
 *
 * 刻意**不复用**生成器的任何绘图代码，只读磁盘上的 PNG 与 JSON —— 否则同一个 bug
 * 会同时出现在生成和校验两侧，校验就成了橡皮图章。这里只依赖 lib/png.mjs 解码。
 *
 * 校验不了的是 §9.2 那 8 条人工项（语义能不能被不知情的人说出来、200px 下是否可辨），
 * 那些必须由人看。脚本会在末尾把人工清单打出来提醒。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng } from './lib/png.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKIN = process.argv[2] ?? 'default'
const SKIN_DIR = join(ROOT, 'resources', 'pet', SKIN)
const ICON_DIR = join(ROOT, 'resources', 'icons', SKIN)

/** §3 跨皮肤契约，逐字对应。verify 端独立写一份，与生成端互为对照 */
const CONTRACT = {
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
const KEYS = Object.keys(CONTRACT)
const LOOPING = KEYS.filter((k) => CONTRACT[k].loop)
/** 带道具/符号的动画不参与包围盒尺寸检查：§2.2 允许道具延伸到画布边缘 */
const PROP_FREE = ['idle', 'blink', 'look', 'watching', 'shush']

const SEMANTIC = {
  riskAmber: ['#E8721C', '#F59D4E'],
  chanceGold: ['#F2C230', '#F8DE7A'],
  offlineGray: ['#4A4E5A', '#9AA0B4', '#C8CCD9', '#ECEEF2'],
}

const FRAME_1X = 200
const failures = []
const notes = []

function check(id, label, ok, detail = '') {
  if (!ok) failures.push(`${id} ${label}${detail ? ` —— ${detail}` : ''}`)
}

// ── 载入 ────────────────────────────────────────────────────────────
if (!existsSync(join(SKIN_DIR, 'skin.json'))) {
  console.error(`找不到皮肤：${SKIN_DIR}`)
  process.exit(2)
}
const skin = JSON.parse(readFileSync(join(SKIN_DIR, 'skin.json'), 'utf-8'))
const paletteFile = JSON.parse(readFileSync(join(SKIN_DIR, 'palette.json'), 'utf-8'))

const images = {}
for (const file of readdirSync(SKIN_DIR)) {
  if (file.endsWith('.png') && file !== 'preview.png') {
    images[file] = decodePng(readFileSync(join(SKIN_DIR, file)))
  }
}

const px = (img, x, y) => {
  const at = (y * img.width + x) * 4
  return [img.data[at], img.data[at + 1], img.data[at + 2], img.data[at + 3]]
}
const hex = (r, g, b) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`

/** 取图集里第 index 帧的某像素 */
const frameAt = (img, size, index, x, y) => px(img, index * size + x, y)

// ── A1 尺寸 ─────────────────────────────────────────────────────────
for (const key of KEYS) {
  const spec = CONTRACT[key]
  for (const [suffix, frame] of [
    ['', FRAME_1X],
    ['@2x', FRAME_1X * 2],
  ]) {
    const file = `${key}${suffix}.png`
    const img = images[file]
    if (!img) {
      check('A1', `${file} 缺失`, false)
      continue
    }
    check(
      'A1',
      `${file} 尺寸`,
      img.width === frame * spec.frames && img.height === frame,
      `期望 ${frame * spec.frames}×${frame}，实际 ${img.width}×${img.height}`
    )
  }
}

// ── A2 alpha 二值 · A3 单图限色 · A4 全套 ⊆ palette ─────────────────
const allUsed = new Set()
for (const [file, img] of Object.entries(images)) {
  const used = new Set()
  let softAlpha = 0
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]
    if (a !== 0 && a !== 255) softAlpha++
    if (a === 255) used.add(hex(img.data[i], img.data[i + 1], img.data[i + 2]))
  }
  check('A2', `${file} alpha 二值`, softAlpha === 0, `${softAlpha} 个半透明像素`)
  check('A3', `${file} 颜色数 ≤40`, used.size <= 40, `实际 ${used.size}`)
  for (const c of used) allUsed.add(c)
}

const declared = new Set(paletteFile.colors.map((c) => c.toUpperCase()))
const extra = [...allUsed].filter((c) => !declared.has(c))
check('A4', '全部用色 ⊆ palette.json colors', extra.length === 0, `多出 ${extra.join(', ')}`)
for (const [slot, values] of Object.entries(SEMANTIC)) {
  check(
    'A4',
    `palette.json semantic.${slot} 与 §1.3 逐字一致`,
    JSON.stringify(paletteFile.semantic?.[slot]) === JSON.stringify(values)
  )
}
check('A4', 'palette.json outline 已登记', typeof paletteFile.outline === 'string')
check(
  'A4',
  '描边色只有一个（outline 出现在用色里）',
  declared.has(paletteFile.outline.toUpperCase())
)

// ── A5 @2x 是 @1x 的严格 2 倍最近邻 ─────────────────────────────────
for (const key of [...KEYS, 'minimal']) {
  const a = images[`${key}.png`]
  const b = images[`${key}@2x.png`]
  if (!a || !b) continue
  if (b.width !== a.width * 2 || b.height !== a.height * 2) {
    check('A5', `${key}@2x 不是 2 倍尺寸`, false)
    continue
  }
  let bad = 0
  for (let y = 0; y < a.height && bad === 0; y++) {
    for (let x = 0; x < a.width; x++) {
      const src = px(a, x, y)
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const dst = px(b, x * 2 + dx, y * 2 + dy)
        if (dst.join() !== src.join()) {
          bad++
          break
        }
      }
      if (bad) break
    }
  }
  check('A5', `${key}@2x 严格最近邻放大`, bad === 0)
}

// ── A6 每帧格线内 1px 边缘无非透明像素 ──────────────────────────────
for (const key of KEYS) {
  const img = images[`${key}.png`]
  if (!img) continue
  let touching = 0
  for (let f = 0; f < CONTRACT[key].frames; f++) {
    for (let i = 0; i < FRAME_1X; i++) {
      if (frameAt(img, FRAME_1X, f, i, 0)[3] !== 0) touching++
      if (frameAt(img, FRAME_1X, f, i, FRAME_1X - 1)[3] !== 0) touching++
      if (frameAt(img, FRAME_1X, f, 0, i)[3] !== 0) touching++
      if (frameAt(img, FRAME_1X, f, FRAME_1X - 1, i)[3] !== 0) touching++
    }
  }
  check('A6', `${key} 帧边缘留白`, touching === 0, `${touching} 个贴边像素`)
}

// ── A7 skin.json 与图集及 §3 契约一致 ───────────────────────────────
check('A7', 'skin.json states 覆盖全部 9 个 key', KEYS.every((k) => skin.states?.[k]))
for (const key of KEYS) {
  const spec = CONTRACT[key]
  const state = skin.states?.[key]
  if (!state) continue
  const img = images[state.sheet]
  check('A7', `${key}.frames 与图集宽度一致`, img && img.width === FRAME_1X * state.frames)
  check('A7', `${key} 帧数符合契约`, state.frames === spec.frames)
  check('A7', `${key} fps 符合契约`, state.fps === spec.fps)
  check('A7', `${key} loop 符合契约`, state.loop === spec.loop)
  check('A7', `${key} minHold 符合契约`, (state.minHold ?? null) === (spec.minHold ?? null))
}
check(
  'A7',
  'canvas 为 200×200',
  skin.canvas?.width === FRAME_1X && skin.canvas?.height === FRAME_1X
)

// ── A8 主体基线逐帧一致（excited 除外） ─────────────────────────────
function lowestRow(img, index) {
  for (let y = FRAME_1X - 1; y >= 0; y--) {
    for (let x = 0; x < FRAME_1X; x++) {
      if (frameAt(img, FRAME_1X, index, x, y)[3] !== 0) return y
    }
  }
  return -1
}
const baselines = new Map()
for (const key of KEYS) {
  if (key === 'excited') continue
  const img = images[`${key}.png`]
  if (!img) continue
  for (let f = 0; f < CONTRACT[key].frames; f++) {
    baselines.set(`${key}#${f}`, lowestRow(img, f))
  }
}
const baselineValues = new Set(baselines.values())
check(
  'A8',
  '主体基线逐帧一致',
  baselineValues.size === 1,
  `出现 ${[...baselineValues].join('/')} 多种基线：${[...baselines]
    .filter(([, v]) => v !== [...baselineValues][0])
    .slice(0, 5)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')}`
)

// ── A9 主体尺寸（只测无道具的动画，§2.2 允许道具外扩） ──────────────
for (const key of PROP_FREE) {
  const img = images[`${key}.png`]
  if (!img) continue
  for (let f = 0; f < CONTRACT[key].frames; f++) {
    let minX = FRAME_1X
    let maxX = -1
    let minY = FRAME_1X
    let maxY = -1
    for (let y = 0; y < FRAME_1X; y++) {
      for (let x = 0; x < FRAME_1X; x++) {
        if (frameAt(img, FRAME_1X, f, x, y)[3] === 0) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const h = maxY - minY + 1
    const w = maxX - minX + 1
    check(
      'A9',
      `${key}#${f} 主体高度占比`,
      h >= FRAME_1X * 0.85 && h <= FRAME_1X * 0.92,
      `${((h / FRAME_1X) * 100).toFixed(1)}%`
    )
    check('A9', `${key}#${f} 主体宽度 ≤120px`, w <= 120, `${w}px`)
  }
}

// ── A10 hitRects 落在剪影内（覆盖率 ≥85%） ──────────────────────────
{
  const img = images['idle.png']
  check('A10', 'hitRects 非空', Array.isArray(skin.hitRects) && skin.hitRects.length > 0)
  for (const [i, r] of (skin.hitRects ?? []).entries()) {
    let inside = 0
    let total = 0
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        total++
        if (frameAt(img, FRAME_1X, 0, x, y)[3] !== 0) inside++
      }
    }
    const ratio = inside / total
    check('A10', `hitRects[${i}] 覆盖率 ≥85%`, ratio >= 0.85, `${(ratio * 100).toFixed(1)}%`)
    notes.push(`hitRects[${i}] 剪影覆盖率 ${(ratio * 100).toFixed(1)}%`)
  }
}

// ── A11 minimal.png 帧序与配色（§6.1） ──────────────────────────────
{
  const img = images['minimal.png']
  const EXPECT = [
    ['SLEEPY', '#9AA0B4', '#6F748A'],
    ['IDLE', '#FDFBF5', '#2A2028'],
    ['WATCHING', '#6C8EBF', '#2A2028'],
    ['EXCITED', '#F2C230', '#2A2028'],
    ['ALERT', '#E8721C', '#2A2028'],
    ['OFFLINE', '#6B7080', '#2A2028'],
  ]
  if (!img) {
    check('A11', 'minimal.png 缺失', false)
  } else {
    check('A11', 'minimal.png 为 6 帧 32×32', img.width === 192 && img.height === 32)
    EXPECT.forEach(([state, fill, stroke], index) => {
      // 取「占比最大的不透明色」而非圆心像素：EXCITED/ALERT/OFFLINE 的形状标记
      // 恰好压在圆心上（§6.1 要求的色觉障碍冗余线索），采样圆心会误判
      const tally = new Map()
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const p = frameAt(img, 32, index, x, y)
          if (p[3] !== 255) continue
          const key = hex(p[0], p[1], p[2])
          tally.set(key, (tally.get(key) ?? 0) + 1)
        }
      }
      const dominant = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      check('A11', `minimal 第 ${index + 1} 帧（${state}）填充色`, dominant === fill, String(dominant))
      check('A11', `minimal 第 ${index + 1} 帧（${state}）描边色`, tally.has(stroke))
    })
  }
}

// ── A12 blink / look / shush 首帧与 idle 首帧逐像素一致 ──────────────
{
  const idle = images['idle.png']
  for (const key of ['blink', 'look', 'shush']) {
    const img = images[`${key}.png`]
    if (!img || !idle) continue
    let diff = 0
    for (let y = 0; y < FRAME_1X; y++) {
      for (let x = 0; x < FRAME_1X; x++) {
        if (frameAt(idle, FRAME_1X, 0, x, y).join() !== frameAt(img, FRAME_1X, 0, x, y).join()) diff++
      }
    }
    check('A12', `${key} 首帧与 idle 首帧一致`, diff === 0, `${diff} 个像素不同`)
  }
}

// ── A13 循环动画首尾像素差 ≤5% ──────────────────────────────────────
for (const key of LOOPING) {
  const img = images[`${key}.png`]
  if (!img) continue
  const last = CONTRACT[key].frames - 1
  let diff = 0
  for (let y = 0; y < FRAME_1X; y++) {
    for (let x = 0; x < FRAME_1X; x++) {
      if (frameAt(img, FRAME_1X, 0, x, y).join() !== frameAt(img, FRAME_1X, last, x, y).join()) diff++
    }
  }
  const ratio = diff / (FRAME_1X * FRAME_1X)
  check('A13', `${key} 首尾衔接差异 ≤5%`, ratio <= 0.05, `${(ratio * 100).toFixed(2)}%`)
  notes.push(`${key} 首尾差异 ${(ratio * 100).toFixed(2)}%`)
}

// ── 交付清单完整性（§8） ────────────────────────────────────────────
const REQUIRED_ICONS = ['tray.png', 'tray@2x.png', 'tray-muted.png', 'tray-muted@2x.png', 'icon.png', 'icon.ico']
for (const file of REQUIRED_ICONS) {
  check('§8', `icons/${SKIN}/${file} 存在`, existsSync(join(ICON_DIR, file)))
}
for (const [file, size] of [
  ['tray.png', 16],
  ['tray@2x.png', 32],
]) {
  const path = join(ICON_DIR, file)
  if (!existsSync(path)) continue
  const img = decodePng(readFileSync(path))
  check('§6.2', `${file} 为 ${size}×${size}`, img.width === size && img.height === size)
}

// ── 报告 ────────────────────────────────────────────────────────────
for (const note of notes) console.log(`  · ${note}`)

if (failures.length > 0) {
  console.error(`\n✗ 皮肤「${SKIN}」未通过自动验收（${failures.length} 项）：`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

console.log(`\n✓ 皮肤「${SKIN}」通过 docs/09 §9.1 全部自动校验（A1–A13）`)
console.log('  仍需人工验收（§9.2 M1–M8）：200px 下特征可辨、三种壁纸下轮廓清晰、')
console.log('  按标称 fps 播放无抖脚、九个动画的语义可被不知情的人正确说出。')
