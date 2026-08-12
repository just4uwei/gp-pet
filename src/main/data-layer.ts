/**
 * M1 数据层装配（docs/02 §2）。
 *
 * 这里是「设置 → 数据库 → HTTP → provider → registry → 日历 → 取数 → 调度」的唯一装配点，
 * 上层（controller / ipc / 托盘）只拿 DataLayer 这一个门面，不认识 undici、也不认识 SQLite。
 *
 * 本文件**只接线，不做判断** —— 一轮 tick 到底做什么在 engine/tick.ts（那儿能用假依赖测）。
 * 装配层的正确性靠真机启动一次来验（CLAUDE.md：改完主进程要真启一次）。
 *
 * M2 追加了信号编排（SignalEngine）：取数之后跑一轮引擎，指标与信号落库。
 * 提醒（气泡、通知、冷却、免打扰）仍属 M3 —— 这里只把评估结果交给 onSignals 回调。
 * engineStatus 里 offline / stale 如实上报，宁可显示「行情离线」也不要让界面
 * 看起来在工作而实际没有数据。
 */

import { join } from 'node:path'
import type {
  AppSettings,
  EngineStatus,
  ProviderHealth,
  QuoteTick,
  SignalEvidence,
  SignalRecord,
} from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import {
  BENCHMARK_CODE,
  createMarketDataService,
  createSignalEngine,
  createTickPipeline,
  createWatchlistService,
  type MarketDataService,
  type SignalEngine,
  type SignalOutcome,
  type SnapshotOutcome,
  type WatchlistService,
} from './engine'
import { createHttpClient, createUndiciTransport } from './net/http'
import { createLimiter } from './net/limiter'
import {
  ALL_PROVIDER_IDS,
  createProvider,
  createProviderRegistry,
  DEFAULT_REGISTRY_OPTIONS,
  perProviderLimited,
  type ProviderId,
  type ProviderRegistry,
  type QuoteProvider,
} from './providers'
import {
  createScheduler,
  createTradingCalendar,
  loadHolidayTable,
  type Scheduler,
  type TickContext,
  type TradingCalendar,
} from './scheduler'
import { SettingsStore } from './settings/store'
import { createStorage, openMarketDatabase, type Storage } from './storage'
import { pruneIfDue } from './storage/retention'

/** 健康度统计窗口。出口条件「成功率 > 99%」按当日统计，取 24h（docs/08 M1） */
const HEALTH_WINDOW_MS = 24 * 60 * 60_000

export interface DataLayerOptions {
  /** %APPDATA%/gp-pet 或其覆盖值（AppSettings.dataDir） */
  userDataDir: string
  resourcesRoot: string
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  now?: () => number
  /** 每轮取数结束后回调：controller 用它推 push:quoteTick 与刷新托盘 */
  onQuotes?: (ctx: TickContext, snapshots: SnapshotOutcome) => void
  /** 每轮引擎跑完后回调：M2 用它刷新面板；M3 在这里接 AlertDispatcher */
  onSignals?: (ctx: TickContext, outcomes: SignalOutcome[]) => void
  onTickError?: (error: unknown, ctx: TickContext) => void
}

export interface DataLayer {
  readonly storage: Storage
  readonly settings: SettingsStore
  readonly registry: ProviderRegistry
  readonly calendar: TradingCalendar
  readonly market: MarketDataService
  readonly watchlist: WatchlistService
  readonly signals: SignalEngine
  readonly scheduler: Scheduler

  start(): void
  /** 用户点「立即刷新」：跑一轮完整 tick */
  refreshNow(): Promise<void>
  /** 设置变更后重新生效（轮询频率每 tick 现读，这里只处理需要动状态的项） */
  applySettings(settings: AppSettings): void
  status(): Pick<EngineStatus, 'session' | 'lastTickAt' | 'watchCount' | 'offline'> & {
    calendarUncertain: boolean
    stale: boolean
  }
  health(): ProviderHealth[]
  quoteTicks(): QuoteTick[]
  signalHistory(query: { code?: SecCode; from?: number; to?: number; limit?: number }): SignalRecord[]
  explainSignal(id: string): SignalEvidence | null
  /** 最近一轮的评估结果，供桌宠状态与面板使用 */
  latestSignals(): SignalOutcome[]
  dispose(): void
}

