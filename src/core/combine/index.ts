/**
 * 组合层（docs/04 §4）：把子信号按市场状态加权、投票、裁决成一条 `CombinedSignal`。
 *
 * ```
 * rawScore(d) = Σ_strategies  strategyWeight × 加权平均(已成立子信号的 score, 按 sub.weight)
 * adjusted(d) = rawScore(d) + Σ multiTfAdjustments(d)
 * final(d)    = clamp(adjusted(d), 0, 1) × 数据充分性折价 × 盘中折价
 * votes(d)    = 满足 sub.score ≥ 0.5 的子信号个数
 * 触发        = final(d) ≥ scoreThreshold 且 votes(d) ≥ voteThreshold
 * ```
 *
 * 动态权重表（docs/04 §4.1）：
 *
 * | Regime | 趋势 | 均值回归 |
 * |---|---|---|
 * | TREND_UP | 0.70 | 0.30 |
 * | TREND_DOWN | 0.70 | 0.30（BUY 再 ×0.5 —— 下跌趋势里抢反弹是接飞刀） |
 * | RANGE | 0.30 | 0.70 |
 * | TRANSITION | 0.50 | 0.50 |
 *
 * ⚠ 0.60 / 3 票 / 0.15 冲突带都是**待标定**参数（ADR-0003）。整套设计的核心假设
 * 「按市场状态切换权重能提升表现」必须由 docs/07 的分 Regime 归因来验；
 * 若归因显示无效，应当砍掉这一层的复杂度而不是保留它（docs/08 关键决策点 2）。
 */

import type { EngineParams } from '../params'
import type {
  CombinedSignal,
  Direction,
  MultiTfAdjustment,
  Regime,
  SecCode,
  SignalStage,
  SubSignal,
  TradeDate,
} from '../types'

const DIRECTIONS: readonly Direction[] = ['BUY', 'SELL']

export interface CombineInput {
  code: SecCode
  date: TradeDate
  regime: Regime
  subSignals: readonly SubSignal[]
  adjustments: readonly MultiTfAdjustment[]
  stage: SignalStage
  /** 数据充分性折价，1 表示数据充分（见 indicators/sufficiency.ts） */
  sufficiencyPenalty: number
  params: EngineParams
}

export interface DirectionBreakdown {
  raw: number
  adjusted: number
  final: number
  votes: number
  triggered: boolean
}

export interface CombineResult {
  signal: CombinedSignal
  /** 两个方向各自的中间量，落进 evidence 供「为什么没提醒」这类追问 */
  breakdown: Record<Direction, DirectionBreakdown>
  /** direction 为 NONE 时说明原因：得分不足 / 票数不足 / 多空矛盾 */
  reason: 'TRIGGERED' | 'BELOW_THRESHOLD' | 'NOT_ENOUGH_VOTES' | 'CONFLICT'
}

/** TREND_DOWN 之外的 regime 没有 meanReversionBuyPenalty 字段，缺省即 1（不惩罚） */
function weightsFor(params: EngineParams, regime: Regime): {
  trend: number
  meanReversion: number
  meanReversionBuyPenalty: number
} {
  const weights = params.weights[regime]
  return {
    trend: weights.trend,
    meanReversion: weights.meanReversion,
    meanReversionBuyPenalty:
      'meanReversionBuyPenalty' in weights ? weights.meanReversionBuyPenalty : 1,
  }
}

