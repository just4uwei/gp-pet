/**
 * meta 表：schema_version、各类「上次刷新时间」等键值。
 *
 * 用它记录刷新时间而不是文件 mtime：mtime 会被同步工具、备份、杀软改掉。
 */

import type { Database } from '../db'

export class MetaRepo {
  constructor(private readonly db: Database) {}

  get(key: string): string | null {
    return this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get<{ value: string }>(key)?.value ?? null
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  getNumber(key: string): number | null {
    const raw = this.get(key)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  setNumber(key: string, value: number): void {
    this.set(key, String(value))
  }
}

export const META_KEYS = {
  calendarRefreshedAt: 'calendar_refreshed_at',
  profileRefreshedAt: 'profile_refreshed_at',
  lastPruneAt: 'last_prune_at',
  /**
   * 最近一次**补行业**的时刻（`engine/tick.ts` 的 `INDUSTRY_RETRY_INTERVAL_MS`）。
   *
   * 与 `profileRefreshedAt` 分开是因为两者的失败方式不同：整周刷新那趟**报成功也可能
   * 一个行业都没拿到**（主源在冷却里被跳过，备源不提供这个字段），而它一旦盖下时间戳
   * 就是七天之后才会再来。这个键让「只差行业」的那批标的每天再试一次，拿到即收敛。
   */
  industryRetryAt: 'industry_retry_at',
  /**
   * 最近一次补跑过收盘确认轮的交易日（`engine/settle.ts`）。**存日期串不是时刻。**
   *
   * 它是幂等闸门：补跑本身是幂等的（签名去重 + 只动 PROVISIONAL 行 + upsert），
   * 但它要为每只标的算一遍 320 根的全套指标，没必要每轮 tick 都来。
   *
   * **不能改用「当日有没有 CONFIRMED 行」来判**：一个交易日合法地可以零信号，
   * 那样会变成每轮都重跑。
   */
  lastSettledDate: 'last_settled_date',
  /**
   * 当日日线**已经补齐**的那个交易日（`engine/tick.ts` 的收盘后补齐窗口）。**存日期串。**
   *
   * 收盘（15:10）之后应用本来一个请求都不发，而个股日线数据源 15:05–15:30 才发布 ⇒
   * 当天的收盘线要到次日盘前才入库 ⇒ 日报整天卡在「未定稿」。收盘后那个窗口专门补这一下，
   * 补齐即置这个键并停手 —— 少了它，那 10 只结构性拉不到的 ETF 会把整个窗口每一轮都烧满。
   */
  dailyCompleteDate: 'daily_complete_date',
  /** 收盘后补齐窗口在 `dailyCompleteDate` 那天已经试过几轮。上限见 tick.ts 的 `CLOSE_CATCHUP` */
  dailyCatchupAttempts: 'daily_catchup_attempts',
  /** `dailyCatchupAttempts` 属于哪个交易日（跨日要清零，否则昨天用满了今天就一轮都不跑） */
  dailyCatchupDate: 'daily_catchup_date',
  /**
   * 提醒闸门的跨重启状态（`alerts/dispatcher.ts` 的 `DispatcherState`，JSON）。
   *
   * 存 meta 而不是新建一张表：它是**单值状态**，为它建表只会多一处「忘了初始化」
   * （与 `SHADOW_KEYS` 同一个模式）。恢复时按当前时刻重新裁剪，
   * 所以一份很旧的状态不会把闸门长期卡住 —— 判据在 `AlertDispatcher.restore`。
   */
  alertGateState: 'alert_gate_state',
} as const
