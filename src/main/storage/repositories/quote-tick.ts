/**
 * 当日分时留痕表访问（004_quote_tick.sql）。
 *
 * 只服务面板上那张走势图：引擎、回测、指标一个字都不读它。
 * 那张表的头注释写清了「它不是什么」，改这里之前先看一眼。
 *
 * ## ⚠ 2026-08-14 起它是**兜底**，不再是那张图的主数据源
 *
 * 分时图默认画的是数据源的逐分钟分时（`QuoteProvider.fetchMinutes`，用户打开抽屉
 * 「行情」页时拉一次、带 30s 缓存）。这张表只在**那一趟拉不到**时顶上 ——
 * 取舍规则在 `engine/intraday.ts`，两份数据**不合并**（分钟收盘价与 30s 快照是两种
 * 采样口径，拼在一条线上会出现肉眼可见的锯齿，而用户看不出那是两个来源）。
 *
 * 这张表因此**不要删**：数据源全挂时它是唯一还画得出东西的东西，
 * 而它的写入照旧不花任何额外请求（顺手落一行本来就拿到的快照）。
 *
 * 两条：
 *   1. **写入是 INSERT OR IGNORE**，靠主键 `(code, ts)` 幂等 —— 盘后会跑好几轮 tick，
 *      快照时刻不变时重复写不该攒出新点。
 *   2. **`series()` 返回的序列可能有洞**（午休、应用当时没开着）。
 *      调用方必须把洞画出来，不许当成连续序列直连 —— 见渲染层 IntradayChart。
 */

import type { SecCode } from '@core/types'
import type { Database } from '../db'

export interface QuoteTickInput {
  code: SecCode
  ts: number
  last: number
  /** 拿不到时传 null，**不要传 0** */
  preClose: number | null
}

export interface QuoteTickPoint {
  ts: number
  last: number
}

export class QuoteTickRepo {
  constructor(private readonly db: Database) {}

  /** 返回本次真正写进去的行数（被主键挡掉的不计） */
  record(rows: readonly QuoteTickInput[]): number {
    if (rows.length === 0) return 0
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO quote_tick (code, ts, last, pre_close) VALUES (?, ?, ?, ?)`
    )
    let written = 0
    this.db.transaction(() => {
      for (const row of rows) {
        if (!Number.isFinite(row.last)) continue
        const preClose = row.preClose !== null && Number.isFinite(row.preClose) ? row.preClose : null
        written += stmt.run(row.code, Math.round(row.ts), row.last, preClose).changes
      }
    })
    return written
  }

  /** [from, to] 闭区间，按 ts 升序 */
  series(code: SecCode, from: number, to: number): QuoteTickPoint[] {
    return this.db
      .prepare(
        `SELECT ts, last FROM quote_tick
         WHERE code = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`
      )
      .all<QuoteTickPoint>(code, Math.round(from), Math.round(to))
  }

  /**
   * 该区间里最后一个非空昨收。取「最后一个」而不是第一个：
   * 跨日的区间里，晚的那个才是当天的昨收。
   */
  preCloseOf(code: SecCode, from: number, to: number): number | null {
    return (
      this.db
        .prepare(
          `SELECT pre_close FROM quote_tick
           WHERE code = ? AND ts >= ? AND ts <= ? AND pre_close IS NOT NULL
           ORDER BY ts DESC LIMIT 1`
        )
        .get<{ pre_close: number | null }>(code, Math.round(from), Math.round(to))?.pre_close ?? null
    )
  }

  /**
   * 每只票最后一次留痕（2026-08-19）。**只服务「重启后先把上次看到的价显示出来」。**
   *
   * 为什么需要它：快照缓存在内存里（`market-data.ts` 的 `cache`），重启即空；
   * 而休市时段 `needsQuotes` 为 false ⇒ **不会有任何一轮 tick 去补** ⇒
   * 晚上/周末重启之后，面板与悬浮条的价格一直空到下一个交易日 09:00。
   *
   * 拿它当「上次看到的价」是安全的：这张表**刻意不存 stale 快照**
   * （004 头注释的第三条），所以每一行都是真实观测到的成交价。
   * 但调用方必须把它标成 `stale` 并把 `ts` 显示出来 —— 绝不假装实时（docs/03）。
   */
  latest(codes: readonly SecCode[]): Map<SecCode, { ts: number; last: number; preClose: number | null }> {
    const out = new Map<SecCode, { ts: number; last: number; preClose: number | null }>()
    if (codes.length === 0) return out
    // 主键是 (code, ts)，所以这条按 code 定位再取尾是走索引的
    const stmt = this.db.prepare(
      `SELECT ts, last, pre_close FROM quote_tick WHERE code = ? ORDER BY ts DESC LIMIT 1`
    )
    for (const code of codes) {
      const row = stmt.get<{ ts: number; last: number; pre_close: number | null }>(code)
      if (row) out.set(code, { ts: row.ts, last: row.last, preClose: row.pre_close })
    }
    return out
  }

  /** 删掉 before 之前的全部点（docs/03 §4.3） */
  prune(before: number): number {
    return this.db.prepare(`DELETE FROM quote_tick WHERE ts < ?`).run(Math.round(before)).changes
  }
}
