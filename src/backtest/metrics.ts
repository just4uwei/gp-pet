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
  /**
   * 当日收盘持仓市值，元（2026-08-21 加）。**只有 `riskFreeAdjustedSharpe` 用它**，
   * 缺省时那个数给 null 而不是退回「按满仓收 rf」—— 见那个函数的头注释。
   */
  positionValue?: number | undefined
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

/** 总体偏度 `γ₃ = m₃/m₂^{3/2}`（÷n，与 `sharpeRatioHac` 的总体口径一致） */
export function skewness(values: readonly number[]): number {
  const n = values.length
  if (n === 0) return 0
  const m = mean(values)
  const m2 = values.reduce((s, v) => s + (v - m) ** 2, 0) / n
  const m3 = values.reduce((s, v) => s + (v - m) ** 3, 0) / n
  return m2 > 0 ? m3 / m2 ** 1.5 : 0
}

/** 皮尔逊峰度 `γ₄ = m₄/m₂²`（÷n，正态 = 3，不是超额峰度） */
export function pearsonKurtosis(values: readonly number[]): number {
  const n = values.length
  if (n === 0) return 0
  const m = mean(values)
  const m2 = values.reduce((s, v) => s + (v - m) ** 2, 0) / n
  const m4 = values.reduce((s, v) => s + (v - m) ** 4, 0) / n
  return m2 > 0 ? m4 / (m2 * m2) : 0
}

/**
 * PSR 框架下的显著性门槛：**这个窗口长度下，年化夏普 ≥ X 才算 95% 显著**
 * （`SR*` = 0，单侧）。**只由 `T` 与高阶矩决定、与策略的实际夏普无关** -- 调不动，
 * 不重判任何既有结果，**只印不当门槛**（M2 §5.48 判据 1）。
 *
 * 解 `PSR(SR,0,T,γ₃,γ₄) = 0.95` -- 它是 `SR` 的二次方程
 * （`varTerm = 1 − γ₃·SR + ((γ₄−1)/4)·SR²` 里 `SR` 最高 2 次）：
 *
 * ```
 * a·SR² + b·SR + c = 0
 * a = (T−1) − Z²·(γ₄−1)/4
 * b = Z²·γ₃
 * c = −Z²          Z = normInv(0.95) = 1.6449
 * ```
 *
 * 取正根。T 不足或肥尾过重（`a ≤ 0`）时返回 null -- 这种窗口里谈显著性没有意义。
 */
