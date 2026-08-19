/**
 * 影子运行的持久化（schema v2，docs/07 §2.3）。
 *
 * 三张业务表 + 一张委托表，读写都很直白。真正需要注意的只有两点：
 *
 * 1. **`advance()` 必须幂等。** 盘后 tick 会跑好几轮，`shadow_equity.trade_date`
 *    是主键，`hasDate()` 因此是推进前的唯一判据。
 * 2. **现金与计数存 meta**，不存表：它们是单值状态，为它们建一张单行表只会多一处
 *    「忘了初始化」的可能。
 */

import type { SecCode, TradeDate } from '@core/types'
import type { Database } from '../db'
import type { ShadowOrder, ShadowPosition, ShadowTrade } from '../../shadow/portfolio'

export interface ShadowEquityPoint {
  date: TradeDate
  cash: number
  positionValue: number
  equity: number
  /** 沪深300 当日前复权收盘；那天拿不到基准时为 null（**不是 0**） */
  benchmark: number | null
}

/** meta 里的影子运行状态键 */
export const SHADOW_KEYS = {
  startedAt: 'shadow_started_at',
  startedDate: 'shadow_started_date',
  /** 起始资金，用于净值归一化 */
  startCapital: 'shadow_start_capital',
  cash: 'shadow_cash',
  engineVersion: 'shadow_engine_version',
  /** 因现金池空了而没开的仓数（必须报出来，见 portfolio.ts 头注释） */
  skippedNoCash: 'shadow_skipped_no_cash',
  /** 因涨停买不到 / 跌停卖不掉而作废的委托数 */
  limitBlocked: 'shadow_limit_blocked',
} as const

interface OrderRow {
  code: string
  action: string
  placed_date: string
  rule: string
  score: number
  regime: string
  signal_id: string | null
  deferred: number
}

interface PositionRow {
  code: string
  shares: number
  entry_date: string
  entry_price_adj: number
  entry_price_raw: number
  entry_costs: number
  entry_regime: string
  entry_score: number
  entry_rule: string
  peak_raw: number
  last_close_adj: number
  bars_held: number
  engine_version: string
}

interface TradeRow {
  id: string
  code: string
  entry_date: string
  exit_date: string
  entry_price: number
  exit_price: number
  entry_price_raw: number
  exit_price_raw: number
  shares: number
  pnl: number
  pnl_pct: number
  holding_bars: number
  costs: number
  regime_at_entry: string
  entry_score: number
  exit_rule: string
  partial: number
  engine_version: string
}

function toOrder(row: OrderRow): ShadowOrder {
  return {
    code: row.code,
    action: row.action as ShadowOrder['action'],
    placedDate: row.placed_date,
    rule: row.rule,
    score: row.score,
    regime: row.regime as ShadowOrder['regime'],
    signalId: row.signal_id,
    deferred: row.deferred,
  }
}

function toPosition(row: PositionRow): ShadowPosition {
  return {
    code: row.code,
    shares: row.shares,
    entryDate: row.entry_date,
    entryPriceAdj: row.entry_price_adj,
    entryPriceRaw: row.entry_price_raw,
    entryCosts: row.entry_costs,
    entryRegime: row.entry_regime as ShadowPosition['entryRegime'],
    entryScore: row.entry_score,
    entryRule: row.entry_rule,
    peakRaw: row.peak_raw,
    lastCloseAdj: row.last_close_adj,
    barsHeld: row.bars_held,
    engineVersion: row.engine_version,
  }
}

function toTrade(row: TradeRow): ShadowTrade {
  return {
    id: row.id,
    code: row.code,
    entryDate: row.entry_date,
    exitDate: row.exit_date,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    entryPriceRaw: row.entry_price_raw,
    exitPriceRaw: row.exit_price_raw,
    shares: row.shares,
    pnl: row.pnl,
    pnlPct: row.pnl_pct,
    holdingBars: row.holding_bars,
    costs: row.costs,
    regimeAtEntry: row.regime_at_entry as ShadowTrade['regimeAtEntry'],
    entryScore: row.entry_score,
    exitRule: row.exit_rule,
    partial: row.partial === 1,
    engineVersion: row.engine_version,
  }
}

/**
 * 一行流水（013_shadow_journal）。**给人看的**，不参与任何绩效计算。
 *
 * 不复用 `ShadowTrade` / `ShadowOrder`：那两个是账本，字段齐全且各有口径；
 * 这里要的是「那一刻发生了什么」，缺什么就是 null（比如 `NOT_ADVANCED` 只有 reason）。
 */
export interface ShadowJournalEntry {
  date: TradeDate
  seq: number
  at: number
  kind: 'PLACED' | 'FILLED_BUY' | 'FILLED_SELL' | 'VOIDED' | 'DEFERRED' | 'CLOSED_OUT' | 'NOT_ADVANCED'
  code: SecCode | null
  action: 'BUY' | 'SELL' | 'REDUCE' | null
  shares: number | null
  price: number | null
  rule: string | null
  regime: string | null
  score: number | null
  reason: string | null
}

