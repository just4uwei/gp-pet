#!/usr/bin/env node
/**
 * 回测 CLI（docs/07 §2.2）。
 *
 * ```bash
 * pnpm backtest -- --codes SH600000,SZ000001 --from 2020-01-01 --to 2026-06-30 \
 *               --params ./params/candidate-a.json --out ./reports/a.json
 * ```
 *
 * 它不是「锦上添花的 P2 功能」，而是**决定出厂默认参数的工具**（docs/07 §1）：
 * params.ts 里每个数字都还是来源文档的转述，只有跑过这里才有资格改成出厂值。
 *
 * 装配层的克制与 data-layer.ts 一致：本文件只接线与打印，判断逻辑都在
 * simulate.ts / report.ts / calibrate.ts —— 那些有测试，这里没有。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode } from '../core/code'
import {
  DEFAULT_PARAMS,
  engineVersionOf,
  paramsFingerprint,
  withParams,
  type EngineParams,
  type ParamOverrides,
} from '../core/params'
import type { SecCode, TradeDate } from '../core/types'
import { SENSITIVITY_PRESETS, USAGE, parseArgs, type CliOptions } from './args'
import {
  calibrate,
  expandGrid,
  renderCalibration,
  warmupForSplit,
  DEFAULT_SPLITS,
  codeGroups,
  timeSlices,
  type GridSpec,
  type Split,
  type SplitRun,
} from './calibrate'
import { DEFAULT_COSTS, type CostModel } from './costs'
import {
  loadDelistedMap,
  openFixtureSource,
  openSqliteSource,
  sentimentSeries,
  type DataSource,
  type LoadedSeries,
} from './data'
import { assembleReport, performanceOf, mergeEquity, renderReport, type PerformanceBlock } from './report'
import { simulateCode, type CodeResult, type SentimentLookup } from './simulate'

/** 默认数据库位置，与主进程一致（%APPDATA%/gp-pet/market.db） */
function defaultDbPath(): string {
  const appData =
    process.env['APPDATA'] ??
    (process.env['HOME'] !== undefined ? join(process.env['HOME'], '.config') : process.cwd())
  return join(appData, 'gp-pet', 'market.db')
}

function log(options: CliOptions, message: string): void {
  if (!options.quiet && !options.json) process.stdout.write(`${message}\n`)
}

/**
 * `--params` / `--grid` 里的 JSON 不经过类型检查，写错了只会在引擎里变成 `undefined`。
 * 最危险的一种是 `voteThreshold` 写成数字（2026-08-12 之前的写法）：
 * `votes >= undefined` 恒为 false，回测会一声不响地跑出 0 笔交易，看起来像「参数太严」。
 * 所以这里显式挡一次 —— 报错比 0 笔更容易查。
 */
function assertParamsShape(source: string, raw: Record<string, unknown>): void {
  const combine = raw['combine']
  if (typeof combine !== 'object' || combine === null) return
  const vote = (combine as Record<string, unknown>)['voteThreshold']
  if (vote === undefined) return
  if (typeof vote === 'number') {
    throw new Error(
      `${source} 里的 combine.voteThreshold 是数字（${vote}）。` +
        '票数线自 2026-08-12 起按策略分开，应写成 {"trend": 3, "meanReversion": 2}。'
    )
  }
  const line = vote as Record<string, unknown>
  if (typeof line['trend'] !== 'number' || typeof line['meanReversion'] !== 'number') {
    throw new Error(`${source} 里的 combine.voteThreshold 缺 trend 或 meanReversion`)
  }
}

function resolveParams(options: CliOptions): EngineParams {
  let overrides: ParamOverrides = {}
  if (options.params) {
    const parsed: unknown = JSON.parse(readFileSync(options.params, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`--params 文件不是 JSON 对象：${options.params}`)
    }
    assertParamsShape(options.params, parsed as Record<string, unknown>)
    overrides = parsed as ParamOverrides
  }
  if (options.sensitivity) {
    const preset = SENSITIVITY_PRESETS[options.sensitivity]
    overrides = {
      ...overrides,
      combine: { ...(overrides.combine ?? {}), ...preset },
    }
  }
  return withParams(overrides, DEFAULT_PARAMS)
}

