/**
 * 绩效指标（docs/07 §2.2 的「输出指标」清单）。
 *
 * 相对 src/core 的克制在这里同样适用：**不算无从验证的东西**。
 * 无风险利率没有可靠的本地来源，所以夏普按 rf = 0 计算并在报告里注明；
 * 基准缺失时超额收益与信息比率一律给 null，不用 0 冒充。
 *
 * ## ⚠ 这里的夏普与主流口径不是同一个数，差**将近一倍**（2026-08-19 对照，M2 §5.39）
 *
 * 与聚宽（也就是国内平台的通行定义）逐条比：**最大回撤、年化公式、日收益标准差（除 n−1）
 * 三项同口径**，夏普有两处实质差异，而且**同向叠加**：
 *
 * | | 我们 | 主流 |
 * |---|---|---|
 * | 无风险利率 | **0** | **0.04** |
 * | 分子 | 日均收益 × √243（算术） | 年化**几何**收益 − Rf |
 *
 * 拿沪深300 被动持有量：2005–2017 我们 **0.533**、主流口径 **0.281**；
 * 2018–2023 我们 **−0.054**、主流口径 **−0.355**。
 *
 * **算法不改**（rf 硬填一个数就是新的未标定参数，而夏普不参与任何门槛 ——
 * 标定排名口径是 Calmar、折上口径是总收益）。要记住的是**怎么说**：
 * 这个数只能当口径统一的**内部排序量**，一句话都不许拿去与外部策略的夏普横比。
 *
 * `BARS_PER_YEAR = 243` vs 惯例的 250 也差 2.8%，但那个方向是保守的（年化更小 ⇒ Calmar 更小），
 * 而且 243 更接近 A 股实际，**不改**。
 */

import type { TradeDate } from '../core/types'

/** A 股一年约 243 个交易日 */
export const BARS_PER_YEAR = 243

export interface EquityPoint {
  date: TradeDate
  equity: number
  /** 基准指数归一化到同一起点的净值；缺基准时为 null */
  benchmark: number | null
}

export interface DrawdownResult {
  /** 0..1 的正数 */
  maxDrawdown: number
  peakDate: TradeDate | null
  troughDate: TradeDate | null
  /** 从峰值到谷底的交易日数 */
  durationBars: number
  /** 谷底到重回峰值的交易日数；截至回测结束仍未收复时为 null */
  recoveryBars: number | null
}

export function maxDrawdown(points: readonly EquityPoint[]): DrawdownResult {
  let peak = -Infinity
  let peakDate: TradeDate | null = null
  let peakIndex = -1
  let worst = 0
  let troughDate: TradeDate | null = null
  let troughIndex = -1
  let bestPeakDate: TradeDate | null = null
  let bestPeakIndex = -1

  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (!point) continue
    if (point.equity > peak) {
      peak = point.equity
      peakDate = point.date
      peakIndex = i
    }
    if (peak > 0) {
      const drawdown = (peak - point.equity) / peak
      if (drawdown > worst) {
        worst = drawdown
        troughDate = point.date
        troughIndex = i
        bestPeakDate = peakDate
        bestPeakIndex = peakIndex
      }
    }
  }

  let recoveryBars: number | null = null
  if (troughIndex >= 0 && bestPeakIndex >= 0) {
    const target = points[bestPeakIndex]?.equity ?? 0
    for (let i = troughIndex + 1; i < points.length; i++) {
      if ((points[i]?.equity ?? 0) >= target) {
        recoveryBars = i - troughIndex
        break
      }
    }
  }

  return {
    maxDrawdown: worst,
    peakDate: bestPeakDate,
    troughDate,
    durationBars: troughIndex >= 0 && bestPeakIndex >= 0 ? troughIndex - bestPeakIndex : 0,
    recoveryBars,
  }
}