interface JournalRow {
  trade_date: string
  seq: number
  at: number
  kind: string
  code: string | null
  action: string | null
  shares: number | null
  price: number | null
  rule: string | null
  regime: string | null
  score: number | null
  reason: string | null
}

function toJournal(row: JournalRow): ShadowJournalEntry {
  return {
    date: row.trade_date,
    seq: row.seq,
    at: row.at,
    kind: row.kind as ShadowJournalEntry['kind'],
    code: row.code,
    action: row.action as ShadowJournalEntry['action'],
    shares: row.shares,
    price: row.price,
    rule: row.rule,
    regime: row.regime,
    score: row.score,
    reason: row.reason,
  }
}

export class ShadowRepo {
  constructor(private readonly db: Database) {}

  // ── 委托 ──────────────────────────────────────────────────────────

  orders(): ShadowOrder[] {
    return this.db.prepare(`SELECT * FROM shadow_order ORDER BY code`).all<OrderRow>().map(toOrder)
  }

  putOrder(order: ShadowOrder): void {
    this.db
      .prepare(
        `INSERT INTO shadow_order (code, action, placed_date, rule, score, regime, signal_id, deferred)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           action = excluded.action, placed_date = excluded.placed_date, rule = excluded.rule,
           score = excluded.score, regime = excluded.regime, signal_id = excluded.signal_id,
           deferred = excluded.deferred`
      )
      .run(
        order.code,
        order.action,
        order.placedDate,
        order.rule,
        order.score,
        order.regime,
        order.signalId,
        order.deferred
      )
  }

  clearOrder(code: SecCode): void {
    this.db.prepare(`DELETE FROM shadow_order WHERE code = ?`).run(code)
  }

  // ── 持仓 ──────────────────────────────────────────────────────────

  positions(): ShadowPosition[] {
    return this.db
      .prepare(`SELECT * FROM shadow_position ORDER BY code`)
      .all<PositionRow>()
      .map(toPosition)
  }

  position(code: SecCode): ShadowPosition | null {
    const row = this.db.prepare(`SELECT * FROM shadow_position WHERE code = ?`).get<PositionRow>(code)
    return row ? toPosition(row) : null
  }

  putPosition(position: ShadowPosition): void {
    this.db
      .prepare(
        `INSERT INTO shadow_position (code, shares, entry_date, entry_price_adj, entry_price_raw,
           entry_costs, entry_regime, entry_score, entry_rule, peak_raw, last_close_adj,
           bars_held, engine_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           shares = excluded.shares, entry_date = excluded.entry_date,
           entry_price_adj = excluded.entry_price_adj, entry_price_raw = excluded.entry_price_raw,
           entry_costs = excluded.entry_costs, entry_regime = excluded.entry_regime,
           entry_score = excluded.entry_score, entry_rule = excluded.entry_rule,
           peak_raw = excluded.peak_raw, last_close_adj = excluded.last_close_adj,
           bars_held = excluded.bars_held, engine_version = excluded.engine_version`
      )
      .run(
        position.code,
        position.shares,
        position.entryDate,
        position.entryPriceAdj,
        position.entryPriceRaw,
        position.entryCosts,
        position.entryRegime,
        position.entryScore,
        position.entryRule,
        position.peakRaw,
        position.lastCloseAdj,
        position.barsHeld,
        position.engineVersion
      )
  }

  clearPosition(code: SecCode): void {
    this.db.prepare(`DELETE FROM shadow_position WHERE code = ?`).run(code)
  }

  // ── 已平仓交易 ────────────────────────────────────────────────────

  insertTrade(trade: ShadowTrade): void {
    this.db
      .prepare(
        `INSERT INTO shadow_trade (id, code, entry_date, exit_date, entry_price, exit_price,
           entry_price_raw, exit_price_raw, shares, pnl, pnl_pct, holding_bars, costs,
           regime_at_entry, entry_score, exit_rule, partial, engine_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trade.id,
        trade.code,
        trade.entryDate,
        trade.exitDate,
        trade.entryPrice,
        trade.exitPrice,
        trade.entryPriceRaw,
        trade.exitPriceRaw,
        trade.shares,
        trade.pnl,
        trade.pnlPct,
        trade.holdingBars,
        trade.costs,
        trade.regimeAtEntry,
        trade.entryScore,
        trade.exitRule,
        trade.partial ? 1 : 0,
        trade.engineVersion
      )
  }

  trades(limit?: number): ShadowTrade[] {
    const sql =
      limit === undefined
        ? `SELECT * FROM shadow_trade ORDER BY exit_date ASC, id ASC`
        : `SELECT * FROM shadow_trade ORDER BY exit_date DESC, id DESC LIMIT ?`
    const rows = limit === undefined ? this.db.prepare(sql).all<TradeRow>() : this.db.prepare(sql).all<TradeRow>(limit)
    const mapped = rows.map(toTrade)
    // limit 分支查的是倒序，翻回时间正序交给上层 —— 净值与归因都按时间序算
    return limit === undefined ? mapped : mapped.reverse()
  }

  tradeCount(): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM shadow_trade`).get<{ n: number }>()?.n ?? 0
  }

  // ── 净值曲线 ──────────────────────────────────────────────────────

