/**
 * 生成「小猫」皮肤的全部交付物（docs/09 §8 清单）。
 *
 *   node tools/asset-build/build-skin.mjs
 *
 * 输出 28 个文件 + preview.png。生成完请跑 `pnpm verify:assets` —— 本脚本只负责画，
 * 「画对没有」由独立的校验器判定（docs/09 §9.1），两者刻意不共用判定代码。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeSheet } from './lib/grid.mjs'
import { encodeIco, encodePng } from './lib/png.mjs'
import { CONTRACT, renderAnimation, renderFrame } from './skins/default/animations.mjs'
import { allColors, OUTLINE_HEX, palette } from './skins/default/palette.mjs'
import { minimalFrames, muted, trayHead16, trayHead32 } from './skins/default/icons.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKIN_ID = 'default'
const SKIN_DIR = join(ROOT, 'resources', 'pet', SKIN_ID)
const ICON_DIR = join(ROOT, 'resources', 'icons', SKIN_ID)

const LOGICAL = 100
/** 逻辑格 → @1x 是 2 倍，@2x 是 4 倍（docs/09 §2.1） */
const SCALE_1X = 2
const SCALE_2X = 4

const written = []

function write(path, buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buffer)
  written.push({ path: path.slice(ROOT.length + 1), bytes: buffer.length })
}

function writeSheet(dir, name, grids, scale, suffix) {
  const size = LOGICAL * scale
  const frames = grids.map((g) => g.toRgba(palette, scale))
  const sheet = composeSheet(frames, size, size)
  write(join(dir, `${name}${suffix}.png`), encodePng(size * grids.length, size, sheet))
}

// ── 九个动画 ────────────────────────────────────────────────────────
const animations = {}
for (const name of Object.keys(CONTRACT)) {
  const grids = renderAnimation(name)
  animations[name] = grids
  writeSheet(SKIN_DIR, name, grids, SCALE_1X, '')
  writeSheet(SKIN_DIR, name, grids, SCALE_2X, '@2x')
}

// ── 极简色点（§6.1：@1x 就是 32×32，不走逻辑格） ──────────────────
const dots = minimalFrames()
for (const [scale, suffix] of [
  [1, ''],
  [2, '@2x'],
]) {
  const size = 32 * scale
  const sheet = composeSheet(
    dots.map((g) => g.toRgba(palette, scale)),
    size,
    size
  )
  write(join(SKIN_DIR, `minimal${suffix}.png`), encodePng(size * dots.length, size, sheet))
}

// ── 命中区（docs/06 §2.2 方案 1；坐标为 @1x 像素） ──────────────────
// 只覆盖头与躯干核心。外伸的耳尖、须、尾巴故意不算命中 ——
// 宁可少覆盖，也不要吞掉本该穿透的点击（C2 是底线，见 docs/09 §5）
const HIT_RECTS_LOGICAL = [
  { x: 36, y: 24, w: 28, h: 24 },
  { x: 40, y: 58, w: 20, h: 31 },
]
const hitRects = HIT_RECTS_LOGICAL.map((r) => ({
  x: r.x * SCALE_1X,
  y: r.y * SCALE_1X,
  w: r.w * SCALE_1X,
  h: r.h * SCALE_1X,
}))

// ── 气泡锚点：主体最高点上方留 6px（§5） ───────────────────────────
const reference = renderFrame('idle', 0)
const bounds = reference.bounds()
const anchor = { bubbleX: (LOGICAL / 2) * SCALE_1X, bubbleY: bounds.minY * SCALE_1X - 6 }

// ── skin.json ──────────────────────────────────────────────────────
const states = {}
for (const [name, spec] of Object.entries(CONTRACT)) {
  states[name] = {
    sheet: `${name}.png`,
    frames: spec.frames,
    fps: spec.fps,
    loop: spec.loop,
    ...(spec.minHold === undefined ? {} : { minHold: spec.minHold }),
  }
}
write(
  join(SKIN_DIR, 'skin.json'),
  Buffer.from(
    `${JSON.stringify(
      {
        name: '小猫',
        canvas: { width: LOGICAL * SCALE_1X, height: LOGICAL * SCALE_1X },
        anchor,
        hitRects,
        states,
      },
      null,
      2
    )}\n`,
    'utf-8'
  )
)

