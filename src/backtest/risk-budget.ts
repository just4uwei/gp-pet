#!/usr/bin/env node
/**
 * 配置形态的**第三个可证伪实验**：股 + 债 + 金的**等风险贡献（ERC）** vs 同一批资产的
 * **固定权重再平衡**。
 *
 * ```bash
 * pnpm exp:risk-budget -- --fixtures ./data/history
 * ```
 *
 * ## 它在回答什么，以及它与前两轮差在哪
 *
 * 前两轮测的都是同一条规则 `w = min(1, σ_target/σ_t)` —— 一个**对自身波动率的时序反应**
 * （降不降总暴露）。它在[论证 §8](../../docs/notes/配置形态-论证.md) 与 §12 被自己的判据
 * 各否过一次，失败机制是「对波动率对称、对方向中立 ⇒ 只压得住快跌，压不住阴跌」。
 *
 * 本轮换成**横截面**配置：**总暴露恒为满仓**，变的只是钱在三条腿上怎么分。
 * ⇒ §12.1 那个失败机制不自动搬过来（它从不降总暴露）。
 * ⚠ **但不许说「这条完全不依赖波动率」** —— 协方差仍然要估。差别是
 * **它不用波动率决定要不要在市场里，只用它决定钱放在哪条腿上**。
 *
 * 预注册（规则 · 窗口 · 判据 · 停止规则 · 六条预测）全部写在**看到结果之前**，
 * 出处是[论证 §13](../../docs/notes/配置形态-论证.md)，本文件不重复一份
 * —— 一件事只有一个出处。下面只留三条**代码层面**必须一起读的东西。
 *
 * ## ⚠ 三条不许省的读数纪律
 *
 * 1. **承重的对照是「同一批资产的固定权重」，不是「满仓宽基」。**
 *    国债 ETF 的波动率只有宽基的 1/10 量级 ⇒ ERC 必然给出压倒性的债券权重
 *    ⇒ 曲线基本就是「持有国债」，而 2013–2023 恰好是国债牛市。
 *    拿满仓宽基当对照，量到的是**资产选择（beta）不是配置能力** ——
 *    与 §5.13（超额离开占用率会被读反）和 GH1 同一个形状，本项目已因此判错过两次。
 *    「vs 满仓宽基」那一列照样打印，**但它不承重**（论证 §13.2）。
 * 2. **判定用 t 日收盘的数据，权重从 t+1 日的收益开始生效。** 同日生效就是未来函数。
 *    协方差窗口取 `[i−COV_WINDOW, i−1]`，**不含今天**。
 * 3. **预热段不进绩效。** 段前历史留在收益序列里做预热，但不进净值 ——
 *    `--grid` 那次踩过（不切回本段会让验证集年化被压小 5.1 倍，M2 §5.13）。
 *    实现上靠 `indices` 只装评估期的下标。
 *
 * ## 一处刻意的重复：多腿净值自己算
 *
 * `vol-target.ts` 的 `simulatePath` 是**标量仓位**的（一条腿 + 现金），套不进三腿。
 * 这里另写 `simulateLegs`，但**成本记账与绩效口径逐字对齐它**
 * （换手在这一根开盘前发生 ⇒ 先扣费再吃当日收益；`oneWayRate = slippage + commissionRate`；
 * ETF 载体免印花税与过户费）。两处数字要能并排读，那是 CLAUDE.md 那条横向边的全部理由。
 */

import { DEFAULT_COSTS, type CostModel } from './costs'
import { andrewsLag } from './ic-audit'
import {
  BARS_PER_YEAR,
  mean,
  sameRiskPassive,
  sampleStdev,
  sharpeDiffHac,
  type SameRiskPassive,
  type SharpeDiffResult,
} from './metrics'
import type { TradeDate } from '../core/types'
import { loadBars, returnsOfBars, type Bar } from './vol-target'

/**
 * 预注册的常量（论证 §13.4）。**导出**是为了下一个实验要用时不许照抄一份
 * —— 同 `vol-target.ts` 里 `SIGMA_TARGET` 那条头注释。
 *
 * ⚠ **它们不许被搜索。** `COV_WINDOW = 60` 在论证 §13.4 预注册过一次，
 * 而 §13.5 ② 明写着「换成 20 或 120 结果可能不同，而本轮没有资格去看那件事」。
 */
