/**
 * 组合层（docs/04 §4）：把子信号汇总、投票、裁决成一条 `CombinedSignal`。
 *
 * ```
 * part(s,d)   = 加权平均(已成立子信号的 score, 按 sub.weight)   // 0..1，策略内的平均强度
 * rawScore(d) = clamp( Σ_strategies part(s,d) × penalty(s,d), 0, 1 )
 * adjusted(d) = rawScore(d) + Σ multiTfAdjustments(d)
 * final(d)    = clamp(adjusted(d), 0, 1) × 数据充分性折价 × 盘中折价
 * votes(s,d)  = 该策略里满足 sub.score ≥ 0.5 的子信号个数
 * 触发        = final(d) ≥ scoreThreshold 且 **任一策略** votes(s,d) ≥ voteThreshold[s]
 * ```
 *
 * 票数线**按策略分开**（2026-08-12，见 params.ts 的说明）：趋势 5 个子信号、
 * 均值回归 4 个，共用一条整数线对后者系统性不利。合并规则取「任一策略达标」而不是
 * 「两边票数相加」—— 票数衡量的是同一个策略内部有多少条规则互相印证，跨策略相加没有这个含义
 *（跨策略的印证已经由得分相加表达了）。
 *
 * `penalty` 只有一处不为 1：**下跌趋势里的均值回归买入**（`combine.downtrendBuyPenalty`，
 * docs/04 §4.1 的「别接飞刀」）。它是方向级抑制，不是策略可信度。
 *
 * ⚠ **两个策略现在是等权的 —— 这是 2026-08-12 删掉动态权重后的形态。**
 * 这一层原本按市场状态给两个策略不同权重（TREND_UP 0.7/0.3、RANGE 0.3/0.7…），
 * 那是整套设计的核心假设。它被测过两轮：
 *   - 第一轮发现「单策略得分上限恰好等于该策略权重」，与 `scoreThreshold` 乘性耦合，
 *     `TRANSITION`（占判定根 66.6%）的 0.50 低于出厂阈值 0.60 —— 三分之二的时间里
 *     单策略信号在算术上无法触发。那是口径 bug，不是效果，先解掉（改为除以行内最大权重）。
 *   - 第二轮在解耦后重测：动态权重与固定 0.5/0.5 的差值在四个参数点上正负交替、
 *     都在 1pp 以内。**看不出效果，且这次不能再归咎于耦合。**
 * docs/07 §2.2 对这种情况的规定是「这个假设就该被推翻，而不是保留一套复杂而无效的机制」，
 * 于是权重表整张删除。全部数字见 [M2 偏差报告 §5.5–§5.8](../../../docs/notes/M2-偏差报告.md)。
 *
 * **不要把权重表加回来。** 它已经被测过一次了；要重新表达「某状态下某策略更可信」，
 * 得先说清楚新机制与旧机制差在哪，并单独标定 —— 尤其不能靠压低某一行的两个数来表达
 *「这个状态整体不可信」，那会原样复现第一轮那个耦合坑。
 *
 * ⚠ 0.60 得分 / (3, 2) 票 / 0.15 冲突带 / 0.5 折价都是**待标定**参数（ADR-0003）。
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
  /** 两个策略的票数之和。展示与落库用这一个数，触发判定用下面的分策略票数 */
  votes: number
  votesByStrategy: { trend: number; meanReversion: number }
  triggered: boolean
}

export interface CombineResult {
  signal: CombinedSignal
  /** 两个方向各自的中间量，落进 evidence 供「为什么没提醒」这类追问 */
  breakdown: Record<Direction, DirectionBreakdown>
  /** direction 为 NONE 时说明原因：得分不足 / 票数不足 / 多空矛盾 */
  reason: 'TRIGGERED' | 'BELOW_THRESHOLD' | 'NOT_ENOUGH_VOTES' | 'CONFLICT'
}

