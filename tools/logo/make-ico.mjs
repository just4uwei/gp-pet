/**
 * 从 `resources/icons/app/icon.png`（256×256，手绘）生成 `icon.ico` —— **一次性脚本，不参与构建**。
 *
 *   node tools/logo/make-ico.mjs                  # 覆盖 icon.ico
 *   LOGO_PREVIEW=1 node tools/logo/make-ico.mjs   # 顺带往临时目录写各档的放大图给人眼看
 *
 * ## 为什么需要它
 *
 * `win.icon` / `nsis.installerIcon` / `nsis.uninstallerIcon` 三处都要 `.ico`，
 * 而 ico 是个多尺寸容器：Windows 在不同场景（任务栏 / Alt-Tab / 资源管理器各档视图 /
 * 安装程序）各取一档。**只放一张 256 会让小尺寸场景由系统临时缩，糊且不可控**，
 * 所以这里预先出好 16/32/48/64/128/256 六档。
 *
 * ## 三条实现取舍
 *
 * 1. **零依赖**：自己解 PNG（zlib inflate + 反滤波）、自己缩、自己打包 ico。
 *    项目里没有 sharp / jimp 这类原生图像库，为一个一次性脚本引一个不值得。
 * 2. **缩放走「按面积平均」，且在 alpha 预乘之后做**。直接对 RGBA 取平均会让
 *    透明像素里存的那份颜色（多数导出器写 0,0,0）渗进边缘 —— 症状是缩小后角色轮廓
 *    发黑，看起来像描边变粗了。预乘之后再除回去就没有这件事。
 * 3. **每档存成 PNG 条目而不是 BMP/DIB**。改动前那份 `icon.ico` 就是这个形状，
 *    而它 2026-08-13 打过包、NSIS 吃得下 —— 沿用已经验证过的那条路。
 *
 * ## 源文件是手绘的，别再生成它
 *
 * `icon.png` 与四张 `tray*.png` 都是**项目方提供的美术资产**，这个脚本
 * **只读不写**它们，只产出 `icon.ico`。（2026-08-14 之前这里有个按像素网格画角色的
 * 生成器，换成真美术之后删掉了 —— 留着它下一次误跑就会把美术覆盖掉。）
 */

import { deflateSync, inflateSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'icons', 'app')

/** Windows 会用到的档位。改这里要顺便想清楚哪个场景用哪一档 */
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

// ── PNG 解码 ──────────────────────────────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 只支持 8bit、非隔行 —— 够用即可，遇到别的形状宁可报错也不要静默出错图 */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG 文件')

  let pos = 8
  let ihdr = null
  let palette = null
  let transparency = null
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') transparency = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
  }

  if (!ihdr) throw new Error('PNG 缺少 IHDR')
  if (ihdr.bitDepth !== 8) throw new Error(`只支持 8bit PNG，这张是 ${ihdr.bitDepth}bit`)
  if (ihdr.interlace !== 0) throw new Error('不支持隔行（Adam7）PNG，请另存为非隔行')

  const channelsByType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByType[ihdr.colorType]
  if (!channels) throw new Error(`不支持的 PNG colorType ${ihdr.colorType}`)
  if (ihdr.colorType === 3 && !palette) throw new Error('索引色 PNG 缺少 PLTE')

  const { width, height } = ihdr
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const lines = Buffer.alloc(stride * height)

  // 反滤波（PNG 规范 §9）。a=左、b=上、c=左上，单位是**字节**不是像素
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = lines.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let value
      switch (filter) {
        case 0:
          value = src[i]
          break
        case 1:
          value = src[i] + a
          break
        case 2:
          value = src[i] + b
          break
        case 3:
          value = src[i] + ((a + b) >> 1)
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          value = src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`第 ${y} 行是没见过的滤波类型 ${filter}`)
      }
      cur[i] = value & 0xff
    }
  }

  // 统一摊平成 RGBA
  const rgba = Buffer.alloc(width * height * 4)
  for (let p = 0; p < width * height; p++) {
    const s = p * channels
    const d = p * 4
    switch (ihdr.colorType) {
      case 0: // 灰度
        rgba[d] = rgba[d + 1] = rgba[d + 2] = lines[s]
        rgba[d + 3] = 255
        break
      case 2: // RGB
        rgba[d] = lines[s]
        rgba[d + 1] = lines[s + 1]
        rgba[d + 2] = lines[s + 2]
        rgba[d + 3] = 255
        break
      case 3: {
        // 索引色：调色板取色，tRNS 逐索引给 alpha（缺项按不透明）
        const idx = lines[s]
        rgba[d] = palette[idx * 3]
        rgba[d + 1] = palette[idx * 3 + 1]
        rgba[d + 2] = palette[idx * 3 + 2]
        rgba[d + 3] = transparency && idx < transparency.length ? transparency[idx] : 255
        break
      }
      case 4: // 灰度 + alpha
        rgba[d] = rgba[d + 1] = rgba[d + 2] = lines[s]
        rgba[d + 3] = lines[s + 1]
        break
      default: // 6: RGBA
        rgba[d] = lines[s]
        rgba[d + 1] = lines[s + 1]
        rgba[d + 2] = lines[s + 2]
        rgba[d + 3] = lines[s + 3]
    }
  }

  return { width, height, rgba }
}

// ── 缩放 ──────────────────────────────────────────────────────────────────

/**
 * 按面积平均缩放，**alpha 预乘**（见文件头第 2 条）。
 * 支持非整数倍（256 → 48 是 5.333 倍），边缘那一格按覆盖比例加权。
 */