/** 逐期简单收益率 */
export function returnsOf(points: readonly EquityPoint[], key: 'equity' | 'benchmark' = 'equity'): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]?.[key]
    const now = points[i]?.[key]
    if (prev === null || prev === undefined || now === null || now === undefined || prev <= 0) continue
    out.push(now / prev - 1)
  }
  return out
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** 样本标准差（除 n-1）—— 这里是统计推断而非「与行情软件对齐」，用无偏估计 */
export function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

export function annualizedReturn(totalReturn: number, bars: number): number | null {
  if (bars <= 0) return null
  const years = bars / BARS_PER_YEAR
  if (years <= 0) return null
  const growth = 1 + totalReturn
  // 亏到本金归零后无法按几何方式年化，直接给 -1（全损），不产出 NaN
  if (growth <= 0) return -1
  return growth ** (1 / years) - 1
}

/**
 * 夏普比率，rf = 0。样本少于 2 期时给 null 而不是 0 —— 0 会被读成「无风险调整收益」。
 *
 * ⚠ **`×√243` 假设日收益 iid，而这里的日收益不是**（持仓跨日、同池标的同涨同跌）——
 * 自相关为正时这个数**偏大**，迭代计划 §4.6 记的三处相关性问题之一。
 * 按 §4.6 的处置它停在「立刻」档：**报告如实标注、算法不改**。
 * 理由是夏普不参与任何门槛（标定排名口径是 Calmar，折上口径是总收益），
 * 而 Newey-West / Lo (2002) 的调整要选截断滞后阶数 —— 那是一个新的判断，
 * 该单独做一次并单独归档，不该顺手塞进一次判据修复里。
 */
export function sharpeRatio(returns: readonly number[]): number | null {
  const sd = sampleStdev(returns)
  if (returns.length < 2 || sd === 0) return null
  return (mean(returns) / sd) * Math.sqrt(BARS_PER_YEAR)
}

/** 信息比率：超额收益的年化均值 / 年化跟踪误差 */
export function informationRatio(
  strategy: readonly number[],
  benchmark: readonly number[]
): number | null {
  const n = Math.min(strategy.length, benchmark.length)
  if (n < 2) return null
  const excess: number[] = []
  for (let i = 0; i < n; i++) {
    excess.push((strategy[i] ?? 0) - (benchmark[i] ?? 0))
  }
  const sd = sampleStdev(excess)
  if (sd === 0) return null
  return (mean(excess) / sd) * Math.sqrt(BARS_PER_YEAR)
}

/**
 * 策略与基准的**严格配对**日收益：只有 `prev`/`now` 两端的**两列都有值**时才算一期。
 *
 * **为什么不能各算一遍再往一起塞**：`returnsOf(points, 'equity')` 与
 * `returnsOf(points, 'benchmark')` 各自会跳过自己缺值的那些期 ⇒ 基准列一有空洞，
 * 两个数组的**下标就错位**，而 `informationRatio` / `betaOf` 都是按下标配对的 ——
 * 算出来的是「策略第 100 天 vs 基准第 103 天」，而且不报错、只是给一个错的数。
 *
 * 回测里基准（沪深300 fixture）覆盖整个窗口、实测零空洞，所以这个坑一直没被踩到；
 * 但**影子运行的基准列真的会缺**（2026-08-19 真机上 2/2 行都是 null，根因是应用内
 * provider 不认识「指数无复权」）⇒ 那一侧必须严格配对。两处共用这一个函数。
 */
export function alignedReturns(points: readonly EquityPoint[]): {
  strategy: number[]
  benchmark: number[]
} {
  const strategy: number[] = []
  const benchmark: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const now = points[i]
    if (!prev || !now) continue
    if (prev.benchmark === null || now.benchmark === null) continue
    if (prev.equity <= 0 || prev.benchmark <= 0) continue
    strategy.push(now.equity / prev.equity - 1)
    benchmark.push(now.benchmark / prev.benchmark - 1)
  }
  return { strategy, benchmark }
}