export const COV_WINDOW = 60
export const LEGS = [
  { code: 'SH510300', name: '沪深300ETF' },
  { code: 'SH511010', name: '国债ETF' },
  { code: 'SH518880', name: '黄金ETF' },
] as const
/** 固定权重对照：等权。**唯一一组**（论证 §13.4：不设第二组） */
export const FIXED_WEIGHTS = [1 / 3, 1 / 3, 1 / 3] as const

interface Window {
  name: string
  from: string
  to: string
  note: string
}

const WINDOWS: readonly Window[] = [
  { name: '训练', from: '2013-07-29', to: '2018-12-31', note: '起点 = 黄金ETF 上市日（不是抓取缺口）' },
  { name: '验证', from: '2019-01-01', to: '2023-12-31', note: '不碰 2024 之后（沿用论证 §5）' },
]

export interface ArmResult {
  label: string
  totalReturn: number
  annualized: number | null
  maxDrawdown: number
  sharpe: number | null
  calmar: number | null
  /** 平均暴露。本实验三条组合腿恒为 1（满仓），留着是为了让这件事可见（§5.13） */
  exposure: number
  /** 各腿平均权重，与 `LEGS` 同序 */
  legWeights: number[]
  rebalances: number
  turnover: number
  costPaid: number
  bars: number
  daily: number[]
  /** 净值曲线（含起点 1）。**GH1 与回撤共用它** —— 各算一遍会让两个数出自两套代码 */
  equity: number[]
}

/** 单边成本率。与 `vol-target.ts` 的 `oneWayRate` 逐字同口径 */
function oneWayRate(costs: CostModel): number {
  return costs.slippage + costs.commissionRate
}

function maxDrawdownOf(equity: readonly number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of equity) {
    if (v > peak) peak = v
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak)
  }
  return worst
}

/**
 * 样本协方差矩阵（总体口径 ÷n 与 `sampleStdev` 的 ÷(n−1) 不同，这里用 ÷(n−1) 保持一致）。
 *
 * `rows[t][k]` = 第 t 期第 k 条腿的收益。
 */
export function covarianceMatrix(rows: readonly (readonly number[])[]): number[][] {
  const n = rows.length
  const k = rows[0]?.length ?? 0
  const mu = Array.from({ length: k }, (_, j) => mean(rows.map((r) => r[j] ?? 0)))
  const cov = Array.from({ length: k }, () => Array.from({ length: k }, () => 0))
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      let s = 0
      for (const r of rows) s += ((r[a] ?? 0) - (mu[a] ?? 0)) * ((r[b] ?? 0) - (mu[b] ?? 0))
      const row = cov[a]
      if (row) row[b] = n > 1 ? s / (n - 1) : 0
    }
  }
  return cov
}

/**
 * **等风险贡献**（ERC / risk parity）：解 `w_i · (Σw)_i` 对所有 i 相等，`Σw = 1`、`w ≥ 0`。
 *
 * 解法是**循环坐标下降**（CCD），归属 **Griveau-Billion, Richard & Roncalli (2013)**,
 * *A fast algorithm for computing high-dimensional risk parity portfolios*：
 * ERC 是下面这个严格凸问题的解（再归一化），
 *
 * ```
 * min  ½ w′Σw − (1/k)·Σ ln w_i        w > 0
 * ```
 *
 * 对第 i 个坐标求偏导置零得一个一元二次方程 `α w_i² + β w_i + γ = 0`，
 * `α = Σ_ii`、`β = Σ_{j≠i} Σ_ij w_j`、`γ = −1/k`
 * ⇒ 取正根 `w_i = (−β + √(β² − 4αγ)) / (2α)`。
 * `γ < 0 ⇒ 判别式恒 > 0 且正根唯一` ⇒ **每一步都给出严格正的权重**。
 *
 * ## ⚠ 为什么不是那条更好写的不动点迭代（2026-08-27 实测踩到）
 *
 * 常被引用的 `w_i ← (1/(Σw)_i) / Σ_j (1/(Σw)_j)` 在这三条腿上**振荡并发散**：
 * 实测第 0/1/2/3 步的债腿权重是 `0.333 → 0.967 → 0.280 → 0.998`，
 * 第 3 步某条腿的边际风险直接变成负数（`−1.31e-6`）⇒ 抛错。
 * 根因是三腿的方差差两个量级（宽基 1.29e-4 · 国债 **2.18e-6** · 黄金 1.14e-4），
 * 那条迭代没有阻尼、一步跨到解的另一侧。**CCD 不需要阻尼，也不需要挑步长。**
 *
 * ⚠ **不收敛就抛错，不许静默退回等权** —— 那会让「ERC 这一臂」变成「有时是等权」，
 * 而净值曲线上完全看不出来（本项目最贵的那一类缺陷）。
 */
