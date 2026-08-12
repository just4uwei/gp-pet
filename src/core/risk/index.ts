/**
 * 风控层（docs/05 §1–§3）。
 *
 * 本软件不下单，所以这一层的产物不是「拒绝成交」，而是三件事：
 *   1. **抑制**无执行意义的信号（涨跌停、停牌、T+1、数据不足）
 *   2. **改写**信号（弱买入降为观察；持仓风险升为强制卖出）
 *   3. **附加**风险标注（ST、行业集中度、波动率历史高位）
 *
 * 两条结构性决定：
 *
 * - **持仓风控是独立通道，不经过组合层得分** —— 止损不需要投票（docs/05 §2.3）。
 *   哪怕当日一条子信号都没成立，只要成本线被击穿就必须提醒。
 * - **被抑制的信号仍然入库并带上原因**（docs/05 §4）。不制造信息黑洞：
 *   用户要能在提醒日志里回答「它是不是漏提醒了」。
 *
 * ⚠ 8% / 7% / 5% / 3% 这些比例直接采自来源文档，**未经验证**（ADR-0003）。
 *   8% 止损对高波动科技股可能过紧、对低波动蓝筹可能过松。
 *   P1 迭代按 ATR 自适应（docs/05 §2.3 脚注）。
 */

import { at } from '../indicators/series'
import type { DataSufficiency } from '../indicators/sufficiency'
import type { EngineParams } from '../params'
import { isSTName, priceLimits } from '../code'
import { SESSION_BOUNDS } from '../session'
import type {
  AlertLevel,
  Candle,
  CombinedSignal,
  Direction,
  Evidence,
  GatedDirection,
  GatedSignal,
  IndicatorSet,
  Position,
  RiskVerdict,
  SecProfile,
  Snapshot,
  TradingSession,
} from '../types'
import { DIRECTION_LABELS, composeHeadline, topReasons } from './text'

const LEVELS: readonly AlertLevel[] = ['L1', 'L2', 'L3']

/** 降级：每命中一条降级规则退一档，L1 是地板（docs/05 §2.2） */
export function downgrade(level: AlertLevel, steps = 1): AlertLevel {
  const index = LEVELS.indexOf(level)
  return LEVELS[Math.max(0, index - Math.max(0, steps))] ?? 'L1'
}

export interface GateInput {
  signal: CombinedSignal
  profile: SecProfile
  /** 与信号同一份序列。**不复权**价从这里取（成本与止损用真实成交价） */
  candles: readonly Candle[]
  ind: IndicatorSet
  index: number
  sufficiency: DataSufficiency
  snapshot?: Snapshot | undefined
  position?: Position | undefined
  /** 该标的所属行业在持仓中的占比 0..1，undefined 表示未统计 */
  industryShare?: number | undefined
  now: {
    minuteOfDay: number
    session: TradingSession
    /** 墙上时刻，仅用于快照陈旧判定；缺省则跳过该规则 */
    atMs?: number | undefined
  }
  params: EngineParams
}

