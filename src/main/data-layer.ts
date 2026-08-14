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
 * M3 起 `onSignals` 的接收方是 AlertService（四道闸门 → 气泡 / 通知 / 角标 / 表情），
 * 但**装配层仍然不认识提醒**：它只把 (ctx, outcomes) 交出去，谁来接是 controller 的事。
 * engineStatus 里 offline / stale 如实上报，宁可显示「行情离线」也不要让界面
 * 看起来在工作而实际没有数据。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AppSettings,
  EngineStatus,
  IntradaySeries,
  ProviderHealth,
  QuoteTick,
  SignalEvidence,
  SignalRecord,
} from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import { withSensitivity } from '@core/params'
import {
  BENCHMARK_CODE,
  createMarketDataService,
  createSignalEngine,
  createMinuteCache,
  createTickPipeline,
  closeMsOf,
  settleDay,
  createWatchlistService,
  mergeIntraday,
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
  type MinuteSeries,
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
import { createShadowRunner, type ShadowRunner } from './shadow'
import { createStorage, openMarketDatabase, type Storage } from './storage'
import { BACKUP_DIR_NAME, DEFAULT_BACKUP_POLICY, backupIfDue } from './storage/backup'
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
  /** 每轮引擎跑完后回调：controller 用它跑一轮提醒分发并刷新面板 */
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
  /** 影子运行（M4，docs/07 §2.3） */
  readonly shadow: ShadowRunner
  /** market.db 所在目录与备份目录 —— 设置页「关于」与「打开数据目录」要用 */
  readonly paths: { dataDir: string; backupDir: string }

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
  /**
   * 当日分时，只服务抽屉「行情」页那张图。**会发一次网络请求**（带 30s 缓存），
   * 拉不到时退回本机留痕 `quote_tick` —— 取舍规则在 engine/intraday.ts。
   */
  intradaySeries(query: { code: SecCode; from: number; to?: number }): Promise<IntradaySeries>
  signalHistory(query: { code?: SecCode; from?: number; to?: number; limit?: number; perCode?: number }): SignalRecord[]
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
  const backupDir = join(dataDir, BACKUP_DIR_NAME)
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

  // ── 分时缓存（engine/intraday.ts，它是这条取数路径自己的请求闸门）───────
  const minuteCache = createMinuteCache((code) => registry.fetchMinutes(code).then((r) => r.value), now)

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
  //
  // 参数按用户设置的**灵敏度档位**构造（M4）。在这之前 `AppSettings.sensitivity`
  // 是个死设置：schema 里有、没人读 —— 与 `autoLaunch` 曾经的问题同一类，
  // 而这一个更隐蔽（开机自启不生效用户能发现，灵敏度不生效发现不了）。
  //
  // `withSensitivity` 只动 `combine` 的得分线与票数线，其余保持出厂值；
  // 换档会改变参数指纹 → `engineVersionOf` 变 → 指标缓存作废重算、影子运行暂停。
  // 那不是副作用，是**必须**如此：两套参数下的指标与绩效不可比（docs/03 §4.2）。
  const buildEngine = (tier: AppSettings['sensitivity']): SignalEngine =>
    createSignalEngine({
      market,
      watchlist: storage.watchlist,
      positions: storage.positions,
      signals: storage.signals,
      indicators: storage.indicators,
      lookback: market.options.initialBars,
      params: withSensitivity(tier),
      log,
    })

  // `let` 而不是 `const`：换灵敏度档位要**整个重建**引擎。
  // 引擎版本是在构造时算的（它是缓存键与落库字段），做成运行时可变的会让
  // 「这一行 signal 是哪套参数下产出的」失去答案 —— 重建一个干净得多。
  let signals = buildEngine(settings.sensitivity)
  // 参数或算法变了 → 旧的指标缓存不再可比，启动时清一次（docs/03 §4.2）
  const purged = signals.purgeStaleCache()
  if (purged > 0) log.info(`[engine] 引擎版本 ${signals.engineVersion}，已清理 ${purged} 条旧指标缓存`)

  // ── 影子运行（M4，docs/07 §2.3）────────────────────────────────
  const shadow = createShadowRunner({
    repo: storage.shadow,
    meta: storage.meta,
    klines: storage.klines,
    engineVersion: () => signals.engineVersion,
    trackedCodes: () => new Set(storage.watchlist.list().map((entry) => entry.profile.code)),
    profileOf: (code) => {
      const entry = storage.watchlist.get(code)
      return entry ? { board: entry.profile.board, isST: entry.profile.isST } : null
    },
    newId: () => randomUUID(),
    log,
  })

  // ── tick 流水线 ────────────────────────────────────────────────
  // 行为都在 engine/tick.ts 里（那儿有测试）；这里只负责把真实依赖递进去
  const pipeline = createTickPipeline({
    market,
    watchlist,
    calendar,
    meta: storage.meta,
    auxCodes: () => [BENCHMARK_CODE],
    prune: (at) => pruneIfDue(db, at),
    backup: (at) => backupIfDue(db, backupDir, at, DEFAULT_BACKUP_POLICY, (m) => log.info(m)),
    log,
    // 转发而不是直接给 `signals`：换灵敏度会重建引擎，直接给的话
    // 流水线会一直握着**旧那个**（换完档以后信号还按旧参数出，几乎无从发现）
    engine: { run: (tick) => signals.run(tick) },
    /*
      补跑收盘确认轮（engine/settle.ts）。与 `engine` 同样用转发闭包而不是直接给对象 ——
      换灵敏度会重建引擎参数，而补跑必须用**当前**那套（它落库的行带引擎版本）。

      `closedAt` 由这里算：settle.ts 与 src/core 同一条纪律，不读时钟。
      15:00 是收盘时刻，按北京时间换算（`shanghaiToEpochMs` 与分时那边共用一个口径 ——
      用 `new Date(...)` 会让非 +08 的机器上算出偏 8 小时的 created_at）。
    */
    settle: (date) =>
      settleDay(date, {
        market,
        watchlist: storage.watchlist,
        positions: storage.positions,
        signals: storage.signals,
        indicators: storage.indicators,
        lookback: market.options.initialBars,
        params: withSensitivity(settings.sensitivity),
        closedAt: closeMsOf(date),
        log,
      }),
    shadow,
    /*
      分时留痕 + 转发。**始终**挂这个回调（不再是 `...(onQuotes ? …)`）——
      落库是数据层自己的事，不该取决于外面有没有人订阅推送。

      两条纪律写在 004_quote_tick.sql 头注释里，这里是它们的落点：
        1. `stale` 为 true 时一行都不写。stale = 本轮取数失败、重放的是上一轮缓存，
           写进去会在图上画出一条「其实没有成交」的平线。
        2. ts 取 `snapshot.at`（交易所给的行情时刻，三家 provider 都在解析它）
           而不是 `ctx.at`。这样重复的快照会被主键挡掉 —— 盘后还会跑好几轮 tick，
           用本机时钟当键的话每轮都会多一个点。
      落库失败不能连累推送：图是锦上添花，行情推送不是。
    */
    onQuotes: (ctx, snapshots) => {
      if (!snapshots.stale) {
        try {
          storage.quoteTicks.record(
            snapshots.snapshots.map((s) => ({
              code: s.code,
              ts: s.at,
              last: s.last,
              preClose: Number.isFinite(s.preClose) && s.preClose > 0 ? s.preClose : null,
            }))
          )
        } catch (error) {
          log.warn(`[quote-tick] 分时留痕写入失败：${String(error)}`)
        }
      }
      onQuotes?.(ctx, snapshots)
    },
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
    // getter：换灵敏度会重建引擎，快照式的字段会把旧实例的 engineVersion 冻在这里
    get signals() {
      return signals
    },
    scheduler,
    shadow,
    paths: { dataDir, backupDir },

    start() {
      scheduler.start()
    },

    refreshNow() {
      return scheduler.tick()
    },

    applySettings(next) {
      const previous = settings
      settings = next
      registry.setPriority(next.providerPriority)

      // 灵敏度换档 = 换一套引擎参数。整个重建，并清掉按旧指纹缓存的指标 ——
      // 不清的话新参数会读到旧参数算出来的指标值，而两者在库里长得一模一样
      if (next.sensitivity !== previous.sensitivity) {
        signals = buildEngine(next.sensitivity)
        const stale = signals.purgeStaleCache()
        log.info(
          `[engine] 灵敏度 ${previous.sensitivity} → ${next.sensitivity}，` +
            `引擎版本 ${signals.engineVersion}，已清理 ${stale} 条旧指标缓存`
        )
      }
      // dataDir 改动**不在这里生效**：market.db 是启动时打开的，
      // 中途换目录要么搬库要么重开连接，两者都比「提示重启」更容易出错（见 IPC 处理）
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

    async intradaySeries(query) {
      const to = query.to ?? now()
      const local = {
        preClose: storage.quoteTicks.preCloseOf(query.code, query.from, to),
        points: storage.quoteTicks.series(query.code, query.from, to),
      }

      let remote: MinuteSeries | null = null
      if (registry.supports('minute')) {
        try {
          remote = await minuteCache.get(query.code)
        } catch (error) {
          // 一张图拉不到不该让面板报错，也不该顶掉本机留痕 ——
          // 降级路径本来就在，而它的文案（「自 xx:xx 起在本机记录」）恰好是真的
          log.warn(`[intraday] ${query.code} 取分时失败，退回本机留痕：`, error)
        }
      }

      return mergeIntraday(query.code, local, remote, { from: query.from, to })
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