export function sharpeSignificanceThreshold(returns: readonly number[]): number | null {
  const T = returns.length
  if (T < 3) return null
  const skew = skewness(returns)
  const kurt = pearsonKurtosis(returns)
  const z = 1.6449 // normInv(0.95) 单侧
  const z2 = z * z
  const a = T - 1 - (z2 * (kurt - 1)) / 4
  const b = z2 * skew
  const c = -z2
  if (a <= 0) return null
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const srDailyThreshold = (-b + Math.sqrt(disc)) / (2 * a)
  return srDailyThreshold * Math.sqrt(BARS_PER_YEAR)
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

/**
 * 无风险利率调整后的年化夏普：**只在实际投出去的那部分资金上收机会成本**。
 *
 * ```
 * 超额_t = r_t − (rf / 243) · w_{t−1}          w = 上一日收盘持仓市值 / 净值
 * ```
 *
 * ## 为什么不是「直接减 rf」（2026-08-21，用户拍板 rf = 2%）
 *
 * 直接减是**罚两次**。这套策略绝大多数时间空仓（出厂参数下逐日占用 3.50%），
 * 而回测与影子**都不给现金计息** ⇒ 那 96.5% 的钱在账本里一分钱没赚，
 * 再按满仓的标准扣掉整个 rf，扣的是一笔它从来没拿到过的收益。
 * 「给现金按 rf 计息、再整体减 rf」与「只对持仓部分减 rf」在代数上恒等
 * （`r + rf·(1−w) − rf = r − rf·w`），后者不用去动净值曲线，这一点很要紧 ——
 * 真把利息累进净值里，六年下来的现金利息会把 `totalReturn` 从 −1.99% 抬成正数，
 * 而那是货币基金赚的，不是策略赚的。**这个项目最不能产出的就是那种数字。**
 *
 * 实测量级（`cap-100000` 训练窗口，2026-08-21 重跑逐位复现基线后算的）：
 * rf=0 给 **−0.412**，只对持仓收给 **−0.502**，而直接减给 **−2.888**
 * —— 后者与前两者差 2.4 个夏普，全部来自这个 artifact。
 * 差距这么大是因为分母被空仓稀释了约 24 倍（日标准差 0.05% vs 沪深300 1.24%），
 * `rf/243` 占策略日标准差的 15.9%、占指数的 0.66% ⇒ **同一个 rf 对低暴露策略的
 * 伤害是对指数的 25 倍**。这与「低暴露策略上 CAPM alpha 的符号由 Rf 决定」同源
 * （M2 §5.41），那一条已经否掉了 alpha 当判据。
 *
 * `positionValue` 缺任意一期就返回 **null**：不知道占用就算不出这个数，
 * 而退回「按满仓收」恰好是上面那个要防的双罚。`rf = 0` 时该项恒为 0，
 * 直接走 `sharpeRatio` —— 于是老口径逐位不变。
 *
 * ⚠ `×√243` 的自相关问题这里**一模一样地存在**（见 `sharpeRatio`），rf 不改变它。
 */
export function riskFreeAdjustedSharpe(
  points: readonly EquityPoint[],
  annualRiskFree: number
): number | null {
  if (annualRiskFree === 0) return sharpeRatio(returnsOf(points, 'equity'))

  const perBar = annualRiskFree / BARS_PER_YEAR
  const excess: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const now = points[i]
    if (!prev || !now || prev.equity <= 0) continue
    if (prev.positionValue === undefined) return null
    excess.push(now.equity / prev.equity - 1 - perBar * (prev.positionValue / prev.equity))
  }
  return sharpeRatio(excess)
}

/**
 * Bartlett 核的 **HAC 长期协方差**（Newey & West 1987）：
 *
 * ```
 * S_ab = γ₀^ab + Σ_{k=1..L} (1 − k/(L+1)) · (γ_k^ab + γ_k^ba)
 * γ_k^ab = (1/T) · Σ_{t=k}^{T−1} (a_t − ā)(b_{t−k} − b̄)
 * ```
 *
 * `a === b` 时退化成标量版 `γ₀ + 2Σ w_k γ_k`（`ic-audit.ts` 的 `neweyWestVariance`
 * 就是它除以 `T`，那边**只留一层薄封装**，别在任何地方照抄第二份自协方差循环）。
 *
 * ⚠ **交叉项必须对称化**：`γ_k^ab ≠ γ_k^ba`（一个是 `a` 领先、一个是 `b` 领先），
 * 只取一边算出来的矩阵不对称 ⇒ 二次型可能变负，而那会表现成一个「负方差」。
 *
 * ⚠ 两条与 `neweyWestVariance` 同源的读法：① `L` 是**滞后截断阶**不是带宽；
 * ② `L = ⌊4(T/100)^(2/9)⌋` 那个经验规则归 **Andrews (1991)**，不归 NW (1987)。
 *
 * 除数用 `1/T`（NW 原式）而不是 `1/(T−1)`：这里估的是长期方差，不是样本方差。
 * 序列必须**按时间排好**，顺序错了这个数没有意义。
 */
export function bartlettLongRunCovariance(
  a: readonly number[],
  b: readonly number[],
  lag: number
): number | null {
  const T = Math.min(a.length, b.length)
  if (T < 2) return null
  const ma = mean(a.slice(0, T))
  const mb = mean(b.slice(0, T))
  const da = a.slice(0, T).map((v) => v - ma)
  const db = b.slice(0, T).map((v) => v - mb)
  // γ_k^ab：a 在 t、b 在 t−k
  const gamma = (k: number): number => {
    let sum = 0
    for (let t = k; t < T; t++) sum += (da[t] ?? 0) * (db[t - k] ?? 0)
    return sum / T
  }
  const gammaRev = (k: number): number => {
    let sum = 0
    for (let t = k; t < T; t++) sum += (db[t] ?? 0) * (da[t - k] ?? 0)
    return sum / T
  }
  const L = Math.max(0, Math.min(lag, T - 1))
  let out = gamma(0)
  for (let k = 1; k <= L; k++) out += (1 - k / (L + 1)) * (gamma(k) + gammaRev(k))
  return out
}

