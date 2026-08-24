/**
 * 从 PDF 里抽正文 —— **学习任务专用**（核对外部公式与算例，不进应用）。
 *
 * ```bash
 * curl -sSL --max-time 40 -o /tmp/paper.pdf "https://…/paper.pdf"
 * node scripts/verify/pdf-text.mjs /tmp/paper.pdf "Table 3" "3/5"
 * BEFORE=1000 AFTER=100 node scripts/verify/pdf-text.mjs /tmp/paper.pdf "Trade duration"
 * ```
 *
 * ## 为什么值得进仓库
 *
 * 这段逻辑（Flate 流 + 括号字符串）**已经被现写现丢三次**：2026-08-20（DSR）·
 * 08-21（Lo 2002）· 08-24（Almgren 2005，M2 §5.54）。
 * [信源台账](../../docs/notes/信源台账.md) §8 记着「PDF 正文可以本机提取」这条结论，
 * 却没有任何一处存着实现 ⇒ 每轮学习任务都要重写一遍，而重写会犯不同的错
 * （08-24 那次在 `node -e` 里写正则，反斜杠被 shell 吃掉、报 "Invalid regular expression"）。
 *
 * ## 边界
 *
 * - **只处理 Flate 压缩的内容流 + 括号字符串**，不做字形映射、不还原版面。
 *   ⇒ 表格会被拉成一行、连字符与特殊字符留着 `\016` 这类八进制转义。
 *   **这够用**：我们要的是「找到那个数并核对」，不是重排文档。
 * - 抽不出来（加密 / 纯扫描件 / 非 Flate）就是抽不出来，**不猜**。
 * - 命中不到关键词打印 `(未见)` —— 别读成「原文没这个说法」，也可能是被版面切断了。
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('用法：node scripts/verify/pdf-text.mjs <pdf> [关键词...]（BEFORE/AFTER 控制上下文字数）')
  process.exit(2)
}

const buf = readFileSync(path)
const chunks = []
let i = 0
for (;;) {
  const s = buf.indexOf('stream', i)
  if (s < 0) break
  let p = s + 6
  if (buf[p] === 13) p++
  if (buf[p] === 10) p++
  const e = buf.indexOf('endstream', p)
  if (e < 0) break
  try {
    chunks.push(zlib.inflateSync(buf.subarray(p, e)).toString('latin1'))
  } catch {
    // 非 Flate 或损坏的流：跳过，不猜
  }
  i = e + 9
}

const raw = chunks.join('\n')
const text = [...raw.matchAll(/\((?:\\.|[^()\\])*\)/g)]
  .map((m) => m[0].slice(1, -1).replace(/\\([()\\])/g, '$1'))
  .join(' ')
  .replace(/\s+/g, ' ')

console.log(`流 ${chunks.length} 段 · 正文 ${text.length} 字`)
const before = Number(process.env.BEFORE ?? 200)
const after = Number(process.env.AFTER ?? 300)
for (const kw of process.argv.slice(3)) {
  const idx = text.indexOf(kw)
  console.log(`\n== ${kw} ==\n${idx >= 0 ? text.slice(Math.max(0, idx - before), idx + after) : '(未见)'}`)
}
