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
import { shanghaiDayStartMs } from '@shared/time'
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
  /**
   * 某只票里「今天买进、T+1 下今天卖不掉」的股数（`Position.lockedShares`）。
   *
   * 做成依赖而不是让引擎自己去查流水，是因为 `SignalEngineDeps.positions` 只认 `Position`
   * 那张表，而这个数住在 `trade_log` 里。缺省返回 0 —— 单测与「还没接流水」的调用方
   * 因此逐位保持旧行为。
   *
   * ⚠ **`sinceMs` 由引擎按 `tick.at` 算，不是「现在」。** 收盘补跑（`settle.ts`）传的
   * `tick.at` 是那一天的收盘时刻，于是它算的是**那天**的锁定量；用「现在」会让补跑
   * 拿今天的流水去判昨天的信号。
   */
  lockedSharesOf?: (code: SecCode, sinceMs: number) => number
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

/**
 * 昨日收盘那条「明日观察」在今天得到了兑现（2026-08-14）。
 *
 * ## 为什么需要这个东西
 *
 * 收盘确认轮**永远**落在 T+1 尾盘窗口里：`minuteOfDayFrom()` 把
 * `minutesSinceOpen` 钳在 240，于是收盘后任何一轮算出来的 minuteOfDay 恒等于 900（15:00），
 * 而 `T1_LATE_BUY` 的窗口是 14:50–15:10。实测 46 只 2024 年起 28973 个判定根：
 * 组合层产出 182 次 BUY，`T1_LATE_BUY` **也是 182 次** —— 一次不漏，
 * 收盘轮的买入结论 100% 被改写成 `NEXT_DAY_WATCH`。
 *
 * 那条改写本身是对的（收盘之后确实买不进了）。缺的是**后半句**：
 * 「明日观察」到了第二天没有任何跟进，那条建议就此消失，
 * 而用户的观感是「这软件从来不给买入建议」。
 *
 * ## 判据是两次独立成立，不是把昨天那条搬过来
 *
 * 只有**今天自己也判出 BUY** 时才复活。昨天的结论不构成今天的理由 ——
 * 隔夜跳空、消息面变化都可能让它不再成立，而照搬等于用一根过期的 K 线下结论。
 * 所以这条通知只是给今天那条 BUY 提醒**加一层佐证**（提到 L2、文案标明来历），
 * 它**不新发一条提醒**：一天两条说同一件事，用户只会觉得吵。
 */
export interface CarryoverNotice {
  /** 昨日那条「明日观察」的 id。文案与追溯用，**不作 alert_log 外键**（那条用今天的） */
  signalId: string
  /** 昨日那根的交易日 */
  from: TradeDate
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
  /** 非空表示今天这条 BUY 兑现了昨日收盘的「明日观察」（见 CarryoverNotice） */
  carriedOver?: CarryoverNotice
}

