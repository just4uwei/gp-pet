/**
 * 存储层门面：一个 Database 连接 + 一组仓储。
 *
 * 全应用共用单连接（better-sqlite3 是同步 API，主进程里再开第二个连接只会互相抢写锁）。
 */

import type { Database } from './db'
import { AiExplainRepo } from './repositories/ai-explain'
import { ReportNoteRepo } from './repositories/report-note'
import { AnnouncementRepo } from './repositories/announcement'
import { AlertRepo } from './repositories/alert'
import { CalendarRepo } from './repositories/calendar'
import { ProviderHealthRepo } from './repositories/health'
import { IndicatorRepo } from './repositories/indicator'
import { IndustryHistoryRepo } from './repositories/industry'
import { KlineRepo } from './repositories/kline'
import { MetaRepo } from './repositories/meta'
import { PositionRepo } from './repositories/position'
import { QuoteTickRepo } from './repositories/quote-tick'
import { ShadowRepo } from './repositories/shadow'
import { SignalRepo } from './repositories/signal'
import { TradeRepo } from './repositories/trade'
import { WatchPointRepo } from './repositories/watch'
import { WatchlistRepo } from './repositories/watchlist'

export interface Storage {
  readonly db: Database
  readonly watchlist: WatchlistRepo
  readonly klines: KlineRepo
  readonly indicators: IndicatorRepo
  readonly signals: SignalRepo
  readonly alerts: AlertRepo
  readonly calendar: CalendarRepo
  readonly health: ProviderHealthRepo
  readonly positions: PositionRepo
  /** 影子运行的账本（M4，docs/07 §2.3） */
  readonly shadow: ShadowRepo
  /** 观察点：用户确认的一次性盯盘条件（**不是策略参数**，见 003_watch.sql） */
  readonly watchPoints: WatchPointRepo
  /** 当日分时留痕：只服务面板上那张走势图，引擎与回测都不读它（见 004_quote_tick.sql） */
  readonly quoteTicks: QuoteTickRepo
  /** 成交流水：用户自己的账本，不进裁剪、不挂自选的生命周期（见 007_trade_log.sql） */
  readonly trades: TradeRepo
  /** AI 解读历史：花过钱的记录，不进裁剪，只能用户手删（见 008_ai_explain.sql） */
  readonly aiExplains: AiExplainRepo
  /** 收盘日报的 AI 评价：一天一条，同样不进裁剪（见 010_report_note.sql） */
  readonly reportNotes: ReportNoteRepo
  readonly announcements: AnnouncementRepo
  /**
   * 行业分类的逐日留痕（014）。**唯一一个「今天不做就永久少一天」的缺口** ——
   * 数据源只给当前行业名，拿它回标历史是未来函数。不进裁剪。
   */
  readonly industries: IndustryHistoryRepo
  readonly meta: MetaRepo
  close(): void
}

export function createStorage(db: Database): Storage {
  return {
    db,
    watchlist: new WatchlistRepo(db),
    klines: new KlineRepo(db),
    indicators: new IndicatorRepo(db),
    signals: new SignalRepo(db),
    alerts: new AlertRepo(db),
    calendar: new CalendarRepo(db),
    health: new ProviderHealthRepo(db),
    positions: new PositionRepo(db),
    shadow: new ShadowRepo(db),
    watchPoints: new WatchPointRepo(db),
    quoteTicks: new QuoteTickRepo(db),
    trades: new TradeRepo(db),
    aiExplains: new AiExplainRepo(db),
    reportNotes: new ReportNoteRepo(db),
    announcements: new AnnouncementRepo(db),
    industries: new IndustryHistoryRepo(db),
    meta: new MetaRepo(db),
    close: () => db.close(),
  }
}

export type { Database } from './db'
export { openDatabase, openMarketDatabase } from './db'
export { LATEST_SCHEMA_VERSION } from './migrations'
