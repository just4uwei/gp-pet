/**
 * 指标的**独立参照实现**（docs/07 §2.1 的交叉验证）。
 *
 * 规则：本文件不 import `src/core` 的任何东西，一律照 docs/04 的公式直写。
 * 风格也刻意与生产实现相反 —— 生产实现是「一次遍历 + 增量递推」，
 * 这里是「每个下标各自取窗口重算」。两套实现若因为共用了同一个错误的辅助函数而同时算错，
 * 交叉验证就白做了；风格分歧是这道防线的一部分。
 *
 * 已知的口径取舍（与 docs/04 的文字有出入，但与生产实现一致，理由见对应源文件）：
 *   - `hist = 2 × (DIF - DEA)`（国内平台口径）
 *   - `atr = Wilder(TR,14) / 14`（通行意义上的 ATR；文档写的是和式）
 *   - `bbwPct[i]` 取严格 250 个样本的窗口 → 首个有效值在第 269 根
 */

const NULL = null

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return NULL
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j]
      if (v === NULL || v === undefined) return NULL
      sum += v
    }
    return sum / period
  })
}

function ema(values, period) {
  const out = values.map(() => NULL)
  const alpha = 2 / (period + 1)
  let prev = NULL
  let seed = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === NULL || v === undefined) {
      prev = NULL
      seed = []
      continue
    }
    if (prev === NULL) {
      seed.push(v)
      if (seed.length === period) {
        prev = seed.reduce((a, b) => a + b, 0) / period
        out[i] = prev
      }
      continue
    }
    prev = alpha * v + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/** Wilder 和式：W[i] = W[i-1] - W[i-1]/n + x[i]，种子 = 首 n 个有效值之和 */
function wilder(values, period) {
  const out = values.map(() => NULL)
  let prev = NULL
  let seed = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === NULL || v === undefined) {
      prev = NULL
      seed = []
      continue
    }
    if (prev === NULL) {
      seed.push(v)
      if (seed.length === period) {
        prev = seed.reduce((a, b) => a + b, 0)
        out[i] = prev
      }
      continue
    }
    prev = prev - prev / period + v
    out[i] = prev
  }
  return out
}

function populationStd(window) {
  const mean = window.reduce((a, b) => a + b, 0) / window.length
  const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / window.length
  return Math.sqrt(variance)
}