export function combineSignals(input: CombineInput): CombineResult {
  const { params, regime, stage } = input
  const weights = weightsFor(params, regime)
  const discount = stage === 'PROVISIONAL' ? params.combine.provisionalDiscount : 1

  const breakdown: Record<Direction, DirectionBreakdown> = {
    BUY: { raw: 0, adjusted: 0, final: 0, votes: 0, triggered: false },
    SELL: { raw: 0, adjusted: 0, final: 0, votes: 0, triggered: false },
  }

  for (const direction of DIRECTIONS) {
    let trendScore = 0
    let trendWeight = 0
    let meanReversionScore = 0
    let meanReversionWeight = 0
    let votes = 0

    for (const sub of input.subSignals) {
      if (sub.direction !== direction) continue
      if (sub.score >= 0.5) votes++
      if (sub.strategy === 'MEAN_REVERSION') {
        meanReversionScore += sub.score * sub.weight
        meanReversionWeight += sub.weight
      } else {
        trendScore += sub.score * sub.weight
        trendWeight += sub.weight
      }
    }

    // 策略内取**加权平均**（除以已成立子信号的权重和），而不是直接求和。
    //
    // 文档 §4.2 的式子写作 `Σ sub.score × sub.weight`，字面读是「未成立的子信号按 0 计入」。
    // 但那样一来，趋势市里要过 0.60 就得让 5 条子信号中的 4 条同时满分（0.7 × 0.857），
    // 而同一节又写着「votes ≥ 3 即可触发」—— 两个数在字面读法下不可能同时成立。
    // 取加权平均后，得分含义变成「已成立规则的平均强度 × 该策略在当前状态下的权重」，
    // 一致性由票数负责、强度由得分负责，0.60/3 票才是一组自洽的阈值。
    // 详见 docs/notes/M2-偏差报告.md §1。
    const trendPart = trendWeight > 0 ? trendScore / trendWeight : 0
    const meanReversionPart = meanReversionWeight > 0 ? meanReversionScore / meanReversionWeight : 0

    // 下跌趋势里的均值回归买入：条件成立但降权。放在这里而不是策略层，
    // 是为了让「信号成立、被降权」这件事在 breakdown 里看得见
    const buyPenalty =
      direction === 'BUY' && regime === 'TREND_DOWN' ? weights.meanReversionBuyPenalty : 1

    const raw = weights.trend * trendPart + weights.meanReversion * meanReversionPart * buyPenalty
    const delta = input.adjustments
      .filter((adjustment) => adjustment.direction === direction)
      .reduce((sum, adjustment) => sum + adjustment.delta, 0)
    const adjusted = raw + delta
    const final = clamp01(adjusted) * input.sufficiencyPenalty * discount

    breakdown[direction] = {
      raw,
      adjusted,
      final,
      votes,
      triggered: final >= params.combine.scoreThreshold && votes >= params.combine.voteThreshold,
    }
  }

  const { direction, reason } = adjudicate(breakdown, params)
  const chosen = direction === 'NONE' ? null : breakdown[direction]
  const score = chosen ? chosen.final : Math.max(breakdown.BUY.final, breakdown.SELL.final)
  const votes = chosen ? chosen.votes : Math.max(breakdown.BUY.votes, breakdown.SELL.votes)

  const signal: CombinedSignal = {
    code: input.code,
    date: input.date,
    direction,
    score,
    votes,
    regime,
    stage,
    // 只保留与裁决方向一致的子信号会让「为什么判成矛盾」无从解释，所以全留
    subSignals: [...input.subSignals],
    adjustments: [...input.adjustments],
    scoreByDirection: { BUY: breakdown.BUY.final, SELL: breakdown.SELL.final },
    sufficiencyPenalty: input.sufficiencyPenalty,
  }

  return { signal, breakdown, reason }
}

/**
 * 方向裁决。文档只写了两条规则，其余留白，这里的补全：
 *
 * 1. 两个方向都触发 → 取 final 较高者；差值 < conflictBand → 判为矛盾（NONE）
 * 2. 只有一个方向触发，但**对侧得分也过了阈值**（只是票数不够）且差值 < conflictBand
 *    → 同样判为矛盾。文档的冲突条款只提「都触发」，但「多空得分几乎相等」的本质是
 *    规则之间互相打架，与对侧差一票无关 —— 此时提醒用户买入是不负责任的。
 * 3. 谁都没触发 → NONE，并区分是得分不够还是票数不够（面板「被静默的信号」要显示原因）
 */
function adjudicate(
  breakdown: Record<Direction, DirectionBreakdown>,
  params: EngineParams
): { direction: Direction | 'NONE'; reason: CombineResult['reason'] } {
  const { scoreThreshold, conflictBand } = params.combine
  const buy = breakdown.BUY
  const sell = breakdown.SELL
  const gap = Math.abs(buy.final - sell.final)
  const contested = buy.final >= scoreThreshold && sell.final >= scoreThreshold

  if (buy.triggered && sell.triggered) {
    if (gap < conflictBand) return { direction: 'NONE', reason: 'CONFLICT' }
    return { direction: buy.final > sell.final ? 'BUY' : 'SELL', reason: 'TRIGGERED' }
  }

  for (const direction of DIRECTIONS) {
    const candidate = breakdown[direction]
    if (!candidate.triggered) continue
    if (contested && gap < conflictBand) return { direction: 'NONE', reason: 'CONFLICT' }
    return { direction, reason: 'TRIGGERED' }
  }

  // 谁都没触发：得分够但票不够 vs 得分本身不够，是两种完全不同的调参方向
  const best = buy.final >= sell.final ? buy : sell
  return {
    direction: 'NONE',
    reason: best.final >= scoreThreshold ? 'NOT_ENOUGH_VOTES' : 'BELOW_THRESHOLD',
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}