function resolveCosts(options: CliOptions): CostModel {
  return { ...DEFAULT_COSTS, ...options.costs }
}

interface Loaded {
  series: LoadedSeries[]
  benchmark: LoadedSeries | null
  source: DataSource
  /** `--delisted` 给的退市日表；没给就是空 Map ⇒ 行为与以前逐位相同 */
  delistedAt: Map<SecCode, TradeDate>
}


async function loadAll(options: CliOptions, range: { from: TradeDate; to: TradeDate }): Promise<Loaded> {
  const source = options.fixtures
    ? openFixtureSource(options.fixtures, range)
    : await openSqliteSource(options.db ?? defaultDbPath(), range)

  const codes = options.codes.map((code) => normalizeCode(code))
  const series: LoadedSeries[] = []
  for (const code of codes) {
    const loaded = source.load(code)
    if (!loaded) {
      log(options, `[warn] ${code} 在 ${range.from}..${range.to} 区间内没有日线，已跳过`)
      continue
    }
    series.push(loaded)
  }
  if (series.length === 0) throw new Error('没有任何标的有可用日线，回测无法进行')

  const benchmark = options.benchmark ? source.load(normalizeCode(options.benchmark)) : null
  if (options.benchmark && !benchmark) {
    log(options, `[warn] 基准 ${options.benchmark} 无日线，超额收益与信息比率将为空`)
  }

  const delistedAt =
    options.delisted === undefined ? new Map<SecCode, TradeDate>() : loadDelistedMap(options.delisted)
  const covered = series.filter((s) => delistedAt.has(s.profile.code)).length
  if (delistedAt.size > 0) {
    log(options, `[backtest] 退市清单 ${delistedAt.size} 只，其中 ${covered} 只在本次标的池内（退市日收盘强制平仓）`)
  }

  return { series, benchmark, source, delistedAt }
}

/** 基准日线 → 情绪查表 + 净值查表。两者都按「截至该日期的最后一个有值日」前值填充 */
function benchmarkViews(benchmark: LoadedSeries | null): {
  sentiment: SentimentLookup
  byDate: Map<TradeDate, number>
} {
  if (!benchmark) {
    return { sentiment: { at: () => 0.5 }, byDate: new Map() }
  }
  const closes = benchmark.candles.map((c) => c.closeAdj)
  const series = sentimentSeries(closes)
  const sentimentByDate = new Map<TradeDate, number>()
  let last = 0.5
  benchmark.candles.forEach((candle, i) => {
    const value = series[i]
    if (value !== null && value !== undefined) last = value
    sentimentByDate.set(candle.date, last)
  })

  const byDate = new Map<TradeDate, number>()
  for (const candle of benchmark.candles) byDate.set(candle.date, candle.closeAdj)

  // 非交易日或基准缺失日：取不到就用中性值，不外推
  return { sentiment: { at: (date) => sentimentByDate.get(date) ?? 0.5 }, byDate }
}

function runSimulation(
  loaded: Loaded,
  params: EngineParams,
  options: CliOptions,
  sentiment: SentimentLookup,
  range: { from: TradeDate; to: TradeDate }
): CodeResult[] {
  const costs = resolveCosts(options)
  return loaded.series.map((series) => {
    const delistedAt = loaded.delistedAt.get(series.profile.code)
    return simulateCode(
      {
        profile: series.profile,
        candles: series.candles.filter((c) => c.date >= range.from && c.date <= range.to),
      },
      {
        params,
        costs,
        capitalPerCode: options.capital,
        lookback: options.lookback,
        ...(options.warmup === undefined ? {} : { warmupBars: options.warmup }),
        ...(delistedAt === undefined ? {} : { delistedAt }),
      },
      sentiment
    )
  })
}

/*
 * 这里曾经有一个 `fixedWeightParams()`：把权重表压成 0.5/0.5 跑一遍同参数对照组，
 * 用来回答 M2 出口条件里的「按状态切换权重是否有效」。**2026-08-12 随权重表一起删除** ——
 * 权重表没了，对照组就是拿引擎和它自己比，只会让每次回测的耗时翻倍。
 * 那两轮对照的结论见 M2 偏差报告 §5.5–§5.8。
 */

