/**
 * 引擎参数的唯一来源。
 *
 * ⚠ ADR-0003：以下数值**除下面这张已标定清单之外**，全部来自需求文档的转述、
 * 未经本项目回测验证，属于「待标定的初始猜测」。出厂默认值必须由 docs/07 的
 * 标定流程产出后替换，替换时同步递增 ENGINE_VERSION 并在 CHANGELOG 记录标定依据。
 *
 * 已标定（逐项列出，不要笼统地说「参数已验证」）：
 * - `strategy.squeezeBbwPct = 20`（2026-08-12，M2-偏差报告 §5.10）
 *
 * 其余数值仍未标定，因此 ENGINE_VERSION 保留 `-unvalidated` 后缀。
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
    /**
     * R3：带宽极度压缩线。**已标定**（2026-08-12，M2-偏差报告 §5.10）。
     *
     * 出厂值曾是 docs/04 §1.4 转述的「< 10 变盘前夜」，那个 10 把 R3 卡得几乎不出手，
     * 让整个均值回归策略的边际贡献看起来只有 +0.14pp（噪音带内）、两次被提议砍掉。
     * 标定显示 10 与 5 在两种基线下都被验证集红线淘汰，而 16–30 是一整片通过的高原；
     * 取 20 —— 它是高原上唯一在训练集与验证集上都靠前的值。
     * 改这个值前先读 §5.10 的保留意见（测试集纪律缺口、幸存者偏差、超额为负）。
     */
    squeezeBbwPct: 20,
    /** R4：偏离中轨多少个标准差算超调 */
    midReversionStd: 1.5,
    /** 风控：带宽极度扩张线（docs/04 §1.4「> 90 趋势末端」，docs/05 §2.2 据此降级） */
    expandedBbwPct: 90,
  },

  /**
   * 策略消融开关：**测量工具，不是可标定参数**。出厂形态是两项皆 true。
   *
   * 为什么不能用「把权重调成 0」代替：组合层的票数不分策略（任何 `sub.score ≥ 0.5`
   * 都计一票，见 combine/index.ts），权重 0 的策略得分贡献是 0、票照投 ——
   * 那测出来的是「关掉它的得分、留着它的票」，不是关掉这个策略。
   * 关掉后该策略一个子信号都不产出，既不供分也不供票。
   * 多周期调整项不受影响：它不属于这两个策略中的任何一个（docs/04 §3.3）。
   */
  enabledStrategies: { trend: true, meanReversion: true },

  regime: {
    hysteresisDays: 2,
    rangeMidBand: 0.03,
    /** 震荡市要求带宽处于历史低位（docs/04 §1.4 的「< 30 收敛」） */
    rangeBbwPct: 30,
    adxSlopeWindow: 3,
    adxSlopeTrigger: 5,
    bbwPctJump: 30,
  },

  /**
   * 三档灵敏度预设：灵敏 0.50/(2,2) · 均衡 0.60/(3,2) · 保守 0.72/(4,3)。
   *
   * `voteThreshold` **按策略分开给**（2026-08-12）。原先是一条共用的整数线，
   * 但趋势有 5 个子信号（T1–T5）、均值回归只有 4 个（R1–R4），同一条「≥ 3 票」
   * 对前者是五中取三（60%），对后者是四中取三（75%）—— 系统性地不对等，
   * 而实测里均值回归在出厂参数下一次都没独立触发过（M2 §5.7）。
   * 现在每档按同一个比例换算再取整：趋势 2/3/4 票 ⇒ 40%/60%/80%，
   * 均值回归 4 × 同比例 = 1.6/2.4/3.2 ⇒ 2/2/3 票。
   *
   * 判据是「**任一策略在自己内部足够一致**」，不是把两边的票加起来 ——
   * 票数衡量的是同一个策略里有多少条规则互相印证，跨策略相加没有这个含义。
   * 强度由得分负责，一致性由这里负责（见 combine/index.ts 的注释）。
   *
   * `downtrendBuyPenalty`：下跌趋势里均值回归**买入**信号的折价（docs/04 §4.1 的「别接飞刀」）。
   * 它是**方向级抑制**，与已删除的动态权重不是一回事 —— 后者是「按状态切换两个策略的可信度」，
   * 2026-08-12 实测无效后删除；这一条从未被单独测过，因此保留并等待标定。
   */
  combine: {
    scoreThreshold: 0.6,
    voteThreshold: { trend: 3, meanReversion: 2 },
    conflictBand: 0.15,
    provisionalDiscount: 0.9,
    downtrendBuyPenalty: 0.5,
  },

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

  /*
   * 这里曾经有一张 `weights` 表：按市场状态给趋势 / 均值回归两个策略不同的权重
   *（TREND_UP 0.7/0.3、RANGE 0.3/0.7…）。**2026-08-12 删除**，理由是实测无效：
   * 解掉「得分上限 × 阈值」的耦合口径后，动态权重与固定 0.5/0.5 的差值在四个参数点上
   * 正负交替、都在 1pp 以内。docs/07 §2.2 早就写明「若切换后并不优于固定权重，
   * 这个假设就该被推翻，而不是保留一套复杂而无效的机制」。
   * 判据见 M2 偏差报告 §5.5–§5.8，决策记录见 docs/08 关键决策点 2。
   *
   * 想重新表达「某个状态下某个策略更可信」不要把这张表加回来 —— 它已经被测过一次了。
   * 要加就得先说清楚新机制与旧机制差在哪，并单独标定。
   */

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
 * `-unvalidated` 后缀不是装饰：只要它还在，就说明出厂参数**整体上**仍是 ADR-0003 说的
 * 「初始猜测」，UI 与文档都不得据此宣称任何绩效。**单个参数被标定不足以摘掉它** ——
 * 0.2.5 里 `strategy.squeezeBbwPct` 已标定，另外二十来个数值没有，报告仍须打「参数未标定」
 * 提示（docs/07 §3、M2 清单 5.4）。摘后缀（改为 `0.3.0`）的条件是整套参数标定完成，
 * 那是清单 4.9 的「标定完成」一档。
 *
 * 0.2.6 不含参数标定，是 `R2_REVERT_TO_MID` 的判定口径修正（docs/04 §3.2、M2 §5.11）。
 */
export const ENGINE_VERSION = '0.2.6-unvalidated'

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