export interface SharpeHacResult {
  /**
   * 原始频率的夏普，**总体标准差口径（÷n）**。
   *
   * ⚠ 与 `sharpeRatio()` 的 `÷(n−1)` 差 `√(T/(T−1))`（T = 1456 时 0.03%）。
   * 这里**必须**用总体口径：`lag = 0` 时逐位退回 `1 − γ₃·SR + ((γ₄−1)/4)·SR²`
   * 这条嵌套恒等式是本函数唯一的正确性保证，而那个式子里的 `SR` 与 `γ₃/γ₄`
   * 是同一套总体中心矩。换成 `n−1` 只会让自检差一点点 —— 那正是最糟的情形：
   * 看起来像通过了。
   */
  sharpe: number
  /** Lo (2002) 的 `V_GMM`。夏普估计量的方差是 `varTerm / T` */
  varTerm: number
  /** 同一份数据在 `lag = 0` 下的 `varTerm` = Mertens/Christie 的闭式（`sharpeVarianceTerm`） */
  varTermIid: number
  /** `varTerm / varTermIid` —— **自相关把夏普估计量的方差抬高了多少倍** */
  varianceInflation: number
  /** 实际用到的滞后截断阶（会被 `T−1` 夹住） */
  lag: number
  /** 原始频率的标准误 `√(varTerm / T)` */
  standardError: number
}

/**
 * **Lo (2002) 的夏普估计量方差**，允许序列相关与条件异方差（HAC）。
 *
 * 归属：**Lo, A. W.** (2002), *The Statistics of Sharpe Ratios*,
 * **Financial Analysts Journal 58(4) 36–52**（原文 Appendix A 一手核对，M2 §5.50）。
 *
 * ```
 * θ = (μ, σ²)   g(θ) = μ/σ   ∇g = (1/σ, −μ/(2σ³))′
 * V_GMM = ∇g′ · S · ∇g     S = [r_t−μ, (r_t−μ)²−σ²] 的 HAC 长期协方差
 * ```
 *
 * 展开就是这个函数在算的三项：
 * `V = S₁₁/σ² − (μ/σ⁴)·S₁₂ + (μ²/4σ⁶)·S₂₂`。
 *
 * ## 归属链（**本仓库此前引错了一环**，M2 §5.50 易读错 ③）
 *
 * **Jobson & Korkie (1981)** 先给 IID 正态 → **Lo (2002)** 重述，并给出这里用的
 * GMM/HAC 一般形式 → **Mertens (2002)** 是**对 Lo 的更正**（指出 Lo 那一段只在
 * IID **正态**下成立，给出带 `γ₃/γ₄` 的闭式）→ **Christie (2005)** 在平稳遍历下用 GMM 推
 * → **Opdyke (2007)** 证明 Christie 与 Mertens 是同一个式子。
 *
 * ⚠ **Mertens (2002) 与 Memmel (2003) 是两个人两篇文章**（名字差一个字母）：
 * 前者更正**单条**夏普的方差（就是这个函数），后者更正**两条之差**的
 * （见 `sharpeDiffHac`）。混起来会以为这一处已经把两件事都做了。
 *
 * ⚠ **「Mertens 的闭式在平稳遍历下也成立」不等于「自相关已经处理了」**：
 * 那个闭式用的是**同期**中心矩，而自相关只能从 `S` 的**长期**协方差进来 ——
 * Lo 的实证部分之所以要跑 Newey–West（截断阶 m = 3 / 6）就是这个原因。
 * 两句混读会得出「不用做了」这个相反的结论。
 * **这一条 2026-08-26 拿到了外部佐证**：Ledoit & Wolf (2008) 的 Remark 3.1 明说
 * Opdyke 的时间序列公式**是错的** ——「因为它们等价于 IID 情形的公式」。
 * ⇒ 上面那句不是保守措辞，是文献里有人专门指出过的错误（M2 §5.60 易读错 ③）。
 *
 * ## ⚠ 它的前提（H1：平稳 + 遍历）在本项目数据上**不成立**，2026-08-21 实测
 *
 * [M2 §5.51](../../docs/notes/M2-偏差报告.md)：CUSUMSQ（κ₂ 口径）在**策略、基准同期、
 * 基准 2005–2017 三条序列上一致拒绝方差恒定**，而那个检验实测偏保守（水平 2.5–3.5%）。
 * ⇒ **`varianceInflation` 是「这个窗口上的平均值」，不是常数**：训练窗口全段 1.3208，
 * 而等长三段是 1.09 / 1.56 / 1.18。**引用时必须带窗口**（「训练窗口上的 1.32」）。
 *
 * 它仍然可用，理由是这个量恰好是**最耐受**那种不平稳的：`VIF ≈ S₁₁/σ²` 是个比值，
 * 分子分母同随局部方差缩放 ⇒ 尺度不变（三段极差 1.43×，而同期 σ 的极差是 2.30×）。
 *
 * 顺带一条机制：**基准自己的 VIF 是 0.9606（< 1，负自相关）**，而策略是 1.3208
 * ⇒ 这个正自相关是**策略持仓结构**的（持仓平均 14 根），不是从市场继承的。
 *
 * ## 三条边界
 *
 * 1. **它不改任何夏普的点估计。** `performance.sharpe` 永久是 rf = 0 + `×√243`
 *    （CLAUDE.md 写死），这个函数只答「那个数的标准误有多大」。
 * 2. **`lag` 必须预承诺**，不许看着结果挑 —— 「调滞后阶到显著为止」是文献里
 *    有记录的 p-hacking 通道（M2 §5.47）。
 * 3. **传进来的必须是原始频率的收益**（日频）。年化过的收益会让 `SR²` 那一项
 *    放大两个数量级。
 */