/** 样本协方差（除 n−1，与 `sampleStdev` 同口径） */
export function sampleCovariance(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 2) return null
  const ma = mean(a.slice(0, n))
  const mb = mean(b.slice(0, n))
  let sum = 0
  for (let i = 0; i < n; i++) sum += ((a[i] ?? 0) - ma) * ((b[i] ?? 0) - mb)
  return sum / (n - 1)
}

/**
 * 市场 beta = `Cov(策略日收益, 基准日收益) / Var(基准日收益)`（口径与聚宽/通行定义一致）。
 *
 * **为什么值得算**：它是 `averageExposure` 的**第二种量法**，而且**不含任何参数** ——
 * 前者按建仓价 × 持仓天数近似「投进去多少钱」，后者由净值曲线回归出「跟着大盘动多少」。
 * 实测两者逐份同向（主池 261 只：占用 3.49% ↔ beta 0.0205；单指数：11.52% ↔ 0.0371，M2 §5.41）。
 * ⇒ 「超额收益离开占用率会被读反」那条老纪律因此有了一个独立确认量。
 *
 * ## ⚠ 刻意不做的两件事（M2 §5.41 的否定结论，别「顺手补全」）
 *
 * 1. **不算 CAPM alpha**（`Rp − [Rf + β(Rm−Rf)]`）。低暴露策略几乎全程持现 ⇒
 *    `α ≈ Rp − Rf(1−β) − βRm`，`Rf` 那一项直接支配结果，实测**连符号都能翻**
 *    （单指数择时 2005–2017：rf=0 → +1.29%/年、rf=4% → −2.57%/年，而事实是
 *    +24.14% vs 被动 +301.70%）。而 `Rf` 没有可靠的本地来源 —— 与夏普那里 rf = 0 同一条理由，
 *    只是后果更严重：夏普不参与门槛，而一个正的 alpha 会被读成「风险调整后跑赢了」。
 * 2. **不算日胜率**（跑赢基准的天数占比）。空仓日的日收益是 0，基准跌它就「赢」 ⇒
 *    实测它约等于「基准下跌天数占比」（单指数那份 45.9% vs 45.9%）⇒ 零信息量。
 *
 * 两个都能在 `scripts/verify/jq-riskmetrics.mjs` 里按需算出来看，那是调研工具、不进报告。
 *
 * 缺基准或基准无波动（比如一段只有一个交易日、或基准整段缺失）时给 null，不用 0 冒充 ——
 * beta = 0 的含义是「与大盘无关」，与「算不出来」是两件事。
 */
export function betaOf(strategy: readonly number[], benchmark: readonly number[]): number | null {
  const varBenchmark = sampleCovariance(benchmark, benchmark)
  if (varBenchmark === null || varBenchmark === 0) return null
  const covariance = sampleCovariance(strategy, benchmark)
  if (covariance === null) return null
  return covariance / varBenchmark
}

/**
 * 除法版超额收益 `(1+Rp)/(1+Rm) − 1` —— 净值是几何增长，所以「相对基准多赚了多少」
 * 自然的运算是除法而不是减法。
 *
 * **减法版（`totalReturn − benchmarkReturn`）在基准涨幅大的窗口上会给出读不出意思的数**：
 * 单指数 2005–2017 那份减法是 **−277.56%**，除法是 **−69.10%** ——
 * 后者可以直接读成「策略净值只有被动持有的 30.9%」（M2 §5.41 ④）。
 * 两个都保留是刻意的：`excessReturn` 是历史上所有引用过的口径，改掉它会让旧结论对不上号。
 */
export function ratioExcessReturn(totalReturn: number, benchmarkReturn: number | null): number | null {
  if (benchmarkReturn === null) return null
  const benchmarkGrowth = 1 + benchmarkReturn
  // 基准归零/为负增长（本金全损）时这个比值没有意义，给 null 而不是一个巨大的正数
  if (benchmarkGrowth <= 0) return null
  return (1 + totalReturn) / benchmarkGrowth - 1
}

