/**
 * MarketDataService：core 的指标输入从哪来（docs/02 §4 ②、docs/03 §2.3/§2.4、docs/07 §4）。
 *
 * 职责边界：
 *   - 回补日线（增量、复权双轨、入库前质量校验、复权口径变化时整只重拉）
 *   - 批量拉快照（全部源都挂时返回上一轮缓存并置 stale，而不是抛给上层）
 *   - 把「历史日线 + 当日临时线」拼成 core 能直接吃的序列
 * 它**不**算指标、不判信号、不发提醒 —— 那些是 M2 的事。
 *
 * 两条实现取向值得写下来：
 *
 * 1. **getContext 是同步纯读，不在里面发请求。** docs/02 的数据流图把「缺口 → 增量补齐」
 *    画在 getContext 里，这里改成由 tick 显式先 `backfill()` 再 `getContext()`。
 *    理由：在指标计算路径里发网络请求，会让一次 tick 的耗时不可预测，
 *    也让同一轮内多个调用方对同一代码重复回补。
 *
 * 2. **回补自己限并发（默认 2 只并发）。** 底层 HttpClient 已有全局 ≤4 / 单源 ≤2 的闸门，
 *    但 registry 的 attemptDeadline 计时器是**下发即开始**的：100 只自选股一次性丢进去，
 *    排在闸门队列尾部的那些会在还没发出请求时就先超时，进而把好端端的源熔断掉。
 */

import type {
  AdjustMode,
  Candle,
  SecCode,
  Snapshot,
  TradeDate,
} from '@core/types'
import { withProvisional } from '@core/candle'
import { addDays, isWeekday } from '@core/date'
import { SESSION_BOUNDS } from '@core/session'
import {
  type QualityIssue,
  detectAdjustmentDrift,
  screenCandles,
} from '@core/quality'
import { createLimiter } from '../net/limiter'
import type { ProviderId, ProviderRegistry } from '../providers'
import { AllProvidersUnavailableError } from '../providers'
import type { TradingCalendar } from '../scheduler/calendar'

/** 指标用前复权，展示与成本用不复权 —— 两套价格由同一次 fetchDaily 一并带回（docs/03 §2.3） */
const ADJUST: AdjustMode = 'qfq'

export interface MarketDataOptions {
  /** 首次回补的目标根数。docs/03 §1 要求 ≥ 300（250 根 MA + 预热余量） */
  initialBars: number
  /**
   * 增量回补时向前多要几天。这段重叠不是浪费：
   * 它是复权口径变化的唯一检出手段（要有共同日期才能比 adj_factor）。
   */
  overlapDays: number
  /** 同时回补几只。见文件头第 2 条，别为了快把它调大 */
  backfillConcurrency: number
  /** 相邻收盘跳变告警阈值（docs/07 §4） */
  jumpThreshold: number
  /** 复权因子突变的相对容差，超过即整只重拉 */
  driftTolerance: number
  /** 单只每轮最多重拉一次，防止「拉完又判漂移」自激循环 */
  maxRefetchPerRound: number
}

export const DEFAULT_MARKET_DATA_OPTIONS: MarketDataOptions = {
  initialBars: 320,
  overlapDays: 30,
  backfillConcurrency: 2,
  jumpThreshold: 0.2,
  driftTolerance: 0.005,
  maxRefetchPerRound: 1,
}

/** KlineRepo 结构上就满足它。这样 engine 不必 import 具体仓储，测试也不用建库 */
export interface KlineStore {
  upsertMany(code: SecCode, candles: readonly Candle[], provider: string): number
  lastDate(code: SecCode): TradeDate | null
  recent(code: SecCode, limit: number): Candle[]
  range(code: SecCode, from: TradeDate, to: TradeDate): Candle[]
  deleteAll(code: SecCode): number
}

export type BackfillStatus = 'UP_TO_DATE' | 'WRITTEN' | 'REFETCHED' | 'EMPTY' | 'FAILED'

export interface BackfillOutcome {
  code: SecCode
  status: BackfillStatus
  /** 实际入库根数（provisional 已被仓储层滤掉，不计入） */
  written: number
  /** 请求区间，便于按日志复现一次回补 */
  from?: TradeDate
  to?: TradeDate
  provider?: ProviderId
  /** 主源不可用、由备源顶上 */
  degraded?: boolean
  issues: QualityIssue[]
  /** 复权因子突变：已整只重拉 */
  drift?: { date: TradeDate; storedFactor: number; incomingFactor: number }
  error?: string
}

export interface SnapshotOutcome {
  at: number
  snapshots: Snapshot[]
  provider?: ProviderId
  degraded?: boolean
  /**
   * 本轮取数失败、返回的是上一轮缓存（docs/03 §2.2：UI 显示「行情离线」）。
   * 缓存也没有时 snapshots 为空。
   */
  stale: boolean
  /** 上一次成功取数的时刻，null 表示从未成功 */
  lastOkAt: number | null
  /** 要了但没回来的代码。免费源会静默丢掉整行为 0 的品种 */
  missing: SecCode[]
  error?: string
}