export function sharpeRatioHac(returns: readonly number[], lag: number): SharpeHacResult | null {
  const T = returns.length
  if (T < 2) return null
  const mu = mean(returns)
  // 总体口径（÷n）—— 见 `SharpeHacResult.sharpe` 的注释，嵌套自检要求如此
  const m2 = returns.reduce((sum, v) => sum + (v - mu) ** 2, 0) / T
  if (m2 <= 0) return null
  const sigma = Math.sqrt(m2)

  const dev = returns.map((v) => v - mu)
  const sq = dev.map((d) => d * d - m2)

  const varTermAt = (l: number): number | null => {
    const s11 = bartlettLongRunCovariance(dev, dev, l)
    const s12 = bartlettLongRunCovariance(dev, sq, l)
    const s22 = bartlettLongRunCovariance(sq, sq, l)
    if (s11 === null || s12 === null || s22 === null) return null
    const v = s11 / m2 - (mu / (m2 * m2)) * s12 + ((mu * mu) / (4 * m2 * m2 * m2)) * s22
    return v > 0 ? v : null
  }

  const effectiveLag = Math.max(0, Math.min(lag, T - 1))
  const varTerm = varTermAt(effectiveLag)
  const varTermIid = varTermAt(0)
  if (varTerm === null || varTermIid === null) return null

  return {
    sharpe: mu / sigma,
    varTerm,
    varTermIid,
    varianceInflation: varTerm / varTermIid,
    lag: effectiveLag,
    standardError: Math.sqrt(varTerm / T),
  }
}

