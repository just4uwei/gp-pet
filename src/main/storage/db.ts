/**
 * 数据库打开、迁移与备份（docs/03 §4）。
 *
 * 顺序有讲究：
 *   1. 先用目标驱动打开一次，只为读 meta.schema_version
 *   2. 有待执行的迁移且库非空 → **关掉连接**再复制文件做备份（WAL 下不能边写边拷）
 *   3. 重新打开 → 逐条迁移 → 写回 schema_version
 *
 * 备份只保留最近 1 份（docs/03 §4.4）：多留几份对本地工具没有意义，磨掉的是磁盘。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'
import { openDriver, type DriverKind, type SqlDriver } from './driver'

const SCHEMA_VERSION_KEY = 'schema_version'
const BACKUP_PREFIX = 'market.db.bak-'

export interface OpenDatabaseOptions {
  file: string
  /** 默认 better-sqlite3；测试与原生模块加载失败时用 node:sqlite */
  driver?: DriverKind
  /** 迁移前是否备份。内存库与测试可关掉 */
  backup?: boolean
  log?: (message: string) => void
}

export interface Database {
  readonly driver: SqlDriver
  readonly schemaVersion: number
  exec(sql: string): void
  prepare: SqlDriver['prepare']
  /**
   * BEGIN/COMMIT/ROLLBACK 包裹。两种驱动都没有可移植的 transaction() API，所以自己来。
   *
   * **可重入**：嵌套调用直接并入外层事务，不再发一次 BEGIN。
   * SQLite 不支持嵌套 BEGIN（`cannot start a transaction within a transaction`），
   * 而仓储方法自带事务是常态（如 `WatchlistRepo.reorder`）—— 上层想把几个仓储调用
   * 凑成一个原子操作时，不该被「这个方法里面有没有事务」绊倒。
   * 内层抛错仍会一路冒到最外层并整体 ROLLBACK。
   */
  transaction<T>(fn: () => T): T
  close(): void
}

function readSchemaVersion(driver: SqlDriver): number {
  const table = driver
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get<{ name: string }>()
  if (!table) return 0
  const row = driver.prepare(`SELECT value FROM meta WHERE key = ?`).get<{ value: string }>(SCHEMA_VERSION_KEY)
  const parsed = Number(row?.value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 只保留最近 1 份备份 */
function backupDatabase(file: string, version: number, log: (m: string) => void): void {
  const dir = dirname(file)
  const target = join(dir, `${BACKUP_PREFIX}${version}`)
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(BACKUP_PREFIX)) rmSync(join(dir, entry), { force: true })
    }
    copyFileSync(file, target)
    log(`[db] 迁移前已备份 → ${target}`)
  } catch (error) {
    // 备份失败不阻断迁移：库还在，迁移本身是幂等的顺序脚本。但必须留痕（docs/02 §7）
    log(`[db] 备份失败（继续迁移）：${String(error)}`)
  }
}

function applyMigrations(driver: SqlDriver, from: number, log: (m: string) => void): number {
  let version = from
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue
    driver.exec('BEGIN')
    try {
      driver.exec(migration.sql)
      driver.exec(
        `INSERT INTO meta(key, value) VALUES ('${SCHEMA_VERSION_KEY}', '${migration.version}')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      driver.exec('COMMIT')
    } catch (error) {
      driver.exec('ROLLBACK')
      throw new Error(`迁移 ${migration.name} 失败：${String(error)}`, { cause: error })
    }
    version = migration.version
    log(`[db] 迁移完成 → v${migration.version}（${migration.name}）`)
  }
  return version
}

function applyPragmas(driver: SqlDriver): void {
  // WAL：主进程读写与后台裁剪并发时不互相阻塞
  driver.exec('PRAGMA journal_mode = WAL')
  driver.exec('PRAGMA synchronous = NORMAL')
  driver.exec('PRAGMA foreign_keys = ON')
  // 5s 忙等：裁剪/vacuum 与 tick 撞上时排队而不是直接抛 SQLITE_BUSY
  driver.exec('PRAGMA busy_timeout = 5000')
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  const { file } = options
  const log = options.log ?? ((): void => {})
  const kind: DriverKind = options.driver ?? 'better-sqlite3'
  const isFile = file !== ':memory:'

  // 「库里有没有东西」必须在打开**之前**判定：一旦打开，WAL 头就会把空文件写成非空，
  // 于是每次全新安装都会白白备份一份空库
  const hadData = isFile && existsSync(file) && statSync(file).size > 0

  if (isFile) mkdirSync(dirname(file), { recursive: true })

  let driver = await openDriver(kind, file)
  applyPragmas(driver)
  let version = readSchemaVersion(driver)

  if (version > LATEST_SCHEMA_VERSION) {
    // 用旧版软件打开新版库：继续用会写坏数据，直说并让上层决定
    driver.close()
    throw new Error(`数据库 schema v${version} 高于本版支持的 v${LATEST_SCHEMA_VERSION}，请升级应用`)
  }

  if (version < LATEST_SCHEMA_VERSION) {
    if ((options.backup ?? true) && hadData) {
      // WAL 下不能边写边拷：先关连接，拷完再开
      driver.close()
      backupDatabase(file, version, log)
      driver = await openDriver(kind, file)
      applyPragmas(driver)
    }
    try {
      version = applyMigrations(driver, version, log)
    } catch (error) {
      // 迁移失败必须关掉连接再抛：否则文件句柄悬着，用户连「删库重来」都做不到
      driver.close()
      throw error
    }
  }

  const active = driver
  // 嵌套深度。>0 时内层只跑函数体，BEGIN/COMMIT 归最外层那一次
  let depth = 0
  return {
    driver: active,
    schemaVersion: version,
    exec: (sql) => active.exec(sql),
    prepare: (sql) => active.prepare(sql),
    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        depth += 1
        try {
          return fn()
        } finally {
          depth -= 1
        }
      }
      active.exec('BEGIN')
      depth = 1
      try {
        const result = fn()
        active.exec('COMMIT')
        return result
      } catch (error) {
        active.exec('ROLLBACK')
        throw error
      } finally {
        depth = 0
      }
    },
    close: () => active.close(),
  }
}

/**
 * 生产路径：先试 better-sqlite3，原生模块加载失败则退到 node:sqlite。
 *
 * 为什么要这条回退：better-sqlite3 的 .node 必须匹配 Electron ABI，
 * 而这一步发生在用户机器之外（CI 打包时 electron-rebuild）。一旦漏做，
 * 没有回退就是「双击图标毫无反应」；有回退则是「能用 + 日志里一条刺眼的警告」。
 */
export async function openMarketDatabase(
  file: string,
  log: (message: string) => void
): Promise<Database> {
  try {
    return await openDatabase({ file, driver: 'better-sqlite3', log })
  } catch (error) {
    log(`[db] better-sqlite3 不可用（${String(error)}），回退 node:sqlite —— 请检查 electron-rebuild`)
    return openDatabase({ file, driver: 'node:sqlite', log })
  }
}
