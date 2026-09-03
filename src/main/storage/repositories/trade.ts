/**
 * 成交流水仓储（007_trade_log.sql）。
 *
 * 这一层只做读写，记账规则在 `src/main/trades/ledger.ts`（纯函数、可测）。
 * 表的性质与「为什么不加外键、为什么不进裁剪」见 SQL 的头注释。
 */

import type { SecCode } from '@core/types'
import type { TradeSide } from '@shared/ipc-types'
import type { Database } from '../db'

/** 五种流水的定义在 `shared/ipc-types.ts` 的 `TradeSide`（一处定义，主/渲染共用） */
export type TradeSideRow = TradeSide

export interface TradeRow {
  id: string
  code: SecCode
  side: TradeSideRow
  /** 成交**日**（表单里选的日期，存成北京 12:00）。**不是**真实成交时刻 */
  tradedAt: number
  /** 真实成交时刻（含分钟，016）。**undefined = 不知道**，不是 0（约束 4） */
  tradedAtExact?: number
  /** 照哪条提醒做的（016）。undefined = 未关联，**不是「没有提醒」** */
  signalId?: string
  /** 决策时刻的冗余快照 —— `signal` 会被裁剪，账本不会（016 头注释） */
  decisionAt?: number
  /** 决策价 = `signal.price_at`，同样是冗余快照 */
  decisionPrice?: number
  price: number
  shares: number
  /** 手续费。**一律由费率算**，用户不填这个数（017：对不上时改的是费率） */
  fee: number
  /**
   * 仅 `OPENING`：录入的 `price` 已经含手续费了吗（017）。
   * **undefined = 017 之前落库的老行**，一律按「已含」处理（见 017 头注释）。
   */
  feeIncluded?: boolean
  /**
   * 已实现盈亏。两种行会有它：卖出结转的差额，以及**分红把成本摊到 0 之后
   * 多出来的那部分**。买入 / 建仓 / 送转为 undefined —— **不是 0**（约束 4）
   */
  realized?: number
  note?: string
  createdAt: number
}

interface Row {
  id: string
  code: string
  side: string
  traded_at: number
  traded_at_exact: number | null
  signal_id: string | null
  decision_at: number | null
  decision_price: number | null
  price: number
  shares: number
  fee: number
  fee_included: number | null
  realized: number | null
  note: string | null
  created_at: number
}

function toRow(row: Row): TradeRow {
  const out: TradeRow = {
    id: row.id,
    code: row.code,
    side: row.side as TradeSideRow,
    tradedAt: row.traded_at,
    price: row.price,
    shares: row.shares,
    fee: row.fee,
    createdAt: row.created_at,
  }
  // exactOptionalPropertyTypes：没有就不要这个键，而不是塞 undefined
  if (row.realized !== null) out.realized = row.realized
  if (row.note !== null) out.note = row.note
  if (row.traded_at_exact !== null) out.tradedAtExact = row.traded_at_exact
  if (row.signal_id !== null) out.signalId = row.signal_id
  if (row.decision_at !== null) out.decisionAt = row.decision_at
  if (row.decision_price !== null) out.decisionPrice = row.decision_price
  // NULL **不能**折成 false：那是「017 之前的老行」，语义是「已含费」（017 头注释）。
  // 折成 false 会让升级那一刻全库的期初成本被凭空补一笔费用
  if (row.fee_included !== null) out.feeIncluded = row.fee_included !== 0
  return out
}

const COLUMNS =
  `id, code, side, traded_at, traded_at_exact, signal_id, decision_at, decision_price, ` +
  `price, shares, fee, fee_included, realized, note, created_at`

export class TradeRepo {
  constructor(private readonly db: Database) {}

