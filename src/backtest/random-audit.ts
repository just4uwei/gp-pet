#!/usr/bin/env node
/**
 * 随机入场基准（零假设分布）。
 *
 * ```bash
 * pnpm audit:random -- --baseline reports/calib/baseline-261.json --fixtures ./data/history --trials 200
 * ```
 *
 * **为什么需要这个工具**：回测报出「TREND_UP 建仓 396 次 / 仓位加权 −1.01%」，
 * 但这个数**缺一个零点**。唯一的基准是沪深300，而它是满仓的、我们平均资金占用只有 3.69%
 * —— 报告里「超额 −15.04%」那一行离开占用率就会被读反（§5.13）。
 * 于是分不开两件事：
 *
 * | | 含义 | 对策完全不同 |
 * |---|---|---|
 * | A 策略没信息 | 同池同期随机买入也是 −1% | 问题是「该不该在 TREND_UP 里买」，不是判定逻辑写错了 |
 * | B 策略有信息但符号反了 | 随机明显好于 −1% | 「得分越高越糟」就不是噪音，深挖判定逻辑值得做 |
 *
 * **配对随机化**：对每一次真实建仓，在**同一只票**上随机挑一个入场日，
 * 持有**同样的根数**，走**同一套成本模型**。于是标的构成、持仓时长分布、
 * 投入资金、费率滑点全部对齐，**唯一变化的是「什么时候进」** —— 那正是被检验的东西。
 *
 * 两种口径，回答两个不同的问题：
 *
 * - **无条件**（默认）：随机日可以是任何一天 ⇒ 答「这套规则挑的点比随便挑好吗」
 * - **同 regime**（`--match-regime`）：随机日限定在与真实建仓相同的市场状态里
 *   ⇒ 答「除掉 regime 过滤之后，子信号与得分还有没有增量」。
 *   这一档才分得开 A 与 B：若真实 ≈ 同 regime 随机，则亏的是 TREND_UP 这个状态本身，
 *   而不是状态内的挑选。
 *
 * **四条纪律**：
 * 1. **只统计，不改参数**。与 `audit:regime` / `audit:subsignals` 同类。
 * 2. **成本模型复用 `costs.ts`**，不在这里重写一份 —— 两边数字对不上的时候
 *    「是策略差异还是口径差异」会变成一个查不清的问题（CLAUDE.md 那条横向边）。
 * 3. **成交口径与 `simulate.ts` 逐条对齐**：次日开盘成交（`entryDate` 就是成交那根）、
 *    涨停开盘买不到、跌停开盘顺延最多 5 根、`hasGap` 那根不成交、手数向下取整。
 *    差一条，比的就不是同一件事。
 * 4. **RNG 必须可复现**：种子由 `--seed` 给，默认 1。用 `Math.random()` 会让
 *    同一份数据两次跑出不同的结论，而这个工具的产出是要写进偏差报告的。
 *
 * **一处必须声明的偏倚**：`holdingBars` 是**内生**的 —— 真实建仓里跌得快的被止损在 8 根，
 * 涨上去的被移动止损拖到 15 根。配对时照抄这个分布，等于让随机组也按同样的
 * 「短持有 / 长持有」比例去抽。这是刻意的（否则比的是两种持有策略），
 * 但它意味着本工具回答的是「**在同样的持有时长安排下，入场时点选得好不好**」，
 * 不是「这套策略整体比随机好不好」。后者要连离场规则一起随机化，是另一个实验。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeCode, priceLimits } from '../core/code'
import { computeIndicators } from '../core/indicators'
import { classifyRegimes } from '../core/regime'
import { DEFAULT_PARAMS, type EngineParams } from '../core/params'
import type { Regime, SecCode, TradeDate } from '../core/types'
import {
  DEFAULT_COSTS,
  buyFees,
  buyFill,
  lotsAffordable,
  sellFees,
  sellFill,
  type CostModel,
} from './costs'
import { openFixtureSource, openSqliteSource, type DataSource, type LoadedSeries } from './data'

/** 与 simulate.ts 的 MAX_DEFER_BARS 同源：连续跌停超过这个天数就当作卖不掉 */
const MAX_DEFER_BARS = 5