export function erc(cov: readonly (readonly number[])[], maxIter = 10_000, tol = 1e-12): number[] {
  const k = cov.length
  if (k === 0) throw new Error('ERC：协方差矩阵是空的')
  for (let i = 0; i < k; i++) {
    const v = cov[i]?.[i]
    // 对角非正 ⇒ 这一段某条腿没有波动，协方差不可用。抛错而不是猜一个权重
    if (v === undefined || !(v > 0)) throw new Error(`ERC：第 ${i} 条腿的方差非正，协方差矩阵退化`)
  }
  // 起点用 1/σ_i 归一化（风险平价的一阶近似），比等权少几步
  const sd = Array.from({ length: k }, (_, i) => Math.sqrt(cov[i]?.[i] ?? 0))
  const inv0 = sd.map((v) => 1 / v)
  const sum0 = inv0.reduce((a, b) => a + b, 0)
  const w = inv0.map((v) => v / sum0)

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0
    for (let i = 0; i < k; i++) {
      const alpha = cov[i]?.[i] ?? 0
      let beta = 0
      for (let j = 0; j < k; j++) {
        if (j !== i) beta += (cov[i]?.[j] ?? 0) * (w[j] ?? 0)
      }
      const gamma = -1 / k
      const next = (-beta + Math.sqrt(beta * beta - 4 * alpha * gamma)) / (2 * alpha)
      if (!Number.isFinite(next) || next <= 0) throw new Error(`ERC：第 ${i} 条腿解出非正权重`)
      moved = Math.max(moved, Math.abs(next - (w[i] ?? 0)))
      w[i] = next
    }
    if (moved < tol) {
      const total = w.reduce((a, b) => a + b, 0)
      return w.map((v) => v / total)
    }
  }
  throw new Error(`ERC：${maxIter} 次迭代未收敛`)
}

/**
 * 跑一条多腿净值。
 *
 * @param returns  `returns[t][k]` 第 t 期第 k 条腿的收益
 * @param weights  `weights[t][k]` 第 t 期**已生效**的权重（调用方保证只用了 t−1 及以前的信息）
 */
export function simulateLegs(
  label: string,
  returns: readonly (readonly number[])[],
  weights: readonly (readonly number[])[],
  costs: CostModel
): ArmResult {
  const rate = oneWayRate(costs)
  const k = LEGS.length
  const equity: number[] = [1]
  const daily: number[] = []
  const weightSum = Array.from({ length: k }, () => 0)
  let value = 1
  let held = Array.from({ length: k }, () => 0)
  let rebalances = 0
  let turnover = 0
  let costPaid = 0

  for (let t = 0; t < returns.length; t++) {
    const w = weights[t] ?? []
    const r = returns[t] ?? []
    // 换手发生在这一根开盘之前（权重由 t−1 收盘定），成本先扣再吃当日收益
    let delta = 0
    for (let j = 0; j < k; j++) delta += Math.abs((w[j] ?? 0) - (held[j] ?? 0))
    if (delta > 1e-12) {
      const fee = value * delta * rate
      costPaid += fee
      value -= fee
      turnover += delta
      rebalances++
      held = w.slice()
    }
    let portfolioReturn = 0
    for (let j = 0; j < k; j++) {
      portfolioReturn += (w[j] ?? 0) * (r[j] ?? 0)
      weightSum[j] = (weightSum[j] ?? 0) + (w[j] ?? 0)
    }
    const before = value
    value *= 1 + portfolioReturn
    daily.push(before > 0 ? value / before - 1 : 0)
    equity.push(value)
  }

  const totalReturn = value - 1
  const bars = returns.length
  const years = bars / BARS_PER_YEAR
  const growth = 1 + totalReturn
  const annualized = years <= 0 ? null : growth <= 0 ? -1 : growth ** (1 / years) - 1
  const sd = sampleStdev(daily)
  const sharpe = daily.length < 2 || sd === 0 ? null : (mean(daily) / sd) * Math.sqrt(BARS_PER_YEAR)
  const drawdown = maxDrawdownOf(equity)
  const legWeights = weightSum.map((s) => (bars > 0 ? s / bars : 0))
  return {
    label,
    totalReturn,
    annualized,
    maxDrawdown: drawdown,
    sharpe,
    // 回撤为 0 时不给 Infinity —— 与 calibrate.ts 的 calmar() 同一条守卫
    calmar: annualized === null ? null : drawdown <= 0 ? null : annualized / drawdown,
    exposure: legWeights.reduce((a, b) => a + b, 0),
    legWeights,
    rebalances,
    turnover,
    costPaid,
    bars,
    daily,
    equity,
  }
}

