/**
 * 悬浮条滚动内容的判据（docs/06 §2.1）。
 *
 * 与 `featured.ts` 的关系：那条规则解决「一行只能显示一只」，这条解决
 * 「**全部自选轮流显示**」—— 条子改成跑马灯之后，选谁不再是问题，**先后顺序**才是。
 * 放在 shared 而非组件里，理由与 `hit-test.ts` / `featured.ts` 相同：
 * 这是可测的纯判据，不该埋在 JSX 里靠肉眼验收。
 *
 * ## 规则
 *
 * 1. **今日有未静默信号的排在前面**，按置信度降序。被风控静默的信号
 *    （`suppressedReason` 非空）不算 —— 它们在面板的提醒日志里可查，
 *    但不构成「值得看一眼」（docs/05 §6）。
 * 2. 其余按 **|涨跌幅| 降序**；本轮没有报价的排在最后（宁可排后面，也不拿 0 占位）。
 * 3. 同分同幅按**代码升序**兜底 —— 没有它，两只涨跌相同的票会随每轮快照的数组
 *    顺序来回换位，一条常驻置顶的跑马灯来回抖比不显示更烦人。
 *
 * ## 两条纪律
 *
 * - **没有报价就是 `null`，不是 0**（与约束 4 同一条纪律）：条子上显示「—」，
 *   绝不显示一个不存在的价格。
 * - **没有信号就是 `action: null`，不是「观望」**：引擎今天没说话，条子就不许
 *   替它说一句像建议的话。渲染层把 `null` 画成「无信号」，而不是任何带方向的词。
 *
 * 动作标签取**当日最后一条**未静默信号的方向，不是得分最高的那条：
 * 收盘失效提示（`direction: 'NONE'`）的全部意义就是「上午那条别当真了」，
 * 让它被上午那条得分更高的买入盖住，等于把撤销吞掉（docs/05 §4）。
 */

import type { AlertLevel, GatedDirection, SecCode } from '@core/types'

/** 只要求「有代码和名称」，方便调用方直接传 WatchItem */
export interface TickerItem {
  code: SecCode
  name: string
}

/** 字段与 QuoteTick 的同名子集一致 */
export interface TickerQuote {
  code: SecCode
  last: number
  changePct: number
  stale: boolean
}

/** 字段与 SignalRecord 的同名子集一致 */
export interface TickerSignal {
  code: SecCode
  name: string
  createdAt: number
  direction: GatedDirection
  score: number
  level: AlertLevel
  suppressedReason?: string
}

export interface TickerEntry {
  code: SecCode
  name: string
  /** 本轮没有报价时为 null（绝不填 0） */
  last: number | null
  changePct: number | null
  /** 价格取自缓存 —— 渲染层必须灰显，不假装实时 */
  stale: boolean
  /** 今日无未静默信号时为 null，渲染层不得据此编一个方向出来 */
  action: GatedDirection | null
  level: AlertLevel | null
  score: number | null
}

/**
 * 「顺序该不该重排」的指纹：**代码集合与各自的方向**，价格与涨跌幅不参与。
 *
 * 排序规则里有 |涨跌幅|，而涨跌幅每一轮取数都在变 —— 直接按每轮结果重排，
 * 跑马灯会在滚动过程中把条目换位，看起来像卡带。所以位置只在
 * 「加/删了标的」或「某只票今天的方向变了」时才动，其余时候原地更新数字。
 */
export function orderFingerprint(entries: readonly TickerEntry[]): string {
  return entries
    .map((entry) => `${entry.code}:${entry.action ?? '-'}`)
    .sort()
    .join(',')
}

/** 按给定的代码顺序重排；不在其中的（本轮新出现）留在末尾，相对次序不变 */
export function applyOrder(entries: readonly TickerEntry[], codes: readonly SecCode[]): TickerEntry[] {
  const rank = new Map<SecCode, number>()
  codes.forEach((code, index) => {
    if (!rank.has(code)) rank.set(code, index)
  })
  return [...entries].sort(
    (a, b) => (rank.get(a.code) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.code) ?? Number.MAX_SAFE_INTEGER)
  )
}

function compareCode(a: SecCode, b: SecCode): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 排序用的「值得看一眼」的幅度。没有报价记 -1，排在所有有报价的后面 */
function moveOf(entry: TickerEntry): number {
  return entry.changePct === null ? -1 : Math.abs(entry.changePct)
}

/**
 * 排出悬浮条要滚动的全部条目。
 *
 * @param items   自选列表。首轮基础信息补齐前可能为空，此时名称退到信号里的名称、再退到代码
 * @param quotes  本轮快照
 * @param signals 今日信号；缺省表示还没取到，此时全部条目都是「无信号」
 */
export function buildTicker(
  items: readonly TickerItem[],
  quotes: readonly TickerQuote[],
  signals: readonly TickerSignal[] = []
): TickerEntry[] {
  const quoteOf = new Map<SecCode, TickerQuote>()
  for (const quote of quotes) if (!quoteOf.has(quote.code)) quoteOf.set(quote.code, quote)

  // 当日最后一条未静默信号（见文件头：撤销提示不能被上午那条盖住）
  const signalOf = new Map<SecCode, TickerSignal>()
  for (const signal of signals) {
    if (signal.suppressedReason !== undefined) continue
    const prev = signalOf.get(signal.code)
    if (prev === undefined || signal.createdAt >= prev.createdAt) signalOf.set(signal.code, signal)
  }

  const nameOf = new Map<SecCode, string>()
  // 自选列表是名称的权威来源；信号里的名称只在自选还没读到时兜底
  for (const signal of signals) nameOf.set(signal.code, signal.name)
  for (const item of items) nameOf.set(item.code, item.name)

  // 自选是主集合；报价与信号里多出来的代码也带上（刚加进来、自选还没重取的那一瞬）
  const codes = new Set<SecCode>([
    ...items.map((item) => item.code),
    ...quotes.map((quote) => quote.code),
    ...signalOf.keys(),
  ])

  const entries: TickerEntry[] = [...codes].map((code) => {
    const quote = quoteOf.get(code)
    const signal = signalOf.get(code)
    return {
      code,
      name: nameOf.get(code) ?? code,
      last: quote?.last ?? null,
      changePct: quote?.changePct ?? null,
      stale: quote?.stale ?? false,
      action: signal?.direction ?? null,
      level: signal?.level ?? null,
      score: signal?.score ?? null,
    }
  })

  return entries.sort((a, b) => {
    const rank = Number(a.action === null) - Number(b.action === null)
    if (rank !== 0) return rank
    if (a.action !== null && b.action !== null) {
      const byScore = (b.score ?? 0) - (a.score ?? 0)
      if (byScore !== 0) return byScore
    }
    // 无报价排最后：|涨跌幅| 恒 ≥ 0，所以 -1 是安全的哨兵（注意 abs 要在判空之后取）
    const byMove = moveOf(b) - moveOf(a)
    if (byMove !== 0) return byMove
    return compareCode(a.code, b.code)
  })
}
