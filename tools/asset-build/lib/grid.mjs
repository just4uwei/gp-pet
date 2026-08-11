/**
 * 逻辑网格绘图（docs/09 §2.1）。
 *
 * 一切造型都画在 100×100 的**索引网格**上（0 = 全透明），最后整数倍最近邻放大：
 *   ×2 → @1x 200×200，×4 → @2x 400×400。
 *
 * 用调色板索引而不是直接 RGBA，有三个好处，都直接对应 docs/09 的验收项：
 *   - 限色（A3/A4）天然成立：画不出调色板之外的颜色
 *   - alpha 二值（A2）天然成立：索引要么是 0（透明）要么是实色，不存在中间态
 *   - @2x 严格 2 倍（A5）天然成立：同一份索引网格放大两次，不做任何重采样
 *
 * 换句话说，这些验收项不是靠最后检查通过的，是靠数据结构不可能违反。
 */

export const TRANSPARENT = 0

export class Grid {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.px = new Uint8Array(width * height)
  }

  clone() {
    const g = new Grid(this.width, this.height)
    g.px.set(this.px)
    return g
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return TRANSPARENT
    return this.px[y * this.width + x]
  }

  set(x, y, color) {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return
    this.px[yi * this.width + xi] = color
  }

  /** 只在目标像素为透明时落笔，用于「画在背后」 */
  setIfEmpty(x, y, color) {
    if (this.get(x, y) === TRANSPARENT) this.set(x, y, color)
  }

  hLine(x0, x1, y, color) {
    const from = Math.round(Math.min(x0, x1))
    const to = Math.round(Math.max(x0, x1))
    for (let x = from; x <= to; x++) this.set(x, y, color)
  }

  rect(x, y, w, h, color) {
    for (let dy = 0; dy < h; dy++) this.hLine(x, x + w - 1, y + dy, color)
  }

  /** 实心椭圆。cx/cy/rx/ry 可为小数，用于做出偶数宽度 */
  ellipse(cx, cy, rx, ry, color) {
    const top = Math.floor(cy - ry)
    const bottom = Math.ceil(cy + ry)
    for (let y = top; y <= bottom; y++) {
      const ny = (y - cy) / ry
      if (Math.abs(ny) > 1) continue
      const half = rx * Math.sqrt(1 - ny * ny)
      this.hLine(Math.round(cx - half), Math.round(cx + half), y, color)
    }
  }

  /** 胶囊（圆角竖条），用于四肢与尾巴的一段 */
  capsule(x0, y0, x1, y1, radius, color) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, radius, color)
    }
  }

  /** 实心三角形（重心坐标判定），用于耳朵与鼻子 */
  triangle(p0, p1, p2, color) {
    const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]))
    const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]))
    const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]))
    const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]))
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1])
    if (area === 0) return
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((p1[0] - p0[0]) * (y - p0[1]) - (x - p0[0]) * (p1[1] - p0[1])) / area
        const w1 = ((x - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (y - p0[1])) / area
        if (w0 >= -0.02 && w1 >= -0.02 && w0 + w1 <= 1.02) this.set(x, y, color)
      }
    }
  }

  line(x0, y0, x1, y1, color) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      this.set(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color)
    }
  }

  /**
   * 剪影描边：所有「透明且四邻含非透明」的像素涂成描边色。
   * 一次成型保证「剪影外缘统一 1 逻辑像素」（docs/09 §2.4），
   * 也避免逐部件手描导致部件之间出现双层深色边把剪影切碎。
   */
  outline(color) {
    const src = Uint8Array.from(this.px)
    const at = (x, y) =>
      x < 0 || y < 0 || x >= this.width || y >= this.height ? TRANSPARENT : src[y * this.width + x]
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (at(x, y) !== TRANSPARENT) continue
        if (
          at(x - 1, y) !== TRANSPARENT ||
          at(x + 1, y) !== TRANSPARENT ||
          at(x, y - 1) !== TRANSPARENT ||
          at(x, y + 1) !== TRANSPARENT
        ) {
          this.set(x, y, color)
        }
      }
    }
  }

  /** 非透明像素的包围盒，null 表示整幅为空 */
  bounds() {
    let minX = this.width
    let minY = this.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.px[y * this.width + x] === TRANSPARENT) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX, maxY }
  }

  /** 最近邻整数倍放大为 RGBA。palette[0] 必须是透明槽 */
  toRgba(palette, scale) {
    const w = this.width * scale
    const h = this.height * scale
    const out = Buffer.alloc(w * h * 4)
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const index = this.px[y * this.width + x]
        if (index === TRANSPARENT) continue
        const [r, g, b] = palette.rgb(index)
        for (let dy = 0; dy < scale; dy++) {
          let at = ((y * scale + dy) * w + x * scale) * 4
          for (let dx = 0; dx < scale; dx++) {
            out[at] = r
            out[at + 1] = g
            out[at + 2] = b
            out[at + 3] = 255
            at += 4
          }
        }
      }
    }
    return out
  }
}

/** 把若干等大的 RGBA 帧横向拼成精灵图（docs/09 §2.3：单行 N 列，无间隙） */
export function composeSheet(frames, frameWidth, frameHeight) {
  const sheetWidth = frameWidth * frames.length
  const out = Buffer.alloc(sheetWidth * frameHeight * 4)
  frames.forEach((frame, index) => {
    for (let y = 0; y < frameHeight; y++) {
      const src = y * frameWidth * 4
      const dst = (y * sheetWidth + index * frameWidth) * 4
      frame.copy(out, dst, src, src + frameWidth * 4)
    }
  })
  return out
}