export interface MarketContext {
  code: SecCode
  /** 升序。最后一根可能是 provisional，调用方必须据此降级信号强度（docs/04 §6） */
  candles: Candle[]
  /** 尾部那根是不是临时线 */
  provisional: boolean
  snapshot: Snapshot | null
  /** 快照来自缓存而非本轮取数 */
  stale: boolean
  /** 已入库的最后一个交易日，null 表示这只还没有任何历史 */
  storedThrough: TradeDate | null
}

export interface MarketDataDeps {
  registry: Pick<ProviderRegistry, 'fetchDaily' | 'fetchSnapshots'>
  kline: KlineStore
  /** 质量校验的「交易日」口径来源。缺省退到「周一至周五」，缺口会误报 */
  calendar?: Pick<TradingCalendar, 'resolve'>
  options?: Partial<MarketDataOptions>
  now?: () => number
  /** 质量问题的去处（日志 / 面板）。服务自己不决定怎么呈现 */
  onIssues?: (code: SecCode, issues: QualityIssue[]) => void
}

export interface MarketDataService {
  readonly options: MarketDataOptions
  /** 把 codes 的日线补到 through（含）。已经补齐的整只跳过，不发请求 */
  backfill(codes: readonly SecCode[], through: TradeDate): Promise<BackfillOutcome[]>
  /** 批量快照。绝不抛错：失败时返回缓存 + stale */
  refreshSnapshots(codes: readonly SecCode[]): Promise<SnapshotOutcome>
  /** 同步读：历史日线 + 当日临时线。不发请求 */
  getContext(code: SecCode, date: TradeDate, bars?: number): MarketContext
  /** 缓存里的快照，供面板展示涨跌幅 */
  snapshotOf(code: SecCode): Snapshot | null
  lastSnapshotAt(): number | null
  /**
   * 本轮快照里有没有「今天真的在交易」的证据。
   * 探测轮（日历说休市但依据不硬）用它决定是否 calendar.markObserved(date, true)。
   */
  looksLikeTradingNow(snapshots: readonly Snapshot[]): boolean
}

/**
 * initialBars 根日线要往前找多少个自然日。
 * A 股一年约 243 个交易日 / 365 天 ≈ 0.666，取 1.55 倍再加 15 天余量
 * —— 宁可多要一段（数据源自己会截断），也不要少要导致预热不足。
 */
export function calendarSpanFor(bars: number): number {
  return Math.ceil(Math.max(1, bars) * 1.55) + 15
}

/**
 * 当前时点「应该已经存在」的最后一根日线的日期，也就是 backfill 的 through。
 *
 * 收盘（15:00）之前当日线还没定稿，目标只能是上一个交易日 —— 把 through 设成今天
 * 会让每个 tick 都判定「有缺口」并重新请求一整段，而拿回来的又是一根随时在变的当日线。
 *
 * 15:00 之后目标是当日，但数据源发布有几分钟延迟：那几分钟里请求会拿不到当日线，
 * lastDate 仍小于 through，下一次 SETTLE tick 会自动再试 —— 不需要额外的重试逻辑。
 */
export function expectedLastBar(
  calendar: Pick<TradingCalendar, 'resolve'>,
  date: TradeDate,
  minuteOfDay: number,
  maxLookbackDays = 20
): TradeDate | null {
  const today = calendar.resolve(date)
  if (today.isOpen && minuteOfDay >= SESSION_BOUNDS.close) return date
  // 往前找最近的交易日。20 天足以跨过春节与国庆的连休
  for (let i = 1; i <= maxLookbackDays; i++) {
    const candidate = addDays(date, -i)
    if (calendar.resolve(candidate).isOpen) return candidate
  }
  return null
}