/** 持仓风控的四条强制规则，按严重程度排序 —— 命中第一条即定案 */
export function positionVerdict(input: GateInput): { verdict: RiskVerdict; direction: GatedDirection; level: AlertLevel } | null {
  const { position, params } = input
  if (!position || position.shares <= 0 || position.cost <= 0) return null

  const price = currentPrice(input)
  if (price === null) return null

  const profit = (price - position.cost) / position.cost
  const peak = position.peakPrice > 0 ? position.peakPrice : Math.max(position.cost, price)
  const fromPeak = peak > 0 ? (price - peak) / peak : 0
  const peakProfit = (peak - position.cost) / position.cost
  const risk = params.risk
  const base: Evidence = {
    price,
    cost: position.cost,
    profitPct: profit * 100,
    peakPrice: peak,
    fromPeakPct: fromPeak * 100,
    peakProfitPct: peakProfit * 100,
  }

  // ① 固定止损：亏损触及止损线 —— 最高优先级，不容降级
  if (profit <= -risk.stopLossPct) {
    return {
      direction: 'SELL',
      level: 'L3',
      verdict: {
        rule: 'STOP_LOSS',
        action: 'FORCE_SELL',
        reason: `已亏损 ${(profit * 100).toFixed(1)}%，触及 ${(risk.stopLossPct * 100).toFixed(0)}% 止损线`,
        evidence: base,
      },
    }
  }

  // ② 移动止损：**当前**盈利仍 ≥ 5%，但已从最高点回撤 3% —— 趁还赚着落袋
  //
  // ⚠ 这里的「盈利 ≥ 5%」取**当前**浮盈，而 ④ 盈利保护取的是**曾达**（peak）浮盈。
  // 两者若都按 peak 读，④ 几乎永远够不着：peakProfit ≥ 5% 且 profit < 2% 反推出
  // fromPeak ≤ -2.86%，与 ② 的 -3% 几乎重合，② 会把 ④ 整个吃掉。
  // 按「当前 / 曾达」区分后两条规则不重叠：② 是「赚着的时候走」，④ 是「已经回吐大半，保住剩下的」。
  // 原文（docs/05 §2.3）的措辞正是「盈利 ≥ 5% 后」与「曾达 +5% 后」。
  if (profit >= risk.profitProtectTrigger && fromPeak <= -risk.trailingStopPct) {
    return {
      direction: 'SELL',
      level: 'L3',
      verdict: {
        rule: 'TRAILING_STOP',
        action: 'FORCE_SELL',
        reason: `自最高点回撤 ${Math.abs(fromPeak * 100).toFixed(1)}%，移动止损触发`,
        evidence: base,
      },
    }
  }

  // ③ 回撤减仓：从最高点回撤 7% 且当前仍盈利或微亏
  //    「仍盈利或微亏」的边界取 -止损线：再往下就该由 ① 接手了
  if (fromPeak <= -risk.drawdownReducePct && profit > -risk.stopLossPct) {
    return {
      direction: 'REDUCE',
      level: 'L3',
      verdict: {
        rule: 'DRAWDOWN_REDUCE',
        action: 'FORCE_REDUCE',
        reason: `自最高点回撤 ${Math.abs(fromPeak * 100).toFixed(1)}%，建议减仓 50%`,
        evidence: base,
      },
    }
  }

  // ④ 盈利保护：曾达 +5% 后回落到 +2% 以下
  if (peakProfit >= risk.profitProtectTrigger && profit < risk.profitProtectFallback) {
    return {
      direction: 'REDUCE',
      level: 'L2',
      verdict: {
        rule: 'PROFIT_PROTECT',
        action: 'FORCE_REDUCE',
        reason: `浮盈自 ${(peakProfit * 100).toFixed(1)}% 回落至 ${(profit * 100).toFixed(1)}%，建议保护利润`,
        evidence: base,
      },
    }
  }

  return null
}

/** 硬抑制（docs/05 §2.1）。返回全部命中项，便于面板显示「为什么被静默」 */
export function hardSuppressions(input: GateInput, direction: GatedDirection): RiskVerdict[] {
  const { snapshot, params, candles, index, sufficiency } = input
  const out: RiskVerdict[] = []
  const candle = candles[index]

  if (snapshot?.suspended === true || (candle !== undefined && candle.volume === 0)) {
    out.push({
      rule: 'SUSPENDED',
      action: 'SUPPRESS',
      reason: '停牌或全日无成交，无法交易',
      evidence: { suspended: snapshot?.suspended ?? null, volume: candle?.volume ?? null },
    })
  }

  if (!sufficiency.usable) {
    out.push({
      rule: 'INSUFFICIENT_DATA',
      action: 'SUPPRESS',
      reason: sufficiency.note ?? `日线不足 ${params.data.minBars} 根`,
      evidence: { bars: sufficiency.bars, minBars: params.data.minBars },
    })
  }

  // 次新股：上市不足 60 个交易日，形态与指标都还没站稳。
  // 用已入库根数近似「上市天数」—— 序列本身就是从上市首日开始的
  if (sufficiency.bars < params.risk.newListingMinBars) {
    out.push({
      rule: 'NEW_LISTING',
      action: 'SUPPRESS',
      reason: `上市不足 ${params.risk.newListingMinBars} 个交易日，指标失真`,
      evidence: { bars: sufficiency.bars, required: params.risk.newListingMinBars },
    })
  }

  const limits = limitPrices(input)
  const price = currentPrice(input)
  if (price !== null && limits) {
    if (direction === 'BUY' && price >= limits.limitUp - 0.001) {
      out.push({
        rule: 'HARD_LIMIT_UP',
        action: 'SUPPRESS',
        reason: '已涨停，买不到',
        evidence: { price, limitUp: limits.limitUp },
      })
    }
    if ((direction === 'SELL' || direction === 'REDUCE') && price <= limits.limitDown + 0.001) {
      out.push({
        rule: 'HARD_LIMIT_DOWN',
        action: 'SUPPRESS',
        reason: '已跌停，卖不掉',
        evidence: { price, limitDown: limits.limitDown },
      })
    }
  }

  // 快照陈旧：连续竞价时段里超过 5 分钟没有新价，结论不可信。
  // 没有 atMs（回测）或不在连续竞价时段时不判 —— 收盘后快照本来就是「旧」的
  const continuous = input.now.session === 'CONTINUOUS_AM' || input.now.session === 'CONTINUOUS_PM'
  if (continuous && snapshot && input.now.atMs !== undefined) {
    const age = input.now.atMs - snapshot.at
    if (age > params.data.staleSnapshotMs) {
      out.push({
        rule: 'STALE_SNAPSHOT',
        action: 'SUPPRESS',
        reason: `行情已 ${Math.round(age / 60000)} 分钟未更新，结论不可信`,
        evidence: { ageMs: age, limitMs: params.data.staleSnapshotMs },
      })
    }
  }

  return out
}

