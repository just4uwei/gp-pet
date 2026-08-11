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

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionPolicy {
  /** 每只保留的日线根数（≈6 年） */
  klineBars: number
  /** 每只保留的指标快照根数 */
  indicatorBars: number
  signalDays: number
  alertDays: number
  healthDays: number
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  klineBars: 1500,
  indicatorBars: 500,
  signalDays: 730,
  alertDays: 365,
  healthDays: 30,
}

export interface RetentionReport {
  klineDeleted: number
  indicatorDeleted: number
  signalDeleted: number
  alertDeleted: number
  healthDeleted: number
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

  const signalDeleted = db.prepare(`DELETE FROM signal WHERE created_at < ?`).run(signalCutoff).changes

  const healthDeleted = health.prune(now - policy.healthDays * DAY_MS)

  meta.setNumber(META_KEYS.lastPruneAt, now)

  return { klineDeleted, indicatorDeleted, signalDeleted, alertDeleted, healthDeleted }
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
