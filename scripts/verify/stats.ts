/**
 * PSR / DSR / MinTRL 那一族共用的纯统计件。**只有这一份** ——
 * `dsr.ts` 与 `mintrl.ts` 都从这里取，别在任何一边照抄第二份：
 * 那三个统计量共用同一个「夏普估计量的方差」，各写一份的症状是
 * 「DSR 说要 1.0，MinTRL 说要 0.9」，而没人能判断哪个对
 * （与 `trade:preview` 那条纪律同一形状）。
 *
 * `mean` / `sampleStdev` / `BARS_PER_YEAR` 刻意**不重新定义**，从 `src/backtest/metrics.ts` 取。
 */
export { BARS_PER_YEAR, mean, sampleStdev } from '../../src/backtest/metrics'

/** k 阶中心矩（总体口径，除 n） */
function centralMoment(xs: readonly number[], k: number): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, b) => a + Math.pow(b - m, k), 0) / xs.length
}

/** 偏度 `γ₃ = m₃ / m₂^1.5`（总体口径） */
export function skewness(xs: readonly number[]): number {
  return centralMoment(xs, 3) / Math.pow(centralMoment(xs, 2), 1.5)
}

/**
 * **皮尔逊**峰度 `γ₄ = m₄ / m₂²` —— 正态 = **3**，不是超额峰度（正态 = 0）。
 *
 * ⚠ PSR/DSR/MinTRL 的公式里那一项是 `(γ₄ − 1)/4`，喂超额峰度会让整项偏 0.75。
 */
export function pearsonKurtosis(xs: readonly number[]): number {
  return centralMoment(xs, 4) / Math.pow(centralMoment(xs, 2), 2)
}

/** 标准正态 CDF（Abramowitz & Stegun 7.1.26 的 erf 有理近似，|ε| < 1.5e-7） */
export function normCdf(z: number): number {
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return 0.5 * (1 + sign * y)
}

/** 标准正态分位（Acklam 有理近似，|ε| < 1.15e-9） */
export function normInv(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}

/**
 * 夏普估计量方差里的那一项：`1 − γ₃·SR + ((γ₄−1)/4)·SR²`。
 *
 * 归属链（**2026-08-21 更正，原来写错了一环**，M2 §5.50 易读错 ③）：
 * **Jobson & Korkie (1981)** 先给 IID 正态 → **Lo (2002)** 重述并给出 GMM/HAC 一般形式
 * → **Mertens (2002)** 是**对 Lo 的更正**（指出 Lo 那一段只在 IID **正态**下成立，
 * 给出这里这个带 `γ₃/γ₄` 的闭式）→ **Christie (2005)** 在平稳遍历下用 GMM 推
 * → **Opdyke (2007)** 证明 Christie 与 Mertens 是**同一个式子**。
 * PSR / DSR / MinTRL 三处用的是同一个东西。
 *
 * ⚠ **「在平稳遍历下成立」不等于「自相关已经被处理了」**：这个闭式用的是**同期**中心矩，
 * 自相关只能从长期协方差进来。要那一档走 `metrics.ts` 的 `sharpeRatioHac`
 * （Lo 的 `V_GMM`，`lag = 0` 时逐位退回本函数 —— 有自检钉着）。
 *
 * ⚠ `sr` 必须是**原始频率**的夏普（不是年化）—— 年化会让 `SR²` 那一项放大两个数量级。
 */
export function sharpeVarianceTerm(sr: number, skew: number, kurt: number): number {
  return 1 - skew * sr + ((kurt - 1) / 4) * sr * sr
}

/** 从净值序列取逐期收益（跳过非正的净值点） */
export function returnsFromEquity(points: ReadonlyArray<{ equity: number }>): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.equity
    const cur = points[i]!.equity
    if (prev > 0) out.push(cur / prev - 1)
  }
  return out
}
