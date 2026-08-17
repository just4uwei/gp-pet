/**
 * 回测的取数：从应用数据库（`market.db`）或 JSON fixture 读日线。
 *
 * 两条实现说明：
 *
 * 1. **相对路径 import，不用 `@core/*` 别名。** CLI 由 tsx 直接跑
 *    （`pnpm backtest`），而根 tsconfig.json 是 solution 风格、不带 paths，
 *    tsx 解析不到别名。别名只在 electron-vite 与 vitest 里生效。
 *
 * 2. **自己开 SQLite，不复用 `src/main/storage`。** 按 CLAUDE.md 的分层，
 *    `src/backtest` 只复用 `src/core`。这里只读一张表、不跑迁移，
 *    十几行驱动壳换来的是「回测不依赖主进程装配」。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isSTName, normalizeCode, splitCode } from '../core/code'
import type { Candle, SecCode, SecProfile, TradeDate } from '../core/types'

export interface LoadedSeries {
  profile: SecProfile
  candles: Candle[]
}

export interface DataSource {
  readonly description: string
  load(code: SecCode): LoadedSeries | null
  close(): void
}

/**
 * 代码 → 缺省的 SecProfile。
 *
 * 板块由代码段推出（涨跌停比例只依赖它）；名称与 ST 标记数据源不一定有，
 * 缺时按「非 ST」处理，并在报告里注明 —— ST 降级规则因此在回测中偏乐观，
 * 这个偏差要写在报告里而不是藏起来。
 */
export function fallbackProfile(code: SecCode, name?: string): SecProfile {
  const parsed = splitCode(code)
  const label = name ?? code
  const profile: SecProfile = {
    code,
    name: label,
    market: parsed?.market ?? 'SH',
    board: parsed?.board ?? 'MAIN',
    isST: isSTName(label),
  }
  return profile
}

interface KlineRow {
  trade_date: string
  open: number
  high: number
  low: number
  close: number
  open_adj: number
  high_adj: number
  low_adj: number
  close_adj: number
  volume: number
  amount: number | null
  has_gap: number
}

interface MinimalStatement {
  all(...params: unknown[]): unknown[]
}

interface MinimalDatabase {
  prepare(sql: string): MinimalStatement
  close(): void
}

/** better-sqlite3 优先，失败退到 node:sqlite（与 src/main/storage/driver.ts 同样的取舍） */
async function openReadOnly(file: string): Promise<MinimalDatabase> {
  try {
    const mod: unknown = await import('better-sqlite3')
    const ctor = ((mod as { default?: unknown }).default ?? mod) as new (
      path: string,
      options?: { readonly?: boolean }
    ) => MinimalDatabase
    return new ctor(file, { readonly: true })
  } catch {
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(file, { readOnly: true }) as unknown as MinimalDatabase
  }
}

export async function openSqliteSource(
  file: string,
  range: { from: TradeDate; to: TradeDate }
): Promise<DataSource> {
  if (!existsSync(file)) throw new Error(`数据库不存在：${file}`)
  const db = await openReadOnly(file)

  const klines = db.prepare(
    `SELECT trade_date, open, high, low, close, open_adj, high_adj, low_adj, close_adj,
            volume, amount, has_gap
       FROM kline_daily
      WHERE code = ? AND trade_date >= ? AND trade_date <= ?
      ORDER BY trade_date ASC`
  )
  const names = db.prepare(`SELECT name FROM watchlist WHERE code = ?`)

  return {
    description: `sqlite:${file}`,
    load(code) {
      const rows = klines.all(code, range.from, range.to) as KlineRow[]
      if (rows.length === 0) return null
      const nameRow = (names.all(code) as { name?: string }[])[0]
      return {
        profile: fallbackProfile(code, nameRow?.name),
        candles: rows.map(toCandle),
      }
    },
    close: () => db.close(),
  }
}

function toCandle(row: KlineRow): Candle {
  const candle: Candle = {
    date: row.trade_date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    openAdj: row.open_adj,
    highAdj: row.high_adj,
    lowAdj: row.low_adj,
    closeAdj: row.close_adj,
    volume: row.volume,
    amount: row.amount,
  }
  if (row.has_gap === 1) candle.hasGap = true
  return candle
}