export interface SignalEngine {
  readonly engineVersion: string
  /** 跑一轮全量评估。竞市之外的时段返回空数组且不落库 */
  run(tick: TickInfo): SignalOutcome[]
  /**
   * 就地评估**一只**票并把结果原样交出来 —— 建仓体检（`trade:entryCheck`）用。
   *
   * 与 `run()` 的差别是它**什么都不写**：不落 `signal` 表、不写指标缓存、不 bumpPeak、
   * 不跑收盘确认与「明日观察」复活。用户点开一个体检面板不该在信号历史里留下一行，
   * 也不该把 `persistedSignature` 的去重状态搅乱（那会让下一轮真信号被误判成「没变」）。
   *
   * **不受 `producesSignals` 限制**：这是用户主动要的一次查看，不是提醒。
   * 拿不到日线（不在自选、还没回补）时返回 null —— 调用方必须把它显示成
   * 「体检做不了」，**不许显示成「没问题」**。
   */
  assess(code: SecCode, tick: TickInfo): Evaluation | null
  /** 最近一轮的评估结果，供面板与桌宠状态使用 */
  latest(): SignalOutcome[]
  history(query: { code?: SecCode; from?: number; to?: number; limit?: number; perCode?: number }): SignalRecord[]
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
    lockedSharesOf = () => 0,
    params = DEFAULT_PARAMS,
    benchmarkCode = BENCHMARK_CODE,
    lookback = 320,
    newId = () => randomUUID(),
    log = { info: () => {}, warn: () => {} },
  } = deps

  const engineVersion = engineVersionOf(params)
  /** 落库去重：code → 上一次已落库的签名与 id */
  const persistedSignature = new Map<SecCode, { signature: string; id: string }>()
  /** 复活去重：code → 已经报过复活的交易日（见 carryover 第 4 道闸门） */
  const carriedOverOn = new Map<SecCode, TradeDate>()
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

  /** 行业集中度（docs/05 §2.2）。口径在 `industryValueShares()`，这里只把依赖接上 */
  function industryShares(entries: readonly WatchEntry[]): Map<string, number> {
    return industryValueShares({
      held: positions.list(),
      industryOf: industryMapOf(entries),
      priceOf: (code) => market.snapshotOf(code)?.last ?? null,
    })
  }

  /** 只缓存收盘指标：临时线算出来的指标每 tick 都在变（docs/04 §6） */
  function cacheIndicators(code: SecCode, evaluation: Evaluation, stage: SignalStage): void {
    if (stage !== 'CONFIRMED') return
    indicators.put(code, evaluation.date, snapshotOfIndicators(evaluation.indicators, evaluation.index), engineVersion)
  }

  /**
   * 跑一只。同时把**上一根的交易日**带出来 —— 复活判定要用它去查昨日收盘那条结论，
   * 而「昨天」这件事只有 K 线序列答得准（停牌、节假日都在里面），日历算不出来。
   */
  function evaluateOne(
    entry: WatchEntry,
    tick: TickInfo,
    sentiment: number,
    shares: Map<string, number>
  ): { evaluation: Evaluation; prevDate: TradeDate | null } | null {
    const profile: SecProfile = entry.profile
    const context = market.getContext(profile.code, tick.date, lookback)
    if (context.candles.length === 0) return null

    // T+1：今天买进的今天卖不掉。合进 `Position` 而不是另开一个入参，
    // 是因为风控层的三条判据（硬抑制 / 标注 / 做T的底仓）都跟着持仓走。
    // 日界按 `tick.at` 算 —— 引擎不读时钟（见 lockedSharesOf 的注释）
    const held = positions.get(profile.code)
    const position =
      held === null
        ? null
        : withLockedShares(held, lockedSharesOf(profile.code, shanghaiDayStartMs(tick.at)))
    const industry = profile.industry ?? '未分类'
    const share = position ? shares.get(industry) : undefined

    const evaluation = evaluate(
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
    if (!evaluation) return null
    // 被判定那根的**前一根**。盘中被判定的是今天的临时线，于是这就是昨天；
    // 快照还没到手时被判定的是昨天的收盘线，此时它是前天 —— 所以复活判定
    // 另有一道 `evaluation.date === tick.date` 的闸门，见 carryover()
    const prev = context.candles[evaluation.index - 1]
    return { evaluation, prevDate: prev?.date ?? null }
  }

  function persist(evaluation: Evaluation, tick: TickInfo): { persisted: boolean; id: string | null } {
    const code = evaluation.code
    const signature = signalSignature(evaluation)
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

  /**
   * 昨日收盘的「明日观察」今天兑现了吗（见 CarryoverNotice）。
   *
   * 四道闸门，少一道都会让它变成一个吵人的东西：
   *
   * 1. **今天自己也判 BUY** —— 昨天的结论不构成今天的理由（见 CarryoverNotice 头注释）；
   * 2. **判的必须是今天这根临时线**（`evaluation.date === tick.date` 且 PROVISIONAL）。
   *    快照还没到手时引擎判的是昨天的收盘线，那时的「前一根」是前天，
   *    照着查会把前天那条明日观察当成昨天的；
   * 3. **昨日那条必须是当日最后一条且已确认** —— 收盘轮那条才是昨天的最终结论。
   *    用 `latestOfDay` 而不是「昨天有没有出现过 NEXT_DAY_WATCH」：
   *    上午出、收盘被判失效的那种不算数；
   * 4. **一天只报一次**。盘中每 30s 一轮，不去重的话它会跟着每一轮 BUY 重复报，
   *    虽然冷却挡得住，但 alert_log 里会攒一串「被冷却挡掉」的噪音。
   */
  function carryover(evaluation: Evaluation, prevDate: TradeDate | null, tick: TickInfo): CarryoverNotice | null {
    if (evaluation.gated.direction !== 'BUY') return null
    if (evaluation.date !== tick.date || evaluation.signal.stage !== 'PROVISIONAL') return null
    if (prevDate === null) return null
    if (carriedOverOn.get(evaluation.code) === tick.date) return null

    const previous = signals.latestOfDay(evaluation.code, prevDate)
    if (!previous || previous.direction !== 'NEXT_DAY_WATCH' || previous.stage !== 'CONFIRMED') return null

    carriedOverOn.set(evaluation.code, tick.date)
    log.info(`[signal] ${evaluation.code} 昨日（${prevDate}）收盘的明日观察今日仍成立`)
    return { signalId: previous.id, from: prevDate }
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
          const evaluated = evaluateOne(entry, tick, sentiment, shares)
          if (!evaluated) continue
          const { evaluation, prevDate } = evaluated

          const stage = evaluation.signal.stage
          cacheIndicators(entry.profile.code, evaluation, stage)
          const invalidated = reconcile(evaluation)
          const carriedOver = carryover(evaluation, prevDate, tick)
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
            ...(carriedOver ? { carriedOver } : {}),
          })
        } catch (error) {
          // 一只算不出来不该拖垮整轮：退市股的畸形序列、突然缺列的数据都可能走到这里
          log.warn(`[signal] ${entry.profile.code} 评估失败：${String(error)}`)
        }
      }

      lastOutcomes = outcomes
      return outcomes
    },

    assess(code, tick) {
      const entry = watchlist.list().find((item) => item.profile.code === code)
      // 指数不产出交易信号（docs/04 §1.6），体检同理 —— 它不是可交易品种
      if (!entry || entry.profile.board === 'INDEX') return null
      try {
        return evaluateOne(entry, tick, sentimentOf(tick.date), industryShares(watchlist.list()))?.evaluation ?? null
      } catch (error) {
        // 与 run() 同一条：一只算不出来只是这一次体检做不了，不该把异常抛给 IPC
        log.warn(`[signal] ${code} 建仓体检评估失败：${String(error)}`)
        return null
      }
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

/** 自选清单 → 「代码 → 行业」。缺行业的一律归「未分类」，那是一个真实的分组不是缺省值 */
export function industryMapOf(entries: readonly WatchEntry[]): (code: SecCode) => string {
  const map = new Map(entries.map((e) => [e.profile.code, e.profile.industry ?? '未分类']))
  return (code) => map.get(code) ?? '未分类'
}

/**
 * 行业集中度（docs/05 §2.2）：每个行业在**持仓市值**里占多少。
 *
 * 取不到现价的持仓按成本价估 —— 停牌股与刚加进来还没取到快照的票不该整个消失，
 * 那会让分母缩小、其余行业的占比集体虚高。
 *
 * **没有任何持仓时返回空 Map**，让风控层看到 `undefined` 而不是 0
 * （见 `EngineContext.industryShare`：0 是「完全没有同行业持仓」这个明确结论，
 * 拿它顶替「没统计」会让规则永不触发且看不出是缺数据）。
 *
 * `extra` 是给**建仓体检**用的：把「还没成交的这一笔」按金额加进分子与分母，
 * 于是同一个上限能回答「买完会不会超」而不只是「现在有没有超」。
 * 单独抽出来是因为它有两个调用方（引擎每轮 + 体检），照抄一份必然分叉。
 */
export function industryValueShares(input: {
  held: readonly Position[]
  industryOf: (code: SecCode) => string
  /** 现价；取不到给 null（**不是 0**，那会让这只票的市值凭空归零） */
  priceOf: (code: SecCode) => number | null
  extra?: { industry: string; amount: number }
}): Map<string, number> {
  const { held, industryOf, priceOf, extra } = input
  if (held.length === 0 && !extra) return new Map()

  const values = new Map<string, number>()
  let total = 0
  for (const position of held) {
    const price = priceOf(position.code) ?? position.cost
    const value = price * position.shares
    total += value
    const industry = industryOf(position.code)
    values.set(industry, (values.get(industry) ?? 0) + value)
  }
  if (extra && extra.amount > 0) {
    total += extra.amount
    values.set(extra.industry, (values.get(extra.industry) ?? 0) + extra.amount)
  }
  if (total <= 0) return new Map()

  const shares = new Map<string, number>()
  for (const [industry, value] of values) shares.set(industry, value / total)
  return shares
}

/**
 * 把「今天买的股数」挂到持仓上。**0 时不带这个键** —— `exactOptionalPropertyTypes`
 * 下塞一个 `undefined` 与不塞是两回事，而回测那边正是靠「这个键不存在」保持行为不变。
 */
function withLockedShares(position: Position, locked: number): Position {
  const value = Math.max(0, Math.trunc(locked))
  return value > 0 ? { ...position, lockedShares: value } : position
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

/**
 * 落库签名 = **结论 + 依据的结构**。任一变化即视为「新的一条」。
 *
 * 为什么不是每轮都插：盘中每 30s 一轮，一天 800 轮 × 100 只 = 8 万行，
 * 而其中绝大多数是同一条信号的重复。
 *
 * ## 只放离散量，一个连续量都不许进来
 *
 * 得分、指标值、票数都会随最后一根临时 K 线连续抖动 —— 放进签名等于没有去重
 * （每一轮都会算出一个新签名）。所以「依据」取的是**结构**：
 * 哪些子信号在响、多周期怎么调、风控判了什么，而不是它们的数值。
 *
 * ## 为什么依据必须进签名
 *
 * 早先的签名只有 `reasons[0]`。于是子信号集合从 {T1,T3} 变成 {T1,T3,T4} 时，
 * 结论没变、首要理由没变，就**不落新行** —— 而 `signal.evidence` 里存的还是
 * 三小时前那份旧依据。面板上「触发时的指标值」会与实际不符，
 * 而这件事从界面上完全看不出来（2026-08-14 补）。
 *
 * ## `reasons[0]` 已经**移出**签名（2026-08-14 晚，实测数据逼出来的）
 *
 * 它是上面那个旧签名的遗留物，而它是一句**文案** —— 里面嵌着连续量：
 * 止损那条写的是「已亏损 −32.7%，触及 8% 止损线」，每 0.1pp 就是一个新字符串。
 *
 * 实测一天的真实数据（SZ002716，跌破止损线后被强制通道接管）：
 * 子信号集合 1 种、裁决集合 1 种、level 1 种、方向 1 种，
 * **而 `reasons[0]` 有 22 种，落了 243 行**。
 * （243 > 22 是因为去重比的是「上一次」不是「见过的集合」：
 * −32.7% → −32.6% → −32.7% 来回抖，每一次都算「变了」。）
 *
 * 移除它不会漏掉任何该落的新行 —— 它能表达的离散信息**已经全在**下面三项里：
 *   * 强制类的首要理由由 `verdicts` 的 `rule:action` 决定；
 *   * 策略类的首要理由由 `topReasons()` 从子信号里挑，而子信号集合就是 `subs`。
 * 它**独有**的那部分恰恰全是连续量：百分比、以及「谁最强」这个由
 * `score × weight` 决定的排序。两者都正是本函数开头那条纪律要挡的东西。
 */
export function signalSignature(evaluation: Evaluation): string {
  const gated = evaluation.gated
  const signal = evaluation.signal
  // 排序后拼接：子信号的产出顺序不保证稳定，不排序会让顺序变化被误判成「依据变了」
  const subs = signal.subSignals.map((sub) => `${sub.id}:${sub.direction}`).sort().join(',')
  const adjustments = signal.adjustments.map((item) => item.id).sort().join(',')
  const verdicts = gated.verdicts.map((item) => `${item.rule}:${item.action}`).sort().join(',')
  return [
    evaluation.date,
    gated.direction,
    signal.stage,
    gated.level,
    gated.suppressed ? 'S' : '-',
    // ⚠ 这里曾经有一项 `gated.reasons[0]`。**别加回来** —— 它是一句嵌着百分比的文案，
    //   一天能制造 243 行同一条止损（见上面那段）。它的离散部分已经被 subs/verdicts 覆盖。
    subs,
    adjustments,
    verdicts,
  ].join('|')
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
