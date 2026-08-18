#!/usr/bin/env node
/**
 * 横截面存不存在：**同一个判定日，有几只票同时给出买入方向信号**。
 *
 * ```bash
 * pnpm audit:crosssec -- --codes "$(cat reports/calib/_codes261.txt)" \
 *   --fixtures ./data/history --from 2018-01-01 --to 2026-06-30 \
 *   --baseline reports/calib/t3fix.json --out reports/calib/crosssec-261.json
 * ```
 *
 * ## 为什么需要它（它在补一个「测错了量」的洞）
 *
 * [§3.11](../../docs/notes/下一阶段取舍与迭代计划.md) 的 S0 预注册的量是
 * 「同一天同时有 ≥2 只票出现**买入方向信号**」。2026-08-18 第一次实测走了近路 ——
 * 用回测报告里的**建仓**（`code@entryDate`）当代理，得到「401 天 / 中位 1 / 74.3% 的建仓有同日同伴」
 * （M2 §5.33）。那份计数是**下界**：被硬抑制的、开盘涨停买不到的、单笔名义金额买不起一手的
 * 信号全都不在里面，而它们**照样是横截面上的候选**（提醒层看得见它们）。
 *
 * 于是判据（写在看数据之前）与被测量的量对不上号。本工具测的是**预注册的那个量本身**，
 * 判据一个字不改。
 *
 * ## 与 `audit:regime` / `audit:subsignals` 同一个立场：**只统计，不改参数**
 *
 * 不写回、不推荐、不打分。产出是一张按日期的计数表 + 一份可后处理的 JSON。
 *
 * ## 三条口径纪律
 *
 * 1. **判定根集合与 `simulate.ts` 逐条对齐**：`i >= warmup`、`i < len - 1`（最后一根不判：
 *    没有下一根可成交）、`hasGap` 那根跳过。差一条，占比就与回测报告对不上号。
 * 2. **不带持仓评估（`position` 恒为 undefined）**，这是刻意的。问题是「引擎今天对这只票
 *    说了什么」，不是「模拟组合当时恰好持不持有」—— 持仓会让风控产出 `SELL`/`REDUCE`
 *    并把 `BUY` 压掉，那是**组合状态**不是信号。后果要说清：本工具的买入数是回测建仓数的
 *    **超集**，`--baseline` 的自检就建在这条上。
 * 3. **硬抑制分开数**。提醒层的候选里没有被硬抑制的那些（风控判它无执行意义），
 *    所以主判据只数未抑制的；但被抑制的数也要打印出来当上界 ——
 *    「这一天到底有多少只票被引擎点到过名」是另一个问题，不能与主判据混成一个数。
 *
 * ⚠ **收盘轮的买入方向是 `NEXT_DAY_WATCH`，不是 `BUY`**（`T1_LATE_BUY` 在算术上必然改写，
 * CLAUDE.md 那条）。所以「买入方向」= `BUY` ∪ `NEXT_DAY_WATCH`。只认 `BUY` 会数出 0 条。
 *
 * ## 自检（`--baseline`）
 *
 * 给一份同参数同池同窗口的回测报告，本工具会断言
 * **买入方向信号数 ≥ 该报告的建仓数**（`code@entryDate` 去重后）。
 * 每一次建仓都必须来自一条买入信号，而信号还额外包含买不到/买不起/被抑制的那些 ⇒
 * 超集关系是硬的。**不成立就抛错退出**，不是打个 warning ——
 * 那说明本工具的判定根集合或方向口径已经与回测漂移，报告不可信。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode } from '../core/code'
import { CONTINUOUS_MINUTES } from '../core/session'
import { evaluate } from '../core/engine'
import { aggregateWeekly } from '../core/indicators/weekly'
import {
  DEFAULT_PARAMS,
  engineVersionOf,
  withParams,
  type EngineParams,
  type ParamOverrides,
} from '../core/params'
import type { EngineContext, GatedDirection, SecCode, TradeDate } from '../core/types'
import { USAGE, parseArgs, type CliOptions } from './args'
import { openFixtureSource, openSqliteSource, sentimentSeries, type LoadedSeries } from './data'

/** 收盘轮的买入方向。`T1_LATE_BUY` 会把 `BUY` 改写成 `NEXT_DAY_WATCH`，两个都要认 */
const BUY_DIRECTIONS: readonly GatedDirection[] = ['BUY', 'NEXT_DAY_WATCH']