const REGIMES: readonly Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']

// ── 报告读取 ─────────────────────────────────────────────────────────────

interface ReportTrade {
  code: SecCode
  entryDate: TradeDate
  exitDate: TradeDate
  entryPrice: number
  exitPrice: number
  shares: number
  pnl: number
  holdingBars: number
  regimeAtEntry: Regime
  entryScore: number
  entrySignals: string[]
  exitRule: string
  partial: boolean
}

interface BaselineReport {
  meta: {
    engineVersion: string
    paramsFingerprint: string
    codes: SecCode[]
    from: TradeDate
    to: TradeDate
    capitalPerCode: number
  }
  trades: ReportTrade[]
}

/**
 * 建仓级归并：一行 `trade` 是一次**卖出**，回撤减仓会把一次建仓拆成两三行。
 * 逐笔胜率 28.45% 与建仓级胜率 44.85% 是同一份数据（§5.18），混用就会读错。
 * 这里一律按 `code@entryDate` 归并到建仓级。
 */
interface Position {
  code: SecCode
  entryDate: TradeDate
  /** 最后一笔卖出的日期 —— 建仓级的持有跨度按它算 */
  exitDate: TradeDate
  regimeAtEntry: Regime
  entryScore: number
  entrySignals: string[]
  /** 入场投入的本金（前复权口径）= 入场价 × 总股数 */
  deployed: number
  /** 该次建仓的全部盈亏之和（已扣费） */
  pnl: number
}

function groupPositions(trades: readonly ReportTrade[]): Position[] {
  const map = new Map<string, Position>()
  for (const t of trades) {
    const key = `${t.code}@${t.entryDate}`
    const found = map.get(key)
    if (found) {
      found.pnl += t.pnl
      found.deployed += t.entryPrice * t.shares
      if (t.exitDate > found.exitDate) found.exitDate = t.exitDate
    } else {
      map.set(key, {
        code: t.code,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        regimeAtEntry: t.regimeAtEntry,
        entryScore: t.entryScore,
        entrySignals: t.entrySignals,
        deployed: t.entryPrice * t.shares,
        pnl: t.pnl,
      })
    }
  }
  return [...map.values()]
}

// ── 可复现 RNG（mulberry32）──────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 单次成交模拟（口径与 simulate.ts 逐条对齐）───────────────────────────

interface FillResult {
  deployed: number
  pnl: number
}

/**
 * 在 `entryIdx` 这根的开盘买入、持有 `span` 根后在开盘卖出。
 *
 * `entryIdx` 是**成交**那一根（`simulate.ts` 里 `entryDate = bar.date`，成交价是该根开盘），
 * 所以判定发生在 `entryIdx - 1`。涨跌停的判据也因此拿 `entryIdx - 1` 的收盘算，与 simulate 一致。
 */
function fillTrade(
  series: LoadedSeries,
  entryIdx: number,
  span: number,
  capital: number,
  costs: CostModel
): FillResult | null {
  const candles = series.candles
  const entry = candles[entryIdx]
  const prevClose = candles[entryIdx - 1]?.close
  if (!entry || prevClose === undefined) return null
  if (entry.hasGap === true) return null

  const entryLimits = priceLimits(prevClose, series.profile.board, series.profile.isST)
  // 涨停开盘买不到 —— 不排除的话随机组会白捡一批强势日的入场
  if (entryLimits !== null && entry.open >= entryLimits.limitUp - 0.001) return null

  const fillAdj = buyFill(entry.openAdj, costs)
  const shares = lotsAffordable(capital, fillAdj, costs)
  if (shares <= 0) return null
  const deployed = shares * fillAdj
  const entryFees = buyFees(deployed, costs)

  // 卖出：跌停开盘顺延最多 MAX_DEFER_BARS 根，与 simulate.ts 同
  let exitIdx = entryIdx + span
  for (let deferred = 0; deferred <= MAX_DEFER_BARS; deferred++) {
    const bar = candles[exitIdx]
    const before = candles[exitIdx - 1]?.close
    if (!bar || before === undefined) return null
    if (bar.hasGap === true) {
      exitIdx++
      continue
    }
    const limits = priceLimits(before, series.profile.board, series.profile.isST)
    const limitedDown = limits !== null && bar.open <= limits.limitDown + 0.001
    if (!limitedDown) {
      const exitAdj = sellFill(bar.openAdj, costs)
      const amount = shares * exitAdj
      const exitFees = sellFees(amount, costs)
      return { deployed, pnl: (exitAdj - fillAdj) * shares - entryFees - exitFees }
    }
    exitIdx++
  }
  return null // 连续跌停卖不掉，这次抽样作废
}