export function referenceIndicators(candles, params) {
  const close = candles.map((c) => c.closeAdj)
  const high = candles.map((c) => c.highAdj)
  const low = candles.map((c) => c.lowAdj)
  const volume = candles.map((c) => c.volume)
  const n = candles.length

  // ── MA ────────────────────────────────────────────────────────────
  const ma = {}
  for (const period of params.ma.periods) ma[period] = sma(close, period)

  // ── MACD ──────────────────────────────────────────────────────────
  const fast = ema(close, params.macd.fast)
  const slow = ema(close, params.macd.slow)
  const dif = close.map((_, i) =>
    fast[i] === NULL || slow[i] === NULL ? NULL : fast[i] - slow[i]
  )
  const dea = ema(dif, params.macd.signal)
  const hist = dif.map((_, i) => (dif[i] === NULL || dea[i] === NULL ? NULL : 2 * (dif[i] - dea[i])))

  // ── BOLL ──────────────────────────────────────────────────────────
  const period = params.boll.period
  const mid = sma(close, period)
  const upper = []
  const lower = []
  const bbw = []
  for (let i = 0; i < n; i++) {
    if (mid[i] === NULL) {
      upper.push(NULL)
      lower.push(NULL)
      bbw.push(NULL)
      continue
    }
    const std = populationStd(close.slice(i - period + 1, i + 1))
    const up = mid[i] + params.boll.k * std
    const down = mid[i] - params.boll.k * std
    upper.push(up)
    lower.push(down)
    bbw.push(mid[i] > 0 ? ((up - down) / mid[i]) * 100 : NULL)
  }

  const lookback = params.boll.bbwLookback
  const bbwPct = bbw.map((value, i) => {
    if (value === NULL || i < lookback - 1) return NULL
    const window = bbw.slice(i - lookback + 1, i + 1)
    if (window.some((v) => v === NULL)) return NULL
    const leq = window.filter((v) => v <= value + 1e-9).length
    return (leq / window.length) * 100
  })

  // ── DMI / ADX / ATR ───────────────────────────────────────────────
  const tr = candles.map(() => NULL)
  const plusDM = candles.map(() => NULL)
  const minusDM = candles.map(() => NULL)
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]))
    const up = high[i] - high[i - 1]
    const down = low[i - 1] - low[i]
    plusDM[i] = up > down && up > 0 ? up : 0
    minusDM[i] = down > up && down > 0 ? down : 0
  }

  const p = params.adx.period
  const trW = wilder(tr, p)
  const plusW = wilder(plusDM, p)
  const minusW = wilder(minusDM, p)
  const plusDI = []
  const minusDI = []
  const atr = []
  const dx = []
  for (let i = 0; i < n; i++) {
    if (trW[i] === NULL || plusW[i] === NULL || minusW[i] === NULL) {
      plusDI.push(NULL)
      minusDI.push(NULL)
      atr.push(NULL)
      dx.push(NULL)
      continue
    }
    atr.push(trW[i] / p)
    const pos = trW[i] > 0 ? (100 * plusW[i]) / trW[i] : 0
    const neg = trW[i] > 0 ? (100 * minusW[i]) / trW[i] : 0
    plusDI.push(pos)
    minusDI.push(neg)
    dx.push(pos + neg > 0 ? (100 * Math.abs(pos - neg)) / (pos + neg) : 0)
  }
  const adxW = wilder(dx, p)
  const adx = adxW.map((v) => (v === NULL ? NULL : v / p))

  // ── RSI ───────────────────────────────────────────────────────────
  const gain = candles.map(() => NULL)
  const loss = candles.map(() => NULL)
  for (let i = 1; i < n; i++) {
    const change = close[i] - close[i - 1]
    gain[i] = change > 0 ? change : 0
    loss[i] = change < 0 ? -change : 0
  }
  const gainW = wilder(gain, params.rsi.period)
  const lossW = wilder(loss, params.rsi.period)
  const rsi = gainW.map((g, i) => {
    const l = lossW[i]
    if (g === NULL || l === NULL) return NULL
    if (g === 0 && l === 0) return 50
    if (l === 0) return 100
    return 100 - 100 / (1 + g / l)
  })

  // ── 量能 ──────────────────────────────────────────────────────────
  const volMa = sma(volume, params.volume.maPeriod)
  const volRatio = volMa.map((average, i) =>
    average === NULL || average <= 0 ? NULL : volume[i] / average
  )

  // ── 动态阈值 ───────────────────────────────────────────────────────
  const ratio = atr.map((value, i) => (value === NULL || close[i] <= 0 ? NULL : value / close[i]))
  const volPct = ratio.map((value, i) => {
    if (value === NULL || i < lookback - 1) return NULL
    const window = ratio.slice(i - lookback + 1, i + 1)
    if (window.some((v) => v === NULL)) return NULL
    const leq = window.filter((v) => v <= value + 1e-9).length
    return leq / window.length
  })
  const adxTrend = volPct.map((value) => {
    const scaled = value === NULL ? 0 : value
    const raw = params.adx.baseThreshold + params.adx.volScale * scaled
    return Math.min(params.adx.maxThreshold, Math.max(params.adx.baseThreshold, raw))
  })
  const adxRange = adxTrend.map((value) => value - params.adx.rangeGap)

  return {
    ma,
    macd: { dif, dea, hist },
    boll: { mid, upper, lower, bbw, bbwPct },
    dmi: { adx, plusDI, minusDI, atr },
    rsi,
    volMa,
    volRatio,
    thresholds: { adxTrend, adxRange, volPct },
  }
}