export interface TradeStats {
  count: number
  wins: number
  losses: number
  /** 0..1 —— 报告里称「胜率」是可以的（那是回测事实），但 UI 上的置信度**不得**这么叫 */
  winRate: number | null
  /** 平均盈利 / 平均亏损，均为绝对值；无亏损交易时为 null（不是 Infinity） */
  profitFactor: number | null
  /**
   * 逐行**未加权**的平均百分比收益。
   *
   * ⚠ **这个数的符号可以与 `totalPnl` 相反，不要用它判断赚没赚。** 一行是一次卖出，
   * 而回撤减仓会把一次建仓拆成「先卖一半、后卖一半」两行，两行的仓位差一倍 ——
   * 未加权平均于是把小仓位的那一行和大仓位的那一行等同看待。
   * 实测：出厂参数下四种市况的这个数都是 −1.2% ~ −1.6%，而净盈亏是 **+231,154 元**
   * （M2 §5.18）。要看「平均一笔赚多少」用下面的 `weightedPnlPct`，
   * 要看「一次出手赚不赚」用 `groupPositions()`。
   */
  avgPnlPct: number | null
  /** 按建仓市值加权的百分比收益 = Σpnl ÷ Σ(entryPrice × shares)；缺仓位字段时为 null */
  weightedPnlPct: number | null
  avgHoldingBars: number | null
  totalPnl: number
  totalCosts: number
}

export interface TradeLike {
  pnl: number
  pnlPct: number
  holdingBars: number
  costs: number
  /** 建仓价与股数。两者齐备才算得出 `weightedPnlPct` */
  entryPrice?: number
  shares?: number
}

export interface ExposureLike {
  entryPrice: number
  shares: number
  holdingBars: number
}

/**
 * 平均资金占用率：持仓市值 × 持仓日数的总和 ÷（初始资金 × 交易日数），0..1。
 *
 * **报告里给出这个数，是因为「超额收益」离开它就会被误读。** 基准（沪深300）是 100% 满仓的，
 * 而信号策略绝大多数时间空仓 —— 拿一个占用 4% 资金的策略去比满仓指数，
 * 差额里有多少是「策略不行」、有多少是「钱没投进去」，光看超额一个数分不出来。
 *
 * 口径与近似：按**建仓价**计价（不随持仓期间的浮盈浮亏变化），部分止盈拆出的每条交易
 * 各按自己的份额与持仓天数计入。这是一个持仓规模的近似，不是逐日精确的资金曲线占用率 ——
 * 它够用来回答「资金基本闲置还是基本满仓」这个量级问题，不适合再往下做精细归因。
 */
export function averageExposure(
  trades: readonly ExposureLike[],
  startCapital: number,
  bars: number
): number | null {
  if (startCapital <= 0 || bars <= 0) return null
  let positionBarValue = 0
  for (const trade of trades) positionBarValue += trade.entryPrice * trade.shares * trade.holdingBars
  return positionBarValue / (startCapital * bars)
}

/**
 * 一次**建仓**（同一标的、同一建仓日的全部平仓行合起来）。
 *
 * 为什么必须有这个口径：`trades` 里一行是**一次卖出**，而回撤减仓 / 部分止盈会把一次建仓
 * 拆成两三行。于是逐行统计出来的「胜率」与用户体验到的「我按提醒买了一次，最后赚没赚」
 * 完全不是一回事 —— 实测出厂参数下逐行胜率 **33.16%**，而按建仓归并是 **49.3%**
 * （769 行 → 278 次建仓）。两个数都对，回答的是不同问题：
 *   逐行：每一次卖出动作赚不赚 —— 用来看止损止盈规则本身
 *   建仓：一次出手最后赚不赚 —— **用户口径**，也是「提高胜率」该盯的那个数
 * 所以报告两个都给，且都标明口径（M2 §5.18）。
 */
