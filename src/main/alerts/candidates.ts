/**
 * 引擎评估结果 → 分发器候选（docs/05 §3、§4）。
 *
 * 放在单独的纯函数里而不是塞进 AlertService，是因为这里的每一条取舍都值得单测：
 * 「哪些信号根本不该进提醒层」「用户的一档偏移作用在谁身上」「强制类的浮亏从哪读」
 * 全是少发/多发的分岔点，而少发（漏止损）用户自己发现不了。
 *
 * ## 三条取舍
 *
 * 1. **硬抑制的信号不进提醒层。** docs/05 §2.1 的原话是「信号直接丢弃，仅落库不提醒」——
 *    它已经在 `signal` 表里带着原因，面板的「今日信号」会显示「已静默：停牌」。
 *    再往 alert_log 里写一行会让提醒日志变成信号日志，两张表说同一件事。
 *
 * 2. **用户的整体级别偏移不作用于持仓强制类。** docs/05 §3 允许「整体上调/下调一档」，
 *    但把止损从 L3 调成 L2 意味着跌停那天不响 —— 这类错误用户发现不了。
 *    偏移因此只作用于策略信号；强制类保持风控层定的级别。
 *
 * 3. **拿不到 signalId 的不发。** `alert_log.signal_id` 是指向 `signal(id)` 的外键
 *    （PRAGMA foreign_keys = ON），落不了库的提醒等于发出去就没有审计记录，
 *    而「能不能回答漏没漏」比「这一条早发 30 秒」重要。
 */

import type { Evaluation } from '@core/engine'
import type { AlertLevel, GatedDirection, SecCode, SubSignal } from '@core/types'
import type { AlertPayload } from '@shared/ipc-types'
import type { InvalidationNotice, SignalOutcome } from '../engine/signals'
import type { AlertCandidate } from './dispatcher'

const LEVELS: readonly AlertLevel[] = ['L1', 'L2', 'L3']

/** 整体上调/下调一档，L1 是地板、L3 是天花板（docs/05 §3） */
export function shiftLevel(level: AlertLevel, offset: number): AlertLevel {
  const index = LEVELS.indexOf(level) + Math.trunc(offset)
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, index))] ?? level
}

/** 报价投影，只取气泡与通知要显示的两项 */
export interface QuoteView {
  last: number
  changePct: number
}

export interface PreparedAlert {
  candidate: AlertCandidate
  /** 气泡与系统通知的展示载荷 */
  payload: AlertPayload
}

export interface BuildOptions {
  /** AppSettings.alertLevelOffset */
  levelOffset?: number
  /** code → 最新报价。缺失时退回被判定那根 K 线的**不复权**收盘价，涨跌幅显示 0 */
  quotes?: ReadonlyMap<SecCode, QuoteView>
  /** 触发时刻（墙上时间）。不读时钟，与 src/core 同一条纪律 */
  at: number
}

/** 持仓强制通道：这些裁决绕过组合层得分，不受冷却限制（docs/05 §2.3、§4.2） */
function forcedVerdict(evaluation: Evaluation): { rule: string; lossPct?: number } | null {
  const verdict = evaluation.gated.verdicts.find(
    (v) => v.action === 'FORCE_SELL' || v.action === 'FORCE_REDUCE'
  )
  if (!verdict) return null
  // positionVerdict() 把浮亏写进 evidence.profitPct（百分数）。缺了也不算错 ——
  // 那时台阶判定退化为「不受冷却」，宁可多发一条止损也不能漏
  const raw = verdict.evidence['profitPct']
  const lossPct = typeof raw === 'number' && Number.isFinite(raw) ? raw / 100 : undefined
  return { rule: verdict.rule, ...(lossPct === undefined ? {} : { lossPct }) }
}

/**
 * 防抖键的一部分：本轮**与最终方向一致**的最强子信号。
 *
 * 取一致方向而不是全局最强，是因为防抖问的是「同一个理由是否连续成立」——
 * 反方向那条子信号换成别的，不该让买入信号的连续计数清零。
 */