// ── 汇总口径 ─────────────────────────────────────────────────────────────

interface Summary {
  count: number
  /** 建仓胜率：pnl > 0 的占比 */
  winRate: number
  /** 仓位加权收益 = Σpnl / Σ本金 —— 与 §5.20 ⑧ 那张表同口径 */
  weightedPnlPct: number
  netPnl: number
}

function summarize(items: readonly FillResult[]): Summary {
  if (items.length === 0) return { count: 0, winRate: 0, weightedPnlPct: 0, netPnl: 0 }
  let wins = 0
  let pnl = 0
  let deployed = 0
  for (const it of items) {
    if (it.pnl > 0) wins++
    pnl += it.pnl
    deployed += it.deployed
  }
  return {
    count: items.length,
    winRate: wins / items.length,
    weightedPnlPct: deployed > 0 ? pnl / deployed : 0,
    netPnl: pnl,
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo]
  const b = sorted[hi]
  if (a === undefined || b === undefined) return NaN
  return a + (b - a) * (pos - lo)
}

/** 真实值在随机分布里的百分位（0..1）。越小说明真实值越差 */
function percentileOf(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return NaN
  let below = 0
  for (const v of sorted) if (v < value) below++
  return below / sorted.length
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

export interface StratumResult {
  label: string
  real: Summary
  /** 真实入场日 + 被动持有同 span（与随机组结构一致） */
  passive: Summary
  trials: number
  /** 每次试验的仓位加权收益 */
  randomWeighted: number[]
  randomWinRate: number[]
  /** 每次试验里成功抽到的样本数（涨停/跌停/边界会作废一部分） */
  randomCounts: number[]
}

export interface StratumRow {
  label: string
  realCount: number
  realWeightedPnlPct: number
  realWinRate: number
  realNetPnl: number
  /** 真实入场 + 被动持有：入场质量的干净判据（结构与随机组一致） */
  passiveCount: number
  passiveWeightedPnlPct: number
  passiveWinRate: number
  passivePercentile: number
  passiveWinRatePercentile: number
  randomWeightedMean: number
  randomWeightedSd: number
  randomWeightedP05: number
  randomWeightedP50: number
  randomWeightedP95: number
  /** 真实值在随机分布里的百分位 0..1。越接近 0 说明真实越差 */
  realPercentile: number
  randomWinRateMean: number
  randomWinRateP05: number
  randomWinRateP95: number
  realWinRatePercentile: number
  randomSampleMean: number
}

export interface RandomAuditPayload {
  meta: {
    baseline: string
    engineVersion: string
    paramsFingerprint: string
    codes: number
    from: TradeDate
    to: TradeDate
    trials: number
    seed: number
    matchRegime: boolean
    warmup: number
    positionsTotal: number
    positionsPaired: number
    skipped: number
    regimeSelfCheck: { total: number; hit: number } | null
  }
  strata: StratumRow[]
}

// ── regime 序列（--match-regime 用）──────────────────────────────────────

/**
 * 整条序列一次算完，而不是像 simulate 那样每根切 320 根窗口。
 *
 * 两者对判定根是**等价**的：BBW 分位的 `bbwLookback = 250` 在 320 根窗口里
 * 与整条序列取的是同一段尾随窗口；ADX 是 Wilder 递推，300 根预热之后初值影响已经收敛。
 * 但「等价」是推理不是事实 —— 所以 `--match-regime` 会拿真实建仓的
 * `regimeAtEntry` 做一次自检，对不上就报错退出（与 `audit:subsignals` 同一条纪律）。
 */
function regimeSeries(series: LoadedSeries, params: EngineParams, sentiment: number): Regime[] {
  // 情绪只影响 RSI 阈值、不影响 regime 判定，但 computeIndicators 要它，所以照实给中性值
  const indicators = computeIndicators(series.candles, params, { sentiment, intradayProgress: 1 })
  const classified = classifyRegimes(series.candles, indicators, params)
  return classified.map((r) => r.regime)
}

// ── 主流程 ───────────────────────────────────────────────────────────────

interface Options {
  baseline: string
  fixtures?: string
  db?: string
  trials: number
  seed: number
  matchRegime: boolean
  warmup: number
  out?: string
  json: boolean
}

const USAGE = `用法：
  pnpm audit:random -- --baseline <report.json> --fixtures ./data/history [选项]

必需：
  --baseline <file>      真实回测报告（含 trades），随机组按它逐次配对

数据来源（二选一）：
  --fixtures <dir>       从 <dir>/<CODE>.json 读日线
  --db <file>            market.db 路径

选项：
  --trials <n>           随机试验次数，默认 200
  --seed <n>             RNG 种子，默认 1（可复现是硬要求）
  --match-regime         随机入场日限定在与真实建仓相同的市场状态里
                         （慢很多：要为每只票重算一遍 regime 序列）
  --warmup <根>          随机入场日的最早位置，默认 300（= params.data.fullBars）
  --out <file>           JSON 落盘
  --json                 只输出 JSON
`

function parse(argv: readonly string[]): Options | 'help' {
  const o: Options = { baseline: '', trials: 200, seed: 1, matchRegime: false, warmup: 300, json: false }
  const flags = new Set(['--match-regime', '--json', '--help', '-h'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === undefined || key === '--') continue
    const next = flags.has(key) ? undefined : argv[i + 1]
    if (!flags.has(key)) i++
    const need = (): string => {
      if (next === undefined) throw new Error(`${key} 缺少取值`)
      return next
    }
    switch (key) {
      case '--help':
      case '-h':
        return 'help'
      case '--baseline':
        o.baseline = need()
        break
      case '--fixtures':
        o.fixtures = need()
        break
      case '--db':
        o.db = need()
        break
      case '--trials':
        o.trials = Number(need())
        break
      case '--seed':
        o.seed = Number(need())
        break
      case '--warmup':
        o.warmup = Number(need())
        break
      case '--match-regime':
        o.matchRegime = true
        break
      case '--out':
        o.out = need()
        break
      case '--json':
        o.json = true
        break
      default:
        throw new Error(`无法识别的参数：${key}`)
    }
  }
  if (!o.baseline) throw new Error('必须用 --baseline 指定真实回测报告')
  if (!o.fixtures && !o.db) throw new Error('必须给 --fixtures 或 --db')
  if (!Number.isInteger(o.trials) || o.trials < 1) throw new Error('--trials 必须是 ≥ 1 的整数')
  return o
}

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv)
  if (parsed === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  const opts = parsed
  const report = JSON.parse(readFileSync(opts.baseline, 'utf8')) as BaselineReport
  const positions = groupPositions(report.trades)
  const capital = report.meta.capitalPerCode
  const costs: CostModel = DEFAULT_COSTS

  const source: DataSource = opts.fixtures
    ? openFixtureSource(opts.fixtures, { from: report.meta.from, to: report.meta.to })
    : await openSqliteSource(opts.db ?? '', { from: report.meta.from, to: report.meta.to })

  // ① 载入所有涉及的标的，并建立「日期 → 下标」索引
  const codes = [...new Set(positions.map((p) => p.code))].map((c) => normalizeCode(c))
  const loaded = new Map<SecCode, { series: LoadedSeries; index: Map<TradeDate, number> }>()
  for (const code of codes) {
    const series = source.load(code)
    if (!series) continue
    const index = new Map<TradeDate, number>()
    series.candles.forEach((c, i) => index.set(c.date, i))
    loaded.set(code, { series, index })
  }
  source.close()

  // 随机基准对着出厂参数的那次基线跑，不接受参数覆盖 —— 换参数就该重出基线报告
  const params: EngineParams = DEFAULT_PARAMS

  // ② regime 序列（仅 --match-regime）+ 自检
  const regimes = new Map<SecCode, Regime[]>()
  let checkTotal = 0
  let checkHit = 0
  if (opts.matchRegime) {
    process.stderr.write(`计算 regime 序列（${loaded.size} 只）…\n`)
    for (const [code, entry] of loaded) {
      regimes.set(code, regimeSeries(entry.series, params, 0.5))
    }
    for (const p of positions) {
      const code = normalizeCode(p.code)
      const entry = loaded.get(code)
      const seq = regimes.get(code)
      if (!entry || !seq) continue
      const idx = entry.index.get(p.entryDate)
      if (idx === undefined || idx < 1) continue
      // 判定发生在成交那根的**前**一根
      const got = seq[idx - 1]
      if (got === undefined) continue
      checkTotal++
      if (got === p.regimeAtEntry) checkHit++
    }
    const rate = checkTotal > 0 ? checkHit / checkTotal : 0
    process.stderr.write(
      `regime 自检：${checkHit}/${checkTotal} = ${(rate * 100).toFixed(2)}% 与报告一致\n`
    )
    if (rate < 0.95) {
      process.stderr.write(
        `❌ 自检未过（< 95%）。整条序列算出来的 regime 与 simulate 的 320 根窗口口径不等价，\n` +
          `   同 regime 抽样会抽错状态 —— 拒绝出数，先查口径。\n`
      )
      return 3
    }
  }

  // ③ 逐建仓准备候选入场日
  interface Task {
    position: Position
    code: SecCode
    span: number
    /** 合格的随机入场下标 */
    pool: number[]
    real: FillResult
    /**
     * 真实入场日 + **被动持有**同样根数（不走任何风控离场）。
     *
     * 这一档才是入场质量的干净判据：它与随机组**结构完全一致**（一买一卖、同 span、
     * 同成本模型），唯一差别就是入场日选自信号还是选自骰子。
     * 而 `real` 那一档混着风控离场（回撤减仓把一次建仓拆成两三笔），
     * 拿它直接和随机比，会分不清「点选得差」还是「离场规则差」。
     */
    passive: FillResult | null
  }
  const tasks: Task[] = []
  const skipped: string[] = []
  for (const p of positions) {
    const code = normalizeCode(p.code)
    const entry = loaded.get(code)
    if (!entry) {
      skipped.push(`${p.code}: 无日线`)
      continue
    }
    const entryIdx = entry.index.get(p.entryDate)
    const exitIdx = entry.index.get(p.exitDate)
    if (entryIdx === undefined || exitIdx === undefined) {
      skipped.push(`${p.code}@${p.entryDate}: 日期不在序列里`)
      continue
    }
    const span = exitIdx - entryIdx
    if (span < 1) {
      skipped.push(`${p.code}@${p.entryDate}: 跨度 < 1`)
      continue
    }
    const n = entry.series.candles.length
    const wantRegime = opts.matchRegime ? p.regimeAtEntry : null
    const seq = regimes.get(code)
    const pool: number[] = []
    for (let i = Math.max(1, opts.warmup); i + span + MAX_DEFER_BARS < n; i++) {
      if (wantRegime !== null) {
        const r = seq?.[i - 1]
        if (r !== wantRegime) continue
      }
      pool.push(i)
    }
    if (pool.length === 0) {
      skipped.push(`${p.code}@${p.entryDate}: 无合格随机入场日`)
      continue
    }
    tasks.push({
      position: p,
      code,
      span,
      pool,
      real: { deployed: p.deployed, pnl: p.pnl },
      passive: fillTrade(entry.series, entryIdx, span, capital, costs),
    })
  }

  // ④ 跑 N 次随机试验
  const rng = makeRng(opts.seed)
  const strata = ['ALL', ...REGIMES] as const
  const realByStratum = new Map<string, FillResult[]>()
  const passiveByStratum = new Map<string, FillResult[]>()
  const randByStratum = new Map<string, { weighted: number[]; win: number[]; counts: number[] }>()
  for (const s of strata) {
    realByStratum.set(s, [])
    passiveByStratum.set(s, [])
    randByStratum.set(s, { weighted: [], win: [], counts: [] })
  }
  for (const t of tasks) {
    realByStratum.get('ALL')?.push(t.real)
    realByStratum.get(t.position.regimeAtEntry)?.push(t.real)
    if (t.passive) {
      passiveByStratum.get('ALL')?.push(t.passive)
      passiveByStratum.get(t.position.regimeAtEntry)?.push(t.passive)
    }
  }

  process.stderr.write(`配对 ${tasks.length} 次建仓 × ${opts.trials} 次试验…\n`)
  for (let trial = 0; trial < opts.trials; trial++) {
    const bucket = new Map<string, FillResult[]>()
    for (const s of strata) bucket.set(s, [])
    for (const t of tasks) {
      const entry = loaded.get(t.code)
      if (!entry) continue
      // 一次抽样可能因涨跌停/边界作废，最多重抽 8 次再放弃
      let fill: FillResult | null = null
      for (let attempt = 0; attempt < 8 && fill === null; attempt++) {
        const pick = t.pool[Math.floor(rng() * t.pool.length)]
        if (pick === undefined) break
        fill = fillTrade(entry.series, pick, t.span, capital, costs)
      }
      if (!fill) continue
      bucket.get('ALL')?.push(fill)
      bucket.get(t.position.regimeAtEntry)?.push(fill)
    }
    for (const s of strata) {
      const items = bucket.get(s) ?? []
      const sum = summarize(items)
      const acc = randByStratum.get(s)
      if (!acc) continue
      acc.weighted.push(sum.weightedPnlPct)
      acc.win.push(sum.winRate)
      acc.counts.push(sum.count)
    }
  }

  // ⑤ 汇总输出
  const results: StratumResult[] = []
  for (const s of strata) {
    const real = summarize(realByStratum.get(s) ?? [])
    if (real.count === 0) continue
    const acc = randByStratum.get(s)
    if (!acc) continue
    results.push({
      label: s,
      real,
      passive: summarize(passiveByStratum.get(s) ?? []),
      trials: opts.trials,
      randomWeighted: acc.weighted,
      randomWinRate: acc.win,
      randomCounts: acc.counts,
    })
  }

  const payload: RandomAuditPayload = {
    meta: {
      baseline: opts.baseline,
      engineVersion: report.meta.engineVersion,
      paramsFingerprint: report.meta.paramsFingerprint,
      codes: report.meta.codes.length,
      from: report.meta.from,
      to: report.meta.to,
      trials: opts.trials,
      seed: opts.seed,
      matchRegime: opts.matchRegime,
      warmup: opts.warmup,
      positionsTotal: positions.length,
      positionsPaired: tasks.length,
      skipped: skipped.length,
      regimeSelfCheck: opts.matchRegime ? { total: checkTotal, hit: checkHit } : null,
    },
    strata: results.map((r) => {
      const w = [...r.randomWeighted].sort((a, b) => a - b)
      const win = [...r.randomWinRate].sort((a, b) => a - b)
      return {
        label: r.label,
        realCount: r.real.count,
        realWeightedPnlPct: r.real.weightedPnlPct,
        realWinRate: r.real.winRate,
        realNetPnl: r.real.netPnl,
        passiveCount: r.passive.count,
        passiveWeightedPnlPct: r.passive.weightedPnlPct,
        passiveWinRate: r.passive.winRate,
        passivePercentile: percentileOf(w, r.passive.weightedPnlPct),
        passiveWinRatePercentile: percentileOf(win, r.passive.winRate),
        randomWeightedMean: mean(r.randomWeighted),
        randomWeightedSd: stdev(r.randomWeighted),
        randomWeightedP05: quantile(w, 0.05),
        randomWeightedP50: quantile(w, 0.5),
        randomWeightedP95: quantile(w, 0.95),
        realPercentile: percentileOf(w, r.real.weightedPnlPct),
        randomWinRateMean: mean(r.randomWinRate),
        randomWinRateP05: quantile(win, 0.05),
        randomWinRateP95: quantile(win, 0.95),
        realWinRatePercentile: percentileOf(win, r.real.winRate),
        randomSampleMean: mean(r.randomCounts),
      }
    }),
  }

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true })
    writeFileSync(opts.out, JSON.stringify(payload, null, 2), 'utf8')
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return 0
  }
  process.stdout.write(renderText(payload))
  return 0
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—'
}

