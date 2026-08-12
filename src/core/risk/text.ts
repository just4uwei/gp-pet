/**
 * 提醒文案（docs/05 §5）。
 *
 * 措辞纪律（CLAUDE.md）在这里落地，评审时守住这一个文件即可：
 *   - 置信度**不得**称「胜率」或「概率」
 *   - **不得**出现「必涨」「抄底」「稳赚」「牛股」等词
 *   - 卖出类不用「快跑」「割肉」这类情绪化表达
 *
 * 文案放在 core 而不是渲染层，是因为气泡、系统通知、面板、提醒日志四处都要用同一句话；
 * 分散到各 UI 去拼会让「同一条信号在通知里和面板里说法不同」。
 */

import type { Direction, GatedDirection, Regime, SubSignal } from '../types'

export const REGIME_LABELS: Record<Regime, string> = {
  TREND_UP: '上升趋势',
  TREND_DOWN: '下跌趋势',
  RANGE: '震荡市',
  TRANSITION: '转换期',
}

export const DIRECTION_LABELS: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

/** 子信号的短标签，用于 headline 的第一段（「金叉突破」那一格） */
const SHORT_LABELS: Record<string, Record<Direction, string>> = {
  T1_MA_CROSS: { BUY: '均线金叉', SELL: '均线死叉' },
  T2_MACD_ZERO_CROSS: { BUY: 'MACD 零轴上金叉', SELL: 'MACD 零轴下死叉' },
  T3_BREAKOUT: { BUY: '放量突破上轨', SELL: '放量跌破下轨' },
  T4_ALIGNMENT: { BUY: '多头排列', SELL: '空头排列' },
  T5_PULLBACK_HOLD: { BUY: '回踩中轨不破', SELL: '反弹中轨受压' },
  R1_RSI_BAND: { BUY: '超卖触下轨', SELL: '超买触上轨' },
  R2_REVERT_TO_MID: { BUY: '回归中轨', SELL: '跌回中轨' },
  R3_SQUEEZE: { BUY: '带宽压缩触下轨', SELL: '带宽压缩触上轨' },
  R4_MID_REVERSION: { BUY: '偏离中轨过深', SELL: '偏离中轨过高' },
}

export const ADJUSTMENT_LABELS: Record<string, string> = {
  M1_WEEK_MACD_DAY_RSI: '周线拐头共振',
  M2_WEEK_ADX_CONFIRM: '周线趋势确认',
  M3_FALSE_BREAKOUT: '周线无趋势，突破存疑',
}

export function subSignalLabel(sub: Pick<SubSignal, 'id' | 'direction'>): string {
  return SHORT_LABELS[sub.id]?.[sub.direction] ?? sub.id
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 依据行的一条：短标签 + 关键数值。数值取自 evidence，取不到就只给标签
 * —— 「MA5上穿MA20」本身已经说明了问题，编一个数字进去反而降低可信度。
 */
export function describeSubSignal(sub: SubSignal): string {
  const label = subSignalLabel(sub)
  switch (sub.id) {
    case 'T3_BREAKOUT': {
      const ratio = numberOf(sub.evidence['volRatio'])
      return ratio === null ? label : `${label} · 量比 ${ratio.toFixed(1)}`
    }
    case 'R1_RSI_BAND': {
      const rsi = numberOf(sub.evidence['rsi'])
      return rsi === null ? label : `${label} · RSI ${rsi.toFixed(0)}`
    }
    case 'T4_ALIGNMENT': {
      const adx = numberOf(sub.evidence['adx'])
      return adx === null ? label : `${label} · ADX ${adx.toFixed(0)}`
    }
    case 'R4_MID_REVERSION': {
      const deviation = numberOf(sub.evidence['deviationInStd'])
      return deviation === null ? label : `${label} · 偏离 ${Math.abs(deviation).toFixed(1)}σ`
    }
    default:
      return label
  }
}

/**
 * 依据行：最多 3 条，按「权重 × 强度」排序（docs/05 §5「最多列 3 条最高权重的子信号」）。
 * 完整依据在面板展开里，不在这里堆。
 */
export function topReasons(
  subSignals: readonly SubSignal[],
  direction: Direction,
  limit = 3
): string[] {
  return subSignals
    .filter((sub) => sub.direction === direction)
    .slice()
    .sort((a, b) => b.weight * b.score - a.weight * a.score)
    .slice(0, limit)
    .map(describeSubSignal)
}

/** headline 第二段的格式：「金叉突破 · 趋势市」 */
export function composeHeadline(
  subSignals: readonly SubSignal[],
  direction: Direction,
  regime: Regime
): string {
  const top = subSignals
    .filter((sub) => sub.direction === direction)
    .slice()
    .sort((a, b) => b.weight * b.score - a.weight * a.score)[0]
  const lead = top ? subSignalLabel(top) : DIRECTION_LABELS[direction]
  return `${lead} · ${REGIME_LABELS[regime]}`
}

/** 百分比文案。UI 上称「置信度」，**不得**称「胜率」（docs/04 §4.3） */
export function confidenceText(score: number): string {
  return `置信 ${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}
