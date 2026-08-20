#!/usr/bin/env node
/**
 * **rank IC**：组合得分对未来收益有没有**横截面排序能力**（M2 §5.46 的预注册）。
 *
 * ```bash
 * pnpm audit:ic -- --codes "$(cat reports/calib/_codes252.txt)" \
 *   --fixtures ./data/history --from 2018-01-01 --to 2026-06-30 \
 *   --out reports/calib/ic-261.json
 * ```
 *
 * ## 它为什么存在：一个**不需要零分布**的第二判据
 *
 * [§5.43](../../docs/notes/M2-偏差报告.md) 量出配对胜率的绝对水平有 **20–30pp** 的口径自由度
 * （零点定义），[§5.45](../../docs/notes/M2-偏差报告.md) 又量出它在加权/中位两个口径间能差 **28pp**。
 * ⇒ 我们唯一可信的判据自己有两个控制不住的自由度。
 *
 * rank IC 的性质恰好补这个洞：它是**描述性统计**（逐日横截面的 Spearman 秩相关），
 * **不构造零分布、不做配对、不做随机化** ⇒ 那两个自由度都不适用于它。
 *
 * ## 四条口径纪律
 *
 * 1. **判定根集合与 `simulate.ts` / `crosssec-audit.ts` 逐条对齐**：`i >= warmup`、
 *    `i < len - 1`、`hasGap` 那根跳过。差一条，占比就与既有报告对不上号。
 * 2. **得分取 `combine.breakdown.BUY.final`，每个判定根都取，不管有没有触发。**
 *    只取触发的那些会把样本条件在「引擎出手了」上 —— 那是 §5.45 问的问题，不是这里的。
 *    （§5.46 的修正 1：原预注册写「只取买入方向」，而 §5.33 实测同日买入信号中位数只有 1 只
 *    ⇒ 逐日横截面根本凑不出来。改在动手前、看结果前。）
 * 3. **前瞻收益是收盘到收盘**（`closeAdj[i+h]/closeAdj[i] − 1`），不模拟次日开盘成交、不扣成本。
 *    IC 问的是排序能力，不是可实现收益；把成交与成本混进来会让它变成一个小号回测。
 * 4. **并列必须报出来。** 大量判定根的买入得分是 0（一个子信号都没触发），Spearman 在并列上
 *    取平均秩 ⇒ IC 会被并列稀释。所以两档都给：**全体**与**得分 > 0 的子集**，
 *    并打印并列比例。两档在预注册里写死，不是看到结果再挑。
 *
 * ## 它**不**回答什么
 *
 * IC 测的是得分的排序能力，**不是「这套系统赚不赚钱」**。IC ≈ 0 不否定风控层的价值
 * （回撤 2.96% vs 基准 45%+），也不否定 ETF 那条前向记录；反过来 IC 好也不等于能赚钱
 * （还要过成本）。**只回答排序能力那一个问题。**
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode } from '../core/code'
import { evaluate } from '../core/engine'
import { aggregateWeekly } from '../core/indicators/weekly'
import {
  DEFAULT_PARAMS,
  engineVersionOf,
  paramsFingerprint,
  withParams,
  type EngineParams,
  type ParamOverrides,
} from '../core/params'
import { CONTINUOUS_MINUTES } from '../core/session'
import type { EngineContext, SecCode, TradeDate } from '../core/types'
import { USAGE, parseArgs, type CliOptions } from './args'
import { openFixtureSource, openSqliteSource, sentimentSeries, type LoadedSeries } from './data'

/** 与 cli.ts / crosssec-audit.ts 同一份实现（那两处也各有一份，改动要一起改） */
function defaultDbPath(): string {
  const appData =
    process.env['APPDATA'] ??
    (process.env['HOME'] !== undefined ? join(process.env['HOME'], '.config') : process.cwd())
  return join(appData, 'gp-pet', 'market.db')
}

function resolveParams(options: CliOptions): EngineParams {
  if (!options.params) return DEFAULT_PARAMS
  const parsed: unknown = JSON.parse(readFileSync(options.params, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`--params 文件不是 JSON 对象：${options.params}`)
  }
  return withParams(parsed as ParamOverrides, DEFAULT_PARAMS)
}

/**
 * 只把这个日期之后的判定根计入横截面（`--eval-from`）。指标与预热照常用更早的数据。
 *
 * **为什么必须有它**：300 根预热会把短窗口吃光 —— 实测直接 `--from 2024-01-01` 跑验证窗口
 * 只剩 **54** 个有效交易日，测试窗口（2025H2 起）剩 **0** 个。
 * 这与 CLAUDE.md 那条「跑验证窗口必须带段前历史」是同一个坑，只是换了个工具。
 */
