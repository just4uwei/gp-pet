/**
 * engine：把 src/core 的纯函数接到真实数据与存储上的编排层（docs/02 §3）。
 * M1 只有取数编排（MarketDataService），指标与策略编排是 M2。
 */

export {
  DEFAULT_MARKET_DATA_OPTIONS,
  calendarSpanFor,
  createMarketDataService,
  expectedLastBar,
} from './market-data'
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
