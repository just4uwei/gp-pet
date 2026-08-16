/**
 * 数据保留与裁剪（docs/03 §4.3）。
 *
 * 目标总量 < 100 MB。启动时跑一次，低优先级、非阻塞 ——
 * 它跟第一个 tick 抢的是同一个 SQLite 连接，所以必须晾到窗口起来之后再做。
 */

import type { Database } from './db'
import { KlineRepo } from './repositories/kline'
import { META_KEYS, MetaRepo } from './repositories/meta'
import { ProviderHealthRepo } from './repositories/health'
import { QuoteTickRepo } from './repositories/quote-tick'
import { AnnouncementRepo } from './repositories/announcement'

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionPolicy {
  /** 每只保留的日线根数（≈6 年） */
  klineBars: number
  /** 每只保留的指标快照根数 */
  indicatorBars: number
  signalDays: number
  alertDays: number
  healthDays: number
  /** 已结束的观察点（命中/过期/取消）保留多久。ACTIVE 的永不裁剪 */
  watchDays: number
  /** 当日分时留痕保留多久。只服务面板上那张「今日」走势图，留久了没有用处 */
  quoteTickDays: number
  /**
   * 公告保留多久（docs/11 N2）。
   *
   * **它能进裁剪，是因为它可以重建** —— 再拉一次就有。这与 `ai_explain` /
   * `report_note` / 影子账本刻意不进裁剪恰好相反（那三样花过钱或无法重建）。
   */
  announcementDays: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  klineBars: 1500,
  indicatorBars: 500,
  signalDays: 730,
  alertDays: 365,
  healthDays: 30,
  // 与 alert_log 同一档：观察点的历史是「我当时押了什么、押中没有」，
  // 比信号日志更值得留一年 —— 它是用户自己的判断记录
  watchDays: 365,
  // 面板只画「今日」那张图，7 天纯粹是给「周五收盘后周一才开机」这类情况留的余量。
  // 12 只自选约 3000 行/天，7 天不到 3 MB
  quoteTickDays: 7,
  // 90 天：盘前简报只看「昨收盘之后」，但用户点进某只票的历史时，
  // 一个季度的公告是能说明问题的最短跨度（一份季报到下一份）
  announcementDays: 90,
}

export interface RetentionReport {
  klineDeleted: number
  indicatorDeleted: number
  signalDeleted: number
  alertDeleted: number
  watchDeleted: number
  healthDeleted: number
  quoteTickDeleted: number
  announcementDeleted: number
}

/**
 * 裁剪一轮。now 由调用方传入，便于测试与「跨天唤醒补一次」的场景。
 * vacuum 不在这里做：它会长时间独占写锁，交给 vacuumIfIdle 单独调用。
 */
export function pruneAll(
  db: Database,
  now: number,
  policy: RetentionPolicy = DEFAULT_RETENTION
): RetentionReport {
  const klines = new KlineRepo(db)
  const health = new ProviderHealthRepo(db)
  const meta = new MetaRepo(db)

  let klineDeleted = 0
  for (const code of klines.storedCodes()) {
    klineDeleted += klines.prune(code, policy.klineBars)
  }

  const indicatorDeleted = db
    .prepare(
      `DELETE FROM indicator_daily WHERE (code, trade_date) NOT IN (
         SELECT code, trade_date FROM (
           SELECT code, trade_date,
                  ROW_NUMBER() OVER (PARTITION BY code ORDER BY trade_date DESC) AS rn
           FROM indicator_daily
         ) WHERE rn <= ?
       )`
    )
    .run(policy.indicatorBars).changes

  // alert_log.signal_id 是指向 signal 的外键，删除顺序不能颠倒：
  // 先清「过期的提醒」+「即将被删的信号所对应的提醒」，再删信号本身。
  // 反过来会直接撞 FOREIGN KEY constraint —— 而 foreign_keys 是 ON 的（db.ts）。
  const signalCutoff = now - policy.signalDays * DAY_MS
  const alertDeleted = db
    .prepare(
      `DELETE FROM alert_log
       WHERE created_at < ?
          OR signal_id IN (SELECT id FROM signal WHERE created_at < ?)
          OR signal_id NOT IN (SELECT id FROM signal)`
    )
    .run(now - policy.alertDays * DAY_MS, signalCutoff).changes

  // watch_point.signal_id 同样是指向 signal 的外键，同一条纪律、同一个顺序。
  // 只清**已经结束**的（HIT / EXPIRED / CANCELED）：ACTIVE 的还在盯，
  // 哪怕它的来源信号快被裁掉了也不能删 —— 那是用户明确要跟踪的东西。
  // 实践上撞不上（观察点几周就过期，信号留 2 年），但顺序错了的代价是启动即崩，
  // 所以照抄那条 NOT IN 兜底
  const watchCutoff = now - policy.watchDays * DAY_MS
  const watchDeleted = db
    .prepare(
      `DELETE FROM watch_point
       WHERE status != 'ACTIVE'
         AND (created_at < ?
              OR signal_id IN (SELECT id FROM signal WHERE created_at < ?)
              OR signal_id NOT IN (SELECT id FROM signal))`
    )
    .run(watchCutoff, signalCutoff).changes

  // **还被观察点引着的信号不能删。** 上面那一步刻意留下了 ACTIVE 的观察点
  // （那是用户明确要跟踪的东西），于是它们的来源信号也必须跟着留 —— 否则这一句
  // 直接撞 FOREIGN KEY constraint。留几行两年前的 signal 是很便宜的代价，
  // 而崩在裁剪里会让每轮 tick 都报错
  const signalDeleted = db
    .prepare(
      `DELETE FROM signal
       WHERE created_at < ?
         AND id NOT IN (SELECT signal_id FROM watch_point)`
    )
    .run(signalCutoff).changes

  // 分时留痕没有外键，删除顺序上不需要与谁配合
  const quoteTickDeleted = new QuoteTickRepo(db).prune(now - policy.quoteTickDays * DAY_MS)

  const healthDeleted = health.prune(now - policy.healthDays * DAY_MS)
  const announcementDeleted = new AnnouncementRepo(db).prune(now - policy.announcementDays * DAY_MS)

  meta.setNumber(META_KEYS.lastPruneAt, now)

  return {
    klineDeleted,
    indicatorDeleted,
    signalDeleted,
    alertDeleted,
    watchDeleted,
    healthDeleted,
    quoteTickDeleted,
    announcementDeleted,
  }
}

/**
 * 距上次裁剪不足 interval 就跳过 —— 频繁启动的用户不该每次都付一遍裁剪成本。
 * 返回 null 表示本次跳过。
 */
export function pruneIfDue(
  db: Database,
  now: number,
  intervalMs = DAY_MS,
  policy: RetentionPolicy = DEFAULT_RETENTION
): RetentionReport | null {
  const last = new MetaRepo(db).getNumber(META_KEYS.lastPruneAt)
  if (last !== null && now - last < intervalMs) return null
  return pruneAll(db, now, policy)
}

/** WAL 下的 VACUUM 会重建整库，只在裁剪确实删掉了东西时才值得做 */
export function vacuum(db: Database): void {
  db.exec('VACUUM')
}