export interface SharpeDiffResult {
  /** 两条腿各自的原始频率夏普（总体口径 ÷n，与 `sharpeRatioHac` 一致） */
  sharpeA: number
  sharpeB: number
  /** `sharpeA − sharpeB`（原始频率） */
  delta: number
  /** 两条腿收益的皮尔逊相关 —— 这个数就是「朴素口径高估多少」的主因 */
  rho: number
  /** 配对样本数 */
  bars: number
  /** 实际用到的滞后截断阶 */
  lag: number
  /** LW (2008) Eq. (5) 的标准误（原始频率），`lag` 档 */
  standardError: number
  /** 同一份数据 `lag = 0` 档 —— 即 Jobson–Korkie / Memmel 那一档 */
  standardErrorIid: number
  /**
   * **朴素合成 SE**：`√(SE_A² + SE_B²)`，两条腿各自的 Lo (2002) SE 平方相加。
   *
   * ⚠ 它**只在两条腿独立时**才对（例如 §5.51 ③ 那张不相交子段的表）。
   * 同期两条策略上它系统性偏大 —— 留在结果里就是为了让这个倍数可见。
   */
  naiveCombinedSe: number
  /** `naiveCombinedSe / standardError` —— 朴素口径高估的倍数 */
  naiveRatio: number
  /** `delta / standardError` */
  z: number
  /** 双侧 p 值 `2Φ(−|z|)` */
  pValue: number
}

/**
 * **两条相关收益序列的夏普之差的标准误**（HAC 口径）。
 *
 * 归属：**Jobson & Korkie (1981)**（IID 正态）→ **Memmel (2003)**（更正它的渐近方差，
 * *Finance Letters* 1:21–23）→ **Ledoit, O. & Wolf, M.** (2008), *Robust performance
 * hypothesis testing with the Sharpe ratio*, **Journal of Empirical Finance 15(4) 850–859**
 * —— 本函数实现的是 LW 原文 §3 与 §3.1（一手核对，M2 §5.60）。
 *
 * ```
 * θ = (μ_a, μ_b, γ_a, γ_b)′        γ = E[r²]（**未中心化**二阶矩，LW 的记法）
 * Δ = f(θ) = a/√(c−a²) − b/√(d−b²)                                    ← 原文 Eq. (2)
 * ∇f = ( c/(c−a²)^1.5 , −d/(d−b²)^1.5 , −a/2·(c−a²)^-1.5 , b/2·(d−b²)^-1.5 )′  ← Eq. (4)
 * SE(Δ̂) = √( ∇f′ Ψ̂ ∇f / T )                                           ← Eq. (5)
 * Ψ = [r_ta−μ_a, r_tb−μ_b, r²_ta−γ_a, r²_tb−γ_b]′ 的 4×4 HAC 长期协方差
 * ```
 *
 * 与 `sharpeRatioHac`（Lo 2002）是**同一个结构在两条腿上的版本** —— 矩向量都是
 * `(r, r²)`，都走 `bartlettLongRunCovariance`。所以两者必须放在一起，
 * 各写一份的症状是「单腿说 SE 0.03、两腿说 0.05」而没人判得出哪个对。
 *
 * ## 为什么必须有它：朴素合成 SE 在相关的两条腿上系统性偏大
 *
 * `√(SE_A² + SE_B²)` 隐含 `Cov = 0`。两条高度相关的曲线（消融对照、目标化 vs 满仓、
 * ETF vs 个股）上协方差项很大且为正 ⇒ 差值的真实方差远小于它
 * ⇒ **朴素口径会把「测得出的差别」判成「测不出」**，方向**不保守**。
 * 实测倍数见 M2 §5.60。
 *
 * ## 三条边界
 *
 * 1. **它不改任何夏普的点估计**（同 `sharpeRatioHac` 的边界 1）。
 * 2. **`lag` 必须预承诺**，不许看着结果挑（p-hacking 通道，M2 §5.47）。
 * 3. **两条腿必须是同一批时点的配对收益**。各算各的再按下标塞会错位
 *    —— 与 `alignedReturns` 头注释那条是同一个坑，这里长度不等直接截到短的那条
 *    **不足以**保证配对，调用方得先对齐。
 *
 * ⚠ **LW 原文推荐的是预白化 QS 核 + 自举**，本实现用的是 Bartlett 核 + Andrews 滞后阶
 * （与项目其余 HAC 处一致）。原文明说 HAC 推断在中小样本上**偏自由**（拒真过多）
 * ⇒ 显著的结论要留余量，`p` 刚过 0.05 的不许承重。
 *
 * ⚠ `T/(T−4)` 那个小样本自由度修正是 LW 的规格（Lo 那边没有）。T = 2000 时它是
 * 1.002，量级可忽略，留着是为了与原文逐条对得上。
 */