  hasDate(date: TradeDate): boolean {
    return (
      this.db
        .prepare(`SELECT 1 AS hit FROM shadow_equity WHERE trade_date = ?`)
        .get<{ hit: number }>(date) !== undefined
    )
  }

  putEquity(point: ShadowEquityPoint): void {
    this.db
      .prepare(
        `INSERT INTO shadow_equity (trade_date, cash, position_value, equity, benchmark)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trade_date) DO UPDATE SET
           cash = excluded.cash, position_value = excluded.position_value,
           equity = excluded.equity, benchmark = excluded.benchmark`
      )
      .run(point.date, point.cash, point.positionValue, point.equity, point.benchmark)
  }

  equity(): ShadowEquityPoint[] {
    return this.db
      .prepare(
        `SELECT trade_date, cash, position_value, equity, benchmark
         FROM shadow_equity ORDER BY trade_date ASC`
      )
      .all<{
        trade_date: string
        cash: number
        position_value: number
        equity: number
        benchmark: number | null
      }>()
      .map((row) => ({
        date: row.trade_date,
        cash: row.cash,
        positionValue: row.position_value,
        equity: row.equity,
        benchmark: row.benchmark,
      }))
  }

  barCount(): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM shadow_equity`).get<{ n: number }>()?.n ?? 0
  }

  /**
   * 基准列还空着的那些交易日（2026-08-19）。
   *
   * 为什么会空：推进与日线回补在同一跳里，回补先失败（腾讯对指数结构性没有复权轨、
   * eastmoney 又是间歇性的），0.2 秒后推进读基准就拿到 null；当天晚些时候 kline 补上了，
   * 但那一天不会再推进 ⇒ 永久留 null。而 `summary` 的 `lastBenchmark` 取**最后一行**，
   * 所以只要收尾那天是 null，整条同期对比就是 null —— 影子曲线没有刻度。
   */
  equityMissingBenchmark(): TradeDate[] {
    return this.db
      .prepare(`SELECT trade_date FROM shadow_equity WHERE benchmark IS NULL ORDER BY trade_date ASC`)
      .all<{ trade_date: string }>()
      .map((row) => row.trade_date)
  }

  /**
   * 只补基准这一个**事实列**。
   *
   * ⚠ 这不是「补跑历史」—— 前向纪律（docs/07 §2.3）管的是信号、委托与成交，
   * 那些必须按真实时间往前走。而沪深300 在某一天的收盘价是一个与我们的决策无关的事实，
   * 它当时没取到只是取数失败，不是「那天还不知道」。两者混为一谈会让这条修复
   * 看起来像在破纪律，所以写在这里。
   */
  setBenchmark(date: TradeDate, benchmark: number): void {
    this.db
      .prepare(`UPDATE shadow_equity SET benchmark = ? WHERE trade_date = ? AND benchmark IS NULL`)
      .run(benchmark, date)
  }

  // ── 操作流水（013）────────────────────────────────────────────────

  /** 最近的流水，**按 (日期, seq) 倒序** —— 面板从最新往回翻 */
  journal(limit = 60): ShadowJournalEntry[] {
    return this.db
      .prepare(`SELECT * FROM shadow_journal ORDER BY trade_date DESC, seq DESC LIMIT ?`)
      .all<JournalRow>(Math.max(1, Math.floor(limit)))
      .map(toJournal)
  }

  /**
   * 一次推进的流水整批落盘。**先清掉那天的旧行** ——
   * 与 `shadow_equity.trade_date` 是同一条幂等纪律：推进本身只该发生一次，
   * 但真发生第二次（重置后重推、跨日唤醒补跑）时，流水不该出现两份互相矛盾的记录。
   */
  putJournal(date: TradeDate, entries: readonly Omit<ShadowJournalEntry, 'date' | 'seq'>[]): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM shadow_journal WHERE trade_date = ?`).run(date)
      let seq = 0
      for (const entry of entries) {
        this.db
          .prepare(
            `INSERT INTO shadow_journal
               (trade_date, seq, at, kind, code, action, shares, price, rule, regime, score, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            date,
            ++seq,
            entry.at,
            entry.kind,
            entry.code,
            entry.action,
            entry.shares,
            entry.price,
            entry.rule,
            entry.regime,
            entry.score,
            entry.reason
          )
      }
    })
  }

  /**
   * 整块清空并重新开始。
   *
   * 唯一的正当用途是**引擎版本变了**：参数一改，此前累积的影子绩效衡量的是另一套引擎，
   * 混在一起的曲线不属于任何一套参数。所以 UI 上这个按钮的文案是「重新开始」而不是
   * 「清除」—— 用户要明白丢掉的是一段无法重建的前向记录（历史 K 线补不出它，
   * 补出来的那个叫回测）。
   */
  reset(): void {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM shadow_order`)
      this.db.exec(`DELETE FROM shadow_position`)
      this.db.exec(`DELETE FROM shadow_trade`)
      this.db.exec(`DELETE FROM shadow_equity`)
      this.db.exec(`DELETE FROM shadow_journal`)
      for (const key of Object.values(SHADOW_KEYS)) {
        this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key)
      }
    })
  }
}
