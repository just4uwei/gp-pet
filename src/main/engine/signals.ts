/**
 * 信号编排层（docs/02 §3）：把 `src/core` 的纯函数接到真实数据、存储与 UI 上。
 *
 * 职责边界 —— 这里**不含任何策略判断**，判断全在 `src/core`：
 *   - 为每只自选股拼出 `EngineContext`（日线 + 周线 + 快照 + 持仓 + 大盘情绪）
 *   - 调 `evaluate()`，把收盘指标写进缓存、把信号写进 `signal` 表
 *   - 落库去重（盘中每 30s 一轮，不能每轮都插一行）
 *   - 收盘确认轮：把当日 PROVISIONAL 推进为 CONFIRMED / INVALIDATED（docs/04 §6）
 *
 * **不做**提醒分级之外的任何事：气泡、通知、冷却、免打扰都是 M3 的 AlertDispatcher。
 * 这里只把 `GatedSignal`（已含 level）交出去。
 */

import { randomUUID } from 'node:crypto'
import { evaluate, type Evaluation } from '@core/engine'
import { aggregateWeekly } from '@core/indicators/weekly'
import { marketSentiment } from '@core/indicators/thresholds'
import { at } from '@core/indicators/series'
import { DEFAULT_PARAMS, engineVersionOf, type EngineParams } from '@core/params'
import { continuousMinutesElapsed } from '@core/session'
import type {
  Candle,
  GatedDirection,
  IndicatorSet,
  Position,
  SecCode,
  SecProfile,
  SignalStage,
  TradeDate,
  TradingSession,
} from '@core/types'
import type { SignalEvidence, SignalRecord } from '@shared/ipc-types'
import type { IndicatorRepo } from '../storage/repositories/indicator'
import type { SignalEvidencePayload, SignalRepo, SignalRow } from '../storage/repositories/signal'
import type { WatchEntry } from '../storage/repositories/watchlist'
import type { MarketDataService } from './market-data'

/** 默认基准指数（docs/04 §1.6）。它不可交易，但要走同一套取数与落库路径 */
export const BENCHMARK_CODE: SecCode = 'SH000300'

