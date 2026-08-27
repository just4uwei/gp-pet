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
 * **逆波动率权重**：`w_i ∝ 1/σ_i`，**忽略相关性**（论证 §15.2 的 A₃，描述性）。
 *
 * 它与 ERC 的差别恰好是**协方差的非对角那一半** ——
 * 零相关时两者解析相同（`erc` 那组用例里「对角协方差 ⇒ w ∝ 1/σ」钉着这件事），
 * 所以 `A₀ − A₃` 答的是「用整个协方差矩阵，比只用边际波动多买到了什么」。
 *
 * ⚠ 与 `erc` 同一条纪律：方差非正就抛错，**不许静默退回等权**。
 */
export function inverseVol(cov: readonly (readonly number[])[]): number[] {
  const k = cov.length
  if (k === 0) throw new Error('逆波动率：协方差矩阵是空的')
  const inv = Array.from({ length: k }, (_, i) => {
    const v = cov[i]?.[i]
    if (v === undefined || !(v > 0)) throw new Error(`逆波动率：第 ${i} 条腿的方差非正`)
    return 1 / Math.sqrt(v)
  })
  const total = inv.reduce((a, b) => a + b, 0)
  return inv.map((v) => v / total)
}

/**
 * 跑一条多腿净值。
 *
 * ## `weights` 是**目标**权重，不是实际权重（2026-08-27 改，M2 §5.78）
 *
 * 旧写法把 `weights[t]` 当成 t 期的**实际**权重 ⇒ 调仓之间被**无成本地**拉回目标
 * ⇒ 每一条臂都白得「逐日再平衡」这件事。上一轮（[论证 §14.4 ②](../../docs/notes/配置形态-论证.md)）
 * 只把它记成「方向对 ERC 保守」的小事，因为承重对照的目标每月都在动、两条臂都被同等地美化。
 *
 * **这一轮它压在主判据的正中央**：承重对照是「**不随时间变的**权重」
 * ⇒ 旧写法会让那条静态臂白得逐日再平衡，而本轮问的恰恰是「时变权重值不值」。
 * ⇒ 现在按持有量记账：各腿市值随自己的收益漂移，**只有目标变化的那一根才交易到目标**，
 * 换手 = `Σ|目标 − 漂移后的实际|`。
 *
 * ⚠ **`legWeights` 报的是漂移后的实际平均权重**，不是目标 —— 报目标会让「实际拿了多少」
 * 这件事在表上看不出来，而它是读收益差的前提（§5.13）。
 *
 * ## ⚠ `rebalanceAt` 为什么必须显式给（改完漂移之后当场发现的第二处偏差）
 *
 * 只按「目标变了没有」判断要不要交易，会让**目标恒定**的那条臂**一次都不再平衡**
 * —— 那是「买入并持有」，而 [§13.4](../../docs/notes/配置形态-论证.md) 预注册的是
 * 「固定权重**月度**再平衡」。⇒ 修完漂移之后，那条对照从「白得逐日再平衡」
 * 一步跨到了另一个极端。两个极端都不是预注册说的东西。
 *
 * ⇒ 调仓日由调用方显式给，**所有臂共用同一份**（同一日历、同一节奏）
 * ⇒ 「谁多付了换手」这件事只由权重差决定，不由节奏差决定。
 * **判据是预注册的措辞，不是哪一组数更好看。**
 *
 * @param returns  `returns[t][k]` 第 t 期第 k 条腿的收益
 * @param weights  `weights[t][k]` 第 t 期的**目标**权重（调用方保证只用了 t−1 及以前的信息）
 * @param rebalanceAt `rebalanceAt[t]` 为真时，即使目标没变也交易回目标。省略 = 只在目标变化时交易
 */
