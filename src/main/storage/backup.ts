/**
 * `market.db` 的备份（docs/03 §4.4、docs/08 M4）。
 *
 * 与 `db.ts` 里那个**迁移前备份**是两件事，别混：
 *   - `db.ts` 的 `market.db.bak-<version>`：schema 变更前的**一次性**保险，只留 1 份
 *   - 这里的 `backups/market-<日期>.db`：**周期性**快照，防的是「库被写坏 / 误删自选 /
 *     磁盘坏块」这类与迁移无关的事故，留最近几份
 *
 * ## 为什么用 `VACUUM INTO` 而不是拷文件
 *
 * WAL 模式下 `market.db` 不是自足的：最近的写还在 `-wal` 里。拷主文件会得到一个
 * **少了最后几分钟数据**的库，而它照样能打开 —— 这种备份最坏，因为它看起来成功了。
 * `VACUUM INTO` 由 SQLite 自己保证一致性快照，且**可以在运行中做**，
 * 不需要像迁移备份那样先关连接。顺带还会压掉裁剪留下的空洞。
 *
 * ## 两条与 logging.ts 一致的纪律
 *
 * 1. **认不出名字的文件一律不删。** 用户往 `backups/` 里丢的东西、改名前留下的旧备份
 *    都不动。误删别人的文件比多占几十 MB 贵得多。
 * 2. **失败只 warn，不抛。** 备份失败不该让一轮 tick 挂掉：库还在，行情还要继续走。
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from './db'
import { MetaRepo } from './repositories/meta'

const DAY_MS = 24 * 60 * 60 * 1000

/** `market-YYYY-MM-DD-HHmm.db`。只有匹配它的文件才会被清理 */
const BACKUP_PATTERN = /^market-\d{4}-\d{2}-\d{2}-\d{4}\.db$/

export const BACKUP_DIR_NAME = 'backups'

/** meta 键：上次备份时刻 */
export const LAST_BACKUP_KEY = 'last_backup_at'

export interface BackupPolicy {
  /** 保留最近几份 */
  keep: number
  /** 自动备份的最小间隔 */
  intervalMs: number
}

export const DEFAULT_BACKUP_POLICY: BackupPolicy = {
  // 3 份 × 约 100 MB 上限 = 最坏 300 MB。再多对本地工具没有意义（db.ts 同一个判断）
  keep: 3,
  intervalMs: 7 * DAY_MS,
}

export interface BackupResult {
  path: string
  bytes: number
  /** 本次清理掉的过期备份数 */
  pruned: number
}

/**
 * 备份文件名。**本地时间**而不是 UTC：用户在文件管理器里按名字找「上周三那份」，
 * 用 UTC 会让晚上 8 点之后的备份显示成第二天。
 */
export function backupFileName(now: number): string {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `market-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.db`
}

/** 只认得出名字的才算备份。用于清理与「列出已有备份」 */
export function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => BACKUP_PATTERN.test(name))
      .sort()
  } catch {
    // 目录不存在是正常情况（还没备份过）
    return []
  }
}

/** 保留最近 `keep` 份，返回删掉的份数。认不出名字的一个都不碰 */
export function pruneBackups(dir: string, keep: number, log: (m: string) => void): number {
  const names = listBackups(dir)
  if (names.length <= keep) return 0
  const doomed = names.slice(0, names.length - keep)
  let pruned = 0
  for (const name of doomed) {
    try {
      rmSync(join(dir, name), { force: true })
      pruned++
    } catch (error) {
      log(`[backup] 清理 ${name} 失败：${String(error)}`)
    }
  }
  return pruned
}

/**
 * 立刻备份一份。抛错由调用方处理 —— 手动备份要把失败原因显示给用户，
 * 自动备份则只 warn（见 `backupIfDue`）。
 */
export function backupNow(
  db: Database,
  dir: string,
  now: number,
  policy: BackupPolicy = DEFAULT_BACKUP_POLICY,
  log: (m: string) => void = () => {}
): BackupResult {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, backupFileName(now))
  // VACUUM 不能在事务里跑。目标文件已存在时 SQLite 直接报错 ——
  // 那正是想要的：同一分钟内点两次备份，不该静默覆盖上一份
  db.prepare(`VACUUM INTO ?`).run(target)
  new MetaRepo(db).setNumber(LAST_BACKUP_KEY, now)
  const pruned = pruneBackups(dir, policy.keep, log)
  const bytes = statSync(target).size
  log(`[backup] 已备份 → ${target}（${(bytes / 1024 / 1024).toFixed(1)} MB，清理 ${pruned} 份旧备份）`)
  return { path: target, bytes, pruned }
}

/**
 * 距上次备份不足 interval 就跳过。返回 null 表示本次没做。
 *
 * 挂在 tick 上（与 `pruneIfDue` 同一个位置）。**失败只 warn**：
 * 备份是保险，保险买不上不该让今天的行情停掉。
 */
export function backupIfDue(
  db: Database,
  dir: string,
  now: number,
  policy: BackupPolicy = DEFAULT_BACKUP_POLICY,
  log: (m: string) => void = () => {}
): BackupResult | null {
  const last = new MetaRepo(db).getNumber(LAST_BACKUP_KEY)
  if (last !== null && now - last < policy.intervalMs) return null
  try {
    return backupNow(db, dir, now, policy, log)
  } catch (error) {
    log(`[backup] 自动备份失败（跳过本次）：${String(error)}`)
    // 记下时刻，否则每一轮 tick 都会重试一次同样会失败的备份，把日志刷满
    new MetaRepo(db).setNumber(LAST_BACKUP_KEY, now)
    return null
  }
}
