/**
 * 悬浮条「显示哪一只」的判据（docs/06 §2.1）。
 *
 * **2026-08-13 起没有调用方**：悬浮条改成了跑马灯，全部自选轮流显示，
 * 「选哪一只」的问题不存在了，顺序判据搬到了 `ticker.ts`（它的排序规则就是从这里来的）。
 * 留着是因为「一行只显示一只」是气泡摘要、托盘提示这类单行位置随时可能要用的判据；
 * 但**读它之前先确认自己要的不是 `buildTicker`**。
 *
 * 悬浮条只有一行，而自选可能上百只，所以必须选一只。放在 shared 而非 renderer，
 * 理由与 `hit-test.ts` 相同：这是可测的纯判据，不该埋在组件里靠肉眼验收。
 *
 * ## 规则
 *
 * 1. **今日有未静默信号的标的优先**，按置信度降序 —— 悬浮条的存在意义是「值得看一眼」，
 *    而不是「行情牌」。被风控静默的信号（`suppressedReason` 非空）不参与：
 *    它们在面板的日志里可查，但不构成「值得看一眼」（docs/05 §6）。
 * 2. 否则按 **|涨跌幅| 降序** —— 跌 5% 和涨 5% 一样值得看一眼，取绝对值。
 * 3. 同分同幅时按**代码升序**兜底。这一条不是美观问题：没有它，两只涨幅相同的票
 *    会随每轮快照的数组顺序来回跳，一条常驻置顶的条子来回闪比不显示更烦人。
 *
 * 信号那一路只取 `code`：价格与涨跌一律来自本轮快照，**不用信号落库时的 `priceAt`**
 * —— 那是信号产生时刻的价格，显示它等于给用户一个过期的数（docs/03 的 stale 纪律）。
 */

import type { SecCode } from '@core/types'

/** 只要求「有代码和涨跌幅」，方便调用方传完整的 QuoteTick 进来 */
export interface FeaturedQuote {
  code: SecCode
  changePct: number
}

/** 只要求「有代码、置信度与静默原因」，字段与 SignalRecord 的同名子集一致 */
export interface FeaturedSignal {
  code: SecCode
  score: number
  suppressedReason?: string
}

/**
 * 挑出悬浮条要显示的那一只。
 *
 * @param quotes  本轮快照。没有快照的标的不会被选中（宁可不显示，也不显示一个没有价格的名字）
 * @param signals 今日信号；缺省表示还没取到，此时只按涨跌幅选
 * @returns 传入的那个 quote 对象本身（泛型透传，调用方能拿到完整字段），无可选项时为 null
 */
export function pickFeatured<Q extends FeaturedQuote>(
  quotes: readonly Q[],
  signals: readonly FeaturedSignal[] = []
): Q | null {
  if (quotes.length === 0) return null

  const byCode = new Map<SecCode, Q>()
  for (const quote of quotes) if (!byCode.has(quote.code)) byCode.set(quote.code, quote)

  // ① 今日有未静默信号、且本轮有报价的标的
  const actionable = signals
    .filter((signal) => signal.suppressedReason === undefined && byCode.has(signal.code))
    .sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const top = actionable[0]
  if (top) return byCode.get(top.code) ?? null

  // ② 否则看涨跌幅绝对值
  return (
    [...quotes]
      .sort(
        (a, b) =>
          Math.abs(b.changePct) - Math.abs(a.changePct) ||
          (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
      )
      .at(0) ?? null
  )
}