function evalFromOf(argv: readonly string[]): string | null {
  const i = argv.indexOf('--eval-from')
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

/** 预注册写死的三个持有期（交易日）。它们不是三次尝试，是同一问题的三个时间尺度 */
const HORIZONS = [5, 10, 20] as const

/** 逐日横截面至少要这么多个有效标的才算一天 —— 少于它的日子 IC 没有意义 */
const MIN_CROSS_SECTION = 10

interface Row {
  code: SecCode
  score: number
  /** 持有期 → 前瞻收益；数据不够时缺项 */
  fwd: Map<number, number>
}

export interface IcResult {
  /** 有效交易日数（该持有期上横截面 ≥ MIN_CROSS_SECTION 的天数） */
  days: number
  meanIc: number
  sdIc: number
  /** `mean / (sd / √days)`。样本不足或零方差时 null，不用 0 冒充 */
  t: number | null
  /** 五等分（按当日得分排名）各组前瞻收益的**中位数** */
  quintileMedians: (number | null)[]
}

/** 平均秩（并列取平均）—— Spearman 的前置 */
export function ranksOf(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1]?.v === order[i]?.v) j++
    // [i..j] 是一段并列 ⇒ 全部取这段的平均秩
    const avg = (i + j) / 2
    for (let k = i; k <= j; k++) {
      const idx = order[k]?.i
      if (idx !== undefined) ranks[idx] = avg
    }
    i = j + 1
  }
  return ranks
}

/** 皮尔逊相关（作用在秩上就是 Spearman）。零方差时 null —— 并列到底会走这条 */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - ma
    const db = (b[i] ?? 0) - mb
    sab += da * db
    saa += da * da
    sbb += db * db
  }
  if (saa <= 0 || sbb <= 0) return null
  return sab / Math.sqrt(saa * sbb)
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

/**
 * 一个持有期上的 IC 与分位单调性。
 *
 * 分位组按**当日**得分排名切（不是全样本），与 §5.45 同一条理由：绝对得分随市况漂移，
 * 拿全样本分位会把不同年份的日子排到一起。
 */
export function icOf(byDate: Map<TradeDate, Row[]>, horizon: number): IcResult {
  const ics: number[] = []
  const quintiles: number[][] = [[], [], [], [], []]
  for (const rows of byDate.values()) {
    const usable = rows.filter((r) => r.fwd.has(horizon))
    if (usable.length < MIN_CROSS_SECTION) continue
    const scores = usable.map((r) => r.score)
    const fwds = usable.map((r) => r.fwd.get(horizon) ?? 0)
    const ic = correlation(ranksOf(scores), ranksOf(fwds))
    if (ic !== null) ics.push(ic)
    // 五等分：按得分的平均秩切。并列多的时候各桶大小会不均，那是事实不是 bug
    const ranks = ranksOf(scores)
    ranks.forEach((rank, i) => {
      const q = Math.min(4, Math.floor((rank / usable.length) * 5))
      quintiles[q]?.push(fwds[i] ?? 0)
    })
  }
  const days = ics.length
  const mean = days === 0 ? 0 : ics.reduce((s, v) => s + v, 0) / days
  const sd =
    days < 2 ? 0 : Math.sqrt(ics.reduce((s, v) => s + (v - mean) ** 2, 0) / (days - 1))
  return {
    days,
    meanIc: mean,
    sdIc: sd,
    t: days < 2 || sd === 0 ? null : mean / (sd / Math.sqrt(days)),
    quintileMedians: quintiles.map((q) => median(q)),
  }
}

/** 逐标的扫一遍判定根，把 (日期, 得分, 前瞻收益) 收进横截面表 */
export function collect(
  series: LoadedSeries,
  params: EngineParams,
  options: CliOptions,
  sentimentAt: (date: TradeDate) => number,
  byDate: Map<TradeDate, Row[]>,
  counters: { judged: number; unusable: number; zeroScore: number },
  /** 早于它的判定根不计入横截面（但照常参与预热与指标）；null = 全收 */
  evalFrom: string | null = null
): void {
  const candles = series.candles
  const warmup = options.warmup ?? params.data.fullBars

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue
    // 纪律 1：与 simulate.ts 逐条对齐
    if (i < warmup || i >= candles.length - 1) continue
    if (bar.hasGap === true) continue

    const from = Math.max(0, i - options.lookback + 1)
    const window = candles.slice(from, i + 1)
    const ctx: EngineContext = {
      profile: series.profile,
      candles: window,
      weekly: aggregateWeekly(window),
      marketSentiment: sentimentAt(bar.date),
      now: { date: bar.date, minutesSinceOpen: CONTINUOUS_MINUTES, session: 'SETTLE' },
      // 不传 position：问的是「引擎今天对这只票说了什么」，不是组合当时持不持有
    }
    // 预热与指标照常，但早于 evalFrom 的判定根不进横截面（见 evalFromOf 的注释）
    if (evalFrom !== null && bar.date < evalFrom) continue
    const evaluation = evaluate(ctx, params)
    if (!evaluation) continue
    counters.judged++
    if (!evaluation.sufficiency.usable) {
      counters.unusable++
      continue
    }

    // 纪律 2：买入方向的组合得分，不管触发没触发
    const score = evaluation.combine.breakdown.BUY.final
    if (score <= 0) counters.zeroScore++

    // 纪律 3：收盘到收盘，不模拟成交、不扣成本
    const base = bar.closeAdj
    const fwd = new Map<number, number>()
    if (base > 0) {
      for (const h of HORIZONS) {
        const later = candles[i + h]?.closeAdj
        if (later !== undefined && later > 0) fwd.set(h, later / base - 1)
      }
    }
    if (fwd.size === 0) continue

    const list = byDate.get(bar.date)
    const row: Row = { code: series.profile.code, score, fwd }
    if (list) list.push(row)
    else byDate.set(bar.date, [row])
  }
}

