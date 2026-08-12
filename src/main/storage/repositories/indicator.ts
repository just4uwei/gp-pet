/**
 * 指标缓存（`indicator_daily`，docs/03 §4.2）。
 *
 * 只缓存**收盘值**：盘中那根由临时 K 线算出来的指标每 tick 都在变，落库等于把
 * 「历史」写成一个随时间改写的东西（docs/04 §6）。
 *
 * `engine_version` 是缓存键的一部分（算法版本 + 参数指纹，见 core/params.ts）：
 * 参数一改，旧值立刻失效并重算 —— K 线不重拉。这是 M2 出口条件里
 * 「engine_version 机制与指标缓存失效」那一条的落点。
 */

import type { SecCode, TradeDate } from '@core/types'
import type { Database } from '../db'

export interface CachedIndicators<T = unknown> {
  code: SecCode
  date: TradeDate
  payload: T
  engineVersion: string
}

export class IndicatorRepo {
  constructor(private readonly db: Database) {}

  /** 命中要求版本一致；版本不同视为未命中（旧值留在库里，由 purgeOtherVersions 统一清） */
  get<T>(code: SecCode, date: TradeDate, engineVersion: string): T | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM indicator_daily
          WHERE code = ? AND trade_date = ? AND engine_version = ?`
      )
      .get<{ payload: string }>(code, date, engineVersion)
    if (!row) return null
    try {
      return JSON.parse(row.payload) as T
    } catch {
      // 损坏的 JSON 当未命中处理：重算一次就好，没必要为此让一轮 tick 失败
      return null
    }
  }

  put(code: SecCode, date: TradeDate, payload: unknown, engineVersion: string): void {
    this.db
      .prepare(
        `INSERT INTO indicator_daily (code, trade_date, payload, engine_version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(code, trade_date) DO UPDATE SET
           payload = excluded.payload, engine_version = excluded.engine_version`
      )
      .run(code, date, JSON.stringify(payload), engineVersion)
  }

  /**
   * 清掉非当前版本的缓存。启动时跑一次即可 —— 参数改了之后，旧版本的行永远不会再被命中，
   * 留着只是占磁盘；而按 (code, trade_date) 主键，它们还会挡住新版本的 INSERT
   * （所以 put 用的是 upsert 而不是 insert）。
   */
  purgeOtherVersions(engineVersion: string): number {
    return this.db
      .prepare(`DELETE FROM indicator_daily WHERE engine_version <> ?`)
      .run(engineVersion).changes
  }

  count(): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM indicator_daily`).get<{ n: number }>()?.n ?? 0
    )
  }

  /** 每只保留最近 keep 根（与 kline 的裁剪策略一致，docs/03 §4.3） */
  prune(code: SecCode, keep: number): number {
    return this.db
      .prepare(
        `DELETE FROM indicator_daily WHERE code = ? AND trade_date NOT IN (
           SELECT trade_date FROM indicator_daily WHERE code = ? ORDER BY trade_date DESC LIMIT ?
         )`
      )
      .run(code, code, Math.max(1, Math.floor(keep))).changes
  }
}
