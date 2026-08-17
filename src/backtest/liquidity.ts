/**
 * 池层面的流动性 / 市值过滤（预注册见 [M2 §5.29](../../docs/notes/M2-偏差报告.md)）。
 *
 * 回答的问题是「**这一天该不该在这只票上建仓**」，而不是「参数取多少」——
 * 标的池是按代码段等距抽样的（`scripts/build-universe.mjs` 刻意不按市值/流动性筛），
 * 所以它含大量微型、低流动性标的，而 2018–2023 的 A 股小市值段系统性亏钱。
 * 这一层就是去检验「训练窗口的亏损里有多少来自本来就不该交易的标的」。
 *
 * ## 四条口径，全部在跑之前定死（§5.29）
 *
 * 1. **逐日、点内判定。** 用整段中位数算分位是**前视偏差** —— 那会让结论无效。
 *    每一天的分位只用**那一天的横截面**与**过去 20 个交易日**的成交额。
 * 2. **横截面只在本池之内。** 池外没有数据，所以「最小 30%」是相对这 261 只而言，
 *    不是相对全市场。报告里必须写明（`describe()` 会打出来）。
 * 3. **只挡建仓，不挡离场。** 已持有的仓位必须能正常止损/减仓 ——
 *    挡住卖出会造出永远持有的仓，那是凭空改变风控行为。
 * 4. **缺数不构成剔除理由。** `floatCap` 为 null（停牌日、上市首日换手率为 0）时
 *    既不参与分位计算、**也不挡建仓**。宁可少剔一只，不可因为「那天没数据」
 *    就把一只正常标的判出去 —— 与 CLAUDE.md 约束 4 同一个方向。
 *
 * ## 它不是什么
 *
 * **不是引擎里的新风控裁决。** 用户 2026-08-17 明确「出手频率不能再少」，
 * 而这一层只作用于**回测的标的池**，不影响实盘每天出几条信号。
 * 若这一轮证明它有效，「搬不搬进引擎」是**下一次**独立的取舍。
 */

// 相对路径而不是 `@core/*`：CLI 由 tsx 直接跑，根 tsconfig 是 solution 风格、不带 paths
import type { SecCode, TradeDate } from '../core/types'

/** `data/liquidity/<CODE>.json` 里的一行（由 `scripts/fetch-liquidity.mjs` 产出） */
export interface LiquidityRow {
  date: TradeDate
  amount: number | null
  turnoverRate: number | null
  avgPrice: number | null
  floatShares: number | null
  /** **流通**市值（元），不是总市值 */
  floatCap: number | null
}

export interface LiquiditySeries {
  code: SecCode
  rows: readonly LiquidityRow[]
}

export interface FilterSpec {
  /** 剔除当日横截面流通市值最小的百分比（0 = 不按市值剔） */
  dropCapPct: number
  /** 剔除当日「过去 N 日均成交额」最小的百分比（0 = 不按流动性剔） */
  dropAmountPct: number
  /** 成交额取多少个交易日的均值。§5.29 定的是 20 */
  amountWindow: number
}

export const DEFAULT_AMOUNT_WINDOW = 20

export interface PoolFilter {
  /** 这一天允许在这只票上**建仓**吗。缺数一律 true（口径 4） */
  allows(code: SecCode, date: TradeDate): boolean
  /** 报告用：一句话说清这次按什么剔的 */
  describe(): string
  /** 报告用：逐票被挡掉的判定根数（只统计「有数据且被剔」的） */
  blockedBars(): number
  /** 完全没有流动性数据的标的（**必须报出来**，否则「没剔」会被读成「都合格」） */
  missing(): readonly SecCode[]
}

/** 恒真过滤器：`--liquidity` 没给时用它 ⇒ 行为与以前逐位相同 */
export const ALLOW_ALL: PoolFilter = {
  allows: () => true,
  describe: () => '未启用（未给 --liquidity）',
  blockedBars: () => 0,
  missing: () => [],
}

/**
 * 过去 `window` 个**有值**交易日的成交额均值（含当日）。
 *
 * 用「有值的最近 window 个」而不是「最近 window 行里有值的」：
 * 长期停牌的票不该因为停牌期而被算成低流动性 —— 那是两件事。
 * 不足 window 个时用已有的算（回测起点附近），少于 1 个则为 null。
 */