  insert(row: TradeRow): void {
    this.db
      .prepare(
        `INSERT INTO trade_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.code,
        row.side,
        Math.round(row.tradedAt),
        // ⚠ 缺省一律落 NULL，**不许拿 tradedAt 顶替** —— 那是把「不知道分钟」
        // 写成「中午 12 点成交」，而 IS 分解会把它当真实时刻用（016 头注释）
        row.tradedAtExact === undefined ? null : Math.round(row.tradedAtExact),
        row.signalId ?? null,
        row.decisionAt === undefined ? null : Math.round(row.decisionAt),
        row.decisionPrice ?? null,
        row.price,
        Math.trunc(row.shares),
        row.fee,
        row.feeIncluded === undefined ? null : Number(row.feeIncluded),
        row.realized ?? null,
        row.note ?? null,
        Math.round(row.createdAt)
      )
  }

  /**
   * 改一笔（`trade:update`）。**按 `id` 覆盖除 `created_at` 之外的每一列。**
   *
   * `created_at` 不动是判据不是省事：它是同一天多笔的兜底排序键
   * （`listByCode` 的 `ORDER BY traded_at ASC, created_at ASC`），
   * 改了会让重放顺序随之变 —— 而重放顺序变了，成本就变了。
   *
   * ⚠ 调用方**必须紧接着整条重放**（`replayLedger`）并写回派生列：
   * `fee` 与 `realized` 都依赖它前面的每一行，只改这一行等于让账本
   * 从这里往后全错，而没有任何东西会报警。
   */
  update(row: TradeRow): boolean {
    return (
      this.db
        .prepare(
          `UPDATE trade_log SET
             code = ?, side = ?, traded_at = ?, traded_at_exact = ?,
             signal_id = ?, decision_at = ?, decision_price = ?,
             price = ?, shares = ?, fee = ?, fee_included = ?, realized = ?, note = ?
           WHERE id = ?`
        )
        .run(
          row.code,
          row.side,
          Math.round(row.tradedAt),
          row.tradedAtExact === undefined ? null : Math.round(row.tradedAtExact),
          row.signalId ?? null,
          row.decisionAt === undefined ? null : Math.round(row.decisionAt),
          row.decisionPrice ?? null,
          row.price,
          Math.trunc(row.shares),
          row.fee,
          row.feeIncluded === undefined ? null : Number(row.feeIncluded),
          row.realized ?? null,
          row.note ?? null,
          row.id
        ).changes > 0
    )
  }

  /**
   * 写回重放算出来的派生列。**只有这两列是派生的**，别顺手扩这个方法的职责。
   *
   * `realized === null` 落 NULL 而不是 0：「不适用」与「刚好打平」必须分得开（约束 4）。
   */
  setDerived(id: string, fee: number, realized: number | null): void {
    this.db.prepare(`UPDATE trade_log SET fee = ?, realized = ? WHERE id = ?`).run(fee, realized, id)
  }

  /**
   * 某只票的全部流水，**按成交时刻升序** —— 重放要的就是这个顺序。
   * 展示要倒序的话由调用方翻转：让仓储只出一种顺序，省得两处各记一半。
   *
   * 同一时刻的多笔按 `created_at` 兜底排序：补录的两笔可能填了同一个日期，
   * 没有兜底的话重放结果会随 SQLite 的返回顺序变。
   */
  listByCode(code: SecCode): TradeRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM trade_log WHERE code = ? ORDER BY traded_at ASC, created_at ASC`)
      .all<Row>(code)
      .map(toRow)
  }

  get(id: string): TradeRow | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM trade_log WHERE id = ?`).get<Row>(id)
    return row ? toRow(row) : null
  }

  /**
   * 账本里出现过的全部标的。「按新费率重算全库」要按 code 分组重放。
   *
   * **不与 `watchlist` / `position` 取交集**：卖光之后移出自选的票，
   * 它的历史费用照样该跟着新费率走 —— 否则「这只票总共赚了多少」这个
   * 唯一由账本回答的问题，会留下一批按旧费率算的答案。
   */
  codesWithTrades(): SecCode[] {
    return this.db
      .prepare(`SELECT DISTINCT code FROM trade_log ORDER BY code ASC`)
      .all<{ code: string }>()
      .map((r) => r.code)
  }

  /**
   * 现金分红到账合计（017）。
   *
   * ⚠ **不能与 `sumRealized` 相加**：分红走的是「扣减摊薄成本」，那笔钱要等卖出时
   * 才结转进 `realized` —— 相加会把同一笔钱数两遍。界面上必须是两行。
   */
  sumDividends(code: SecCode): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(price * shares), 0) AS total FROM trade_log
           WHERE code = ? AND side = 'DIVIDEND'`
        )
        .get<{ total: number }>(code)?.total ?? 0
    )
  }

  /** 覆盖式导入时清掉该标的的旧账本 —— 上一份配置的成交记录不能与新持仓混在一起 */
  removeByCode(code: SecCode): number {
    return this.db.prepare(`DELETE FROM trade_log WHERE code = ?`).run(code).changes
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM trade_log WHERE id = ?`).run(id).changes > 0
  }

  /**
   * `sinceMs` 之后买入的股数合计 —— A 股 T+1 的「今天卖不掉的那部分」（`Position.lockedShares`）。
   *
   * 三条：
   *   * **只数 `BUY`**。`OPENING` 按定义就是老仓（迁移或导入时按当时持仓补的），
   *     把它算进来会让刚导入配置的用户一整天卖不出任何东西；
   *     `SPLIT` 送来的股票**到账当日就可卖**，`DIVIDEND` 压根不改股数
   *     —— 两者都不该占 T+1 的额度（017）；
   *   * **日界由调用方给**，一律传 `shanghaiDayStartMs(...)`，不在这里读时钟；
   *   * ⚠ `traded_at` 是**用户在表单里选的日期**，`TradePanel` 把它存成**本机**中午 12:00
   *     （`parseDate` 的 `T12:00:00`）。与北京日界比较在 UTC+7/+8 上正确，
   *     在极西时区（如 UTC−5）上会把昨天的买入也算成今天的。修法是把那个表单的
   *     日期口径换成北京日，属另一处改动 —— 这里先把口径写明白。
   */
  boughtSharesSince(code: SecCode, sinceMs: number): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(shares), 0) AS total FROM trade_log
           WHERE code = ? AND side = 'BUY' AND traded_at >= ?`
        )
        .get<{ total: number }>(code, Math.round(sinceMs))?.total ?? 0
    )
  }

  /** 已实现盈亏合计。没有任何卖出时返回 0 —— 这里 0 是对的：一笔都没卖就是没实现 */
  sumRealized(code: SecCode): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(SUM(realized), 0) AS total FROM trade_log WHERE code = ?`)
        .get<{ total: number }>(code)?.total ?? 0
    )
  }

  sumFees(code: SecCode): number {
    return (
      this.db
        .prepare(`SELECT COALESCE(SUM(fee), 0) AS total FROM trade_log WHERE code = ?`)
        .get<{ total: number }>(code)?.total ?? 0
    )
  }
}