function renderText(p: RandomAuditPayload): string {
  const m = p.meta
  const lines: string[] = []
  lines.push('随机入场基准（零假设分布）')
  lines.push('='.repeat(78))
  lines.push(`基线报告   ${m.baseline}`)
  lines.push(`引擎版本   ${m.engineVersion}（指纹 ${m.paramsFingerprint}）`)
  lines.push(`标的 / 区间 ${m.codes} 只 · ${m.from} → ${m.to}`)
  lines.push(
    `配对       ${m.positionsPaired}/${m.positionsTotal} 次建仓（跳过 ${m.skipped}）· ` +
      `${m.trials} 次试验 · seed=${m.seed}`
  )
  lines.push(`抽样口径   ${m.matchRegime ? '同 regime（限定相同市场状态）' : '无条件（任意交易日）'}`)
  if (m.regimeSelfCheck) {
    const c = m.regimeSelfCheck
    lines.push(
      `regime 自检 ${c.hit}/${c.total} = ${((c.hit / Math.max(1, c.total)) * 100).toFixed(2)}% 与报告一致`
    )
  }
  lines.push('')
  lines.push('仓位加权收益（Σ盈亏 / Σ本金）')
  lines.push('-'.repeat(94))
  lines.push(
    ['状态', '建仓', '真实(含风控)', '真实入场·被动', '随机·被动', '随机 p5', '随机 p95', '被动分位']
      .map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(14)))
      .join('')
  )
  for (const s of p.strata) {
    lines.push(
      [
        s.label.padEnd(12),
        String(s.realCount).padStart(14),
        pct(s.realWeightedPnlPct).padStart(14),
        pct(s.passiveWeightedPnlPct).padStart(14),
        pct(s.randomWeightedMean).padStart(14),
        pct(s.randomWeightedP05).padStart(14),
        pct(s.randomWeightedP95).padStart(14),
        pct(s.passivePercentile).padStart(14),
      ].join('')
    )
  }
  lines.push('')
  lines.push('建仓胜率')
  lines.push('-'.repeat(94))
  lines.push(
    ['状态', '真实(含风控)', '真实入场·被动', '随机·被动', '随机 p5', '随机 p95', '被动分位']
      .map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(14)))
      .join('')
  )
  for (const s of p.strata) {
    lines.push(
      [
        s.label.padEnd(12),
        pct(s.realWinRate).padStart(14),
        pct(s.passiveWinRate).padStart(14),
        pct(s.randomWinRateMean).padStart(14),
        pct(s.randomWinRateP05).padStart(14),
        pct(s.randomWinRateP95).padStart(14),
        pct(s.passiveWinRatePercentile).padStart(14),
      ].join('')
    )
  }
  lines.push('')
  lines.push('读法')
  lines.push('-'.repeat(94))
  lines.push('· 三列的差别只有两处，别混：')
  lines.push('    真实(含风控)   = 信号选的入场日 + 风控离场（止损/回撤减仓/移动止损/盈利保护）')
  lines.push('    真实入场·被动  = 信号选的入场日 + 被动持有同样根数')
  lines.push('    随机·被动      = 骰子选的入场日 + 被动持有同样根数')
  lines.push('  「真实入场·被动」与「随机·被动」**结构完全一致**（一买一卖、同 span、同成本），')
  lines.push('  所以只有这两列之差才是**入场质量**；前两列之差是风控离场的作用。')
  lines.push('· 「被动分位」= 「真实入场·被动」落在随机分布的第几百分位。')
  lines.push('  接近 50% ⇒ 入场与随机无异；接近 0% ⇒ 入场**系统性更差**（在反向挑点）。')
  lines.push('· holdingBars 是内生的（跌得快的被止损在 8 根、涨上去的被拖到 15 根），')
  lines.push('  配对时照抄了这个分布 —— 这是刻意的，否则比的是两种持有策略。')
  lines.push('· 本工具只统计，不改参数。')
  return lines.join('\n') + '\n'
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('random-audit.ts') === true
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n\n${USAGE}`)
      process.exit(1)
    })
}