export function trailingAmount(
  rows: readonly LiquidityRow[],
  index: number,
  window: number
): number | null {
  let sum = 0
  let count = 0
  for (let i = index; i >= 0 && count < window; i--) {
    const amount = rows[i]?.amount
    if (amount === null || amount === undefined) continue
    sum += amount
    count++
  }
  return count === 0 ? null : sum / count
}

/**
 * 下侧分位阈值：返回「最小 pct% 的上边界」，**低于它**的被剔。
 *
 * 空数组返回 null（谁都不剔）。pct ≤ 0 同理。
 * 取法是排序后按 `floor(n × pct / 100)` 取第 k 个 —— k = 0 时返回 null，
 * 也就是**样本太少时不剔**：3 只票剔 30% 会变成剔掉 0 只，那是对的
 * （一个横截面只有 3 只的日子，分位没有意义）。
 */
export function lowerThreshold(values: readonly number[], pct: number): number | null {
  if (pct <= 0 || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const k = Math.floor((sorted.length * pct) / 100)
  return k <= 0 ? null : (sorted[k] ?? null)
}

/**
 * 建过滤器。**一次性算完所有日子的排除集**（261 只 × 约 2000 天，几十万行，毫秒级），
 * 而不是查询时再算 —— 逐日重排会让回测慢一个量级。
 */
export function createPoolFilter(
  series: readonly LiquiditySeries[],
  codes: readonly SecCode[],
  spec: FilterSpec
): PoolFilter {
  const byCode = new Map<SecCode, LiquiditySeries>(series.map((s) => [s.code, s]))
  const missing = codes.filter((code) => !byCode.has(code))
  if (spec.dropCapPct <= 0 && spec.dropAmountPct <= 0) return ALLOW_ALL

  /** date → code → { cap, amount20 }。只放**有值**的，缺数的天然不参与分位 */
  const cross = new Map<TradeDate, Map<SecCode, { cap: number | null; amount: number | null }>>()
  for (const one of series) {
    if (!codes.includes(one.code)) continue
    one.rows.forEach((row, index) => {
      const amount = spec.dropAmountPct > 0 ? trailingAmount(one.rows, index, spec.amountWindow) : null
      const cap = spec.dropCapPct > 0 ? row.floatCap : null
      if (cap === null && amount === null) return
      let day = cross.get(row.date)
      if (!day) {
        day = new Map()
        cross.set(row.date, day)
      }
      day.set(one.code, { cap, amount })
    })
  }

  const blocked = new Map<TradeDate, Set<SecCode>>()
  let blockedBars = 0
  for (const [date, day] of cross) {
    const caps: number[] = []
    const amounts: number[] = []
    for (const value of day.values()) {
      if (value.cap !== null) caps.push(value.cap)
      if (value.amount !== null) amounts.push(value.amount)
    }
    const capFloor = lowerThreshold(caps, spec.dropCapPct)
    const amountFloor = lowerThreshold(amounts, spec.dropAmountPct)
    if (capFloor === null && amountFloor === null) continue
    const out = new Set<SecCode>()
    for (const [code, value] of day) {
      // 两条都是「低于阈值就剔」，任一命中即剔（两者并用时是交集之外，不是并集之内）
      const byCap = capFloor !== null && value.cap !== null && value.cap < capFloor
      const byAmount = amountFloor !== null && value.amount !== null && value.amount < amountFloor
      if (byCap || byAmount) out.add(code)
    }
    if (out.size > 0) {
      blocked.set(date, out)
      blockedBars += out.size
    }
  }

  const parts: string[] = []
  if (spec.dropCapPct > 0) parts.push(`流通市值最小 ${spec.dropCapPct}%`)
  if (spec.dropAmountPct > 0) parts.push(`${spec.amountWindow} 日均成交额最小 ${spec.dropAmountPct}%`)

  return {
    allows: (code, date) => !(blocked.get(date)?.has(code) ?? false),
    describe: () =>
      `逐日剔除${parts.join(' 与 ')}（横截面**仅本池 ${codes.length} 只之内**，缺数不剔）`,
    blockedBars: () => blockedBars,
    missing: () => missing,
  }
}