export function combineSignals(input: CombineInput): CombineResult {
  const { params, regime, stage } = input
  const discount = stage === 'PROVISIONAL' ? params.combine.provisionalDiscount : 1

  const empty = (): DirectionBreakdown => ({
    raw: 0,
    adjusted: 0,
    final: 0,
    votes: 0,
    votesByStrategy: { trend: 0, meanReversion: 0 },
    triggered: false,
  })
  const breakdown: Record<Direction, DirectionBreakdown> = { BUY: empty(), SELL: empty() }

  for (const direction of DIRECTIONS) {
    let trendScore = 0
    let trendWeight = 0
    let trendVotes = 0
    let meanReversionScore = 0
    let meanReversionWeight = 0
    let meanReversionVotes = 0

    for (const sub of input.subSignals) {
      if (sub.direction !== direction) continue
      const votes = sub.score >= 0.5 ? 1 : 0
      if (sub.strategy === 'MEAN_REVERSION') {
        meanReversionScore += sub.score * sub.weight
        meanReversionWeight += sub.weight
        meanReversionVotes += votes
      } else {
        trendScore += sub.score * sub.weight
        trendWeight += sub.weight
        trendVotes += votes
      }
    }

    // 策略内取**加权平均**（除以已成立子信号的权重和），而不是直接求和。
    //
    // 文档 §4.2 的式子写作 `Σ sub.score × sub.weight`，字面读是「未成立的子信号按 0 计入」。
    // 但那样一来，趋势市里要过 0.60 就得让 5 条子信号中的 4 条同时满分（0.7 × 0.857），
    // 而同一节又写着「votes ≥ 3 即可触发」—— 两个数在字面读法下不可能同时成立。
    // 取加权平均后，得分含义变成「已成立规则的平均强度 × 该策略在当前状态下的权重」，
    // 一致性由票数负责、强度由得分负责，0.60 分 + 分策略票数线才是一组自洽的阈值。
    // 详见 docs/notes/M2-偏差报告.md §1。
    const trendPart = trendWeight > 0 ? trendScore / trendWeight : 0
    const meanReversionPart = meanReversionWeight > 0 ? meanReversionScore / meanReversionWeight : 0

    // 下跌趋势里的均值回归买入：条件成立但降权。放在这里而不是策略层，
    // 是为了让「信号成立、被降权」这件事在 breakdown 里看得见。
    // 只作用于均值回归那一项：它是「别接飞刀」，不是「下跌趋势里所有信号都不可信」。
    const buyPenalty =
      direction === 'BUY' && regime === 'TREND_DOWN' ? params.combine.downtrendBuyPenalty : 1

    // 两个策略等权相加。夹到 1：同向共振时和可以到 2。
    // 不夹的话，§3.3 的多周期惩罚项（−0.15）会被溢出的那一截吸收掉 —— 惩罚项在最该起作用的
    // 强共振场景里反而失效。夹紧后「1.0 = 满分」含义唯一，代价是顶部不再有分辨率，
    // 由 votes 承担那一段区分。
    const raw = clamp01(trendPart + meanReversionPart * buyPenalty)
    const delta = input.adjustments
      .filter((adjustment) => adjustment.direction === direction)
      .reduce((sum, adjustment) => sum + adjustment.delta, 0)
    const adjusted = raw + delta
    const final = clamp01(adjusted) * input.sufficiencyPenalty * discount

    // 任一策略在自己内部足够一致即可。两边票数**不相加**：那会让「趋势 2 票 + 均值回归 1 票」
    // 冒充「某个策略有 3 条规则互相印证」，而这两件事的可信度不是一回事。
    const line = params.combine.voteThreshold
    const consistent = trendVotes >= line.trend || meanReversionVotes >= line.meanReversion

    breakdown[direction] = {
      raw,
      adjusted,
      final,
      votes: trendVotes + meanReversionVotes,
      votesByStrategy: { trend: trendVotes, meanReversion: meanReversionVotes },
      triggered: final >= params.combine.scoreThreshold && consistent,
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