export interface LegData {
  /** 三腿共有的交易日（升序） */
  dates: string[]
  /** `rets[t][k]`，与 `dates` 同序；首日之后每期都有值 */
  rets: number[][]
  /** 各腿自己有多少天被丢掉（不在共同日历里）—— 必须打印，静默丢日子会让「共同窗口」变成假话 */
  dropped: number[]
}

/**
 * 把三条腿对齐成一份共同日历。
 *
 * ⚠ **缺任一腿的日子整天跳过，并把跳掉的天数带出来。** 静默丢日子会让
 * 「共同窗口 10.5 年」这句话变成假的 —— 与 M2 §5.56 那条「只统计被匹配上的那些」同源。
 */
export function alignLegs(fixtures: string): LegData {
  const perLeg = LEGS.map((leg) => {
    const bars: Bar[] = loadBars(fixtures, leg.code)
    const rets = returnsOfBars(bars)
    const map = new Map<string, number>()
    bars.forEach((b, i) => {
      const r = rets[i]
      if (r !== null && r !== undefined) map.set(b.date, r)
    })
    return map
  })
  const first = perLeg[0]
  if (!first) throw new Error('没有腿')
  const common = [...first.keys()].filter((d) => perLeg.every((m) => m.has(d))).sort()
  return {
    dates: common,
    rets: common.map((d) => perLeg.map((m) => m.get(d) ?? 0)),
    dropped: perLeg.map((m) => m.size - common.length),
  }
}

/** 月末判定日：共同日历上每个自然月的最后一天 */
function monthEnds(dates: readonly string[]): Set<number> {
  const lastOfMonth = new Map<string, number>()
  dates.forEach((d, i) => lastOfMonth.set(d.slice(0, 7), i))
  return new Set(lastOfMonth.values())
}

export interface WindowResult {
  window: Window
  bars: number
  months: number
  erc: ArmResult
  fixed: ArmResult
  equityOnly: ArmResult
  /**
   * 三条腿**各自单独持有**（描述性，不是判据）。
   *
   * **为什么它必须印**：ERC 会给出压倒性的债腿权重（论证 §13.5 ① 那个最大弱点）
   * ⇒ 读结论的人必须能立刻看到「那条腿自己表现如何」，否则
   * 「配置能力」与「恰好搭上某条腿的十年行情」在这张表上分不开。
   */
  legOnly: ArmResult[]
  diff: SharpeDiffResult | null
  /**
   * **同风险的被动持有**（GH1，论证 §13.4 预注册的第二条并排列）：
   * 把**固定权重那一臂**与现金按每日恒定权重混到 `σ` 等于 ERC 的 `σ`，再比收益。
   *
   * **为什么它必须在**：ERC 的赢法可能只是「持有更少的等权组合」——
   * 夏普与 Calmar 都会奖励降风险，而 §5.13/GH1 那条纪律说的正是
   * 「离开同风险匹配，两条不同暴露的曲线不可直接比收益」。
   * 它**不参与主判据**（预注册写死了不承重），但读结论必须带它。
   */
  gh1: SameRiskPassive | null
}

