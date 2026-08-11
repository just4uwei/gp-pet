/**
 * 引擎层核心契约。
 *
 * ADR-0004：本目录是纯 TS 库 —— 不依赖 Electron、不做 IO、不读时钟。
 * 所有输入（含「现在几点」「今天是不是交易日」）由调用方作为参数传入。
 *
 * 骨架阶段：仅类型，无实现。
 */

// ─────────────────────────────── 基础 ───────────────────────────────

/** 规范化证券代码，形如 'SH600000' / 'SZ000001' / 'BJ430047'（见 docs/03 §5） */
export type SecCode = string

/** 'YYYY-MM-DD' */
export type TradeDate = string

export type Market = 'SH' | 'SZ' | 'BJ'
export type Board = 'MAIN' | 'GEM' | 'STAR' | 'BSE' | 'ETF'
export type AdjustMode = 'none' | 'qfq' | 'hfq'

export interface SecProfile {
  code: SecCode
  name: string
  market: Market
  board: Board
  industry?: string
  listedAt?: TradeDate
  isST: boolean
}

/**
 * 日线。指标计算一律用 *_adj（前复权）；展示与持仓成本用不复权价。
 * 除权日的价格跳空会伪造出金叉/死叉，这是最容易被忽略的信号污染源（见 docs/03 §2.3）。
 */
export interface Candle {
  date: TradeDate
  open: number
  high: number
  low: number
  close: number
  openAdj: number
  highAdj: number
  lowAdj: number
  closeAdj: number
  volume: number
  amount: number
  /** 由实时快照拼出的当日临时 K 线，收盘前会持续变化（见 docs/04 §6） */
  provisional?: boolean
  /** 与前一根之间存在交易日缺口，回测应跳过该段（见 docs/07 §4） */
  hasGap?: boolean
}

export interface Snapshot {
  code: SecCode
  at: number
  last: number
  open: number
  high: number
  low: number
  preClose: number
  volume: number
  amount: number
  limitUp: number
  limitDown: number
  suspended: boolean
}

// ─────────────────────────── ① 指标层 ───────────────────────────

/** 与输入等长的序列；预热期不足处为 null，绝不用 0 冒充（见 docs/04 §1.1） */
export type Series = (number | null)[]

export interface MacdResult {
  dif: Series
  dea: Series
  /** 国内平台口径：2 × (DIF - DEA)。不影响任何穿越或正负判定 */
  hist: Series
}

export interface BollResult {
  mid: Series
  upper: Series
  lower: Series
  /** (upper - lower) / mid × 100 */
  bbw: Series
  /** bbw 在过去 bbwLookback 根中的百分位 0..100，需 270 根日线才有首个有效值 */
  bbwPct: Series
}

export interface DmiResult {
  adx: Series
  plusDI: Series
  minusDI: Series
  atr: Series
}

export interface IndicatorSet {
  ma: Record<number, Series>
  macd: MacdResult
  boll: BollResult
  dmi: DmiResult
  rsi: Series
  volMa: Series
  /** 成交量比；盘中值已按交易时间占比归一化（见 docs/04 §1.7） */
  volRatio: Series
  /** 由动态阈值公式算出的当期阈值，落在 evidence 里便于解释 */
  thresholds: {
    adxTrend: Series
    adxRange: Series
    rsiOverbought: Series
    rsiOversold: Series
  }
}

// ─────────────────────────── ② 市场状态层 ───────────────────────────

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'TRANSITION'

export interface RegimeState {
  regime: Regime
  /** 未经迟滞的原始判定；与 regime 不等时说明正处于迟滞窗口内 */
  raw: Regime
  /** 已连续维持的交易日数 */
  heldDays: number
  evidence: Evidence
}

// ─────────────────────────── ③ 策略层 ───────────────────────────

export type Direction = 'BUY' | 'SELL'
export type StrategyKind = 'TREND' | 'MEAN_REVERSION' | 'MULTI_TF'

/** 触发时的指标原值，「信号可解释」这条产品目标的落点 */
export type Evidence = Record<string, number | string | boolean | null>

export interface SubSignal {
  /** 稳定 ID，如 'T2_MACD_ZERO_CROSS'。测试断言 ID 集合而非具体分数（见 docs/04 §7） */
  id: string
  strategy: StrategyKind
  direction: Direction
  /** 0..1，该子条件自身的强度 */
  score: number
  /** 该子条件在所属策略内的权重 */
  weight: number
  evidence: Evidence
}

/** 多周期共振不单独产出信号，只作为组合得分的调整项（可为负） */
export interface MultiTfAdjustment {
  id: string
  direction: Direction
  delta: number
  evidence: Evidence
}

// ─────────────────────────── ④ 组合层 ───────────────────────────

export type SignalStage = 'PROVISIONAL' | 'CONFIRMED' | 'INVALIDATED'

export interface CombinedSignal {
  code: SecCode
  date: TradeDate
  /** NONE 表示多空得分接近，判为矛盾，不产出提醒但仍落库 */
  direction: Direction | 'NONE'
  /** 0..1。UI 上称为「置信度」，明确不得称为「胜率」（见 docs/04 §4.3） */
  score: number
  votes: number
  regime: Regime
  stage: SignalStage
  subSignals: SubSignal[]
  adjustments: MultiTfAdjustment[]
  scoreByDirection: Record<Direction, number>
  /** 数据不足时的惩罚系数，1 表示数据充分 */
  sufficiencyPenalty: number
}

// ─────────────────────────── ⑤ 风控层 ───────────────────────────

export type GatedDirection = Direction | 'REDUCE' | 'NEXT_DAY_WATCH' | 'NONE'
export type AlertLevel = 'L1' | 'L2' | 'L3'

export interface Position {
  code: SecCode
  shares: number
  /** 不复权成本价 —— 用户的成本是真实成交价 */
  cost: number
  peakPrice: number
  openedAt: number
}

export interface RiskVerdict {
  /** 命中的规则 ID，如 'HARD_LIMIT_UP' / 'STOP_LOSS_8PCT' */
  rule: string
  action: 'SUPPRESS' | 'DOWNGRADE' | 'FORCE_SELL' | 'FORCE_REDUCE' | 'ANNOTATE'
  reason: string
  evidence: Evidence
}

export interface GatedSignal {
  signal: CombinedSignal
  direction: GatedDirection
  level: AlertLevel
  verdicts: RiskVerdict[]
  /** 面板与气泡展示用的文案片段，规范见 docs/05 §5 */
  headline: string
  reasons: string[]
}

// ─────────────────────────── 调用上下文 ───────────────────────────

/**
 * 引擎的全部外部输入。纯函数只认这个对象 —— 没有隐式的时钟、配置或全局状态。
 * 回测时传 candles[0..i] 的切片，未来函数由架构消除（见 ADR-0004）。
 */
export interface EngineContext {
  profile: SecProfile
  candles: Candle[]
  weekly: Candle[]
  snapshot?: Snapshot
  position?: Position
  /** 基准指数的情绪值 0..1，用于 RSI 动态阈值（见 docs/04 §1.6） */
  marketSentiment: number
  /** 由调用方注入，不在引擎内读时钟 */
  now: { date: TradeDate; minutesSinceOpen: number; session: TradingSession }
}

export type TradingSession =
  | 'CLOSED'
  | 'PRE_OPEN'
  | 'AUCTION'
  | 'PRE_TRADE'
  | 'CONTINUOUS_AM'
  | 'LUNCH_BREAK'
  | 'CONTINUOUS_PM'
  | 'CLOSING_AUCTION'
  | 'SETTLE'