/** 降级规则（docs/05 §2.2）。只作用于 BUY —— 离场类不该因为「风险大」而少提醒 */
export function downgrades(input: GateInput, direction: GatedDirection): RiskVerdict[] {
  const { profile, params, ind, index, now } = input
  const out: RiskVerdict[] = []
  if (direction !== 'BUY') return out

  // T+1 尾盘：14:50 之后买入信号改为「明日开盘观察」。
  // lateBuyCutoffMinutes 是含午休的自然分钟（09:30 起算），与量比归一化的口径不同 —— 见 session.ts
  const cutoff = SESSION_BOUNDS.open + params.risk.lateBuyCutoffMinutes
  if (now.minuteOfDay >= cutoff && now.minuteOfDay < SESSION_BOUNDS.settleEnd) {
    out.push({
      rule: 'T1_LATE_BUY',
      action: 'DOWNGRADE',
      reason: 'T+1 限制下尾盘买入已无当日容错，改为明日开盘观察',
      evidence: { minuteOfDay: now.minuteOfDay, cutoff },
    })
  }

  if (profile.isST || isSTName(profile.name)) {
    out.push({
      rule: 'ST_RISK',
      action: 'DOWNGRADE',
      reason: '风险警示股（ST），波动与退市风险显著',
      evidence: { name: profile.name, isST: profile.isST },
    })
  }

  const share = input.industryShare
  if (share !== undefined && share > params.risk.industryConcentrationCap) {
    out.push({
      rule: 'INDUSTRY_CONCENTRATION',
      action: 'DOWNGRADE',
      reason: `${profile.industry ?? '同行业'}持仓占比已达 ${(share * 100).toFixed(0)}%`,
      evidence: { share, cap: params.risk.industryConcentrationCap },
    })
  }

  const bbwPct = at(ind.boll.bbwPct, index)
  if (bbwPct !== null && bbwPct > params.strategy.expandedBbwPct) {
    out.push({
      rule: 'VOLATILITY_EXPANDED',
      action: 'DOWNGRADE',
      reason: '波动率处于历史高位，追高风险大',
      evidence: { bbwPct, cap: params.strategy.expandedBbwPct },
    })
  }

  return out
}

/**
 * 组合层信号 + 风控 → 可提醒的 `GatedSignal`。
 *
 * 分级（docs/05 §3）：
 *   L1 得分达阈值但 < 0.75，或 PROVISIONAL 弱信号，或被降级后的结果
 *   L2 得分 ≥ 0.75；盈利保护类
 *   L3 CONFIRMED 且得分 ≥ 0.75；**全部持仓强制止损/移动止损/回撤减仓**
 */