interface DayEntry {
  /** 当日给出买入方向且**未被硬抑制**的标的 */
  signaled: SecCode[]
  /** 当日给出买入方向但**被硬抑制**的标的（上界用，不进主判据） */
  suppressed: SecCode[]
}

export interface CrossSecTally {
  /** 跑过 evaluate() 的判定根数（与 simulate.ts 的 `evaluations` 同口径） */
  judged: number
  /** 数据不足、策略层没跑的根数 */
  unusable: number
  /** date → 当日情况 */
  byDate: Map<TradeDate, DayEntry>
}

function emptyTally(): CrossSecTally {
  return { judged: 0, unusable: 0, byDate: new Map() }
}

function dayOf(tally: CrossSecTally, date: TradeDate): DayEntry {
  const entry = tally.byDate.get(date) ?? { signaled: [], suppressed: [] }
  tally.byDate.set(date, entry)
  return entry
}

export function auditSeries(
  series: LoadedSeries,
  params: EngineParams,
  options: CliOptions,
  sentimentAt: (date: TradeDate) => number,
  tally: CrossSecTally
): void {
  const candles = series.candles
  const warmup = options.warmup ?? params.data.fullBars

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue
    // 判定根集合与 simulate.ts 逐条对齐（纪律 1）
    if (i < warmup || i >= candles.length - 1) continue
    if (bar.hasGap === true) continue

    const from = Math.max(0, i - options.lookback + 1)
    const window = candles.slice(from, i + 1)
    const ctx: EngineContext = {
      profile: series.profile,
      candles: window,
      weekly: aggregateWeekly(window),
      marketSentiment: sentimentAt(bar.date),
      // 收盘确认口径，与 simulate.ts 逐字相同
      now: { date: bar.date, minutesSinceOpen: CONTINUOUS_MINUTES, session: 'SETTLE' },
      // **不传 position**（纪律 2）
    }
    const evaluation = evaluate(ctx, params)
    if (!evaluation) continue

    tally.judged++
    if (!evaluation.sufficiency.usable) {
      tally.unusable++
      continue
    }

    const gated = evaluation.gated
    if (!BUY_DIRECTIONS.includes(gated.direction)) continue
    const entry = dayOf(tally, bar.date)
    if (gated.suppressed) entry.suppressed.push(series.profile.code)
    else entry.signaled.push(series.profile.code)
  }
}

interface Shape {
  days: number
  multiDays: number
  signals: number
  onMultiDays: number
  median: number
  mean: number
  max: number
  hist: Map<string, number>
}

/** 一组「日期 → 只数」的形状统计。空集时全 0（不编造中位数） */
export function shapeOf(counts: readonly number[]): Shape {
  const sorted = [...counts].sort((a, b) => a - b)
  const days = sorted.length
  const signals = sorted.reduce((s, n) => s + n, 0)
  const hist = new Map<string, number>()
  for (const n of sorted) {
    const key = n >= 5 ? '5+' : String(n)
    hist.set(key, (hist.get(key) ?? 0) + 1)
  }
  return {
    days,
    multiDays: sorted.filter((n) => n >= 2).length,
    signals,
    onMultiDays: sorted.filter((n) => n >= 2).reduce((s, n) => s + n, 0),
    median: days === 0 ? 0 : (sorted[Math.floor(days / 2)] ?? 0),
    mean: days === 0 ? 0 : signals / days,
    max: days === 0 ? 0 : (sorted[days - 1] ?? 0),
    hist,
  }
}