/**
 * 跑一个窗口的三条臂。
 *
 * `indices` 只装评估期的下标；协方差的预热从 `rets` 里往前取，**不进净值**（纪律 3）。
 */
export function runWindow(data: LegData, window: Window, costs: CostModel): WindowResult {
  const ends = monthEnds(data.dates)
  const inWindow: number[] = []
  for (let i = 0; i < data.dates.length; i++) {
    const d = data.dates[i]
    if (d !== undefined && d >= window.from && d <= window.to) inWindow.push(i)
  }

  const used: number[] = []
  const returns: number[][] = []
  const ercWeights: number[][] = []
  const fixedWeights: number[][] = []
  const equityWeights: number[][] = []
  let current: number[] | null = null
  let sawWarmup = false

  for (const i of inWindow) {
    /*
      协方差窗口是 [i−COV_WINDOW, i−1]，**不含今天**（纪律 2）。
      预热不足时这一根不进净值 —— 而不是先用等权顶着：那会让曲线开头一段
      属于另一条规则，而净值上看不出来。
    */
    if (current === null) {
      const rows: number[][] = []
      for (let t = i - COV_WINDOW; t <= i - 1; t++) {
        const row = data.rets[t]
        if (row) rows.push(row)
      }
      if (rows.length < COV_WINDOW) continue
      current = erc(covarianceMatrix(rows))
      sawWarmup = true
    }
    const row = data.rets[i]
    if (!row) continue
    used.push(i)
    returns.push(row)
    ercWeights.push(current)
    fixedWeights.push([...FIXED_WEIGHTS])
    equityWeights.push([1, 0, 0])

    // 月末收盘判定 ⇒ 下一根生效（同日生效就是未来函数）
    if (ends.has(i)) {
      const rows: number[][] = []
      for (let t = i - COV_WINDOW + 1; t <= i; t++) {
        const r = data.rets[t]
        if (r) rows.push(r)
      }
      if (rows.length === COV_WINDOW) current = erc(covarianceMatrix(rows))
    }
  }
  if (!sawWarmup) throw new Error(`${window.name}：协方差预热凑不够 ${COV_WINDOW} 根`)

  const ercArm = simulateLegs('ERC', returns, ercWeights, costs)
  const fixedArm = simulateLegs('固定权重 1/3', returns, fixedWeights, costs)
  const equityArm = simulateLegs('满仓宽基', returns, equityWeights, costs)
  const legOnly = LEGS.map((leg, j) =>
    simulateLegs(
      ` 单独持有 ${leg.name}`,
      returns,
      returns.map(() => LEGS.map((_, m) => (m === j ? 1 : 0))),
      costs
    )
  )
  const lag = andrewsLag(Math.min(ercArm.daily.length, fixedArm.daily.length))
  /*
    GH1 走 `metrics.sameRiskPassive`（**单一出处**）—— 它自带三条纪律：
    严格配对、每日恒定权重的复利（不许用线性近似 `w × R`，实测最大差 16.81pp）、
    现金按 0 计息。这里的「基准」是**固定权重那一臂**，因为本轮问的是
    「ERC 比同一批资产的等权组合好吗」，而不是「比沪深300好吗」。
  */
  // `equity` 比 `used` 多一个起点 ⇒ 第 0 个点是「第一根之前」。
  // 日期不参与 GH1 的算术（`alignedReturns` 只用相邻点的比值），这里只求单调不重复
  const points = ercArm.equity.map((v, t) => ({
    date: (data.dates[used[Math.max(0, t - 1)] ?? 0] ?? '1970-01-01') as TradeDate,
    equity: v,
    benchmark: fixedArm.equity[t] ?? null,
  }))
  return {
    window,
    bars: used.length,
    months: new Set(used.map((i) => (data.dates[i] ?? '').slice(0, 7))).size,
    erc: ercArm,
    fixed: fixedArm,
    equityOnly: equityArm,
    legOnly,
    diff: sharpeDiffHac(ercArm.daily, fixedArm.daily, lag),
    gh1: sameRiskPassive(points),
  }
}

