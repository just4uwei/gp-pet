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

  /**
   * 策略层的回溯窗口与带位阈值（docs/04 §3.1/§3.2）。
   * 子信号**权重**不在这里 —— 它们是策略结构的一部分（每个策略内部权重和为 1），
   * 见 strategies/trend.ts 与 strategies/mean-reversion.ts 的权重表。
   */
  strategy: {
    /** T5：近 N 日曾触轨道 */
    pullbackLookback: 5,
    /** R2：近 N 日曾收在轨道外 */
    revertLookback: 3,
    /** R3：带宽极度压缩线（docs/04 §1.4「< 10 变盘前夜」） */
    squeezeBbwPct: 10,
    /** R4：偏离中轨多少个标准差算超调 */
    midReversionStd: 1.5,
    /** 风控：带宽极度扩张线（docs/04 §1.4「> 90 趋势末端」，docs/05 §2.2 据此降级） */
    expandedBbwPct: 90,
  },

  regime: {
    hysteresisDays: 2,
    rangeMidBand: 0.03,
    /** 震荡市要求带宽处于历史低位（docs/04 §1.4 的「< 30 收敛」） */
    rangeBbwPct: 30,
    adxSlopeWindow: 3,
    adxSlopeTrigger: 5,
    bbwPctJump: 30,
  },

  /** 三档灵敏度预设：灵敏 0.50/2 · 均衡 0.60/3 · 保守 0.72/4 */
  combine: { scoreThreshold: 0.6, voteThreshold: 3, conflictBand: 0.15, provisionalDiscount: 0.9 },

  /**
   * 多周期共振的调整项（docs/04 §3.3）。
   * 来源文档把 25 / 20 直接写成常量，这里提出来 —— 它们与 adx.baseThreshold 一样待标定，
   * 埋在代码里会让标定时漏掉它们。
   */
  multiTf: {
    weekCrossLookback: 3,
    dayRsiBuyMax: 45,
    dayRsiSellMin: 55,
    weekAdxConfirm: 25,
    weekAdxWeak: 20,
    resonanceDelta: 0.1,
    falseBreakoutDelta: -0.15,
  },

  /** 提醒分级的得分线（docs/05 §3）。冷却与频率上限属提醒层（M3），不在这里 */
  alert: { bubbleScore: 0.75 },

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

/**
 * 把 `as const` 产生的字面量类型放宽成 `number` / `string`。
 *
 * 没有这一步，`EngineParams` 的 `macd.fast` 类型就是字面量 `12`，回测**无法**构造
 * 「fast = 26」的候选参数集 —— 而按 ADR-0003，标定候选参数正是 M2 的出口条件。
 * 数组仍保持 readonly：引擎里就地改 `ma.periods` 是不该发生的事。
 */
type Calibratable<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? readonly Calibratable<U>[]
        : { -readonly [K in keyof T]: Calibratable<T[K]> }

export type EngineParams = Calibratable<typeof DEFAULT_PARAMS>

/** 逐块覆盖。块内是整体替换而非深合并 —— 半个 weights 块比写错的参数更难发现 */
export type ParamOverrides = { [K in keyof EngineParams]?: Partial<EngineParams[K]> }

/**
 * 构造候选参数集。回测的 `--params` 与网格搜索都经由这里，
 * 保证「候选参数」与「出厂参数」是同一个结构，指纹也就可比。
 */
export function withParams(
  overrides: ParamOverrides,
  base: EngineParams = DEFAULT_PARAMS
): EngineParams {
  const next = { ...base } as Record<string, unknown>
  for (const [key, patch] of Object.entries(overrides)) {
    if (patch === undefined) continue
    const current = next[key]
    next[key] =
      current !== null && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as object), ...(patch as object) }
        : patch
  }
  return next as EngineParams
}

/**
 * 参数或算法变更即递增。用于：
 * - 使 indicator_daily 缓存失效并重算（K 线不重拉）
 * - 让历史 signal 的横向比较有据可依
 *
 * `-unvalidated` 后缀不是装饰：只要它还在，就说明出厂参数仍是 ADR-0003 说的「初始猜测」，
 * UI 与文档都不得据此宣称任何绩效。标定完成后改为 `0.3.0` 并在 CHANGELOG 记录依据。
 */
export const ENGINE_VERSION = '0.2.0-unvalidated'

/**
 * 参数集的稳定指纹。
 *
 * 为什么算法版本号之外还要它：用户能在设置里改参数（MACD 预设、灵敏度三档），
 * 改完之后 ENGINE_VERSION 没变，但 indicator_daily 与 signal 里的旧值已经不可比。
 * 只按版本号做缓存键会把两套参数下的结果混在一起 —— 那正是「历史信号无法横向比较」的成因。
 *
 * FNV-1a 而非 crypto：core 不许 import node 模块（ADR-0004），而这里只需要「变了就不一样」，
 * 不需要抗碰撞。键排序保证同一份参数的序列化结果唯一。
 */
export function paramsFingerprint(params: unknown): string {
  let hash = 0x811c9dc5
  const text = stableStringify(params)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // Math.imul：JS 位运算是 32 位有符号的，普通乘法会溢出到浮点丢低位
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 缓存与落库用的引擎标识：算法版本 + 参数指纹。任一变化即视为不同引擎。 */
export function engineVersionOf(params: unknown = DEFAULT_PARAMS): string {
  return `${ENGINE_VERSION}+${paramsFingerprint(params)}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