/** 报告里的建仓数（`code@entryDate` 去重，与 metrics.ts 的 `groupPositions()` 同一个 key） */
export function positionsInReport(path: string): number {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const trades = (parsed as { trades?: { code: string; entryDate: string }[] }).trades ?? []
  return new Set(trades.map((t) => `${t.code}@${t.entryDate}`)).size
}

/**
 * 从 argv 里摘掉一个「键 值」对并返回它的值。
 *
 * 共享的 `parseArgs()` 不认识 `--baseline`（它是本工具独有的自检入口），
 * 而遇到不认识的键会抛错。先摘掉再交给它，比另写一套 parser 便宜得多
 * —— `random-audit.ts` 走的是另写一套那条路，那里还有十几个独有选项，本工具只有一个。
 */
export function takeOption(argv: readonly string[], key: string): { value?: string; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === key) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${key} 缺少取值`)
      value = next
      i++
      continue
    }
    rest.push(argv[i] as string)
  }
  return value === undefined ? { rest } : { value, rest }
}

function resolveParams(options: CliOptions): EngineParams {
  if (!options.params) return DEFAULT_PARAMS
  const parsed: unknown = JSON.parse(readFileSync(options.params, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`--params 文件不是 JSON 对象：${options.params}`)
  }
  return withParams(parsed as ParamOverrides, DEFAULT_PARAMS)
}

function defaultDbPath(): string {
  const appData =
    process.env['APPDATA'] ??
    (process.env['HOME'] !== undefined ? join(process.env['HOME'], '.config') : process.cwd())
  return join(appData, 'gp-pet', 'market.db')
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '  —  ' : `${((part / whole) * 100).toFixed(1)}%`
}

function render(tally: CrossSecTally, params: EngineParams, codes: number, baseline: number | null): string {
  const dates = [...tally.byDate.keys()].sort()
  const counts = dates.map((d) => tally.byDate.get(d)?.signaled.length ?? 0).filter((n) => n > 0)
  const shape = shapeOf(counts)
  const suppressed = [...tally.byDate.values()].reduce((s, e) => s + e.suppressed.length, 0)

  const lines: string[] = []
  const rule = '─'.repeat(74)
  lines.push(rule)
  lines.push(`横截面审计（只统计，不改参数）· 引擎 ${engineVersionOf(params)} · ${codes} 只`)
  lines.push(rule)
  lines.push(`判定根 ${tally.judged}（其中数据不足 ${tally.unusable}）`)
  lines.push(`买入方向信号（未被硬抑制）${shape.signals} 条 · 被硬抑制 ${suppressed} 条（上界用，不进主判据）`)
  if (baseline !== null) {
    lines.push(`自检：回测建仓 ${baseline} 次 ≤ 买入信号 ${shape.signals} 条 ✓（信号是建仓的超集）`)
  }
  lines.push('')
  lines.push('【预注册的那个量】同一判定日有几只票同时给出买入方向信号')
  lines.push(`  有买入信号的交易日      ${shape.days}`)
  lines.push(`  其中「同日 ≥2 只」      ${shape.multiDays}  = 有信号日的 ${pct(shape.multiDays, shape.days)}`)
  lines.push(`  每个有信号日的只数      中位数 ${shape.median} · 均值 ${shape.mean.toFixed(2)} · 最大 ${shape.max}`)
  lines.push(
    `  落在「同日 ≥2 只」的信号 ${shape.onMultiDays} / ${shape.signals} = ${pct(shape.onMultiDays, shape.signals)}`
  )
  lines.push('')
  lines.push('【每日只数分布】')
  for (const key of ['1', '2', '3', '4', '5+']) {
    const n = shape.hist.get(key) ?? 0
    lines.push(`  ${key.padStart(2)} 只: ${String(n).padStart(4)} 天  ${'█'.repeat(Math.round((n / Math.max(1, shape.days)) * 56))}`)
  }
  lines.push('')
  lines.push('【按自然年】（四切法要的时间子集从 --out 的 JSON 里后处理，不必重跑）')
  lines.push('  年     有信号日  ≥2 只   占比   信号数  其中在多信号日')
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))].sort()
  for (const year of years) {
    const yearCounts = dates
      .filter((d) => d.startsWith(year))
      .map((d) => tally.byDate.get(d)?.signaled.length ?? 0)
      .filter((n) => n > 0)
    const s = shapeOf(yearCounts)
    lines.push(
      `  ${year}   ${String(s.days).padStart(6)}  ${String(s.multiDays).padStart(6)}  ${pct(s.multiDays, s.days).padStart(6)}  ${String(s.signals).padStart(6)}  ${pct(s.onMultiDays, s.signals).padStart(8)}`
    )
  }
  lines.push(rule)
  lines.push('注：判定根集合与 simulate.ts 对齐；**不带持仓评估**，所以这里的买入数是回测建仓数的超集。')
  lines.push(rule)
  return `${lines.join('\n')}\n`
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions | 'help'
  let baselinePath: string | undefined
  try {
    const taken = takeOption(argv, '--baseline')
    baselinePath = taken.value
    options = parseArgs(taken.rest)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 1
  }
  if (options === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  const range = { from: options.from, to: options.to }
  const params = resolveParams(options)
  const source = options.fixtures
    ? openFixtureSource(options.fixtures, range)
    : await openSqliteSource(options.db ?? defaultDbPath(), range)

  try {
    const benchmark = options.benchmark ? source.load(normalizeCode(options.benchmark)) : null
    const sentimentByDate = new Map<TradeDate, number>()
    if (benchmark) {
      const series = sentimentSeries(benchmark.candles.map((c) => c.closeAdj))
      let last = 0.5
      benchmark.candles.forEach((candle, i) => {
        const value = series[i]
        if (value !== null && value !== undefined) last = value
        sentimentByDate.set(candle.date, last)
      })
    }
    const sentimentAt = (date: TradeDate): number => sentimentByDate.get(date) ?? 0.5

    const tally = emptyTally()
    let audited = 0
    for (const raw of options.codes) {
      const code = normalizeCode(raw)
      const loaded = source.load(code)
      if (!loaded) {
        if (!options.quiet && !options.json) process.stdout.write(`[warn] ${code} 无日线，已跳过\n`)
        continue
      }
      auditSeries(loaded, params, options, sentimentAt, tally)
      audited++
      if (!options.quiet && !options.json && audited % 20 === 0) {
        process.stdout.write(`[audit] ${audited} 只，累计判定根 ${tally.judged}\n`)
      }
    }
    if (audited === 0) throw new Error('没有任何标的有可用日线')

    const signals = [...tally.byDate.values()].reduce((s, e) => s + e.signaled.length, 0)
    let baseline: number | null = null
    if (baselinePath !== undefined) {
      baseline = positionsInReport(baselinePath)
      // 自检：每一次建仓都必须来自一条买入信号，而信号还多含买不到/买不起/被抑制的那些
      if (signals < baseline) {
        throw new Error(
          `自检失败：买入信号 ${signals} 条 < 回测建仓 ${baseline} 次。` +
            '信号必须是建仓的超集，不成立说明判定根集合或方向口径已与 simulate.ts 漂移，先修工具再看结论。'
        )
      }
    }

    const payload = {
      engineVersion: engineVersionOf(params),
      codes: audited,
      judged: tally.judged,
      unusable: tally.unusable,
      baselinePositions: baseline,
      byDate: Object.fromEntries(
        [...tally.byDate.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, entry]) => [date, { signaled: entry.signaled, suppressed: entry.suppressed }])
      ),
    }

    if (options.out !== undefined) {
      mkdirSync(dirname(options.out), { recursive: true })
      writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    }
    if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`)
    else process.stdout.write(render(tally, params, audited, baseline))
    return 0
  } finally {
    await source.close?.()
  }
}

const invokedDirectly = process.argv[1]?.endsWith('crosssec-audit.ts') === true
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