// ── palette.json（仅供验收校验，不参与运行时加载，§2.4） ────────────
write(
  join(SKIN_DIR, 'palette.json'),
  Buffer.from(
    `${JSON.stringify(
      {
        outline: OUTLINE_HEX,
        colors: allColors,
        semantic: {
          riskAmber: ['#E8721C', '#F59D4E'],
          chanceGold: ['#F2C230', '#F8DE7A'],
          offlineGray: ['#4A4E5A', '#9AA0B4', '#C8CCD9', '#ECEEF2'],
        },
      },
      null,
      2
    )}\n`,
    'utf-8'
  )
)

// ── 托盘与应用图标（§6.2） ─────────────────────────────────────────
const head16 = trayHead16()
const head32 = trayHead32()

const trayVariants = [
  ['tray.png', head16, 1],
  ['tray@2x.png', head32, 1],
  ['tray-muted.png', muted(head16), 1],
  ['tray-muted@2x.png', muted(head32), 1],
]
for (const [file, grid, scale] of trayVariants) {
  write(join(ICON_DIR, file), encodePng(grid.width * scale, grid.height * scale, grid.toRgba(palette, scale)))
}

/** 把 grid 放大后居中放进 size×size 画布。放大是无损的，§6.2 禁止的是缩小 */
function centered(grid, scale, size) {
  const content = grid.toRgba(palette, scale)
  const contentSize = grid.width * scale
  if (contentSize > size) throw new Error(`内容 ${contentSize} 放不进 ${size}`)
  const pad = Math.floor((size - contentSize) / 2)
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < contentSize; y++) {
    content.copy(out, ((y + pad) * size + pad) * 4, y * contentSize * 4, (y + 1) * contentSize * 4)
  }
  return out
}

const appIcon256 = centered(animations.idle[0], SCALE_1X, 256)
write(join(ICON_DIR, 'icon.png'), encodePng(256, 256, appIcon256))

// 小尺寸取局部特征（猫头），大尺寸用全身（§6.2）
const icoEntries = [
  { size: 16, png: encodePng(16, 16, head16.toRgba(palette, 1)) },
  { size: 32, png: encodePng(32, 32, head32.toRgba(palette, 1)) },
  { size: 48, png: encodePng(48, 48, head16.toRgba(palette, 3)) },
  { size: 64, png: encodePng(64, 64, head32.toRgba(palette, 2)) },
  { size: 128, png: encodePng(128, 128, centered(animations.idle[0], 1, 128)) },
  { size: 256, png: encodePng(256, 256, appIcon256) },
]
write(join(ICON_DIR, 'icon.ico'), encodeIco(icoEntries))

// ── preview.png：逐帧总览，棋盘格背景，供人工验收（§8、§9.2） ───────
{
  const cell = LOGICAL * SCALE_1X
  const names = Object.keys(CONTRACT)
  const cols = Math.max(...names.map((n) => CONTRACT[n].frames))
  const width = cell * cols
  const height = cell * names.length
  const out = Buffer.alloc(width * height * 4)

  // 棋盘格：16px 一格，让透明区域与浅色毛发区分得开
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const light = ((x >> 4) + (y >> 4)) % 2 === 0
      const v = light ? 0x50 : 0x3c
      const at = (y * width + x) * 4
      out[at] = v
      out[at + 1] = v
      out[at + 2] = v + 4
      out[at + 3] = 255
    }
  }

  names.forEach((name, row) => {
    animations[name].forEach((grid, col) => {
      const frame = grid.toRgba(palette, SCALE_1X)
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const src = (y * cell + x) * 4
          if (frame[src + 3] === 0) continue
          const dst = ((row * cell + y) * width + col * cell + x) * 4
          frame.copy(out, dst, src, src + 4)
        }
      }
    })
  })

  write(join(SKIN_DIR, 'preview.png'), encodePng(width, height, out))
}

// ── 报告 ───────────────────────────────────────────────────────────
const total = written.reduce((sum, f) => sum + f.bytes, 0)
console.log(`皮肤「小猫」已生成：${written.length} 个文件，共 ${(total / 1024).toFixed(0)} KB`)
console.log(`  基线（最低非透明行，逻辑格）：${bounds.maxY}`)
console.log(`  包围盒：x ${bounds.minX}..${bounds.maxX}（宽 ${bounds.maxX - bounds.minX + 1}）· y ${bounds.minY}..${bounds.maxY}（高 ${bounds.maxY - bounds.minY + 1}）`)
console.log(`  气泡锚点：${JSON.stringify(anchor)}`)
