/**
 * engine：把 src/core 的纯函数接到真实数据与存储上的编排层（docs/02 §3）。
 * M1 取数编排（MarketDataService）+ M2 信号编排（SignalEngine）。
 * 提醒编排（AlertDispatcher）仍属 M3。
 */

export {
  DEFAULT_MARKET_DATA_OPTIONS,
  calendarSpanFor,
  createMarketDataService,
  expectedLastBar,
} from './market-data'
export { MINUTE_CACHE_TTL_MS, createMinuteCache, mergeIntraday, shanghaiTradeDate } from './intraday'
export type { IntradayWindow, LocalIntraday, MinuteCache } from './intraday'
export {
  BENCHMARK_CODE,
  createSignalEngine,
  evidencePayload,
  industryMapOf,
  industryValueShares,
  snapshotOfIndicators,
  toSignalRecord,
} from './signals'
export type { SignalEngine, SignalEngineDeps, SignalOutcome, TickInfo } from './signals'
export { closeMsOf, settleDay } from './settle'
export type { SettleDeps, SettleResult } from './settle'
export { MAINTENANCE_INTERVAL_MS, createTickPipeline } from './tick'
export type { TickMetaStore, TickPipeline, TickPipelineDeps, TickState } from './tick'
export { DEFAULT_GROUP, MAX_WATCH_ITEMS, createWatchlistService, toWatchItem } from './watchlist'
export type {
  PositionCodes,
  WatchlistService,
  WatchlistServiceDeps,
  WatchlistStore,
} from './watchlist'
export type {
  BackfillOutcome,
  BackfillStatus,
  KlineStore,
  MarketContext,
  MarketDataDeps,
  MarketDataOptions,
  MarketDataService,
  SnapshotOutcome,
} from './market-data'
