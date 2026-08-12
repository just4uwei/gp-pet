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
import { calibrate, expandGrid, renderCalibration, DEFAULT_SPLITS, type GridSpec, type Split } from './calibrate'
import { DEFAULT_COSTS, type CostModel } from './costs'
import { openFixtureSource, openSqliteSource, sentimentSeries, type DataSource, type LoadedSeries } from './data'
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

function resolveParams(options: CliOptions): EngineParams {
  let overrides: ParamOverrides = {}
  if (options.params) {
    const parsed: unknown = JSON.parse(readFileSync(options.params, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`--params 文件不是 JSON 对象：${options.params}`)
    }
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

  return { series, benchmark, source }
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
  return loaded.series.map((series) =>
    simulateCode(
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
      },
      sentiment
    )
  )
}

/** 固定 0.5/0.5 权重对照组：M2 出口条件要回答「权重切换是否有效」 */
function fixedWeightParams(params: EngineParams): EngineParams {
  const flat = { trend: 0.5, meanReversion: 0.5 }
  return withParams(
    {
      weights: {
        TREND_UP: flat,
        TREND_DOWN: { ...flat, meanReversionBuyPenalty: 1 },
        RANGE: flat,
        TRANSITION: flat,
      },
    },
    params
  )
}

async function runBacktest(options: CliOptions): Promise<number> {
  const range = { from: options.from, to: options.to }
  const params = resolveParams(options)
  const loaded = await loadAll(options, range)
  const views = benchmarkViews(loaded.benchmark)

  try {
    log(options, `[backtest] ${loaded.series.length} 只 · ${range.from} → ${range.to} · ${loaded.source.description}`)
    const results = runSimulation(loaded, params, options, views.sentiment, range)
    const fixed = options.fixedWeights
      ? runSimulation(loaded, fixedWeightParams(params), options, views.sentiment, range)
      : undefined

    const report = assembleReport({
      results,
      ...(fixed ? { fixedWeightResults: fixed } : {}),
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

  try {
    const report = calibrate({
      candidates,
      base: resolveParams(options),
      splits,
      log: (message) => log(options, message),
      run: (params, split) => runSplit(loaded, params, options, views, split),
    })

    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else process.stdout.write(`${renderCalibration(report)}\n`)
    if (options.out) writeJson(options.out, report)
    return report.winner ? 0 : 2
  } finally {
    loaded.source.close()
  }
}

function runSplit(
  loaded: Loaded,
  params: EngineParams,
  options: CliOptions,
  views: { sentiment: SentimentLookup; byDate: Map<TradeDate, number> },
  split: Split
): PerformanceBlock {
  const results = runSimulation(loaded, params, options, views.sentiment, split)
  const equity = mergeEquity(results, views.byDate)
  return performanceOf(
    equity,
    results.flatMap((r) => r.trades)
  )
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