function resize(src, sw, sh, tw, th) {
  if (sw === tw && sh === th) return Buffer.from(src)
  const out = Buffer.alloc(tw * th * 4)
  const xRatio = sw / tw
  const yRatio = sh / th

  for (let y = 0; y < th; y++) {
    const y0 = y * yRatio
    const y1 = (y + 1) * yRatio
    for (let x = 0; x < tw; x++) {
      const x0 = x * xRatio
      const x1 = (x + 1) * xRatio
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      let weight = 0

      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        if (wy <= 0) continue
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
          if (wx <= 0) continue
          const w = wx * wy
          const i = (sy * sw + sx) * 4
          const a = src[i + 3] / 255
          r += src[i] * a * w
          g += src[i + 1] * a * w
          b += src[i + 2] * a * w
          alpha += a * w
          weight += w
        }
      }

      const o = (y * tw + x) * 4
      if (alpha > 0) {
        out[o] = Math.round(r / alpha)
        out[o + 1] = Math.round(g / alpha)
        out[o + 2] = Math.round(b / alpha)
      }
      out[o + 3] = Math.round((alpha / weight) * 255)
    }
  }
  return out
}

/** 最近邻整数倍放大，只给 LOGO_PREVIEW 用 —— 要看清每个像素，不能再做插值 */
function magnify(src, size, factor) {
  const out = Buffer.alloc(size * factor * size * factor * 4)
  const w = size * factor
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / factor) * size + Math.floor(x / factor)) * 4
      const d = (y * w + x) * 4
      src.copy(out, d, s, s + 4)
    }
  }
  return { size: w, rgba: out }
}

// ── PNG 编码 ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 8bit RGBA。逐行试 None / Sub / Up / Paeth 取绝对值和最小的那个（PNG 规范建议的启发式） */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: truecolour + alpha
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)

  for (let y = 0; y < size; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null
    let best = null
    for (const type of [0, 1, 2, 4]) {
      const line = Buffer.alloc(stride)
      let score = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4] : 0
        const b = prev ? prev[i] : 0
        const c = prev && i >= 4 ? prev[i - 4] : 0
        let v
        if (type === 0) v = cur[i]
        else if (type === 1) v = cur[i] - a
        else if (type === 2) v = cur[i] - b
        else {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
        }
        line[i] = v & 0xff
        score += line[i] < 128 ? line[i] : 256 - line[i]
      }
      if (!best || score < best.score) best = { type, line, score }
    }
    raw[y * (stride + 1)] = best.type
    best.line.copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── ICO 打包 ──────────────────────────────────────────────────────────────

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = ICO
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((entry, i) => {
    const o = i * 16
    dir[o] = entry.size >= 256 ? 0 : entry.size // 0 表示 256
    dir[o + 1] = entry.size >= 256 ? 0 : entry.size
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(entry.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// ── 主流程 ────────────────────────────────────────────────────────────────

const source = decodePng(readFileSync(join(ICON_DIR, 'icon.png')))
if (source.width !== source.height) {
  throw new Error(`icon.png 必须是正方形，这张是 ${source.width}×${source.height}`)
}
if (source.width < ICO_SIZES[ICO_SIZES.length - 1]) {
  throw new Error(`icon.png 至少要 ${ICO_SIZES[ICO_SIZES.length - 1]}×，这张只有 ${source.width}×`)
}
console.log(`[ico] 源图 icon.png ${source.width}×${source.height}`)

const entries = ICO_SIZES.map((size) => {
  const rgba = resize(source.rgba, source.width, source.height, size, size)
  return { size, rgba, png: encodePng(size, rgba) }
})

const ico = encodeIco(entries)
writeFileSync(join(ICON_DIR, 'icon.ico'), ico)
for (const e of entries) console.log(`[ico]   ${String(e.size).padStart(3)}px  ${String(e.png.length).padStart(6)} B`)
console.log(`[ico] icon.ico 已写入，共 ${ico.length} B`)

// `src/main/tray/fallback-icon.ts` 的内联兜底图 = `tray.png` 的像素。
// 换了托盘图标要把这一串一起换掉，否则缺资源时托盘会退回上一版美术。
//
// **重新编码一遍而不是直接 base64 原文件**：Photoshop 的「存储为 Web 所用格式」会往
// 16×16 的图里塞约 1 KB 的 XMP 元数据（作者、文档 ID、工具版本），base64 之后变 1.4 KB，
// 全是死重量 —— 而这一串是要贴进 .ts 源码里的。
const trayPng = decodePng(readFileSync(join(ICON_DIR, 'tray.png')))
const trayInline = encodePng(trayPng.width, trayPng.rgba)
console.log(`\n[ico] fallback-icon.ts 用的 base64（tray.png 去掉元数据后重编码，${trayInline.length} B）：`)
console.log(trayInline.toString('base64'))

if (process.env.LOGO_PREVIEW) {
  const dir = mkdtempSync(join(tmpdir(), 'dundian-ico-'))
  for (const e of entries) {
    const big = magnify(e.rgba, e.size, Math.max(1, Math.round(384 / e.size)))
    writeFileSync(join(dir, `ico-${e.size}.png`), encodePng(big.size, big.rgba))
  }
  for (const name of ['tray', 'tray@2x', 'tray-muted', 'tray-muted@2x']) {
    const img = decodePng(readFileSync(join(ICON_DIR, `${name}.png`)))
    const big = magnify(img.rgba, img.width, Math.round(384 / img.width))
    writeFileSync(join(dir, `${name.replace('@', '-')}.png`), encodePng(big.size, big.rgba))
  }
  console.log(`\n[ico] 放大预览：${dir}`)
}
