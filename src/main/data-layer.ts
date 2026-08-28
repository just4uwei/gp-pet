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
  NextDayPreview,
  ProviderHealth,
  QuoteTick,
  SignalEvidence,
  SignalRecord,
} from '@shared/ipc-types'
import type { SecCode, TradeDate } from '@core/types'
import type { Evaluation } from '@core/engine'
import { parseCode } from '@core/code'
import { withSensitivity } from '@core/params'
import { sessionAt } from '@core/session'
import { INDUSTRY_ETF_GROUP, INDUSTRY_ETFS } from '@shared/industry-etf'
import { shanghaiDayStartMs } from '@shared/time'
import {
  BENCHMARK_CODE,
  createMarketDataService,
  createSignalEngine,
  createMinuteCache,
  createTickPipeline,
  closeMsOf,
  previewNextDay,
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
  createClockSync,
  createScheduler,
  createTradingCalendar,
  loadHolidayTable,
  shanghaiTime,
  type ClockReport,
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

/** 主动校时探测的节流。唤醒事件可能连着来好几个，不能一个事件一次请求 */
const CLOCK_PROBE_THROTTLE_MS = 5 * 60_000

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
    clock: ClockReport
  }
  /**
   * 主动取一次校时样本（`scheduler/clock-sync.ts`）。
   *
   * 休市时不发请求 ⇒ 没有样本，所以启动与休眠唤醒后各要主动探一次。
   * 走的是**已有**的 registry 路径、只拉基准指数一只：顺带记一次健康、暖一次缓存，
   * 不新增第三方端点。自带 5 分钟节流，唤醒风暴不会变成请求风暴。
   */
  syncClock(): Promise<void>
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
  /**
   * 就地评估一只票（建仓体检用）。**不落库、不发提醒**，见 `SignalEngine.assess`。
   *
   * 摆在这一层而不是 controller，是因为只有它同时握着**校准钟**（`clock.now()`，
   * 不是本机系统钟）与**当前那个**引擎实例 —— 换灵敏度会整个重建引擎，
   * 在别处快照式地持有它会一直用着旧参数（data-layer 里 `signals` 是 `let` 的理由）。
   */
  assess(code: SecCode): Evaluation | null
  /**
   * 「明日预览」：就地算一次 `date` 那天的收盘确认，答「明天准备买 / 卖 / 减什么」。
   * **不落库、不推进影子、不发提醒**，边界见 `engine/preview.ts` 头注释。
   */
  previewNextDay(date: TradeDate): NextDayPreview
  /** 某只票里「今天买进、T+1 下今天卖不掉」的股数。没有就是 0 */
  lockedShares(code: SecCode): number
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
    now: localNow = () => Date.now(),
    onQuotes,
    onSignals,
    onTickError,
  } = options

  /*
    两个钟，别混（`scheduler/clock-sync.ts` 头注释「哪些钟不归它管」那一节）：

      localNow   本机系统钟。量「过了多久」的用它 —— HTTP 的 latencyMs、
                 provider 健康统计、分时那 30s 缓存 TTL。
                 校准量一挪，正在计时的请求就会算出个偏了的延迟，
                 而延迟直接进健康统计，那是判断数据源好不好的唯一依据。

      now        校准钟。答「现在几点」的用它 —— 调度器、取数编排、自选资料时间戳。
                 **调度器是关键的那一个**：它的 now 产出 ctx.at，
                 而 ctx.at 一路流到时段判定、signal/alert_log 的 created_at、
                 AlertDispatcher 的冷却与跨日、以及风控的 atMs（STALE_SNAPSHOT
                 拿它减远端成交时刻 —— 本机快几分钟就会静默压掉所有买入信号）。
  */
  const clock = createClockSync({ localNow, log: (m) => log.info(m) })
  const now = (): number => clock.now()
  let lastClockProbeAt = Number.NEGATIVE_INFINITY

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
      now: localNow,
      // 校时的样本来源：盘中每 30s 一次的快照请求顺带带回来，零额外请求
      onTiming: (timing) => clock.observe(timing),
    })
    providers[id] = createProvider(id, { http, now: localNow })
  }

  const registry = createProviderRegistry({
    providers,
    health: storage.health,
    options: { priority: [...settings.providerPriority] },
    now: localNow,
  })

  /*
    行业 ETF 是**内置**的观察名单（2026-08-15），不由用户添加。

    ## 为什么在这里播种，且只在「库里没有」时插

    `WatchlistRepo.add()` 的 ON CONFLICT **不动 `group_name`**，所以重复调用不会把
    用户手动加进「自选」的 ETF 拽进这一组 —— 但它**会覆盖 `name`**，
    而库里那个名字是数据源刷出来的（「证券ETF国泰」），比清单里的「证券ETF」准。
    所以判据是「不存在才插」，不是「无脑 upsert」。

    这也定义了「内置」的确切含义：**每次启动补齐缺的那些**。
    用户删掉一只，下次启动它会回来 —— 界面上因此不给这一组删除按钮，
    给了就是一个点了会复活的按钮。

    ## 不发网络请求

    名称与行业直接用清单里的，`market`/`board` 由 `parseCode` 从代码段算出来。
    真正的名称由 `refreshProfiles()`（每周一次）覆盖成数据源的版本。
    在装配路径上等 15 次 profile 请求会让首启多几秒，而那几秒买到的只是更准的名字。
  */
  {
    let seeded = 0
    for (const etf of INDUSTRY_ETFS) {
      const parsed = parseCode(etf.code)
      // 清单写错一位不该让整个应用起不来（有单测钉着这份清单，见 industry-etf.test.ts）
      if (!parsed.ok) {
        log.warn(`[watchlist] 内置行业 ETF ${etf.code} 代码非法，已跳过：${parsed.reason}`)
        continue
      }
      if (storage.watchlist.get(parsed.value.code)) continue
      storage.watchlist.add(
        {
          code: parsed.value.code,
          name: etf.name,
          market: parsed.value.market,
          board: parsed.value.board,
          isST: false,
          industry: etf.industry,
        },
        INDUSTRY_ETF_GROUP,
        localNow()
      )
      seeded++
    }
    if (seeded > 0) log.info(`[watchlist] 已补齐 ${seeded} 只内置行业 ETF（共 ${INDUSTRY_ETFS.length} 只）`)
  }

  // ── 分时缓存（engine/intraday.ts，它是这条取数路径自己的请求闸门）───────
  // TTL 是「过了多久」，用本地钟
  const minuteCache = createMinuteCache((code) => registry.fetchMinutes(code).then((r) => r.value), localNow)

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
    // 行业留痕（014）。**这一条每晚接一天就永久少一天** —— 数据源只给当前行业名，
    // 拿它回标历史是未来函数，所以历史只能从接上的那天起攒
    industries: storage.industries,
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
      // T+1：今天买进的今天卖不掉（`Position.lockedShares`）。**补跑那条路上也要传**，
      // 见下面 settle 的同名参数 —— 漏一处的症状是补跑轮与盘中轮结论不一致，
      // 而界面上完全看不出来
      lockedSharesOf: (code, sinceMs) => storage.trades.boughtSharesSince(code, sinceMs),
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
    /*
      强制离场那四条阈值。**必须是函数**：`settings` 是 `let`，换灵敏度档位要跟着走
      —— 而换档本来就会改 `engineVersion()` ⇒ 闸门 ② 停止累积，
      所以不会出现「用新阈值续旧曲线」。传值（而不是函数）的症状是换完档以后
      影子还按旧阈值判离场，与那个「引擎实例握着旧 params」的坑同一形状。
    */
    params: () => withSensitivity(settings.sensitivity),
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
    settle: (date, feedShadow) => {
      // 「没喂影子」= 那个交易日的前向记录永久缺失。日志里那一行答不了「哪天缺了」，
      // 所以同时落一行流水（013），面板上看得见
      if (!feedShadow) {
        shadow.noteNotAdvanced({
          date,
          at: Date.now(),
          reason: '补跑时今天的开盘已过（或今日休市），按前向纪律不喂影子 —— 这一天的记录永久缺失',
        })
      }
      return settleDay(date, {
        /*
          影子运行挂在补跑这条路上（settle.ts 边界 2，2026-08-17 改）。
          `feedShadow` 由 tick 判「成交机会还没过」——**给了就喂，不给就不喂**，
          这一层不再自己判时间。
        */
        ...(feedShadow ? { shadow, now: Date.now() } : {}),
        market,
        watchlist: storage.watchlist,
        positions: storage.positions,
        signals: storage.signals,
        indicators: storage.indicators,
        lookback: market.options.initialBars,
        // 与 buildEngine 那处**必须成对**。补跑传的 `tick.at` 是 D 的收盘时刻，
        // 于是引擎按 D 当天的日界去数买入 —— 用「现在」会拿今天的流水去判昨天的信号
        lockedSharesOf: (code, sinceMs) => storage.trades.boughtSharesSince(code, sinceMs),
        params: withSensitivity(settings.sensitivity),
        closedAt: closeMsOf(date),
        log,
      })
    },
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

    async syncClock() {
      // 节流用**本地**钟：它问的是「上次探是多久以前」，是一段时长
      const at = localNow()
      if (at - lastClockProbeAt < CLOCK_PROBE_THROTTLE_MS) return
      lastClockProbeAt = at
      try {
        // 样本从 http 层的 onTiming 自己流进 clock，这里不需要读返回值 ——
        // 要的只是「发生过一次成功的请求」
        await registry.fetchSnapshots([BENCHMARK_CODE])
      } catch (error) {
        // 探不到就探不到：校准是附带品，报 warn 不报错（拿不到样本时 report() 会如实说 NONE）
        log.warn(`[clock] 校时探测失败：${String(error)}`)
      }
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
        clock: clock.report(),
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

    /*
      建仓体检的现场评估。**不复用 `latestSignals()`**：那一份在休市、竞价、
      刚启动时是空的，而用户想查「明天要不要买这只」恰恰多半在收盘之后。

      时刻走校准钟 `now()`（本机钟 + HTTP Date 校准量），时段由它推 ——
      与调度器同一套 `sessionAt`。`producesSignals` 这里恒为 true 而不是照抄调度器：
      这是用户主动点出来的一次查看，不是提醒，竞价时段也该给他答案
      （虚价的代价由界面上那句「体检基于此刻行情」承担，而它不落库、不进影子）。
    */
    assess(code) {
      const at = now()
      const { date, minuteOfDay } = shanghaiTime(at)
      return signals.assess(code, {
        date,
        minuteOfDay,
        // 休市日 `sessionAt` 给 CLOSED —— 那正是我们要的：`T1_LATE_BUY`
        // 与快照陈旧那两条都只在盘中成立，周末不该凭空报出来
        session: sessionAt(minuteOfDay, calendar.resolve(date).isOpen),
        at,
        producesSignals: true,
      })
    },

    lockedShares(code) {
      return storage.trades.boughtSharesSince(code, shanghaiDayStartMs(now()))
    },

    /*
      「明日预览」（`engine/preview.ts`）。摆在这一层的理由与 `assess` 相同：
      只有它同时握着 `market`、当前那套参数（换灵敏度会重建引擎）与仓储。

      **每次都新建一个引擎实例**，不复用 `signals` —— 那个的 `market.getContext`
      会在尾部拼当日临时线，而预览要的恰恰是「D 的真实收盘线」。
      与 `settleDay` 那条路同一个做法（settle.ts 边界 3）。

      日期由调用方给（controller 用日报那一个 `reportSubjectDate`，一件事一个出处），
      本层不判「今天是哪天」。
    */
    previewNextDay(date) {
      return previewNextDay(date, {
        market,
        watchlist: storage.watchlist,
        positions: storage.positions,
        signals: storage.signals,
        indicators: storage.indicators,
        lookback: market.options.initialBars,
        // 与 buildEngine / settleDay 那两处**必须成对**：`tick.at` 是 D 的收盘时刻，
        // 于是引擎按 D 当天的日界去数买入 —— 漏传的症状是预览与明早的补跑结论不一致
        lockedSharesOf: (code, sinceMs) => storage.trades.boughtSharesSince(code, sinceMs),
        params: withSensitivity(settings.sensitivity),
        closedAt: closeMsOf(date),
        // 用户**真实**持仓，不是影子组合的 —— 这一屏答的是「我明天要交易什么」
        holds: (code) => storage.positions.get(code) !== null,
        // 覆盖率的判据：D 那根收盘线在不在库里。缺的要显式列出来，不靠 assess 返回 null 反推
        hasClose: (code) => storage.klines.recentThrough(code, date, 1).at(-1)?.date === date,
        log,
      })
    },

    /*
      面板与悬浮条的价格投影。

      ## 内存里没有时从库里读回来（2026-08-19）

      快照缓存 (`market-data.ts` 的 `cache`) 是内存 Map，**重启即空**；而休市时段
      `needsQuotes` 为 false ⇒ 不会有任何一轮 tick 去补 ⇒ 晚上/周末重启之后，
      面板与悬浮条一直空到下一个交易日 09:00。用户看到的是「软件把我的股票忘了」。

      两级回落，都带**真实数据时刻**并标 `STORED`：
        ① `quote_tick` 那只票的最后一行（保留 7 天，且刻意不存 stale 快照 ⇒ 是真实观测）
        ② 再退到日线：最后一根收盘 + 前一根收盘算涨跌幅

      ⚠ **只改这个展示投影，不碰 `market-data.ts` 的缓存。** 引擎照旧看不到快照，
      于是不会拿一个上周五的价去判信号 —— 这正是这个改法比「把缓存也恢复」安全的全部理由。
      渲染层两处都已按 `stale` 灰显（bar/App.tsx、panel/App.tsx），再加上 `at` 说清有多旧。
    */
    quoteTicks() {
      const stale = pipeline.state().lastSnapshots?.stale ?? false
      const codes = watchlist.codes()
      const ticks: QuoteTick[] = []
      const missing: SecCode[] = []

      for (const code of codes) {
        const snapshot = market.snapshotOf(code)
        if (!snapshot) {
          missing.push(code)
          continue
        }
        ticks.push({
          code,
          last: snapshot.last,
          changePct: changePct(snapshot.last, snapshot.preClose),
          preClose: snapshot.preClose,
          stale,
          at: snapshot.at,
          source: 'LIVE',
        })
      }

      if (missing.length === 0) return ticks

      const stored = storage.quoteTicks.latest(missing)
      for (const code of missing) {
        const tick = stored.get(code)
        if (tick) {
          ticks.push({
            code,
            last: tick.last,
            // 昨收拿不到就给 0 涨跌幅，**不编一个** —— 与 `changePct` 自己的口径一致。
            // 而 `preClose` 原样带 null 出去：要算金额的调用方据此显示「—」而不是 0 元
            changePct: tick.preClose === null ? 0 : changePct(tick.last, tick.preClose),
            preClose: tick.preClose,
            stale: true,
            at: tick.ts,
            source: 'STORED',
          })
          continue
        }
        // 留痕也没有（超过 7 天没开机、或刚加进来的票）：退到日线收盘
        const bars = storage.klines.recent(code, 2)
        const day = bars[bars.length - 1]
        if (!day) continue
        const prev = bars[bars.length - 2]
        ticks.push({
          code,
          last: day.close,
          changePct: prev ? changePct(day.close, prev.close) : 0,
          preClose: prev?.close ?? null,
          stale: true,
          // 收盘线的时刻就是那天的收盘 —— 与日报的 quoteOf 同一条口径
          at: closeMsOf(day.date),
          source: 'STORED',
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
