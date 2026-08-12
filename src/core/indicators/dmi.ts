/**
 * ADX / DMI / ATR，Wilder 平滑（docs/04 §1.5）。
 *
 * ```
 * TR       = max(H-L, |H-PC|, |L-PC|)
 * upMove   = H - PH ;  downMove = PL - L
 * +DM      = (upMove > downMove && upMove > 0)   ? upMove   : 0
 * -DM      = (downMove > upMove && downMove > 0) ? downMove : 0
 * +DI      = 100 × Wilder(+DM) / Wilder(TR)      ← 和式相除，周期自己约掉
 * DX       = 100 × |+DI - -DI| / (+DI + -DI)     分母为 0 时 DX = 0
 * ADX      = Wilder 平滑的 DX
 * ```
 *
 * 首个 ADX 需要约 28 根（DX 首值在第 14 根，再 Wilder 预热 14 个 DX）。
 * ADX 不含方向，方向看 `+DI vs -DI`。
 *
 * ⚠ 与 docs/04 §1.5 的一处口径差：文档写 `ATR = Wilder(TR,14)`，那是**和式**
 * （≈ 14 倍的日均真实波幅）。本实现导出的 `atr` 是 `Wilder(TR,14)/14`，即通行意义上的 ATR
 * —— 因为它会被 docs/05 §2.3 的自适应止损（`2×ATR/close`）与波动率分位直接使用，
 * 用和式会让那两处静默地偏大 14 倍。DI 是两个和式相除，除不除 14 结果相同。
 */

import type { DmiResult, Series } from '../types'
import type { PriceSeries } from './prices'
import { at, nulls, wilderSum } from './series'

export function dmi(prices: PriceSeries, period: number): DmiResult {
  const { high, low, close } = prices
  const n = close.length
  if (period <= 0 || n === 0) {
    return { adx: nulls(n), plusDI: nulls(n), minusDI: nulls(n), atr: nulls(n) }
  }

  // 首根没有前收，TR/DM 一律为 null（不是 0 —— 0 会被当成「当日毫无波动」算进种子）
  const tr: Series = nulls(n)
  const plusDM: Series = nulls(n)
  const minusDM: Series = nulls(n)

  for (let i = 1; i < n; i++) {
    const h = at(high, i)
    const l = at(low, i)
    const pc = at(close, i - 1)
    const ph = at(high, i - 1)
    const pl = at(low, i - 1)
    if (h === null || l === null || pc === null || ph === null || pl === null) continue

    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
    const upMove = h - ph
    const downMove = pl - l
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0
  }

  const trSum = wilderSum(tr, period)
  const plusSum = wilderSum(plusDM, period)
  const minusSum = wilderSum(minusDM, period)

  const plusDI: Series = nulls(n)
  const minusDI: Series = nulls(n)
  const atr: Series = nulls(n)
  const dx: Series = nulls(n)

  for (let i = 0; i < n; i++) {
    const trw = at(trSum, i)
    const pw = at(plusSum, i)
    const mw = at(minusSum, i)
    if (trw === null || pw === null || mw === null) continue

    atr[i] = trw / period
    // 完全无波动（连续 n 根一字板或停牌补价）时 TR 和为 0：此时方向动量也必然为 0，
    // 判为「无方向」而不是 null —— 下游的 RANGE 判定要的正是这个结论
    const positive = trw > 0 ? (100 * pw) / trw : 0
    const negative = trw > 0 ? (100 * mw) / trw : 0
    plusDI[i] = positive
    minusDI[i] = negative
    const sum = positive + negative
    dx[i] = sum > 0 ? (100 * Math.abs(positive - negative)) / sum : 0
  }

  // ADX = Wilder 平滑的 DX。wilderSum/period 恰好等于「种子取均值 + 逐步平均」的递推式
  const adxSum = wilderSum(dx, period)
  const adx: Series = nulls(n)
  for (let i = 0; i < n; i++) {
    const value = at(adxSum, i)
    if (value !== null) adx[i] = value / period
  }

  return { adx, plusDI, minusDI, atr }
}
