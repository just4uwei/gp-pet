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
import type { WatchHit } from '../watch/evaluate'
import { conditionsText, hitValuesText } from '../watch/metrics'
import type { AlertCandidate, AlertTrack } from './dispatcher'

const LEVELS: readonly AlertLevel[] = ['L1', 'L2', 'L3']

/** 整体上调/下调一档，L1 是地板、L3 是天花板（docs/05 §3） */
export function shiftLevel(level: AlertLevel, offset: number): AlertLevel {
  const index = LEVELS.indexOf(level) + Math.trunc(offset)
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, index))] ?? level
}

/** 两者取高。**只用于加佐证的场合**，不得用来绕过用户的整体下调之外的任何降级 */
export function maxLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b
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
  /**
   * 本轮命中的观察点（P2 续）。它们与信号**走同一套闸门** ——
   * 不新开分发路径，状态点仍只由闸门点亮。
   */
  watchHits?: readonly WatchHit[]
  /**
   * 这只标的走哪条轨（2026-08-17 双轨提醒）。缺省全是 `PRIMARY` ⇒ 行为与双轨之前逐位相同。
   *
   * 只影响配额与气泡优先级（见 `AlertTrack`），**不影响级别与文案** ——
   * 观察标的没有持仓，风控那套本来就不跑，所以它自然到不了 L3。
   */
  trackOf?: (code: SecCode) => AlertTrack
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

/**
 * 观察点命中（P2 续）。**提醒层的第三类来源**：信号 / 收盘失效 / 观察点命中。
 *
 * 四个字段的取值都不是随手定的：
 *
 * - `signalId` 用观察点的**来源信号** —— `alert_log.signal_id` 是 NOT NULL 外键，
 *   而观察点命中不产生新信号。挂来源信号既满足外键，又让「这条提醒是哪来的」可追溯，
 *   于是**不用动 alert_log 的表结构**。
 * - `direction` 刻意用 **`NONE`**：同键冷却的键是 `code:direction`，沿用原方向会让
 *   上午那条买入提醒的 2h 冷却把这条命中提示一起吃掉 —— 与失效提示同一条理由。
 * - `level` 是 **L2**：用户亲自确认要盯的东西够得上气泡，但**照过四道闸门**
 *   （防抖 / 冷却 / 上限 / 免打扰）。这不是强制类，不该绕过限流。
 * - 文案说的是「你设的观察点到了」而**不是**「策略让你卖」。措辞纪律：
 *   `INVALIDATE` 写成「原判断的失效条件已出现」，不许写成「快卖」。
 */
function watchHitAlert(hit: WatchHit, at: number): PreparedAlert {
  const { point } = hit
  // 组合条件用「且」连起来整句说 —— 只报其中一条会让用户以为软件提前触发了
  const subject = conditionsText(point.conditions)
  const headline =
    point.meaning === 'INVALIDATE'
      ? `你设的失效条件已出现：${subject}`
      : `你设的观察条件已满足：${subject}`

  const reasons = [`当前 ${hitValuesText(point.conditions, hit.values)}`]
  if (point.note !== undefined && point.note !== '') reasons.push(point.note)
  reasons.push(
    point.meaning === 'INVALIDATE'
      ? '这是你当时确认的「判断错了会先看到什么」，不是新的策略信号'
      : '这是你当时确认的观察条件，不是新的策略信号'
  )

  return {
    candidate: {
      signalId: point.signalId,
      code: point.code,
      direction: 'NONE',
      level: 'L2',
      // 观察点没有得分。给 0 会让它在超限排序里永远垫底，
      // 给 1 会让它挤掉真信号 —— 取中间值，且它本来就受冷却与上限管着
      score: 0.5,
      topSubSignalId: 'WATCH_HIT',
    },
    payload: {
      signalId: point.signalId,
      level: 'L2',
      direction: 'NONE',
      headline,
      reasons,
      code: point.code,
      name: hit.name,
      price: hit.price,
      changePct: hit.changePct,
      score: 0.5,
      at,
    },
  }
}

export function buildAlerts(outcomes: readonly SignalOutcome[], options: BuildOptions): PreparedAlert[] {
  const { levelOffset = 0, quotes, at, watchHits = [], trackOf } = options
  const prepared: PreparedAlert[] = []

  // 观察点命中排在信号之前：用户亲自设的东西优先于引擎自己发现的
  for (const hit of watchHits) prepared.push(watchHitAlert(hit, at))

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
    const shifted = forced ? gated.level : shiftLevel(gated.level, levelOffset)
    /*
      昨日收盘那条「明日观察」今天兑现了（engine/signals.ts 的 CarryoverNotice）。

      **不新发一条提醒，而是把今天这条抬到 L2 并写清来历。** 两个理由：
        * 一天两条说同一件事，用户只会觉得吵；
        * 而它确实比一条孤立的盘中买入更值得一看 —— 昨天收盘 CONFIRMED、今天盘中仍成立，
          是两次独立成立。分级规则本来就把「CONFIRMED 且强」放在 L3，
          这里只抬到 L2（今天这根还是临时的，够不着 L3）。

      **只抬不降**：用户把整体级别下调过一档时，`shiftLevel` 已经把它压到 L1，
      而复活的意义就是让这条看得见 —— 但也不越过用户的上调（取两者较高的那个）。
    */
    const level = outcome.carriedOver && !forced ? maxLevel(shifted, 'L2') : shifted
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
      ...(trackOf ? { track: trackOf(evaluation.code) } : {}),
    }

    prepared.push({
      candidate,
      payload: {
        signalId,
        level,
        direction: gated.direction,
        headline: gated.headline,
        // 依据行最多 3 条，完整依据在面板展开（docs/05 §5）。
        // 复活那一句排在最前：它是「这条为什么值得看」的第一理由，
        // 挤掉第三条子信号依据是划算的（那条在面板展开里仍在）
        reasons: (outcome.carriedOver
          ? [`昨日（${outcome.carriedOver.from}）收盘给出明日观察，今日开盘后仍成立`, ...gated.reasons]
          : gated.reasons
        ).slice(0, 3),
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
