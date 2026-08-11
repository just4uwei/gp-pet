/**
 * 引擎参数的唯一来源。
 *
 * ⚠ ADR-0003：以下数值全部来自需求文档的转述，**未经本项目回测验证**，
 * 属于「待标定的初始猜测」。出厂默认值必须由 docs/07 的标定流程产出后替换，
 * 替换时同步递增 ENGINE_VERSION 并在 CHANGELOG 记录标定依据。
 */

export const DEFAULT_PARAMS = {
  ma: { periods: [5, 10, 20, 60, 120] },

  /** preset 可切换：AShareOptimized(12,17,9) 为文档推荐，Classic(12,26,9) 为对照组 */
  macd: { preset: 'AShareOptimized', fast: 12, slow: 17, signal: 9 },

  boll: { period: 20, k: 2, bbwLookback: 250 },

  /** adxTrend = clamp(baseThreshold + volScale × volPct, baseThreshold, maxThreshold) */
  adx: { period: 14, baseThreshold: 20, volScale: 8, maxThreshold: 28, rangeGap: 5 },

  /** overbought = obBase + sentimentScale × s；oversold = osBase + sentimentScale × s */
  rsi: { period: 14, obBase: 65, osBase: 15, sentimentScale: 20, sentimentIndex: 'SH000300' },

  volume: { maPeriod: 20, breakoutRatio: 1.2, shrinkRatio: 0.8, suspiciousRatio: 1.5 },

  regime: { hysteresisDays: 2, rangeMidBand: 0.03, adxSlopeWindow: 3, adxSlopeTrigger: 5, bbwPctJump: 30 },

  /** 三档灵敏度预设：灵敏 0.50/2 · 均衡 0.60/3 · 保守 0.72/4 */
  combine: { scoreThreshold: 0.6, voteThreshold: 3, conflictBand: 0.15, provisionalDiscount: 0.9 },

  weights: {
    TREND_UP: { trend: 0.7, meanReversion: 0.3 },
    TREND_DOWN: { trend: 0.7, meanReversion: 0.3, meanReversionBuyPenalty: 0.5 },
    RANGE: { trend: 0.3, meanReversion: 0.7 },
    TRANSITION: { trend: 0.5, meanReversion: 0.5 },
  },

  risk: {
    stopLossPct: 0.08,
    drawdownReducePct: 0.07,
    profitProtectTrigger: 0.05,
    profitProtectFallback: 0.02,
    trailingStopPct: 0.03,
    industryConcentrationCap: 0.2,
    newListingMinBars: 60,
    lateBuyCutoffMinutes: 320, // 09:30 起算，14:50 = 320 分钟（含午休扣除后的口径见实现）
  },

  data: { minBars: 40, fullBars: 300, insufficientPenalty: 0.8, staleSnapshotMs: 5 * 60 * 1000 },
} as const

export type EngineParams = typeof DEFAULT_PARAMS

/**
 * 参数或算法变更即递增。用于：
 * - 使 indicator_daily 缓存失效并重算（K 线不重拉）
 * - 让历史 signal 的横向比较有据可依
 */
export const ENGINE_VERSION = '0.1.0-unvalidated'
