/**
 * 一份日报「事实层」的指纹（2026-08-14）。**纯函数**：不读时钟、不碰 IO。
 *
 * ## 它在挡什么
 *
 * 日报有两个阶段：盘后即时版（数字取自盘中最后一次行情）与次日定稿版（当日收盘线）。
 * 用户在即时版上点了「让 AI 评一下」，那段话是**对着那一版事实**写的；
 * 第二天日线补齐、报告定稿之后，同一段话可能已经与屏幕上的数字对不上 ——
 * 而它读起来完全正常，用户没有任何办法看出它过期了。
 *
 * 存一个指纹，界面就能如实说「这段是基于盘中数据写的」。
 * 这与「stale 快照必须灰显」「LOCAL 分时必须标注覆盖起点」是同一条纪律：
 * **不假装，也不让用户自己去发现。**
 *
 * ## 取哪些字段
 *
 * 只取**会让评价失效**的那些：阶段、每只票的收盘价与信号方向、明日关注的条数。
 * 刻意**不取** `at`（生成时刻）与 `highlights`（它是从这些数派生的）——
 * 把派生量或时刻放进去会让指纹每次都变，于是提示恒亮，等于没有这个功能。
 */

import type { DailyReport } from '@shared/ipc-types'

/**
 * FNV-1a。与 `core/params.ts` 的 `paramsFingerprint` 同一个理由：
 * 这里只需要「变了就不一样」，不需要抗碰撞，而 `src/main/report` 这一层
 * 引 node:crypto 没有必要（它也要能在纯函数用例里跑）。
 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function reportFactDigest(report: DailyReport): string {
  const parts: string[] = [report.date, report.stage]
  for (const stock of report.stocks) {
    parts.push(
      [
        stock.code,
        // 价格取两位小数：最后一位的浮点噪声不该让指纹变
        stock.quote === null ? '-' : `${stock.quote.close.toFixed(2)}:${stock.quote.source}`,
        stock.signals.last?.direction ?? '-',
        stock.position ? 'P' : '-',
      ].join(':')
    )
  }
  parts.push(`T${report.tomorrow.length}`)
  return fnv1a(parts.join('|'))
}