export function simulateLegs(
  label: string,
  returns: readonly (readonly number[])[],
  weights: readonly (readonly number[])[],
  costs: CostModel,
  rebalanceAt?: readonly boolean[]
): ArmResult {
  const rate = oneWayRate(costs)
  const k = LEGS.length
  const equity: number[] = [1]
  const daily: number[] = []
  const weightSum = Array.from({ length: k }, () => 0)
  let value = 1
  /** 各腿市值（元）。它们各自随本腿收益漂移，只有调仓那一根才被拉回目标 */
  let held = Array.from({ length: k }, () => 0)
  let target: number[] | null = null
  let rebalances = 0
  let turnover = 0
  let costPaid = 0

  for (let t = 0; t < returns.length; t++) {
    const w = weights[t] ?? []
    const r = returns[t] ?? []
    /*
      目标变了才交易，交易发生在这一根开盘之前（目标由 t−1 收盘定），
      成本先扣再吃当日收益 —— 与 `vol-target.ts` 的 `simulatePath` 逐字同口径。
      换手按**漂移后的实际权重**与目标之差算，这正是旧写法漏掉的那一块。
    */
    const targetChanged = target === null || w.some((v, j) => Math.abs(v - (target?.[j] ?? 0)) > 1e-12)
    const forced = rebalanceAt === undefined ? false : rebalanceAt[t] === true
    if (targetChanged || forced) {
      let delta = 0
      for (let j = 0; j < k; j++) {
        const actual = value > 0 ? (held[j] ?? 0) / value : 0
        delta += Math.abs((w[j] ?? 0) - actual)
      }
      if (delta > 1e-12) {
        const fee = value * delta * rate
        costPaid += fee
        value -= fee
        turnover += delta
        rebalances++
      }
      target = w.slice()
      held = w.map((v) => v * value)
    }
    // 这一根的实际权重（漂移后、交易后）—— 报表与组合收益都用它
    for (let j = 0; j < k; j++) {
      weightSum[j] = (weightSum[j] ?? 0) + (value > 0 ? (held[j] ?? 0) / value : 0)
    }
    const before = value
    let after = 0
    for (let j = 0; j < k; j++) {
      const grown = (held[j] ?? 0) * (1 + (r[j] ?? 0))
      held[j] = grown
      after += grown
    }
    value = after
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
  /**
   * **A₁ 静态等价**（论证 §15.2 的**承重对照**）：ERC 在该窗口的**平均权重向量**，固定不变。
   *
   * **零自由参数** —— 不用选「剩余怎么分」，直接用 ERC 自己的平均权重
   * ⇒ `A₀ − A₁` 恰好等于「权重随时间变化」这一件事的全部贡献，
   * 而「债多少」被平均权重按构造固定住 ⇒ §14.2 那个混淆被**结构性**排除。
   *
   * ⚠ **事后构造、不可实施**（平均值是从 A₀ 的结果里读出来的）⇒ 它是**归因对照**，
   * 不是一个可以买的组合。A₀ 输了**不能**推出「静态倾斜可实施」（§15.5 ①）。
   */
  staticEquiv: ArmResult
  /** A₂ 债腿路径匹配（描述性，不承重）：照抄 A₀ 的债腿权重，剩余按 A₀ 的平均股:金比例分 */
  bondPathMatched: ArmResult
  /** A₃ 逆波动率（描述性，不承重）：`w ∝ 1/σ`，**忽略相关性** ⇒ 答「协方差那一层买到了什么」 */
  invVol: ArmResult
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
  const invVolWeights: number[][] = []
  const fixedWeights: number[][] = []
  const equityWeights: number[][] = []
  /*
    调仓日 = **ERC 的新目标真正生效那一天**（月末判定 ⇒ 次一根）。
    所有臂共用它 ⇒ 节奏完全一致，「谁多付了换手」只由权重差决定。
    见 `simulateLegs` 的 `rebalanceAt` 头注释。
  */
  const rebalanceAt: boolean[] = []
  let pendingRebalance = true
  let current: number[] | null = null
  let currentInvVol: number[] | null = null
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
      const cov = covarianceMatrix(rows)
      current = erc(cov)
      currentInvVol = inverseVol(cov)
      sawWarmup = true
    }
    const row = data.rets[i]
    if (!row) continue
    used.push(i)
    returns.push(row)
    ercWeights.push(current)
    invVolWeights.push(currentInvVol ?? current)
    fixedWeights.push([...FIXED_WEIGHTS])
    equityWeights.push([1, 0, 0])
    rebalanceAt.push(pendingRebalance)
    pendingRebalance = false

    // 月末收盘判定 ⇒ 下一根生效（同日生效就是未来函数）
    if (ends.has(i)) {
      const rows: number[][] = []
      for (let t = i - COV_WINDOW + 1; t <= i; t++) {
        const r = data.rets[t]
        if (r) rows.push(r)
      }
      if (rows.length === COV_WINDOW) {
        const cov = covarianceMatrix(rows)
        current = erc(cov)
        currentInvVol = inverseVol(cov)
        pendingRebalance = true
      }
    }
  }
  if (!sawWarmup) throw new Error(`${window.name}：协方差预热凑不够 ${COV_WINDOW} 根`)

  const ercArm = simulateLegs('A₀ ERC', returns, ercWeights, costs, rebalanceAt)
  /*
    A₁ / A₂ 是**两趟**：先跑 A₀，再用它的**实际**平均权重构造对照（论证 §15.2）。
    ⚠ 用的是 `legWeights`（漂移后的实际），不是目标序列的平均 ——
    A₁ 要等价的是「A₀ 真的拿了多少」，而那两个数在漂移建模之后不再相同。
  */
  const avg = ercArm.legWeights
  const avgSum = avg.reduce((a, b) => a + b, 0)
  const staticVector = avg.map((v) => (avgSum > 0 ? v / avgSum : 1 / LEGS.length))
  const staticArm = simulateLegs(
    'A₁ 静态等价（归因对照）',
    returns,
    returns.map(() => [...staticVector]),
    costs,
    rebalanceAt
  )
  /*
    A₂：照抄 A₀ 每一根的债腿**目标**权重，剩余按 A₀ 的平均股:金比例分。
    ⇒ 「债多少」逐日与 A₀ 相同，只有风险腿内部的时变被抹掉。
  */
  const riskyAvg = (staticVector[0] ?? 0) + (staticVector[2] ?? 0)
  const equityShare = riskyAvg > 0 ? (staticVector[0] ?? 0) / riskyAvg : 0.5
  const bondPathArm = simulateLegs(
    'A₂ 债腿路径匹配（描述）',
    returns,
    ercWeights.map((w) => {
      const bond = w[1] ?? 0
      const risky = 1 - bond
      return [risky * equityShare, bond, risky * (1 - equityShare)]
    }),
    costs,
    rebalanceAt
  )
  const invVolArm = simulateLegs('A₃ 逆波动率（描述）', returns, invVolWeights, costs, rebalanceAt)
  const fixedArm = simulateLegs('固定权重 1/3（§5.77 的旧对照）', returns, fixedWeights, costs, rebalanceAt)
  // 「单独持有」与「满仓宽基」是**买入并持有**的参照 ⇒ 刻意不给调仓日
  // （单腿组合没有「再平衡」这件事，硬给它一份调仓日只会白付换手）
  const equityArm = simulateLegs('满仓宽基', returns, equityWeights, costs)
  const legOnly = LEGS.map((leg, j) =>
    simulateLegs(
      ` 单独持有 ${leg.name}`,
      returns,
      returns.map(() => LEGS.map((_, m) => (m === j ? 1 : 0))),
      costs
    )
  )
  const lag = andrewsLag(Math.min(ercArm.daily.length, staticArm.daily.length))
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
    benchmark: staticArm.equity[t] ?? null,
  }))
  return {
    window,
    bars: used.length,
    months: new Set(used.map((i) => (data.dates[i] ?? '').slice(0, 7))).size,
    erc: ercArm,
    staticEquiv: staticArm,
    bondPathMatched: bondPathArm,
    invVol: invVolArm,
    fixed: fixedArm,
    equityOnly: equityArm,
    legOnly,
    // ⚠ 对照必须与主判据同一条臂（2026-08-27 当场踩到：换了 A₁ 之后这一行还指着旧对照
    // ⇒ 打出来的 p 答的是另一个比较，而表上完全看不出来）
    diff: sharpeDiffHac(ercArm.daily, staticArm.daily, lag),
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
      '  臂'.padEnd(28) +
        '总收益'.padStart(11) +
        '年化'.padStart(10) +
        '最大回撤'.padStart(11) +
        '夏普'.padStart(9) +
        'Calmar'.padStart(9) +
        '调仓'.padStart(7) +
        '换手'.padStart(9) +
        '成本'.padStart(9)
    )
    for (const arm of [
      r.erc,
      r.staticEquiv,
      r.bondPathMatched,
      r.invVol,
      r.fixed,
      ...r.legOnly,
    ]) {
      L.push(
        `  ${arm.label}`.padEnd(28) +
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
      '  各腿平均权重 A₀：' +
        LEGS.map((l, i) => `${l.name} ${pct(r.erc.legWeights[i] ?? 0)}`).join(' · ')
    )
    L.push(
      '  各腿平均权重 A₁：' +
        LEGS.map((l, i) => `${l.name} ${pct(r.staticEquiv.legWeights[i] ?? 0)}`).join(' · ') +
        '（**构造自检：应与上一行逐位相近** —— A₁ 就是 A₀ 的平均权重）'
    )
    L.push(`  平均暴露 A₀ ${pct(r.erc.exposure)} · A₁ ${pct(r.staticEquiv.exposure)}（都该是 100%）`)
    L.push('')
    const dS = (r.erc.sharpe ?? 0) - (r.staticEquiv.sharpe ?? 0)
    const dC = (r.erc.calmar ?? 0) - (r.staticEquiv.calmar ?? 0)
    const dD = r.erc.maxDrawdown - r.staticEquiv.maxDrawdown
    L.push(
      `  ⚖ 对 **A₁ 静态等价**（承重的对照，论证 §15.2）：夏普 ${dS >= 0 ? '+' : ''}${dS.toFixed(3)} · ` +
        `Calmar ${dC >= 0 ? '+' : ''}${dC.toFixed(3)} · 回撤 ${dD >= 0 ? '+' : ''}${pct(dD)}`
    )
    L.push(
      `     ⇒ 本窗口主判据（夏普与 Calmar 同时改善）：${dS > 0 && dC > 0 ? '**改善**' : '**未同时改善**'}`
    )
    /*
      次判据来自 §4④ 2026-08-27 的拍板（回撤优先）：回撤不升 + 总收益 ≥ 对照的 80%。
      那个 80% 沿用论证 §5 第一次预注册就写着的数，**不是看完结果新定的**。
    */
    const retOk = r.staticEquiv.totalReturn <= 0 ? null : r.erc.totalReturn / r.staticEquiv.totalReturn >= 0.8
    L.push(
      `     ⇒ 次判据（回撤不升 + 总收益 ≥ A₁ 的 80%）：回撤 ${dD <= 0 ? '过' : '**不过**'} · ` +
        `收益比 ${r.staticEquiv.totalReturn <= 0 ? '—（对照收益非正，比值无意义）' : pct(r.erc.totalReturn / r.staticEquiv.totalReturn)}` +
        ` ${retOk === null ? '' : retOk ? '过' : '**不过**'}`
    )
    const dS2 = (r.erc.sharpe ?? 0) - (r.bondPathMatched.sharpe ?? 0)
    const dS3 = (r.erc.sharpe ?? 0) - (r.invVol.sharpe ?? 0)
    const dSf = (r.erc.sharpe ?? 0) - (r.fixed.sharpe ?? 0)
    L.push(
      `  ⓘ 描述性（**都不承重**）：vs A₂ 债腿路径匹配 夏普 ${dS2 >= 0 ? '+' : ''}${dS2.toFixed(3)}` +
        `（剩下的是「风险腿内部择时」）· vs A₃ 逆波动率 ${dS3 >= 0 ? '+' : ''}${dS3.toFixed(3)}` +
        `（剩下的是「协方差非对角那一半」）· vs 固定权重 1/3（§5.77 的旧对照）${dSf >= 0 ? '+' : ''}${dSf.toFixed(3)}`
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
        `  ⚖ GH1 同风险（把 **A₁** 与现金混到 σ 等于 A₀）：` +
          `w ${pct(r.gh1.weight)} · 参照收益 ${pct(r.gh1.referenceReturn)} · ` +
          `**GH1 ${r.gh1.gh1 >= 0 ? '+' : ''}${pct(r.gh1.gh1)}**`
      )
      L.push(
        '     ⇒ 它回答的是「A₀ 比**持有更少的 A₁**好吗」。' +
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

  const both = results.every(
    (r) => (r.erc.sharpe ?? 0) > (r.staticEquiv.sharpe ?? 0) && (r.erc.calmar ?? 0) > (r.staticEquiv.calmar ?? 0)
  )
  L.push('='.repeat(100))
  L.push(
    `主判据（对 **A₁ 静态等价**：夏普与 Calmar 同时改善，且两个窗口同向）：${both ? '**通过**' : '**不通过**'}`
  )
  L.push('')
  L.push('⚠ 读数纪律（论证 §13）：')
  L.push('  1. **承重的对照只有 A₁ 静态等价**（论证 §15.2）：它是 A₀ 自己的平均权重向量')
  L.push('     ⇒ 「债多少」被结构性固定住，A₀ − A₁ 恰好等于「权重随时间变化」的全部贡献。')
  L.push('     ⚠ **A₁/A₂ 事后构造、不可实施** ⇒ 它们是归因对照，不是可以买的组合；')
  L.push('     **A₀ 输了不能推出「静态倾斜可实施」**（§15.5 ①）。')
  L.push('     A₂/A₃/固定权重/单腿那几行**都是描述性的**，不进裁决。')
  L.push('  2. 债腿权重高不是缺陷，是这条规则的算术后果；它同时是本轮最大的弱点（§13.5 ①）。')
  L.push('  3. `COV_WINDOW` 预注册一个值，**不许搜**（§13.5 ②）。')
  L.push('  4. **本轮的停止规则与上一轮刻意不同**（§15.4）：不通过 ⇒ 关闭的是')
  L.push('     「ERC / 风险平价这条**规则**」，**不是配置层** —— 因为「静态债券倾斜」')
  L.push('     本身就是一个配置决定，而 A₁ 若赢了，赢的正是它。')
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
