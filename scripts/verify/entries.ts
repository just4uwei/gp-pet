/**
 * **建仓样本的共享载入层**：把一份回测报告的 `trades` 归组成「一次建仓」，
 * 并给每次建仓配上 `ADV_20` / `σ_20` / 当日成交额。
 *
 * 供 [`impact.ts`](./impact.ts)（M2 §5.54，平方根冲击律）与
 * [`volume-cap.ts`](./volume-cap.ts)（M2 §5.55，成交量硬上限）共用。
 *
 * ## 为什么抽出来
 *
 * 两个脚本必须落在**同一批**建仓上 —— §5.55 的产出是「按冲击排序的名单」与
 * 「按参与率排序的名单」的**重合度**，两个名单只要样本集合差一次建仓，
 * 那个重合度就不是同一个东西了。各写一份载入逻辑的症状是**两边慢慢漂移而没有人报错**。
 *
 * ## 三条口径（改这里会同时改动两节的数字，别顺手动）
 *
 * 1. **建仓 = 按 `(code, entryDate)` 归组求和 `shares`** —— 回撤减仓会把一次建仓拆成多行，
 *    逐行算等于把一次下单当成两次小单，会**低估**冲击。
 * 2. **`ADV_20` 与 `σ_20` 都取入场日之前 20 根，不含当日** —— 信号日的成交量可能被信号
 *    本身选中（量能子信号 / 带宽扩张），用当日会让参与率系统性偏低。
 *    当日口径另存 `advSameDay` 作对照（那也是聚宽 `order_volume_ratio` 的真分母，§5.55）。
 * 3. **缺输入的建仓显式计入 `missing`，不当 0**（约束 4）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sampleStdev } from '../../src/backtest/metrics'

/** 回看窗口：`ADV` 与 `σ` 都用入场日之前这么多根 */
export const LOOKBACK = 20

interface TradeRow {
  code: string
  entryDate: string
  shares: number
  entryPriceRaw: number
}

export interface Report {
  meta: { engineVersion: string; from: string; to: string; capitalPerCode: number }
  trades: TradeRow[]
}

interface Candle {
  date: string
  close: number
  closeAdj: number
  volume: number
}

export interface Entry {
  code: string
  date: string
  /** 模拟里真的下到市场上的金额（元，不复权价） */
  qSim: number
  /** 名义资金（元）—— 真实资金口径 */
  qNominal: number
  /** 入场日之前 20 根的日成交额中位数（元） */
  adv: number
  /** 当日成交额（元），对照口径 */
  advSameDay: number
  /** 入场日之前 20 根的已实现日波动 */
  sigma: number
}

export interface LoadResult {
  report: Report
  entries: Entry[]
  /** 归组后的建仓总数（分母） */
  total: number
  missing: { noFixture: number; noBar: number; shortHistory: number; zeroAdv: number; zeroSigma: number }
  missingCodes: Set<string>
}

export const median = (xs: readonly number[]): number => quantile(xs, 0.5)

export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  const a = sorted[lo]
  const b = sorted[hi]
  if (a === undefined || b === undefined) return Number.NaN
  return a + (b - a) * (idx - lo)
}

export function pct(x: number): string {
  return `${(x * 100).toFixed(4)}%`
}

export function bps(x: number): string {
  return `${(x * 10000).toFixed(2)} bp`
}

function loadCandles(historyDir: string, code: string): Candle[] | null {
  try {
    const raw = readFileSync(join(historyDir, `${code}.json`), 'utf8')
    const parsed = JSON.parse(raw) as { candles?: Candle[] }
    return parsed.candles ?? null
  } catch {
    return null
  }
}

export function loadEntries(reportPath: string, historyDir: string): LoadResult {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report
  const nominal = report.meta.capitalPerCode

  // 建仓 = 按 (code, entryDate) 分组求和 shares —— 回撤减仓会把一次建仓拆成多行
  const grouped = new Map<string, { code: string; date: string; shares: number; priceRaw: number }>()
  for (const t of report.trades) {
    const key = `${t.code}:${t.entryDate}`
    const prev = grouped.get(key)
    if (prev) prev.shares += t.shares
    else grouped.set(key, { code: t.code, date: t.entryDate, shares: t.shares, priceRaw: t.entryPriceRaw })
  }

  const candleCache = new Map<string, Candle[] | null>()
  const entries: Entry[] = []
  const missing = { noFixture: 0, noBar: 0, shortHistory: 0, zeroAdv: 0, zeroSigma: 0 }
  const missingCodes = new Set<string>()

  for (const g of grouped.values()) {
    if (!candleCache.has(g.code)) candleCache.set(g.code, loadCandles(historyDir, g.code))
    const candles = candleCache.get(g.code) ?? null
    if (!candles) {
      missing.noFixture++
      missingCodes.add(g.code)
      continue
    }
    const i = candles.findIndex((c) => c.date === g.date)
    if (i < 0) {
      missing.noBar++
      continue
    }
    if (i < LOOKBACK + 1) {
      missing.shortHistory++
      continue
    }

    const window = candles.slice(i - LOOKBACK, i) // 入场日之前 20 根，不含当日
    const amounts = window.map((c) => c.volume * c.close).filter((a) => a > 0)
    if (amounts.length < LOOKBACK) {
      missing.zeroAdv++
      continue
    }
    const rets: number[] = []
    for (let k = i - LOOKBACK; k < i; k++) {
      const prev = candles[k - 1]
      const cur = candles[k]
      if (!prev || !cur || prev.closeAdj <= 0 || cur.closeAdj <= 0) continue
      rets.push(Math.log(cur.closeAdj / prev.closeAdj))
    }
    const sigma = rets.length >= LOOKBACK - 1 ? sampleStdev(rets) : Number.NaN
    if (!Number.isFinite(sigma) || sigma <= 0) {
      missing.zeroSigma++
      continue
    }
    const sameDay = candles[i]
    entries.push({
      code: g.code,
      date: g.date,
      qSim: g.shares * g.priceRaw,
      qNominal: nominal,
      adv: median(amounts),
      advSameDay: sameDay ? sameDay.volume * sameDay.close : Number.NaN,
      sigma,
    })
  }

  return { report, entries, total: grouped.size, missing, missingCodes }
}
