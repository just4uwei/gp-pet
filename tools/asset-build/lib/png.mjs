/**
 * 零依赖 PNG 编解码（8-bit RGBA，color type 6）。
 *
 * 为什么自己写而不引 sharp/pngjs：素材生成是一次性构建工具，
 * 不该给运行时依赖树增加一个原生模块（sharp 带 libvips，安装体积与 CI 成本都不小）。
 * 而且 docs/09 §2.1 明令禁止抗锯齿、要求 alpha 二值 —— 通用图像库的默认行为
 * （插值缩放、色彩管理）恰恰是这里最不想要的，自己写反而更可控。
 *
 * 编码固定用 filter 0（None）：像素画大片同色，deflate 本身压得很好，
 * 不做行滤波换来的是解码端可以极简、且输出字节完全可预测。
 */

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

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
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/** @param {number} width @param {number} height @param {Buffer} rgba */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  if (rgba.length !== stride * height) {
    throw new Error(`RGBA 长度不符：期望 ${stride * height}，实际 ${rgba.length}`)
  }
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** @returns {{width:number,height:number,data:Buffer}} data 为 RGBA */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG')

  let pos = 8
  let width = 0
  let height = 0
  const idat = []

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) {
        throw new Error(`只支持 8-bit RGBA，实际 depth=${data[8]} colorType=${data[9]}`)
      }
      if (data[12] !== 0) throw new Error('不支持隔行 PNG')
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }

  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]
      const a = i >= bpp ? out[dst + i - bpp] : 0
      const b = y > 0 ? out[dst - stride + i] : 0
      const c = i >= bpp && y > 0 ? out[dst - stride + i - bpp] : 0
      let value
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + a
          break
        case 2:
          value = x + b
          break
        case 3:
          value = x + ((a + b) >> 1)
          break
        case 4:
          value = x + paeth(a, b, c)
          break
        default:
          throw new Error(`未知 filter：${filter}`)
      }
      out[dst + i] = value & 0xff
    }
  }

  return { width, height, data: out }
}

/**
 * ICO 容器。各尺寸单独排布的位图由调用方给出（docs/09 §6.2：不得由同一张图缩放）。
 * 条目一律用 PNG 压缩形式 —— Windows Vista 起支持，本产品只面向 Windows 10/11。
 * @param {{size:number, png:Buffer}[]} entries
 */
export function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach((entry, i) => {
    const at = i * 16
    // 256 在目录项里以 0 表示
    dir[at] = entry.size >= 256 ? 0 : entry.size
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir[at + 2] = 0 // 调色板颜色数
    dir[at + 3] = 0 // reserved
    dir.writeUInt16LE(1, at + 4) // color planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}