export function createMarketDataService(deps: MarketDataDeps): MarketDataService {
  const { registry, kline, calendar, onIssues, now = () => Date.now() } = deps
  const options: MarketDataOptions = { ...DEFAULT_MARKET_DATA_OPTIONS, ...deps.options }

  const cache = new Map<SecCode, Snapshot>()
  let lastOkAt: number | null = null
  /** 最近一轮快照是不是失败了。getContext 据此告诉面板「行情离线」 */
  let snapshotsStale = false

  const isTradingDay = (date: TradeDate): boolean =>
    calendar ? calendar.resolve(date).isOpen : isWeekday(date)

  function screen(code: SecCode, incoming: readonly Candle[]): Candle[] {
    const { candles, issues } = screenCandles(incoming, {
      isTradingDay,
      jumpThreshold: options.jumpThreshold,
    })
    if (issues.length > 0) onIssues?.(code, issues)
    return candles
  }

  async function fetchRange(
    code: SecCode,
    from: TradeDate,
    to: TradeDate
  ): Promise<{ candles: Candle[]; provider: ProviderId; degraded: boolean }> {
    const result = await registry.fetchDaily(code, from, to, ADJUST)
    return { candles: result.value, provider: result.provider, degraded: result.degraded }
  }

  async function backfillOne(code: SecCode, through: TradeDate): Promise<BackfillOutcome> {
    const stored = kline.lastDate(code)
    if (stored !== null && stored >= through) {
      // 无缺口则整轮跳过（docs/03 §2.4）—— 盘中每 30s 一次 tick，这里是主要的省请求点
      return { code, status: 'UP_TO_DATE', written: 0, issues: [] }
    }

    const fullFrom = addDays(through, -calendarSpanFor(options.initialBars))
    const from = stored === null ? fullFrom : addDays(stored, -options.overlapDays)
    const issues: QualityIssue[] = []

    try {
      const first = await fetchRange(code, from, through)
      if (first.candles.length === 0) {
        // 区间内真的可能一根都没有（长期停牌、刚上市），这不算失败
        return {
          code,
          status: 'EMPTY',
          written: 0,
          from,
          to: through,
          provider: first.provider,
          degraded: first.degraded,
          issues,
        }
      }

      const drift =
        stored === null
          ? null
          : detectAdjustmentDrift(
              kline.range(code, from, stored),
              first.candles,
              options.driftTolerance
            )

      if (drift && options.maxRefetchPerRound > 0) {
        // 复权口径变了：两套口径混存等于伪造行情，只能整只重拉（docs/07 §4）
        kline.deleteAll(code)
        const full = await fetchRange(code, fullFrom, through)
        const written = kline.upsertMany(code, screen(code, full.candles), full.provider)
        return {
          code,
          status: 'REFETCHED',
          written,
          from: fullFrom,
          to: through,
          provider: full.provider,
          degraded: full.degraded,
          issues,
          drift,
        }
      }

      const written = kline.upsertMany(code, screen(code, first.candles), first.provider)
      return {
        code,
        status: 'WRITTEN',
        written,
        from,
        to: through,
        provider: first.provider,
        degraded: first.degraded,
        issues,
      }
    } catch (error) {
      // 一只失败不影响其余：整轮报错会让「一只退市代码」拖垮全部自选股的更新
      return {
        code,
        status: 'FAILED',
        written: 0,
        from,
        to: through,
        issues,
        error: messageOf(error),
      }
    }
  }

  return {
    options,

    async backfill(codes, through) {
      const limiter = createLimiter(options.backfillConcurrency)
      return Promise.all(codes.map((code) => limiter(() => backfillOne(code, through))))
    },

    async refreshSnapshots(codes) {
      const at = now()
      if (codes.length === 0) {
        return { at, snapshots: [], stale: false, lastOkAt, missing: [] }
      }

      try {
        // 分片是 provider 的职责（各源的批量上限不同，见各自 NOTES.md），这里整批下发
        const result = await registry.fetchSnapshots([...codes])
        const wanted = new Set(codes)
        const fresh = result.value.filter((s) => wanted.has(s.code))
        for (const snapshot of fresh) cache.set(snapshot.code, snapshot)
        lastOkAt = at
        snapshotsStale = false

        const returned = new Set(fresh.map((s) => s.code))
        return {
          at,
          snapshots: fresh,
          provider: result.provider,
          degraded: result.degraded,
          stale: false,
          lastOkAt,
          missing: codes.filter((code) => !returned.has(code)),
        }
      } catch (error) {
        // 全部源不可用 → 返回缓存并置 stale（docs/03 §2.2）。
        // 这里不抛：调度器把异常当「这一轮没跑」，而实际上我们仍能拿旧价格把面板画出来。
        snapshotsStale = true
        const cached = codes
          .map((code) => cache.get(code))
          .filter((s): s is Snapshot => s !== undefined)
        return {
          at,
          snapshots: cached,
          stale: true,
          lastOkAt,
          missing: codes.filter((code) => !cache.has(code)),
          error:
            error instanceof AllProvidersUnavailableError
              ? `全部数据源不可用：${messageOf(error)}`
              : messageOf(error),
        }
      }
    },

    getContext(code, date, bars) {
      const limit = Math.max(1, bars ?? options.initialBars)
      const history = kline.recent(code, limit)
      const snapshot = cache.get(code) ?? null
      const { candles, provisional } = withProvisional(history, snapshot, date)
      return {
        code,
        candles,
        provisional,
        snapshot,
        stale: snapshot !== null && snapshotsStale,
        storedThrough: history[history.length - 1]?.date ?? null,
      }
    },

    snapshotOf(code) {
      return cache.get(code) ?? null
    },

    lastSnapshotAt() {
      return lastOkAt
    },

    looksLikeTradingNow(snapshots) {
      // 「有成交」才算证据：休市日调接口一样有响应，字段是昨收 + 零成交量。
      // 只看响应成功会把每个节假日都判成交易日。
      return snapshots.some((s) => !s.suspended && s.last > 0 && s.volume > 0)
    },
  }
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
}
