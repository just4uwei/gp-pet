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
  /**
   * **朴素 t** `mean / (sd / √days)`，把每个交易日当独立样本。
   * **这是上界，不许引用**（§5.46 限制 1）—— 留着是为了与调整后的并排看。
   * 样本不足或零方差时 null，不用 0 冒充。
   */
  t: number | null
  /**
   * **Newey-West 调整后的 t**，滞后阶 `L = horizon − 1`（主口径，见 §5.47）。
   * 前瞻收益是**重叠**的（每天都算一次 h 日收益）⇒ IC 序列在结构上带 MA(h−1)，
   * 这个滞后阶不是估出来的、是**机械已知**的。
   */
  tNw: number | null
  /** 主口径实际用的滞后阶 */
  lagNw: number
  /**
   * 第二个**预承诺**滞后阶下的 t：`L = ⌊4(T/100)^(2/9)⌋`（Andrews 1991 的经验规则）。
   * 报它是为了让「滞后阶怎么选」这件事**可见** —— 调滞后阶到显著为止是文献里
   * 有记录的 p-hacking 通道，所以两档都在看结果之前写死（§5.47）。
   */
  tNwAndrews: number | null
  lagAndrews: number
  /** 五等分（按当日得分排名）各组前瞻收益的**中位数** */
  quintileMedians: (number | null)[]
}

/**
 * Bartlett 核的 Newey-West 长期方差（作用在**均值**上）：
 *
 * ```
 * Var(x̄) = (1/T) · ( γ₀ + 2 · Σ_{k=1..L} (1 − k/(L+1)) · γₖ )
 * ```
 *
 * `γₖ` 是滞后 k 的样本自协方差。三角权重 `1 − k/(L+1)` 是 Newey & West (1987) 的选择，
 * 它保证估计出来的方差**非负**（早期 HAC 估计量会给出负方差）。
 *
 * ⚠ **两条容易读错的**：
 * ① `L` 是**滞后截断阶**，不是「带宽」—— 两者按核函数换算，文献里同一个数两种叫法都有；
 * ② `L = ⌊4(T/100)^(2/9)⌋` 那个经验规则应归 **Andrews (1991)**，
 *    不是 Newey-West (1987)（后者把权重选择留开了）。
 *
 * 序列**必须按时间排好**再传进来：自协方差按相邻位置算，顺序错了这个数就没有意义。
 * 返回 null 的两种情形：样本不足，或方差非正（全部并列会走到）。
 */
export function neweyWestVariance(series: readonly number[], lag: number): number | null {
  const T = series.length
  if (T < 2) return null
  const mean = series.reduce((s, v) => s + v, 0) / T
  const dev = series.map((v) => v - mean)
  // γ₀ 用 1/T（与 NW 原式一致），不是 1/(T−1)：这里估的是长期方差不是样本方差
  const gamma = (k: number): number => {
    let sum = 0
    for (let i = k; i < T; i++) sum += (dev[i] ?? 0) * (dev[i - k] ?? 0)
    return sum / T
  }
  let lrv = gamma(0)
  const L = Math.max(0, Math.min(lag, T - 1))
  for (let k = 1; k <= L; k++) lrv += 2 * (1 - k / (L + 1)) * gamma(k)
  if (!(lrv > 0)) return null
  return lrv / T
}

/** Andrews (1991) 的经验滞后阶 `⌊4(T/100)^(2/9)⌋` */
export const andrewsLag = (T: number): number => (T < 2 ? 0 : Math.floor(4 * (T / 100) ** (2 / 9)))

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
  /*
    **必须按日期排序再算**（2026-08-20 加）。`byDate` 的插入顺序由 `collect` 的扫描
    决定 —— 第一只票按它自己的日期顺序插，之后的票只补它没有的日子 ⇒ 一只**起始更早**
    的票会把它的早期日子**追加到尾部**。Newey-West 按相邻位置算自协方差，
    顺序错了那个数就没有意义，**而且不会报错**。IC 的均值与五等分不受顺序影响，
    所以这个坑在加 NW 之前是隐性的。
  */
  const byDateSorted = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [, rows] of byDateSorted) {
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
  // 主口径滞后阶 = h−1：重叠窗口带来的 MA(h−1) 是**机械已知**的，不用估
  const lagNw = Math.max(0, horizon - 1)
  const lagAndrewsL = andrewsLag(days)
  const tOf = (lag: number): number | null => {
    const v = neweyWestVariance(ics, lag)
    return v === null ? null : mean / Math.sqrt(v)
  }
  return {
    days,
    meanIc: mean,
    sdIc: sd,
    t: days < 2 || sd === 0 ? null : mean / (sd / Math.sqrt(days)),
    tNw: tOf(lagNw),
    lagNw,
    tNwAndrews: tOf(lagAndrewsL),
    lagAndrews: lagAndrewsL,
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
  // 三个 t 并排打印是刻意的：只印调整后的会让「调整了多少」看不见，
  // 而那个倍数（朴素/NW）恰恰是这一节要报的量（§5.47）
  lines.push(
    '  持有期    有效交易日   平均 IC      IC 标准差    t(朴素·上界)   t(NW,L=h−1)   t(NW,Andrews)      Q1→Q5 前瞻收益中位数'
  )
  for (const h of HORIZONS) {
    const r = icOf(byDate, h)
    const num = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
    lines.push(
      `  ${String(h).padStart(4)} 日  ${String(r.days).padStart(10)}  ${pct(r.meanIc, 4).padStart(10)}  ` +
        `${pct(r.sdIc, 4).padStart(12)}  ${num(r.t).padStart(12)}   ` +
        `${`${num(r.tNw)}(L=${r.lagNw})`.padStart(12)}  ${`${num(r.tNwAndrews)}(L=${r.lagAndrews})`.padStart(13)}   ` +
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
      '  t(朴素) = mean(IC)/(sd(IC)/√有效交易日) —— 把交易日当独立样本，**是上界，不许引用**。',
      '  t(NW) = Newey-West/Bartlett 长期方差下的 t。主口径 L = h−1（重叠窗口的 MA(h−1) 是机械已知的）；',
      '    Andrews(1991) 的 ⌊4(T/100)^(2/9)⌋ 并排报出，两档都在看结果之前写死 —— 调滞后阶到显著为止是',
      '    文献里有记录的 p-hacking 通道（§5.47）。两档给出相反判断时，结论是「不稳健」而不是挑一个。',
      '  判据：t(NW) ≥ 2 且五等分单调（端点差 ≥ 0.3pp）。',
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