function pct(v: number | null, digits = 3): string {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`
}

function render(
  label: string,
  byDate: Map<TradeDate, Row[]>,
  counters: { judged: number; unusable: number; zeroScore: number }
): string[] {
  const lines: string[] = []
  lines.push('')
  lines.push(`【${label}】`)
  const tieShare = counters.judged === 0 ? 0 : counters.zeroScore / counters.judged
  lines.push(
    `  判定根 ${counters.judged} · 数据不足 ${counters.unusable} · ` +
      `买入得分为 0 的占比 ${(tieShare * 100).toFixed(1)}%（并列会稀释 IC，纪律 4）`
  )
  lines.push('  持有期    有效交易日   平均 IC      IC 标准差         t      Q1→Q5 前瞻收益中位数')
  for (const h of HORIZONS) {
    const r = icOf(byDate, h)
    lines.push(
      `  ${String(h).padStart(4)} 日  ${String(r.days).padStart(10)}  ${pct(r.meanIc, 4).padStart(10)}  ` +
        `${pct(r.sdIc, 4).padStart(12)}  ${(r.t === null ? '—' : r.t.toFixed(2)).padStart(8)}   ` +
        r.quintileMedians.map((m) => pct(m, 2).padStart(8)).join(' ')
    )
  }
  return lines
}

export async function main(argv: readonly string[]): Promise<number> {
  const evalFrom = evalFromOf(argv)
  const rest = evalFrom === null ? argv : argv.filter((a, i) => a !== '--eval-from' && argv[i - 1] !== '--eval-from')
  let options: CliOptions | 'help'
  try {
    options = parseArgs(rest)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}

${USAGE}`)
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
    // 情绪序列与 crosssec-audit 逐条相同：基准的收盘序列 → 分位，缺值沿用上一个
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

    const all = new Map<TradeDate, Row[]>()
    const counters = { judged: 0, unusable: 0, zeroScore: 0 }
    let audited = 0
    for (const raw of options.codes) {
      const code = normalizeCode(raw)
      const loaded = source.load(code)
      if (!loaded) {
        if (!options.quiet && !options.json) process.stdout.write(`[warn] ${code} 无日线，已跳过
`)
        continue
      }
      collect(loaded, params, options, sentimentAt, all, counters, evalFrom)
      audited++
      if (!options.quiet && !options.json && audited % 20 === 0) {
        process.stdout.write(`[audit] ${audited} 只，累计判定根 ${counters.judged}
`)
      }
    }
    if (audited === 0) throw new Error('没有任何标的有可用日线')

    // 纪律 4 的第二档：得分 > 0 的子集（同一批数据的另一种切法，预注册里写死）
    const positive = new Map<TradeDate, Row[]>()
    for (const [date, rows] of all) {
      const kept = rows.filter((r) => r.score > 0)
      if (kept.length > 0) positive.set(date, kept)
    }

    const payload = {
      meta: {
        engineVersion: engineVersionOf(params),
        paramsFingerprint: paramsFingerprint(params),
        codes: audited,
        from: options.from,
        to: options.to,
        horizons: HORIZONS,
        minCrossSection: MIN_CROSS_SECTION,
        evalFrom,
        judged: counters.judged,
        unusable: counters.unusable,
        zeroScore: counters.zeroScore,
      },
      all: HORIZONS.map((h) => ({ horizon: h, ...icOf(all, h) })),
      positiveOnly: HORIZONS.map((h) => ({ horizon: h, ...icOf(positive, h) })),
    }

    if (options.out !== undefined) {
      mkdirSync(dirname(options.out), { recursive: true })
      writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}
`, 'utf8')
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload)}
`)
      return 0
    }
    const lines = [
      `[ic] ${audited} 只 · ${options.from} → ${options.to}` +
        (evalFrom === null ? '' : ` · 只统计 ${evalFrom} 之后的判定根（更早的只做预热）`) +
        ` · ${engineVersionOf(params)}`,
      ...render('全体（含买入得分为 0 的并列）', all, counters),
      ...render('得分 > 0 的子集', positive, counters),
      '',
      '  IC 是逐日横截面的 Spearman 秩相关（得分 vs 前瞻收益），**不构造零分布**（§5.46）。',
      '  t = mean(IC)/(sd(IC)/√有效交易日)。判据：t ≥ 2 且五等分单调（端点差 ≥ 0.3pp）。',
      '  ⚠ IC 只回答「得分有没有横截面排序能力」，**不回答「这套系统赚不赚钱」**。',
      '',
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    source.close()
  }
}

if (process.argv[1] !== undefined && process.argv[1].includes('ic-audit')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