const pct = (x: number | null): string => (x === null ? '—' : `${(x * 100).toFixed(2)}%`)
const num = (x: number | null): string => (x === null ? '—' : x.toFixed(3))

function render(results: readonly WindowResult[], data: LegData, costs: CostModel): string {
  const L: string[] = []
  L.push('配置形态 · 第三次预注册：股 + 债 + 金的等风险贡献（ERC）')
  L.push('='.repeat(100))
  L.push(`腿：${LEGS.map((l) => `${l.code} ${l.name}`).join(' · ')}`)
  L.push(`共同交易日 ${data.dates.length} 根（${data.dates[0]} → ${data.dates[data.dates.length - 1]}）`)
  L.push(
    `各腿在共同日历之外的天数（**整条序列**，绝大多数是共同起点之前）：` +
      `${LEGS.map((l, i) => `${l.code} ${data.dropped[i] ?? 0} 天`).join(' · ')}`
  )
  L.push(
    '（必须打印 —— 静默丢日子会让「共同窗口」变成假话。⚠ 落在**评估窗口内**的丢弃数' +
      '实测为 0：三腿在 2013-07-30 → 2023-12-31 上逐日对齐。）'
  )
  L.push(
    `协方差窗口 ${COV_WINDOW} 根（不含当日）· 月末判定次日生效 · 成本 单边 ` +
      `${((costs.slippage + costs.commissionRate) * 100).toFixed(3)}%（ETF 免印花税与过户费）`
  )
  L.push(
    '⚠ **一处与预注册措辞不一致的口径**：本模拟把权重当**目标权重**逐日复用，' +
      '⇒ 两条臂在调仓之间都被无成本地拉回目标（没有模拟月内漂移）。' +
      '固定权重那一臂因此「调仓 1 次、成本 0.13%」，而 ERC 付 0.66–0.92%' +
      ' ⇒ **偏差方向对对照有利、对 ERC 保守**，但量没有量。已登记。'
  )
  L.push('')

  for (const r of results) {
    L.push(`【${r.window.name}】${r.window.from} → ${r.window.to} ${r.window.note}`)
    L.push(`  ${r.bars} 个交易日 · ${r.months} 个月`)
    L.push('-'.repeat(100))
    L.push(
      '  臂'.padEnd(20) +
        '总收益'.padStart(11) +
        '年化'.padStart(10) +
        '最大回撤'.padStart(11) +
        '夏普'.padStart(9) +
        'Calmar'.padStart(9) +
        '调仓'.padStart(7) +
        '换手'.padStart(9) +
        '成本'.padStart(9)
    )
    for (const arm of [r.erc, r.fixed, ...r.legOnly]) {
      L.push(
        `  ${arm.label}`.padEnd(20) +
          pct(arm.totalReturn).padStart(11) +
          pct(arm.annualized).padStart(10) +
          pct(arm.maxDrawdown).padStart(11) +
          num(arm.sharpe).padStart(9) +
          num(arm.calmar).padStart(9) +
          String(arm.rebalances).padStart(7) +
          num(arm.turnover).padStart(9) +
          pct(arm.costPaid).padStart(9)
      )
    }
    L.push('')
    L.push(
      '  各腿平均权重 ERC：' +
        LEGS.map((l, i) => `${l.name} ${pct(r.erc.legWeights[i] ?? 0)}`).join(' · ')
    )
    L.push(`  平均暴露 ERC ${pct(r.erc.exposure)} · 固定权重 ${pct(r.fixed.exposure)}（都该是 100%）`)
    L.push('')
    const dS = (r.erc.sharpe ?? 0) - (r.fixed.sharpe ?? 0)
    const dC = (r.erc.calmar ?? 0) - (r.fixed.calmar ?? 0)
    const dD = r.erc.maxDrawdown - r.fixed.maxDrawdown
    L.push(
      `  ⚖ 对**固定权重**（承重的对照）：夏普 ${dS >= 0 ? '+' : ''}${dS.toFixed(3)} · ` +
        `Calmar ${dC >= 0 ? '+' : ''}${dC.toFixed(3)} · 回撤 ${dD >= 0 ? '+' : ''}${pct(dD)}`
    )
    L.push(
      `     ⇒ 本窗口主判据（两项同时改善）：${dS > 0 && dC > 0 ? '**改善**' : '**未同时改善**'}`
    )
    if (r.diff !== null) {
      L.push(
        `  显著性（LW 2008，lag ${r.diff.lag}）：Δ夏普(日频) ${r.diff.delta.toFixed(5)} · ` +
          `SE ${r.diff.standardError.toFixed(5)} · z ${r.diff.z.toFixed(3)} · ` +
          `**p ${r.diff.pValue.toFixed(4)}** · ρ ${r.diff.rho.toFixed(4)}`
      )
      L.push('     （不参与主判据，只回答「这个差有多不可靠」—— 论证 §13.4）')
      L.push(
        '     ⚠ LW 原文自己说 HAC 推断在中小样本上**偏自由**（拒真过多）⇒ 这个 p 是**下界**，' +
          '不许拿它当「显著」的结论。'
      )
    } else {
      L.push('  显著性：算不出（样本不足）')
    }
    if (r.gh1 !== null) {
      L.push(
        `  ⚖ GH1 同风险（把**固定权重那一臂**与现金混到 σ 等于 ERC）：` +
          `w ${pct(r.gh1.weight)} · 参照收益 ${pct(r.gh1.referenceReturn)} · ` +
          `**GH1 ${r.gh1.gh1 >= 0 ? '+' : ''}${pct(r.gh1.gh1)}**`
      )
      L.push(
        '     ⇒ 它回答的是「ERC 比**持有更少的等权组合**好吗」。' +
          '夏普与 Calmar 都会奖励降风险，而这一列把降风险那部分扣掉（论证 §13.4 预注册的并排列，不承重）。'
      )
    }
    const dSe = (r.erc.sharpe ?? 0) - (r.equityOnly.sharpe ?? 0)
    L.push(
      `  ⓘ 对满仓宽基（**不承重**）：夏普 ${dSe >= 0 ? '+' : ''}${dSe.toFixed(3)} —— ` +
        '它量的是资产选择（beta）不是配置能力，论证 §13.2'
    )
    L.push('')
  }

  const both = results.every((r) => (r.erc.sharpe ?? 0) > (r.fixed.sharpe ?? 0) && (r.erc.calmar ?? 0) > (r.fixed.calmar ?? 0))
  L.push('='.repeat(100))
  L.push(`主判据（对固定权重：夏普与 Calmar 同时改善，且两个窗口同向）：${both ? '**通过**' : '**不通过**'}`)
  L.push('')
  L.push('⚠ 读数纪律（论证 §13）：')
  L.push('  1. 承重的对照是**同一批资产的固定权重**，不是任何单腿 —— 单腿量的是 beta（§13.2）。')
  L.push('     「单独持有 …」三行是**描述性的**，印出来是为了让 §13.5 ① 那个最大弱点')
  L.push('     （ERC 的优势可能只是「把钱挪去了恰好在牛市里的那条腿」）在同一张表上可见。')
  L.push('  2. 债腿权重高不是缺陷，是这条规则的算术后果；它同时是本轮最大的弱点（§13.5 ①）。')
  L.push('  3. `COV_WINDOW` 预注册一个值，**不许搜**（§13.5 ②）。')
  L.push('  4. **停止规则已事先绑定**：主判据不通过 ⇒ 配置形态这条线结案，')
  L.push('     且「不可判」按不通过处置（§13.6，用户 2026-08-27 在知道代价的前提下拍的）。')
  return L.join('\n')
}

function parseFixtures(argv: readonly string[]): string {
  const i = argv.indexOf('--fixtures')
  if (i < 0 || argv[i + 1] === undefined) throw new Error('必须给 --fixtures <dir>')
  return argv[i + 1] as string
}

async function main(): Promise<number> {
  const fixtures = parseFixtures(process.argv.slice(2))
  const data = alignLegs(fixtures)
  const costs = DEFAULT_COSTS
  const results = WINDOWS.map((w) => runWindow(data, w, costs))
  process.stdout.write(`${render(results, data, costs)}\n`)
  return 0
}

// 被 import 时不跑（用例要 import 上面那些纯函数）
if (process.argv[1]?.endsWith('risk-budget.ts') === true) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`)
      process.exit(1)
    })
}
