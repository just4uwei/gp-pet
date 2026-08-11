/**
 * SQLite 驱动的最小接口。
 *
 * 为什么要这层薄壳（而不是到处直接 new Database）：
 *   1. better-sqlite3 是原生模块，必须在 Electron ABI 下重建（CLAUDE.md）。
 *      重建失败时应用应当**降级**而不是启动即崩 —— 有了这层壳才有降级的位置。
 *   2. 单元/集成测试跑在 Node（Vitest）里，Electron ABI 的 .node 在那儿加载会直接段错误。
 *      测试注入 node:sqlite 驱动，被测的是我们的 SQL 与迁移逻辑，而那正是要测的东西。
 *
 * 约定：**只用位置参数（?）**。两种驱动对命名参数的处理不同，位置参数行为完全一致。
 */

export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqlRunResult {
  changes: number
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult
  get<T = Record<string, SqlValue>>(...params: SqlValue[]): T | undefined
  all<T = Record<string, SqlValue>>(...params: SqlValue[]): T[]
}

export interface SqlDriver {
  readonly kind: 'better-sqlite3' | 'node:sqlite'
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/** better-sqlite3 与 node:sqlite 的公共形状，用于适配而不引入两套类型依赖 */
interface RawStatement {
  run(...params: unknown[]): { changes: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface RawDatabase {
  exec(sql: string): unknown
  prepare(sql: string): RawStatement
  close(): void
}

function wrap(kind: SqlDriver['kind'], db: RawDatabase): SqlDriver {
  return {
    kind,
    exec: (sql) => void db.exec(sql),
    prepare(sql) {
      const stmt = db.prepare(sql)
      return {
        run: (...params) => ({ changes: Number(stmt.run(...params).changes) }),
        get: <T>(...params: SqlValue[]) => stmt.get(...params) as T | undefined,
        all: <T>(...params: SqlValue[]) => stmt.all(...params) as T[],
      }
    },
    close: () => db.close(),
  }
}

/**
 * 生产驱动。动态 import 是刻意的：原生模块加载失败要能被 catch 到，
 * 静态 import 会在模块求值阶段就把主进程带走。
 */
export async function openBetterSqlite(file: string): Promise<SqlDriver> {
  const mod: unknown = await import('better-sqlite3')
  const ctor = ((mod as { default?: unknown }).default ?? mod) as new (path: string) => RawDatabase
  return wrap('better-sqlite3', new ctor(file))
}

/**
 * 回退与测试驱动。Node 22 内置，无原生编译，但仍标注为实验特性 ——
 * 所以它是**回退**而非默认：正式路径仍按 docs/02 §1 走 better-sqlite3。
 */
export async function openNodeSqlite(file: string): Promise<SqlDriver> {
  const { DatabaseSync } = await import('node:sqlite')
  return wrap('node:sqlite', new DatabaseSync(file) as unknown as RawDatabase)
}

export type DriverKind = SqlDriver['kind']

export async function openDriver(kind: DriverKind, file: string): Promise<SqlDriver> {
  return kind === 'node:sqlite' ? openNodeSqlite(file) : openBetterSqlite(file)
}