export function topSubSignalId(subSignals: readonly SubSignal[], direction: GatedDirection): string {
  const side = direction === 'SELL' || direction === 'REDUCE' ? 'SELL' : 'BUY'
  let best: SubSignal | null = null
  for (const sub of subSignals) {
    if (sub.direction !== side) continue
    if (!best || sub.score * sub.weight > best.score * best.weight) best = sub
  }
  return best?.id ?? 'NONE'
}

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

/**
 * 收盘失效的撤销提示（docs/04 §6、docs/05 §3「信号失效通知」= L1）。
 *
 * **方向刻意用 `NONE`**：同键冷却的键是 `code:direction`，若沿用原方向，
 * 上午那条买入提醒的 2 小时冷却会把这条撤销提示一起吃掉 —— 而撤销恰恰是
 * 「上午那条别当真了」，被冷却挡住等于让用户拿着一条已经作废的提醒过夜。
 */
function invalidationAlert(
  outcome: SignalOutcome,
  notice: InvalidationNotice,
  at: number,
  quotes: BuildOptions['quotes']
): PreparedAlert {
  const evaluation = outcome.evaluation
  const quote = quotes?.get(evaluation.code)
  const headline = `盘中${DIRECTION_LABEL[notice.direction]}信号收盘未获确认，已失效`
  return {
    candidate: {
      signalId: notice.signalId,
      code: evaluation.code,
      direction: 'NONE',
      level: 'L1',
      score: evaluation.signal.score,
      topSubSignalId: 'INVALIDATED',
    },
    payload: {
      signalId: notice.signalId,
      level: 'L1',
      direction: 'NONE',
      headline,
      reasons: ['收盘价未维持盘中判定，原信号作废'],
      code: evaluation.code,
      name: outcome.name,
      price: quote?.last ?? evaluation.candle.close,
      changePct: quote?.changePct ?? 0,
      score: evaluation.signal.score,
      at,
    },
  }
}

export function buildAlerts(outcomes: readonly SignalOutcome[], options: BuildOptions): PreparedAlert[] {
  const { levelOffset = 0, quotes, at } = options
  const prepared: PreparedAlert[] = []

  for (const outcome of outcomes) {
    const evaluation = outcome.evaluation
    const gated = evaluation.gated

    // 撤销提示与本轮的新信号互不排斥：早上买入、收盘失效、同时又出了一条卖出，
    // 三件事都该让用户知道
    if (outcome.invalidated) prepared.push(invalidationAlert(outcome, outcome.invalidated, at, quotes))

    if (gated.direction === 'NONE') continue
    // ① 硬抑制：仅落库不提醒（docs/05 §2.1）
    if (gated.suppressed) continue
    const signalId = outcome.signalId
    if (signalId === null || signalId === '') continue

    const forced = forcedVerdict(evaluation)
    const level = forced ? gated.level : shiftLevel(gated.level, levelOffset)
    const quote = quotes?.get(evaluation.code)

    const candidate: AlertCandidate = {
      signalId,
      code: evaluation.code,
      direction: gated.direction,
      level,
      score: evaluation.signal.score,
      topSubSignalId: forced ? forced.rule : topSubSignalId(evaluation.signal.subSignals, gated.direction),
      ...(forced ? { forced: true } : {}),
      ...(forced?.lossPct === undefined ? {} : { lossPct: forced.lossPct }),
    }

    prepared.push({
      candidate,
      payload: {
        signalId,
        level,
        direction: gated.direction,
        headline: gated.headline,
        // 依据行最多 3 条，完整依据在面板展开（docs/05 §5）
        reasons: gated.reasons.slice(0, 3),
        code: evaluation.code,
        name: outcome.name,
        // 展示价一律**不复权**：用户在券商 App 看到的是这个数（docs/03 §2.3）
        price: quote?.last ?? evaluation.candle.close,
        changePct: quote?.changePct ?? 0,
        score: evaluation.signal.score,
        at,
      },
    })
  }

  return prepared
}