export interface SignalEngineDeps {
  market: Pick<MarketDataService, 'getContext' | 'snapshotOf'>
  /** WatchlistRepo 结构上就满足它 —— 这里要的是 profile，不是 WatchItem */
  watchlist: { list(): WatchEntry[] }
  positions: { get(code: SecCode): Position | null; list(): Position[]; bumpPeak(code: SecCode, price: number): void }
  signals: SignalRepo
  indicators: IndicatorRepo
  params?: EngineParams
  benchmarkCode?: SecCode
  /** 引擎每次可见的最大回看根数，与 MarketDataService.initialBars 对齐 */
  lookback?: number
  newId?: () => string
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export interface TickInfo {
  date: TradeDate
  minuteOfDay: number
  session: TradingSession
  at: number
  /** 该时段是否允许产出信号（竞价阶段为 false —— 虚价会伪造穿越） */
  producesSignals: boolean
}

/** 收盘确认轮把当日一条盘中信号判为失效（docs/04 §6）。提醒层据此发一条 L1 撤销提示 */
export interface InvalidationNotice {
  /** 被判失效的那一行 —— alert_log.signal_id 指向它 */
  signalId: string
  /** 它当初给出的方向，用于文案「上午的买入信号收盘未获确认」 */
  direction: GatedDirection
}

export interface SignalOutcome {
  evaluation: Evaluation
  name: string
  /** 本轮是否落了新的一行（去重后） */
  persisted: boolean
  /** 落库行的 id；未落库时是上一次的 id */
  signalId: string | null
  /** 非空表示本轮把上一条盘中信号判失效了（docs/05 §3：信号失效通知属 L1） */
  invalidated?: InvalidationNotice
}

export interface SignalEngine {
  readonly engineVersion: string
  /** 跑一轮全量评估。竞市之外的时段返回空数组且不落库 */
  run(tick: TickInfo): SignalOutcome[]
  /** 最近一轮的评估结果，供面板与桌宠状态使用 */
  latest(): SignalOutcome[]
  history(query: { code?: SecCode; from?: number; to?: number; limit?: number }): SignalRecord[]
  explain(id: string): SignalEvidence | null
  /** 启动时调用：清掉旧引擎版本的指标缓存（参数一改，旧值不再可比） */
  purgeStaleCache(): number
}

export function createSignalEngine(deps: SignalEngineDeps): SignalEngine {
  const {
    market,
    watchlist,
    positions,
    signals,
    indicators,
    params = DEFAULT_PARAMS,
    benchmarkCode = BENCHMARK_CODE,
    lookback = 320,
    newId = () => randomUUID(),
    log = { info: () => {}, warn: () => {} },
  } = deps

  const engineVersion = engineVersionOf(params)
  /** 落库去重：code → 上一次已落库的签名与 id */
  const persistedSignature = new Map<SecCode, { signature: string; id: string }>()
  let lastOutcomes: SignalOutcome[] = []

  /** 周线聚合按 (code, 末根日期) 缓存：一轮 tick 内 100 只股票各聚合一次已经够省 */
  const weeklyCache = new Map<SecCode, { through: TradeDate; weekly: Candle[] }>()

  function weeklyOf(code: SecCode, candles: readonly Candle[]): Candle[] {
    const through = candles[candles.length - 1]?.date ?? ''
    const cached = weeklyCache.get(code)
    if (cached && cached.through === through) return cached.weekly
    const weekly = aggregateWeekly(candles)
    weeklyCache.set(code, { through, weekly })
    return weekly
  }

  function sentimentOf(date: TradeDate): number {
    const context = market.getContext(benchmarkCode, date, lookback)
    if (context.candles.length === 0) {
      // 基准指数还没回补时给中性值 0.5 而不是 0：0 意味着「确定处于熊市」，
      // 那是一个由缺数据编出来的结论（见 core/indicators/thresholds.ts）
      return 0.5
    }
    return marketSentiment(context.candles.map((c) => c.closeAdj))
  }

  /**
   * 行业集中度（docs/05 §2.2）。按持仓市值占比算，取不到价格的持仓按成本价估。
   * 没有任何持仓时返回空 Map —— 让风控层看到 undefined 而不是 0（见 EngineContext.industryShare）。
   */
  function industryShares(entries: readonly WatchEntry[]): Map<string, number> {
    const held = positions.list()
    if (held.length === 0) return new Map()
    const industryOf = new Map(entries.map((e) => [e.profile.code, e.profile.industry ?? '未分类']))
    const values = new Map<string, number>()
    let total = 0
    for (const position of held) {
      const price = market.snapshotOf(position.code)?.last ?? position.cost
      const value = price * position.shares
      total += value
      const industry = industryOf.get(position.code) ?? '未分类'
      values.set(industry, (values.get(industry) ?? 0) + value)
    }
    if (total <= 0) return new Map()
    const shares = new Map<string, number>()
    for (const [industry, value] of values) shares.set(industry, value / total)
    return shares
  }

  /** 只缓存收盘指标：临时线算出来的指标每 tick 都在变（docs/04 §6） */
  function cacheIndicators(code: SecCode, evaluation: Evaluation, stage: SignalStage): void {
    if (stage !== 'CONFIRMED') return
    indicators.put(code, evaluation.date, snapshotOfIndicators(evaluation.indicators, evaluation.index), engineVersion)
  }

  function evaluateOne(entry: WatchEntry, tick: TickInfo, sentiment: number, shares: Map<string, number>): Evaluation | null {
    const profile: SecProfile = entry.profile
    const context = market.getContext(profile.code, tick.date, lookback)
    if (context.candles.length === 0) return null

    const position = positions.get(profile.code)
    const industry = profile.industry ?? '未分类'
    const share = position ? shares.get(industry) : undefined

    return evaluate(
      {
        profile,
        candles: context.candles,
        weekly: weeklyOf(profile.code, context.candles),
        marketSentiment: sentiment,
        ...(context.snapshot ? { snapshot: context.snapshot } : {}),
        ...(position ? { position } : {}),
        ...(share === undefined ? {} : { industryShare: share }),
        now: {
          date: tick.date,
          minutesSinceOpen: continuousMinutesElapsed(tick.minuteOfDay),
          session: tick.session,
          atMs: tick.at,
        },
      },
      params
    )
  }

  /**
   * 落库签名。方向、阶段、级别、首要子信号任一变化即视为「新的一条」。
   *
   * 为什么不是每轮都插：盘中每 30s 一轮，一天 800 轮 × 100 只 = 8 万行，
   * 而其中绝大多数是同一条信号的重复。去重键刻意**不含得分** ——
   * 得分会随最后一根临时 K 线连续抖动，含它等于没去重。
   */
  function signatureOf(evaluation: Evaluation): string {
    const gated = evaluation.gated
    const top = gated.reasons[0] ?? ''
    return [evaluation.date, gated.direction, evaluation.signal.stage, gated.level, gated.suppressed ? 'S' : '-', top].join('|')
  }

  function persist(evaluation: Evaluation, tick: TickInfo): { persisted: boolean; id: string | null } {
    const code = evaluation.code
    const signature = signatureOf(evaluation)
    const previous = persistedSignature.get(code)
    if (previous?.signature === signature) return { persisted: false, id: previous.id }

    // 方向为 NONE 且没有任何风控裁决：没有可记录的事件。
    // 「今天什么都没发生」不该在 signal 表里占 800 行
    if (evaluation.gated.direction === 'NONE' && evaluation.gated.verdicts.length === 0) {
      persistedSignature.set(code, { signature, id: previous?.id ?? '' })
      return { persisted: false, id: previous?.id ?? null }
    }

    const id = newId()
    const row: SignalRow = {
      id,
      code,
      createdAt: tick.at,
      tradeDate: evaluation.date,
      direction: evaluation.gated.direction,
      score: evaluation.signal.score,
      votes: evaluation.signal.votes,
      regime: evaluation.regime.regime,
      stage: evaluation.signal.stage,
      priceAt: evaluation.candle.close,
      engineVersion,
      evidence: evidencePayload(evaluation),
    }
    signals.insert(row)
    persistedSignature.set(code, { signature, id })
    return { persisted: true, id }
  }

  /**
   * 收盘确认轮（docs/04 §6）：把当日的 PROVISIONAL 行推进为 CONFIRMED / INVALIDATED。
   *
   * 这里只改 `stage` 并**把失效这件事报上去**，提醒怎么发是提醒层的事（docs/05 §3：
   * 「信号失效通知」属 L1）。分开的理由与整个引擎层一致：这一层不认识气泡与通知。
   *
   * 返回非空 = 上一条盘中信号被判失效，需要一条撤销提示。
   */
  function reconcile(evaluation: Evaluation): InvalidationNotice | null {
    if (evaluation.signal.stage !== 'CONFIRMED') return null
    const previous = signals.latestOfDay(evaluation.code, evaluation.date)
    if (!previous || previous.stage !== 'PROVISIONAL') return null
    const stillValid = previous.direction === evaluation.gated.direction && evaluation.gated.direction !== 'NONE'
    signals.updateStage(previous.id, stillValid ? 'CONFIRMED' : 'INVALIDATED')
    if (stillValid) return null
    log.info(`[signal] ${evaluation.code} 盘中信号收盘未获确认（${previous.direction}），已标记失效`)
    // 只有当初真的指向某个方向的才值得撤销 —— NONE 的那条用户根本没被提醒过
    if (previous.direction === 'NONE') return null
    return { signalId: previous.id, direction: previous.direction }
  }

  return {
    engineVersion,

    run(tick) {
      if (!tick.producesSignals) {
        lastOutcomes = []
        return []
      }

      const entries = watchlist.list()
      if (entries.length === 0) {
        lastOutcomes = []
        return []
      }

      const sentiment = sentimentOf(tick.date)
      const shares = industryShares(entries)
      const outcomes: SignalOutcome[] = []

      for (const entry of entries) {
        // 指数不产出交易信号：它是情绪输入，不是可交易品种（docs/04 §1.6）
        if (entry.profile.board === 'INDEX') continue
        try {
          const evaluation = evaluateOne(entry, tick, sentiment, shares)
          if (!evaluation) continue

          const stage = evaluation.signal.stage
          cacheIndicators(entry.profile.code, evaluation, stage)
          const invalidated = reconcile(evaluation)
          // 持仓峰值每交易日收盘更新（docs/05 §2.3）
          if (stage === 'CONFIRMED' && positions.get(entry.profile.code)) {
            positions.bumpPeak(entry.profile.code, evaluation.candle.high)
          }

          const { persisted, id } = persist(evaluation, tick)
          outcomes.push({
            evaluation,
            name: entry.profile.name,
            persisted,
            signalId: id,
            ...(invalidated ? { invalidated } : {}),
          })
        } catch (error) {
          // 一只算不出来不该拖垮整轮：退市股的畸形序列、突然缺列的数据都可能走到这里
          log.warn(`[signal] ${entry.profile.code} 评估失败：${String(error)}`)
        }
      }

      lastOutcomes = outcomes
      return outcomes
    },

    latest: () => lastOutcomes,

    history(query) {
      const names = new Map(watchlist.list().map((e) => [e.profile.code, e.profile.name]))
      return signals.query(query).map((row) => toSignalRecord(row, names.get(row.code) ?? row.code))
    },

    explain(id) {
      const row = signals.get(id)
      if (!row) return null
      return {
        id: row.id,
        subSignals: row.evidence.subSignals.map((sub) => ({
          id: sub.id,
          direction: sub.direction === 'SELL' ? 'SELL' : 'BUY',
          score: sub.score,
          weight: sub.weight,
          detail: sub.evidence,
        })),
        adjustments: row.evidence.adjustments.map((adjustment) => ({
          id: adjustment.id,
          delta: adjustment.delta,
        })),
        indicatorsAt: row.evidence.indicatorsAt,
      }
    },

    purgeStaleCache: () => indicators.purgeOtherVersions(engineVersion),
  }
}

/** 被缓存的指标截面：只留被判定那根的值。整条序列没必要落库（K 线在，随时能重算） */
export function snapshotOfIndicators(ind: IndicatorSet, index: number): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  for (const [period, series] of Object.entries(ind.ma)) out[`ma${period}`] = at(series, index)
  out['dif'] = at(ind.macd.dif, index)
  out['dea'] = at(ind.macd.dea, index)
  out['hist'] = at(ind.macd.hist, index)
  out['bollMid'] = at(ind.boll.mid, index)
  out['bollUpper'] = at(ind.boll.upper, index)
  out['bollLower'] = at(ind.boll.lower, index)
  out['bbw'] = at(ind.boll.bbw, index)
  out['bbwPct'] = at(ind.boll.bbwPct, index)
  out['adx'] = at(ind.dmi.adx, index)
  out['plusDI'] = at(ind.dmi.plusDI, index)
  out['minusDI'] = at(ind.dmi.minusDI, index)
  out['atr'] = at(ind.dmi.atr, index)
  out['rsi'] = at(ind.rsi, index)
  out['volMa'] = at(ind.volMa, index)
  out['volRatio'] = at(ind.volRatio, index)
  out['adxTrend'] = at(ind.thresholds.adxTrend, index)
  out['adxRange'] = at(ind.thresholds.adxRange, index)
  out['rsiOverbought'] = at(ind.thresholds.rsiOverbought, index)
  out['rsiOversold'] = at(ind.thresholds.rsiOversold, index)
  out['volPct'] = at(ind.thresholds.volPct, index)
  return out
}