async function runBacktest(options: CliOptions): Promise<number> {
  const range = { from: options.from, to: options.to }
  const params = resolveParams(options)
  const loaded = await loadAll(options, range)
  const views = benchmarkViews(loaded.benchmark)

  try {
    log(options, `[backtest] ${loaded.series.length} 只 · ${range.from} → ${range.to} · ${loaded.source.description}`)
    const results = runSimulation(loaded, params, options, views.sentiment, range)

    const report = assembleReport({
      results,
      benchmarkByDate: views.byDate,
      meta: {
        engineVersion: engineVersionOf(params),
        paramsFingerprint: paramsFingerprint(params),
        // 报告生成时刻由 CLI 打（core 不读时钟，这里是 Node 侧，可以）
        generatedAt: Date.now(),
        codes: results.map((r) => r.code),
        from: range.from,
        to: range.to,
        dataSource: loaded.source.description,
        capitalPerCode: options.capital,
      },
    })
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(`${renderReport(report)}\n`)

    if (options.out) writeJson(options.out, report)
    return 0
  } finally {
    loaded.source.close()
  }
}

async function runCalibration(options: CliOptions): Promise<number> {
  if (!options.grid) throw new Error('未指定 --grid')
  const spec: unknown = JSON.parse(readFileSync(options.grid, 'utf8'))
  if (typeof spec !== 'object' || spec === null) throw new Error('--grid 文件不是 JSON 对象')
  const candidates = expandGrid(spec as GridSpec)
  candidates.forEach((candidate, i) =>
    assertParamsShape(`${options.grid} 的第 ${i + 1} 组候选`, candidate as Record<string, unknown>)
  )
  log(options, `[calibrate] 网格展开 ${candidates.length} 组候选`)

  // 三段区间的并集用于一次取数；测试集尾部由 --to 收口
  const splits: Split[] = DEFAULT_SPLITS.map((split) =>
    split.name === 'test' ? { ...split, to: options.to } : { ...split }
  )
  const span = {
    from: splits.reduce((min, s) => (s.from < min ? s.from : min), splits[0]?.from ?? options.from),
    to: options.to,
  }
  const loaded = await loadAll(options, span)
  const views = benchmarkViews(loaded.benchmark)

  const groups = codeGroups(
    loaded.series.map((s) => s.profile.code),
    options.codeFolds
  )
  log(
    options,
    `[calibrate] 折单元 ${groups.length} 个标的子集 × ${options.timeSlices} 个时间片 = ` +
      `${groups.length * options.timeSlices} 折（同一次模拟切出来，不额外跑）`
  )

  try {
    const report = calibrate({
      candidates,
      base: resolveParams(options),
      splits,
      touchTest: options.touchTest,
      ...(options.minDeltaT === undefined ? {} : { minDeltaT: options.minDeltaT }),
      log: (message) => log(options, message),
      run: (params, split) => runSplit(loaded, params, options, views, split, groups),
    })

    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(`${renderCalibration(report)}\n`)
    if (options.out) writeJson(options.out, report)
    // 退出码：WRITE_BACK 0（有东西可写回）· KEEP 0（出厂值站得住，**这是结论不是失败**）
    // · INCONCLUSIVE 2（判不了，要人介入）
    return report.verdict === 'INCONCLUSIVE' ? 2 : 0
  } finally {
    loaded.source.close()
  }
}