export interface PositionStats {
  /** 建仓次数 */
  count: number
  /** 最终净盈亏 > 0 的建仓数 */
  wins: number
  /** 0..1；`count === 0` 时为 null（不是 0 —— 0 会被读成「一次都没赢」） */
  winRate: number | null
  /** 平均每次建仓的净盈亏（元） */
  avgPnl: number | null
  /** 平均每次建仓的净盈亏 ÷ 该次建仓的建仓市值，按次等权 */
  avgReturn: number | null
  /** 赚钱建仓的平均盈利 ÷ 亏钱建仓的平均亏损；无亏损时为 null（不是 Infinity） */
  payoffRatio: number | null
  /** 中途触发过部分卖出（回撤减仓 / 部分止盈）的建仓数 —— 「建仓后先亏」的直接度量 */
  reduced: number
}

export interface PositionRowLike {
  code: string
  entryDate: TradeDate
  entryPrice: number
  shares: number
  pnl: number
  partial: boolean
}

/**
 * 按 `code + entryDate` 把平仓行归并成建仓。
 *
 * 用建仓日而不是持仓 id 是因为回测里一只标的同时只有一个仓位（M2 §3.3），
 * 所以「同一标的、同一天建的仓」唯一确定一次建仓。若将来允许同标的多仓并存，
 * 这里要改成显式的持仓 id —— 到那时这个函数会静默地把两个仓位合成一个，
 * 而单测里那条「同标的不同建仓日算两次」拦不住它。
 */
export function groupPositions(rows: readonly PositionRowLike[]): PositionStats {
  const groups = new Map<string, { pnl: number; cost: number; reduced: boolean }>()
  for (const row of rows) {
    const key = `${row.code}@${row.entryDate}`
    const group = groups.get(key) ?? { pnl: 0, cost: 0, reduced: false }
    group.pnl += row.pnl
    group.cost += row.entryPrice * row.shares
    if (row.partial) group.reduced = true
    groups.set(key, group)
  }

  const all = [...groups.values()]
  if (all.length === 0) {
    return { count: 0, wins: 0, winRate: null, avgPnl: null, avgReturn: null, payoffRatio: null, reduced: 0 }
  }
  const wins = all.filter((g) => g.pnl > 0)
  const losses = all.filter((g) => g.pnl <= 0)
  const avgWin = wins.length > 0 ? mean(wins.map((g) => g.pnl)) : 0
  const avgLoss = losses.length > 0 ? Math.abs(mean(losses.map((g) => g.pnl))) : 0

  return {
    count: all.length,
    wins: wins.length,
    winRate: wins.length / all.length,
    avgPnl: mean(all.map((g) => g.pnl)),
    // 按次等权而不是按金额加权：这里问的是「一次出手的回报」，不是组合收益率
    avgReturn: mean(all.filter((g) => g.cost > 0).map((g) => g.pnl / g.cost)),
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : null,
    reduced: all.filter((g) => g.reduced).length,
  }
}

export function summarizeTrades(trades: readonly TradeLike[]): TradeStats {
  if (trades.length === 0) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      profitFactor: null,
      avgPnlPct: null,
      weightedPnlPct: null,
      avgHoldingBars: null,
      totalPnl: 0,
      totalCosts: 0,
    }
  }

  const wins = trades.filter((t) => t.pnl > 0)
  const losses = trades.filter((t) => t.pnl < 0)
  const avgWin = wins.length > 0 ? mean(wins.map((t) => t.pnl)) : 0
  const avgLoss = losses.length > 0 ? Math.abs(mean(losses.map((t) => t.pnl))) : 0

  const notional = trades.reduce(
    (sum, t) => sum + (t.entryPrice !== undefined && t.shares !== undefined ? t.entryPrice * t.shares : 0),
    0
  )
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)

  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / trades.length,
    profitFactor: avgLoss > 0 ? avgWin / avgLoss : null,
    avgPnlPct: mean(trades.map((t) => t.pnlPct)),
    weightedPnlPct: notional > 0 ? totalPnl / notional : null,
    avgHoldingBars: mean(trades.map((t) => t.holdingBars)),
    totalPnl,
    totalCosts: trades.reduce((sum, t) => sum + t.costs, 0),
  }
}