/** 涨跌幅用**不复权**真实价，与用户在券商 App 看到的一致（docs/03 §2.3） */
export function changePct(last: number, preClose: number): number {
  if (!Number.isFinite(last) || !Number.isFinite(preClose) || preClose <= 0) return 0
  return ((last - preClose) / preClose) * 100
}

export async function createDataLayer(options: DataLayerOptions): Promise<DataLayer> {
  const {
    userDataDir,
    resourcesRoot,
    log = { info: () => {}, warn: () => {} },
    now = () => Date.now(),
    onQuotes,
    onSignals,
    onTickError,
  } = options

  // ── 设置与数据库 ────────────────────────────────────────────────
  const settingsStore = new SettingsStore(join(userDataDir, 'settings.json'), (m) => log.info(m))
  let settings = settingsStore.load()
  // dataDir 只影响 market.db：settings.json 必须留在默认位置，否则改坏了就找不回来了
  const dataDir = settings.dataDir ?? userDataDir
  const db = await openMarketDatabase(join(dataDir, 'market.db'), (m) => log.info(m))
  const storage = createStorage(db)

  // ── HTTP 与 provider ───────────────────────────────────────────
  const transport = await createUndiciTransport()
  // 全局闸门共用一个，单源闸门各自一个（docs/03 §2.4：全局 ≤ 4、单源 ≤ 2）
  const globalLimiter = createLimiter(DEFAULT_REGISTRY_OPTIONS.globalConcurrency)
  const providers: Partial<Record<ProviderId, QuoteProvider>> = {}
  for (const id of ALL_PROVIDER_IDS) {
    const http = createHttpClient({
      transport,
      limiter: perProviderLimited(globalLimiter, DEFAULT_REGISTRY_OPTIONS.perProviderConcurrency),
      timeoutMs: DEFAULT_REGISTRY_OPTIONS.timeoutMs,
      retries: DEFAULT_REGISTRY_OPTIONS.retries,
      now,
    })
    providers[id] = createProvider(id, { http, now })
  }

  const registry = createProviderRegistry({
    providers,
    health: storage.health,
    options: { priority: [...settings.providerPriority] },
    now,
  })

  // ── 交易日历 ───────────────────────────────────────────────────
  const holidays = loadHolidayTable(resourcesRoot)
  if (holidays.error) log.warn('[calendar]', holidays.error)
  const calendar = createTradingCalendar({
    store: storage.calendar,
    ...(holidays.table ? { holidays: holidays.table } : {}),
    registry,
  })

  // ── 取数编排 ───────────────────────────────────────────────────
  const market = createMarketDataService({
    registry,
    kline: storage.klines,
    calendar,
    now,
    onIssues: (code, issues) => {
      // 丢弃过的问题才值得 warn；标记类（缺口、零成交）只记 info，否则日志会被除权与停牌刷满
      const dropped = issues.filter((i) => i.dropped)
      if (dropped.length > 0) {
        log.warn(`[quality] ${code} 丢弃 ${dropped.length} 根：${dropped.map((i) => `${i.date} ${i.kind}`).join('; ')}`)
      }
      const marked = issues.filter((i) => !i.dropped)
      if (marked.length > 0) {
        log.info(`[quality] ${code} 标记 ${marked.length} 处：${marked.map((i) => `${i.date} ${i.kind}`).join('; ')}`)
      }
    },
  })

  const watchlist = createWatchlistService({
    repo: storage.watchlist,
    positions: storage.positions,
    registry,
    now,
    log: (m) => log.info(m),
  })

  // ── 信号编排（M2）───────────────────────────────────────────────
  // 参数取出厂默认值：用户可改参数属 M4 的设置页，改完只需在这里换一个 params
  const signals = createSignalEngine({
    market,
    watchlist: storage.watchlist,
    positions: storage.positions,
    signals: storage.signals,
    indicators: storage.indicators,
    lookback: market.options.initialBars,
    log,
  })
  // 参数或算法变了 → 旧的指标缓存不再可比，启动时清一次（docs/03 §4.2）
  const purged = signals.purgeStaleCache()
  if (purged > 0) log.info(`[engine] 引擎版本 ${signals.engineVersion}，已清理 ${purged} 条旧指标缓存`)

  // ── tick 流水线 ────────────────────────────────────────────────
  // 行为都在 engine/tick.ts 里（那儿有测试）；这里只负责把真实依赖递进去
  const pipeline = createTickPipeline({
    market,
    watchlist,
    calendar,
    meta: storage.meta,
    auxCodes: () => [BENCHMARK_CODE],
    prune: (at) => pruneIfDue(db, at),
    log,
    engine: signals,
    ...(onQuotes ? { onQuotes } : {}),
    ...(onSignals ? { onSignals } : {}),
  })

  const scheduler = createScheduler({
    calendar,
    pollIntervalSec: () => settings.pollIntervalSec,
    onTick: (ctx) => pipeline.run(ctx),
    onError: (error, ctx) => {
      log.warn(`[tick] ${ctx.date} ${ctx.session} 失败：${String(error)}`)
      onTickError?.(error, ctx)
    },
    now,
  })

  return {
    storage,
    settings: settingsStore,
    registry,
    calendar,
    market,
    watchlist,
    signals,
    scheduler,

    start() {
      scheduler.start()
    },

    refreshNow() {
      return scheduler.tick()
    },

    applySettings(next) {
      settings = next
      registry.setPriority(next.providerPriority)
    },

    status() {
      const peeked = scheduler.peek()
      const { lastCtx, lastTickAt, lastSnapshots } = pipeline.state()
      return {
        session: lastCtx?.session ?? peeked.session,
        lastTickAt,
        watchCount: storage.watchlist.count(),
        // 「离线」= 需要行情的时段里一次都没成功过，或最近一轮取的是缓存。
        // 休市时不算离线 —— 那时本来就不该有行情（docs/03 §2.4）
        offline:
          (lastCtx?.needsQuotes ?? false) &&
          (lastSnapshots === null || lastSnapshots.stale || lastSnapshots.lastOkAt === null),
        calendarUncertain: peeked.verdict.uncertain,
        stale: lastSnapshots?.stale ?? false,
      }
    },

    health() {
      const stats = storage.health.stats(now() - HEALTH_WINDOW_MS)
      const byProvider = new Map(stats.map((s) => [s.provider, s]))
      return registry.states().map((state) => {
        const stat = byProvider.get(state.provider)
        const item: ProviderHealth = {
          provider: state.provider,
          status: state.status,
          successRate: stat?.successRate ?? 0,
          p95LatencyMs: stat?.p95LatencyMs ?? 0,
        }
        const lastError = state.lastError ?? stat?.lastError
        if (lastError) item.lastError = lastError
        return item
      })
    },

    signalHistory(query) {
      return signals.history(query)
    },

    explainSignal(id) {
      return signals.explain(id)
    },

    latestSignals() {
      return signals.latest()
    },

    quoteTicks() {
      const stale = pipeline.state().lastSnapshots?.stale ?? false
      const ticks: QuoteTick[] = []
      for (const code of watchlist.codes()) {
        const snapshot = market.snapshotOf(code)
        if (!snapshot) continue
        ticks.push({
          code,
          last: snapshot.last,
          changePct: changePct(snapshot.last, snapshot.preClose),
          stale,
        })
      }
      return ticks
    },

    dispose() {
      scheduler.stop()
      storage.close()
    },
  }
}