export function sharpeDiffHac(
  a: readonly number[],
  b: readonly number[],
  lag: number
): SharpeDiffResult | null {
  const T = Math.min(a.length, b.length)
  if (T < 5) return null
  const ra = a.slice(0, T)
  const rb = b.slice(0, T)
  const muA = mean(ra)
  const muB = mean(rb)
  /*
    总体口径（÷T），与 `sharpeRatioHac` 一致 —— 自检要求两处同口径。
    ⚠ **方差必须用中心化和算，不许写成 `γ − μ²`**：后者在常数序列上是灾难性相消，
    实测给出 1e-20 量级的「正方差」⇒ `varB <= 0` 这道闸门放行，夏普算出 3.8e7
    （用例「零波动给 null」当场变红）。`γ` 反过来由 `var + μ²` 得到 —— LW 的坐标
    要的是未中心化二阶矩，但**估它的路径**可以是稳的那一条。
  */
  const varA = ra.reduce((s, v) => s + (v - muA) ** 2, 0) / T
  const varB = rb.reduce((s, v) => s + (v - muB) ** 2, 0) / T
  /*
    ⚠ 闸门是**相对**的，不是 `> 0`：常数序列上 `Σ(v−μ)²` 只是**接近** 0
    （`mean([0.01 × 12])` 落在 0.01 的最后一位之外）⇒ 绝对闸门会放行一个 1e-36
    的「方差」，夏普算出 3.8e7。零波动必须给 null，不许给一个天文数字。
  */
  // ⚠ 用 reduce 求最大值，不许写 `Math.max(...xs)` —— 20 万个参数会爆调用栈
  const floorOf = (xs: readonly number[]): number =>
    (1e-9 * xs.reduce((m, v) => Math.max(m, Math.abs(v)), Number.MIN_VALUE)) ** 2
  if (varA <= floorOf(ra) || varB <= floorOf(rb)) return null
  const gammaA = varA + muA * muA
  const gammaB = varB + muB * muB

  const gradient = [
    gammaA / varA ** 1.5,
    -gammaB / varB ** 1.5,
    (-muA / 2) * varA ** -1.5,
    (muB / 2) * varB ** -1.5,
  ]
  const y = [
    ra.map((v) => v - muA),
    rb.map((v) => v - muB),
    ra.map((v) => v * v - gammaA),
    rb.map((v) => v * v - gammaB),
  ]

  const quadraticAt = (l: number): number | null => {
    let sum = 0
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const s = bartlettLongRunCovariance(y[i] ?? [], y[j] ?? [], l)
        if (s === null) return null
        sum += (gradient[i] ?? 0) * (gradient[j] ?? 0) * s
      }
    }
    // LW 的小样本自由度修正（估了 4 个参数）
    return (sum * T) / (T - 4)
  }

  const effectiveLag = Math.max(0, Math.min(lag, T - 1))
  const q = quadraticAt(effectiveLag)
  const qIid = quadraticAt(0)
  if (q === null || qIid === null || q <= 0 || qIid <= 0) return null

  const hacA = sharpeRatioHac(ra, effectiveLag)
  const hacB = sharpeRatioHac(rb, effectiveLag)
  const cov = sampleCovariance(ra, rb)
  const sdA = Math.sqrt(varA)
  const sdB = Math.sqrt(varB)
  const se = Math.sqrt(q / T)
  const naive =
    hacA === null || hacB === null
      ? Number.NaN
      : Math.sqrt(hacA.standardError ** 2 + hacB.standardError ** 2)
  const delta = muA / sdA - muB / sdB
  const z = delta / se
  return {
    sharpeA: muA / sdA,
    sharpeB: muB / sdB,
    delta,
    // 样本协方差是 ÷(n−1)，这里配 sampleStdev 口径算相关（相关系数对口径不敏感）
    rho: cov === null ? Number.NaN : cov / (sampleStdev(ra) * sampleStdev(rb)),
    bars: T,
    lag: effectiveLag,
    standardError: se,
    standardErrorIid: Math.sqrt(qIid / T),
    naiveCombinedSe: naive,
    naiveRatio: naive / se,
    z,
    pValue: 2 * (1 - normalCdf(Math.abs(z))),
  }
}