export function gateSignal(input: GateInput): GatedSignal {
  const { signal } = input
  const forced = positionVerdict(input)

  const direction: GatedDirection = forced ? forced.direction : signal.direction
  const verdicts: RiskVerdict[] = forced ? [forced.verdict] : []
  const suppressions = hardSuppressions(input, direction)
  verdicts.push(...suppressions)

  // 方向为 NONE：没有可提醒的东西，但**抑制原因照样要记**。
  // 「这只股票为什么从来不出信号」是面板必须能回答的问题 —— 数据不足、停牌、次新股
  // 都会让方向恒为 NONE，此时若连原因都不落库，用户看到的就是一片空白。
  // 涨跌停那两条与方向有关，NONE 时本来就不成立（见 hardSuppressions），不必特判。
  if (direction === 'NONE') {
    return {
      signal,
      direction: 'NONE',
      level: 'L1',
      verdicts,
      suppressed: suppressions.length > 0,
      headline: suppressions[0]?.reason ?? '无一致信号',
      reasons: annotations(verdicts),
    }
  }

  const downgradeVerdicts = downgrades(input, direction)
  verdicts.push(...downgradeVerdicts)

  const dataNote = input.sufficiency.limited && input.sufficiency.usable
  if (dataNote) {
    verdicts.push({
      rule: 'LIMITED_DATA',
      action: 'ANNOTATE',
      reason: input.sufficiency.note ?? '数据不足，信号可靠性降低',
      evidence: { bars: input.sufficiency.bars, penalty: input.sufficiency.penalty },
    })
  }

  const lateBuy = downgradeVerdicts.some((v) => v.rule === 'T1_LATE_BUY')
  const finalDirection: GatedDirection = lateBuy ? 'NEXT_DAY_WATCH' : direction

  const level = resolveLevel(input, forced, downgradeVerdicts, suppressions)
  const displayDirection: Direction = direction === 'SELL' || direction === 'REDUCE' ? 'SELL' : 'BUY'

  const headline = forced
    ? `${DIRECTION_LABELS[forced.direction]} · ${forced.verdict.reason}`
    : composeHeadline(signal.subSignals, displayDirection, signal.regime)

  const reasons = forced
    ? [forced.verdict.reason, ...topReasons(signal.subSignals, displayDirection, 2)]
    : topReasons(signal.subSignals, displayDirection)

  return {
    signal,
    direction: finalDirection,
    level,
    verdicts,
    suppressed: suppressions.length > 0,
    headline,
    reasons: [...reasons, ...annotations(verdicts)],
  }
}

function resolveLevel(
  input: GateInput,
  forced: ReturnType<typeof positionVerdict>,
  downgradeVerdicts: readonly RiskVerdict[],
  suppressions: readonly RiskVerdict[]
): AlertLevel {
  // 硬抑制后一律 L1：仍要进面板与提醒日志，但不允许发出任何声响
  if (suppressions.length > 0) return 'L1'
  // 持仓强制通道不受降级规则影响 —— 止损不该因为「这是 ST 股」而少提醒一档
  if (forced) return forced.level
  const { signal, params } = input
  const strong = signal.score >= params.alert.bubbleScore
  const base: AlertLevel = strong ? (signal.stage === 'CONFIRMED' ? 'L3' : 'L2') : 'L1'
  return downgrade(base, downgradeVerdicts.length)
}

/** 降级与标注类的理由要出现在文案里，否则用户看不到「为什么这条被压成静默」 */
function annotations(verdicts: readonly RiskVerdict[]): string[] {
  return verdicts
    .filter((v) => v.action === 'SUPPRESS' || v.action === 'DOWNGRADE' || v.action === 'ANNOTATE')
    .map((v) => v.reason)
}

/** 现价：优先快照最新价，否则用当根**不复权**收盘（持仓成本是真实成交价，不能拿复权价比） */
function currentPrice(input: GateInput): number | null {
  const snapshot = input.snapshot
  if (snapshot && Number.isFinite(snapshot.last) && snapshot.last > 0) return snapshot.last
  const candle = input.candles[input.index]
  return candle && candle.close > 0 ? candle.close : null
}

/**
 * 涨跌停价：优先用快照给的，缺失时按板块规则本地算（免费源对涨跌停支持参差不齐，
 * 北交所常直接返回 -1 —— 见 core/code.ts）。
 */
function limitPrices(input: GateInput): { limitUp: number; limitDown: number } | null {
  const snapshot = input.snapshot
  if (snapshot && snapshot.limitUp !== null && snapshot.limitDown !== null) {
    return { limitUp: snapshot.limitUp, limitDown: snapshot.limitDown }
  }
  const preClose =
    snapshot && snapshot.preClose > 0
      ? snapshot.preClose
      : (input.candles[input.index - 1]?.close ?? null)
  if (preClose === null || preClose <= 0) return null
  return priceLimits(preClose, input.profile.board, input.profile.isST || isSTName(input.profile.name))
}

export * from './text'