/**
 * JSON fixture 源：`<dir>/<CODE>.json`，内容是 `Candle[]` 或
 * `{ profile?, candles }`。测试与「无网络环境下验证回测本身」都走这条路。
 */
export function openFixtureSource(
  dir: string,
  range: { from: TradeDate; to: TradeDate }
): DataSource {
  return {
    description: `fixtures:${dir}`,
    load(code) {
      const file = join(dir, `${code}.json`)
      if (!existsSync(file)) return null
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const raw = Array.isArray(parsed)
        ? { candles: parsed as Candle[] }
        : (parsed as { profile?: SecProfile; candles: Candle[] })
      const candles = raw.candles.filter((c) => c.date >= range.from && c.date <= range.to)
      if (candles.length === 0) return null
      return { profile: raw.profile ?? fallbackProfile(code), candles }
    },
    close: () => {},
  }
}

/**
 * 读退市清单 → `code → 退市日`（`params/universe-delisted.json` 的形状）。
 *
 * 给 `simulateCode` 的 `delistedAt` 用：名单内的标的在退市日收盘强制平仓并记一笔 `trade`。
 *
 * **空表和「没给文件」是两回事。** 没传 `--delisted` 是「这次不管退市」，
 * 而传了一个解析出来是空的文件，几乎总是路径写错或字段名写错 —— 静默当成前者，
 * 会让一次「以为修了幸存者偏差」的回测悄悄跑成没修的版本，**而报告上完全看不出来**
 * （建仓数、胜率、收益全都若无其事）。所以后者直接抛错。
 *
 * 住在这里而不是 cli.ts：`cli.ts` 的文件头写着「只接线与打印，判断逻辑都在
 * simulate/report/calibrate —— 那些有测试，这里没有」，而「空表要抛错」是判断。
 */
export function loadDelistedMap(file: string): Map<SecCode, TradeDate> {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    delistedAt?: Record<string, string>
  }
  const map = new Map<SecCode, TradeDate>()
  for (const [code, date] of Object.entries(parsed.delistedAt ?? {})) {
    map.set(normalizeCode(code), date)
  }
  if (map.size === 0) {
    throw new Error(
      `${file} 里没有可用的 delistedAt —— 形状应为 { "delistedAt": { "SH600000": "2020-01-01" } }`
    )
  }
  return map
}

/**
 * 大盘情绪序列：`out[i]` = 截至第 i 根的情绪值 0..1（docs/04 §1.6）。
 *
 * 与 `core/indicators/thresholds.ts` 的 `marketSentiment` 必须给出同一个值 ——
 * 后者只算「当期」，回测要逐根都有，于是在这里用滚动分位一次算出整条。
 * 两者一致性由 tests/unit/backtest 断言：一旦分叉，
 * 回测用的 RSI 阈值曲线就和实盘的不是同一条。
 */
export function sentimentSeries(
  benchmarkCloses: readonly number[],
  window = 20,
  lookback = 250
): (number | null)[] {
  const returns: (number | null)[] = new Array<number | null>(benchmarkCloses.length).fill(null)
  for (let i = window; i < benchmarkCloses.length; i++) {
    const now = benchmarkCloses[i]
    const before = benchmarkCloses[i - window]
    if (now === undefined || before === undefined || before <= 0) continue
    returns[i] = now / before - 1
  }
  // rollingPercentile 要求窗口内无 null，而预热期正好是 null —— 于是把有效段单独拿出来算
  const firstValid = returns.findIndex((r) => r !== null)
  if (firstValid < 0) return returns.map(() => null)
  const dense = returns.slice(firstValid) as (number | null)[]
  const out: (number | null)[] = new Array<number | null>(benchmarkCloses.length).fill(null)

  for (let k = 0; k < dense.length; k++) {
    const value = dense[k]
    if (value === null || value === undefined) continue
    // 样本不足 lookback 时用已有的全部样本，与 marketSentiment 的行为一致
    const start = Math.max(0, k - lookback + 1)
    let leq = 0
    let total = 0
    for (let j = start; j <= k; j++) {
      const sample = dense[j]
      if (sample === null || sample === undefined) continue
      total++
      if (sample <= value) leq++
    }
    out[firstValid + k] = total === 0 ? 0.5 : leq / total
  }
  return out
}
