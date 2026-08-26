/**
 * 用户手工录入的持仓（docs/03 §4.2）。
 *
 * 成本价是**不复权**真实成交价 —— 用户的成本就是当时付的钱，
 * 拿前复权价算止损会在除权后凭空触发一次卖出提醒（docs/03 §2.3）。
 *
 * ## 「已接受的那一段亏损」（009_position_stop.sql）
 *
 * `stopFloor` 是用户确认接受当前亏损后重新画的那条止损线（绝对价、不复权）。
 * 有它时固定止损按它判，没有时按 `params.risk.stopLossPct` 的百分比判。
 *
 * **两处必须清空它**，否则会静默少发提醒（而少发的错误用户发现不了）：
 *   1. `set()` —— 加仓/改成本会让旧线与新成本不再是同一个判断；
 *   2. `clear()` 顺带（整行删掉，天然清空）。
 * 这就是 `set()` 里那三个 `= NULL` 的理由，**别为了「保留用户设置」把它们去掉**。
 */

import type { Position, SecCode } from '@core/types'
import type { Database } from '../db'

interface Row {
  code: string
  shares: number
  cost: number
  peak_price: number | null
  opened_at: number
  stop_floor: number | null
  stop_ack_at: number | null
  stop_ack_loss: number | null
}

function toPosition(row: Row): Position {
  const out: Position = {
    code: row.code,
    shares: row.shares,
    cost: row.cost,
    // peak_price 为空时用成本价兜底：持有期最高价至少是买入价
    peakPrice: row.peak_price ?? row.cost,
    openedAt: row.opened_at,
  }
  // exactOptionalPropertyTypes：没有就不要这个键，而不是塞 undefined。
  // 而且**必须是「没有」而不是 0** —— 0 会被读成「跌到 0 才止损」（约束 4 的形状）
  if (row.stop_floor !== null) out.stopFloor = row.stop_floor
  return out
}

/** 止损确认的完整记录。风控只要 `stopFloor`，这一份是给界面看的 */
export interface StopAck {
  stopFloor: number
  ackAt: number
  /** 确认时的浮亏百分比（负数）。回答「他当时接受的是多大一段」 */
  ackLossPct: number
}

const COLUMNS = `code, shares, cost, peak_price, opened_at, stop_floor, stop_ack_at, stop_ack_loss`

export class PositionRepo {
  constructor(private readonly db: Database) {}

  /**
   * 覆盖式写入持仓。**顺带清掉止损确认** —— 成本变了，用户当时基于旧成本
   * 接受的那段亏损不再是同一个判断（见类头注释）。
   */
  set(code: SecCode, shares: number, cost: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO position (code, shares, cost, peak_price, opened_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           shares = excluded.shares,
           cost = excluded.cost,
           stop_floor = NULL,
           stop_ack_at = NULL,
           stop_ack_loss = NULL`
      )
      .run(code, Math.round(shares), cost, cost, now)
  }

  /** 移动止损/回撤提醒依赖持有期最高价，只允许上调 */
  bumpPeak(code: SecCode, price: number): void {
    this.db
      .prepare(`UPDATE position SET peak_price = MAX(COALESCE(peak_price, cost), ?) WHERE code = ?`)
      .run(price, code)
  }

  /**
   * 用户确认「接受这一段亏损」，把止损线顺延到 `stopFloor`。
   * 没有这行持仓时什么都不做 —— 不给一条不存在的持仓建止损线。
   *
   * ## ⚠ 同时把 `peak_price` 重设为确认那一刻的价（2026-08-26，docs/05 §2.3a）
   *
   * 不重设的后果**不是「多一条提醒」，是「回撤减仓从此永久失去信息量」**：
   * `fromPeak` 会永远停在确认那一刻的大小 ⇒ 回撤减仓天天触发，
   * 而它说的是一件用户三天前就按下确认的事。
   * 真机实测 `SZ001296`：成本 23.998、`peak_price` 也是 23.998（建仓后一天没涨过）、
   * 已确认接受 −19.5% ⇒ `fromPeak = −18.1%` 恒 ≤ −7%，靠「跌幅每再扩大 2%」的台阶硬挡
   * （M3 复盘那五天里 192 行 `STEP`）。
   *
   * 重设之后回撤减仓**仍然带枪**，只是从用户接受的那个位置重新算 ——
   * **再跌 7% 才响，那时它说的是「跌得比你接受的还多」**，是新信息。
   *
   * **为什么动这一列而不是新加一列**：它**本来就不是「历史最高价」**，
   * 而是**风控用的回撤参考点** —— `bumpPeak` 没值时拿 `cost` 兜底，
   * `addTrade` 还会显式把它抬到成本价（否则移动止损会拿一个比成本还低的 peak 算回撤）。
   * 重设一个控制参考点不是篡改事实。价格回升时 `bumpPeak` 会把它一路带上去。
   *
   * ⚠ `priceAt` **必须是不复权价**，与 `cost` / `stop_floor` 同一口径（docs/03 §2.3）。
   * 取不到现价时**不动 `peak_price`** —— 用一个猜出来的价重设参考点，
   * 比不重设更坏（它会静默地改变一条 L3 强制类规则的触发点）。
   */
  acceptLoss(
    code: SecCode,
    stopFloor: number,
    lossPct: number,
    now: number,
    priceAt?: number
  ): boolean {
    const resetPeak = priceAt !== undefined && Number.isFinite(priceAt) && priceAt > 0
    return (
      this.db
        .prepare(
          `UPDATE position SET stop_floor = ?, stop_ack_at = ?, stop_ack_loss = ?` +
            (resetPeak ? `, peak_price = ?` : '') +
            ` WHERE code = ?`
        )
        .run(
          ...(resetPeak
            ? [stopFloor, Math.round(now), lossPct, priceAt, code]
            : [stopFloor, Math.round(now), lossPct, code])
        ).changes > 0
    )
  }

  /** 撤销确认，回到按百分比的出厂行为 */
  clearStop(code: SecCode): boolean {
    return (
      this.db
        .prepare(
          `UPDATE position SET stop_floor = NULL, stop_ack_at = NULL, stop_ack_loss = NULL WHERE code = ?`
        )
        .run(code).changes > 0
    )
  }

  stopAck(code: SecCode): StopAck | null {
    const row = this.db
      .prepare(`SELECT stop_floor, stop_ack_at, stop_ack_loss FROM position WHERE code = ?`)
      .get<{ stop_floor: number | null; stop_ack_at: number | null; stop_ack_loss: number | null }>(code)
    if (!row || row.stop_floor === null) return null
    return {
      stopFloor: row.stop_floor,
      ackAt: row.stop_ack_at ?? 0,
      ackLossPct: row.stop_ack_loss ?? 0,
    }
  }

  clear(code: SecCode): boolean {
    return this.db.prepare(`DELETE FROM position WHERE code = ?`).run(code).changes > 0
  }

  get(code: SecCode): Position | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM position WHERE code = ?`).get<Row>(code)
    return row ? toPosition(row) : null
  }

  list(): Position[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM position ORDER BY code ASC`)
      .all<Row>()
      .map(toPosition)
  }

  codes(): Set<SecCode> {
    return new Set(
      this.db
        .prepare(`SELECT code FROM position`)
        .all<{ code: string }>()
        .map((r) => r.code)
    )
  }
}
