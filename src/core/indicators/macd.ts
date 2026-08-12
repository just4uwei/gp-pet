/**
 * MACD（docs/04 §1.3）。
 *
 * ```
 * DIF  = EMA(fast) - EMA(slow)
 * DEA  = EMA(DIF, signal)
 * HIST = 2 × (DIF - DEA)        ← 国内平台（通达信/同花顺）口径
 * ```
 *
 * ⚠ 默认参数 (12,17,9) 来自来源文档，**未经本项目验证**（ADR-0003）。工程上它必然比
 * 经典 (12,26,9) 更灵敏 —— 交叉更早也更频繁，代价是假信号更多。两套都要能跑，
 * 出厂默认由 docs/07 的回测决定。
 *
 * HIST 的 ×2 只改变柱子高度的显示尺度，**不影响任何穿越或正负判定**
 * （2×(DIF−DEA) 与 DIF−DEA 同号、同零点）。
 */

import type { MacdResult, Series } from '../types'
import { at, ema, nulls } from './series'

export interface MacdParams {
  fast: number
  slow: number
  signal: number
}

export function macd(closes: readonly number[], params: MacdParams): MacdResult {
  const { fast, slow, signal } = params
  const n = closes.length
  if (fast <= 0 || slow <= 0 || signal <= 0) {
    return { dif: nulls(n), dea: nulls(n), hist: nulls(n) }
  }

  const fastEma = ema(closes, fast)
  const slowEma = ema(closes, slow)

  // DIF 从「两条 EMA 都有值」处开始 —— 即 max(fast, slow) - 1。
  // 不用快线单独有值的那段：慢线缺失时 DIF 会等于快线本身，那是个量级完全不同的数
  const dif: Series = nulls(n)
  for (let i = 0; i < n; i++) {
    const f = at(fastEma, i)
    const s = at(slowEma, i)
    if (f !== null && s !== null) dif[i] = f - s
  }

  // DEA 是 EMA 套在 DIF 上，而 DIF 前段是 null：ema() 按有效值计数种子，
  // 所以 DEA 的首个有效位在 DIF 首个有效位之后 signal-1 根处
  const dea = ema(dif, signal)

  const hist: Series = nulls(n)
  for (let i = 0; i < n; i++) {
    const d = at(dif, i)
    const e = at(dea, i)
    if (d !== null && e !== null) hist[i] = 2 * (d - e)
  }

  return { dif, dea, hist }
}