export function evidencePayload(evaluation: Evaluation): SignalEvidencePayload {
  const gated = evaluation.gated
  const suppressedReason = gated.verdicts.find((v) => v.action === 'SUPPRESS')?.reason
  return {
    level: gated.level,
    headline: gated.headline,
    reasons: gated.reasons,
    suppressed: gated.suppressed,
    ...(suppressedReason === undefined ? {} : { suppressedReason }),
    subSignals: evaluation.signal.subSignals.map((sub) => ({
      id: sub.id,
      strategy: sub.strategy,
      direction: sub.direction,
      score: sub.score,
      weight: sub.weight,
      evidence: { ...sub.evidence },
    })),
    adjustments: evaluation.signal.adjustments.map((adjustment) => ({
      id: adjustment.id,
      direction: adjustment.direction,
      delta: adjustment.delta,
    })),
    verdicts: gated.verdicts.map((verdict) => ({
      rule: verdict.rule,
      action: verdict.action,
      reason: verdict.reason,
    })),
    scoreByDirection: { ...evaluation.signal.scoreByDirection },
    indicatorsAt: snapshotOfIndicators(evaluation.indicators, evaluation.index),
    regimeEvidence: { ...evaluation.regime.evidence },
    sufficiency: {
      bars: evaluation.sufficiency.bars,
      limited: evaluation.sufficiency.limited,
      penalty: evaluation.sufficiency.penalty,
      note: evaluation.sufficiency.note,
    },
  }
}

export function toSignalRecord(row: SignalRow, name: string): SignalRecord {
  const record: SignalRecord = {
    id: row.id,
    code: row.code,
    name,
    createdAt: row.createdAt,
    direction: row.direction,
    score: row.score,
    votes: row.votes,
    regime: row.regime,
    stage: row.stage,
    priceAt: row.priceAt,
    level: row.evidence.level,
  }
  if (row.evidence.suppressedReason) record.suppressedReason = row.evidence.suppressedReason
  return record
}