/** 标准正态 c.d.f.（Abramowitz–Stegun 26.2.17，绝对误差 < 7.5e-8） */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2)
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - p : p
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

export interface SameRiskPassive {
  /** 混合权重 `w = σ_p/σ_m` —— 基准占这么多，其余持现（0 息） */
  weight: number
  /** 参照组合的复利收益 */
  referenceReturn: number
  /** `GH1 = R_p − R_{基准@σ_p}`，正 = 主动择时赢了同风险的被动持有 */
  gh1: number
}

/**
 * **同风险的被动持有**（池外参照）：把**基准**与现金按每日恒定权重混到 `σ` 等于组合的 `σ`，
 * 再比收益。`GH1 = R_p − R_{基准@σ_p}`。
 *
 * 归属：**Graham & Harvey**, JFE 42 (1996) 397–421 / FAJ 53 (1997) 54–66。
 *
 * ## 为什么报告里非要有它
 *
 * 报告原有的两个「超额」都是跟**满仓**基准比的，而我们平均占用只有 3.5%
 * ⇒ 那个比较回答不了「这些钱换成被动持有会怎样」（[差距文档 §2.2](../../docs/notes/与机构量化系统的差距.md)
 * 曾把它列为**优先级最高的真空**）。实测两句同时为真且**符号相反**：
 * 训练窗口除法版超额 **+16.75pp**、GH1 **−1.71pp**（M2 §5.52）。
 * ⇒ **引用「超额」时这两个必须一起给**，报告因此把它们打在相邻的行上。
 *
 * ## ⚠ 匹配口径按 σ，这是 2026-08-24 拍板的（不是每次挑）
 *
 * 另一个候选是「按平均资金占用匹配」（`w = exposure`），而它**能翻符号** ——
 * 单指数那份 σ 匹配给 −16.40pp、占用匹配给 **+0.72pp**。
 * 与零点定义 / 加权口径 / DSR 的 `N` / MinTRL 的 `SR*` 同一形状：**自由度必须预承诺**。
 * 选 σ 的理由是它用**净值本身**，而 `averageExposure` 的头注释自己就写着
 * 「是持仓规模的近似，不适合再往下做精细归因」。
 * 占用匹配仍可在 `scripts/verify/outside-pool.ts` 里看，那是调研工具、不进报告。
 *
 * ## ⚠ 三处不许顺手改
 *
 * 1. **必须走 `alignedReturns` 严格配对**：两条收益率各算一遍再按下标塞会错位
 *    （基准列一有空洞就是「策略第 100 天 vs 基准第 103 天」，**不报错、只给错数**）。
 * 2. **参照是每日恒定权重（constant mix）**，`∏(1 + w·r_m) − 1` ——
 *    **绝不能用线性近似 `w × R_m`**：两者实测最大差 **16.81pp**，
 *    而且符号由**基准方向**决定（主项是复利的凸性，不是波动拖累）。
 * 3. **现金按 0 计息**（与 `sharpe` 的 rf = 0、与「回测不给现金计息」一致）。
 *    真给现金计息会让六年的利息把 `totalReturn` 从负抬成正，而那是货币基金赚的。
 *
 * 基准缺失、或两条序列配不出 2 期以上、或基准无波动时给 null —— 不用 0 冒充。
 */
export function sameRiskPassive(points: readonly EquityPoint[]): SameRiskPassive | null {
  const { strategy, benchmark } = alignedReturns(points)
  if (strategy.length < 2 || benchmark.length < 2) return null
  const sdStrategy = sampleStdev(strategy)
  const sdBenchmark = sampleStdev(benchmark)
  if (sdBenchmark === 0) return null
  const weight = sdStrategy / sdBenchmark
  let referenceGrowth = 1
  for (const r of benchmark) referenceGrowth *= 1 + weight * r
  let strategyGrowth = 1
  for (const r of strategy) strategyGrowth *= 1 + r
  const referenceReturn = referenceGrowth - 1
  return { weight, referenceReturn, gh1: strategyGrowth - 1 - referenceReturn }
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