/**
 * 跑一段切分。
 *
 * **不能直接把该段的 K 线切出来喂进去** —— 那样 300 根预热会在每段内部重来一遍，
 * 测试集（272 根）短于预热就永远是 0 笔。这里改成「喂到 split.to 为止的全部历史，
 * 但预热到 split.from 才开始判」，判定区间才真是这一段。理由见 calibrate.ts
 * 的 warmupForSplit()。
 *
 * **但净值曲线必须切回本段**（2026-08-12 修）：`simulateCode` 对喂进去的每一根都
 * push 一个净值点，预热段那些点也在里面。不切的话 `bars` 是「数据起点 → split.to」
 * 而不是本段长度，于是：
 * - `annualized` 用错误的年数折算 —— 验证集实测被压小 **5.1 倍**（0.17% ↔ 0.87%）；
 * - `sharpe` 被一串 0 收益稀释，约 ×√(本段/全长)（验证集 ≈ 0.44）；
 * - `benchmarkReturn` 更离谱：验证集拿的是 2018→2025-06 的指数涨跌，
 *   跟只赚了 18 个月的策略收益相减，`excessReturn` 直接没有意义。
 * 段内排名不受影响（每个候选的 `bars` 一样），但**跨段的 Calmar 衰减红线是坏的** ——
 * 2026-08-12 那轮 16 个候选里它对 3 个报了「衰减超过 50%」，修正后全是 −43% ~ −78%
 * 的**改善**，三个全是假阳性。见 M2 §5.14。
 * `totalReturn` 与 `maxDrawdown` 不受影响（预热段净值恒等于初始资金）。
 *
 * **2026-08-13 起还返回折单元**（`SplitRun.cells`）：横截面折 = 按标的子集重新合并净值，
 * 时间片 = 把判定区间等分。两者都是**从同一批模拟结果里切出来的**，一折都不多跑模拟 ——
 * 39 只 × 一个候选的一段模拟要 50 秒上下，靠重跑攒离散度是负担不起的，
 * 而离散度是「这个差值算不算数」的唯一依据（M2 §5.15）。
 * 单折的绩效**不可与 `overall` 横向比较**（窗口短、标的少、回撤分母小），
 * 它只用于同一折上两个候选之差。
 */
function runSplit(
  loaded: Loaded,
  params: EngineParams,
  options: CliOptions,
  views: { sentiment: SentimentLookup; byDate: Map<TradeDate, number> },
  split: Split,
  groups: readonly SecCode[][]
): SplitRun {
  const costs = resolveCosts(options)
  const floor = options.warmup ?? params.data.fullBars
  const results = loaded.series.map((series) => {
    const candles = series.candles.filter((c) => c.date <= split.to)
    // 退市日晚于本段末尾时 simulateCode 自己会跳过（判据是「末根 >= delistedAt」），
    // 所以这里无条件传：一只 2024 退市的票在训练段（截到 2023）里仍是正常的未平仓
    const delistedAt = loaded.delistedAt.get(series.profile.code)
    return simulateCode(
      { profile: series.profile, candles },
      {
        params,
        costs,
        capitalPerCode: options.capital,
        lookback: options.lookback,
        warmupBars: warmupForSplit(
          candles.map((c) => c.date),
          split,
          floor
        ),
        ...(delistedAt === undefined ? {} : { delistedAt }),
      },
      views.sentiment
    )
  })

  const blockOf = (subset: readonly CodeResult[], from: TradeDate, to: TradeDate): PerformanceBlock => {
    const equity = mergeEquity(subset, views.byDate).filter((p) => p.date >= from && p.date <= to)
    const trades = subset.flatMap((r) => r.trades).filter((t) => t.entryDate >= from && t.entryDate <= to)
    return performanceOf(equity, trades)
  }

  const overall = blockOf(results, split.from, split.to)
  // 折单元由**同一批模拟结果**切出来：横截面按标的子集重新合并净值，时间上按判定区间等分。
  // 因此折数怎么加都不多跑一次模拟 —— 这是这套判据能负担得起的原因。
  const dates = mergeEquity(results, views.byDate)
    .map((p) => p.date)
    .filter((date) => date >= split.from && date <= split.to)
  const cells: SplitRun['cells'] = timeSlices(dates, options.timeSlices).flatMap((slice, s) =>
    groups.map((group, g) => {
      const subset = results.filter((r) => group.includes(r.code))
      return { name: `g${g + 1}/p${s + 1}`, block: blockOf(subset, slice.from, slice.to) }
    })
  )

  return { overall, cells }
}

function writeJson(file: string, payload: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions | 'help'
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 1
  }
  if (options === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  try {
    return options.grid ? await runCalibration(options) : await runBacktest(options)
  } catch (error) {
    process.stderr.write(`[backtest] 失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// tsx 直接跑本文件时才执行；被测试 import 时不执行
const invokedDirectly = process.argv[1]?.endsWith('cli.ts') === true
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

export type { SecCode }
