/**
 * 存储层门面：一个 Database 连接 + 一组仓储。
 *
 * 全应用共用单连接（better-sqlite3 是同步 API，主进程里再开第二个连接只会互相抢写锁）。
 */

import type { Database } from './db'
import { CalendarRepo } from './repositories/calendar'
import { ProviderHealthRepo } from './repositories/health'
import { KlineRepo } from './repositories/kline'
import { MetaRepo } from './repositories/meta'
import { PositionRepo } from './repositories/position'
import { WatchlistRepo } from './repositories/watchlist'

export interface Storage {
  readonly db: Database
  readonly watchlist: WatchlistRepo
  readonly klines: KlineRepo
  readonly calendar: CalendarRepo
  readonly health: ProviderHealthRepo
  readonly positions: PositionRepo
  readonly meta: MetaRepo
  close(): void
}

export function createStorage(db: Database): Storage {
  return {
    db,
    watchlist: new WatchlistRepo(db),
    klines: new KlineRepo(db),
    calendar: new CalendarRepo(db),
    health: new ProviderHealthRepo(db),
    positions: new PositionRepo(db),
    meta: new MetaRepo(db),
    close: () => db.close(),
  }
}

export type { Database } from './db'
export { openDatabase, openMarketDatabase } from './db'
export { LATEST_SCHEMA_VERSION } from './migrations'
