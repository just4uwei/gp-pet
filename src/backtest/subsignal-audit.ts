#!/usr/bin/env node
/**
 * 子信号触发审计。
 *
 * ```bash
 * pnpm audit:subsignals -- --codes SH600000,SZ000001 --fixtures ./data/history --to 2026-08-11
 * ```
 *
 * **为什么需要这个工具**：2026-08-12 标定 R1–R4 时发现 `R2_REVERT_TO_MID` 对它唯一的参数
 * `revertLookback` **完全惰性** —— 取 2 / 3 / 5 的回测结果逐位相同（M2 §5.10）。
 * 「参数调不动结果」有两种完全不同的成因，对策相反：
 *
 * | 成因 | 症状 | 对策 |
 * |---|---|---|
 * | 参数不是约束项 | 这个条件几乎总成立，卡住的是别的条件 | 改另一个条件，或接受这个参数无用 |
 * | 参数所在的条件与别的条件时间常数不匹配 | 两个条件都要，但极少同时成立 | 重新论证触发条件（docs/04 §3.2） |
 *
 * 区分这两者要看**分解到每个合取项的命中数**，以及「其余条件都成立时，这个参数需要多大
 * 才能救回来」的距离分布。回测报告只给最终笔数，看不见这一层。
 *
 * 与 [`regime-audit.ts`](./regime-audit.ts) 同一个立场：**只统计，不改参数**。
 *
 * ## 复写风险与自检
 *
 * regime-audit 能只读 regime 层发布的 `evidence`，因为那一层每根都发布判定依据。
 * 子信号不同 —— **不成立时它根本不产出草稿**，没有 evidence 可读。所以近失分析只能就地
 * 重算合取项，而「审计与被审计对象一起错」的风险是真的。
 *
 * 对策是把重算的部分**钉在真值上**：同一根上跑一次 `evaluate()`，用它实际产出的 R2 数量
 * 与本工具重算出的「三项合取都成立」数量比对，**不一致就报错退出**（不是打个 warning）。
 * 这样重算逻辑漂移会立刻暴露，而不是产出一份看起来合理的假报告。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode } from '../core/code'
import { CONTINUOUS_MINUTES } from '../core/session'
import { evaluate } from '../core/engine'
import { aggregateWeekly } from '../core/indicators/weekly'
import { at, crossDown, crossUp, existsWithin } from '../core/indicators/series'
import {
  DEFAULT_PARAMS,
  engineVersionOf,
  withParams,
  type EngineParams,
  type ParamOverrides,
} from '../core/params'
import type { Candle, EngineContext, Series, TradeDate } from '../core/types'
import { USAGE, parseArgs, type CliOptions } from './args'
import { openFixtureSource, openSqliteSource, sentimentSeries, type LoadedSeries } from './data'

type Counter = Record<string, number>

function bump(counter: Counter, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by
}

export interface SubSignalTally {
  /** 跑过 evaluate() 的判定根数 */
  judged: number
  /** 数据不足、策略层没跑的根数 */
  unusable: number
  /** 每个子信号 ID × 方向的实际触发数（来自 evaluate()，是真值） */
  fired: Counter
  /** R2 的三个合取项各自的命中数（一根可同时命中多项） */
  r2Conjunct: Counter
  /** R2 「只差一项」分布 —— 缺哪一项最多 */
  r2NearMiss: Counter
  /** 其余两项成立时，最近一次「收在轨道外」距今几根（0 = 当根，见下文说明） */
  r2Distance: Counter
  /** 其余两项成立、且 window 根内确有轨道外 → 这就是 R2 能成立的根数 */
  r2Recomputed: number
  /** evaluate() 实际产出的 R2 数（自检基准） */
  r2Actual: number
  /**
   * R2 触发那一根上，**同方向**的其他均值回归子信号共现情况。
   *
   * 为什么要测：组合层要求 `votesByStrategy.meanReversion ≥ 2`，而一票的门槛是
   * `sub.score ≥ 0.5`（combine/index.ts）。R2 单独一条永远凑不够票 —— 它能否影响
   * 最终信号，取决于同一根上有没有别的 R 信号陪它。
   */
  r2CoOccur: Counter
  /** R2 自己的 score 是否够一票 */
  r2Vote: Counter
}

export function emptyTally(): SubSignalTally {
  return {
    judged: 0,
    unusable: 0,
    fired: {},
    r2Conjunct: {},
    r2NearMiss: {},
    r2Distance: {},
    r2Recomputed: 0,
    r2Actual: 0,
    r2CoOccur: {},
    r2Vote: {},
  }
}

/** 距今 `d` 根处是否收在轨道外；返回最小的 d（1 起，因为 d = 0 与「收在中轨上方」互斥） */
function distanceToExcursion(
  candles: readonly Candle[],
  band: Series,
  index: number,
  side: 'BELOW' | 'ABOVE',
  maxBack: number
): number | null {
  for (let d = 0; d <= maxBack && index - d >= 0; d++) {
    const j = index - d
    const close = candles[j]?.closeAdj ?? null
    const level = at(band, j)
    if (close === null || level === null) continue
    if (side === 'BELOW' ? close < level : close > level) return d
  }
  return null
}

/**
 * R2 的三项合取分解（docs/04 §3.2，2026-08-12 改写后的口径）：
 *   ① 近 `revertLookback` 根内曾收在轨道外
 *   ② 今日**上穿/下穿**中轨（事件，相邻两根间判定一次）
 *   ③ MACD 柱朝有利方向变化（软确认，不要求过零）
 *
 * ① 的窗口用 `existsWithin(i, window, …)`，它含当根。当根收在下轨外与「上穿中轨」互斥，
 * 所以 ① 在当根上永不成立，**有效回溯只有 window − 1 根** ——`revertLookback = 1` 会让
 * R2 彻底死掉。这条在改写前后都成立，文档里要写明。
 */
function auditR2(
  params: EngineParams,
  window: readonly Candle[],
  indicators: {
    boll: { upper: Series; lower: Series; mid: Series }
    macd: { hist: Series }
  },
  tally: SubSignalTally
): void {
  const localIndex = window.length - 1
  const closes = window.map((candle) => candle.closeAdj)
  const hist = at(indicators.macd.hist, localIndex)
  const histPrev = at(indicators.macd.hist, localIndex - 1)

  const lookback = params.strategy.revertLookback
  const crossedUp = crossUp(closes, indicators.boll.mid, localIndex)
  const crossedDown = crossDown(closes, indicators.boll.mid, localIndex)
  const improving = hist !== null && histPrev !== null && hist > histPrev
  const weakening = hist !== null && histPrev !== null && hist < histPrev

  for (const side of ['BUY', 'SELL'] as const) {
    const crossedMid = side === 'BUY' ? crossedUp : crossedDown
    const turned = side === 'BUY' ? improving : weakening
    const band = side === 'BUY' ? indicators.boll.lower : indicators.boll.upper
    const excursion = existsWithin(localIndex, lookback, (j) => {
      const c = window[j]?.closeAdj ?? null
      const level = at(band, j)
      return c !== null && level !== null && (side === 'BUY' ? c < level : c > level)
    })

    if (excursion) bump(tally.r2Conjunct, `${side} ①近 ${lookback} 根内曾收在轨道外`)
    if (crossedMid) bump(tally.r2Conjunct, `${side} ②穿越中轨`)
    if (turned) bump(tally.r2Conjunct, `${side} ③MACD 柱朝有利方向`)

    const missing = [
      excursion ? null : '①轨道外',
      crossedMid ? null : '②穿中轨',
      turned ? null : '③柱变化',
    ].filter((m): m is string => m !== null)
    if (missing.length === 1 && missing[0]) bump(tally.r2NearMiss, `${side} 只差 ${missing[0]}`)
    if (missing.length === 0) tally.r2Recomputed++

    // 关键测量：②③ 都成立时，把 ① 的窗口放到多大才够？
    if (crossedMid && turned) {
      const d = distanceToExcursion(window, band, localIndex, side === 'BUY' ? 'BELOW' : 'ABOVE', 60)
      bump(tally.r2Distance, d === null ? `${side} 60 根内没有轨道外` : `${side} ${String(d).padStart(2, '0')} 根前`)
    }
  }
}

function auditSeries(
  series: LoadedSeries,
  params: EngineParams,
  options: CliOptions,
  sentimentAt: (date: TradeDate) => number,
  tally: SubSignalTally
): void {
  const candles = series.candles
  const warmup = options.warmup ?? params.data.fullBars

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue
    // 判定根集合与 simulate.ts 逐条对齐，否则占比与回测报告对不上号
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
    }
    const evaluation = evaluate(ctx, params)
    if (!evaluation) continue

    tally.judged++
    if (!evaluation.sufficiency.usable) {
      tally.unusable++
      continue
    }

    const subs = evaluation.signal.subSignals
    for (const sub of subs) {
      bump(tally.fired, `${sub.id} ${sub.direction}`)
      if (sub.id !== 'R2_REVERT_TO_MID') continue
      tally.r2Actual++
      bump(tally.r2Vote, sub.score >= 0.5 ? 'R2 自己够一票（score ≥ 0.5）' : 'R2 自己不够一票')
      const peers = subs.filter(
        (other) =>
          other !== sub && other.strategy === 'MEAN_REVERSION' && other.direction === sub.direction
      )
      const voting = peers.filter((other) => other.score >= 0.5)
      bump(tally.r2CoOccur, `同根同向的其他 R 信号 ${peers.length} 条`)
      bump(tally.r2CoOccur, `其中够一票的 ${voting.length} 条`)
      for (const peer of voting) bump(tally.r2CoOccur, `  陪跑：${peer.id}`)
    }

    auditR2(params, window, evaluation.indicators, tally)
  }
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

export function render(tally: SubSignalTally, params: EngineParams, codes: number): string {
  const total = tally.judged
  const pct = (n: number): string => (total === 0 ? '  —  ' : `${((n / total) * 100).toFixed(2)}%`)
  const lines: string[] = []
  const rule = '─'.repeat(74)

  lines.push(rule)
  lines.push(`子信号触发审计 · ${codes} 只 · ${total} 根判定 · ${engineVersionOf(params)}`)
  lines.push(`revertLookback = ${params.strategy.revertLookback}（有效回溯 ${params.strategy.revertLookback - 1} 根，见工具头注）`)
  lines.push(rule)

  lines.push('【各子信号实际触发数】（来自 evaluate()，未经组合层裁决）')
  const fired = Object.entries(tally.fired).sort((a, b) => b[1] - a[1])
  if (fired.length === 0) lines.push('  （无）')
  for (const [key, n] of fired) lines.push(`  ${key.padEnd(28)} ${String(n).padStart(7)}  ${pct(n).padStart(7)}`)

  lines.push('')
  lines.push('【R2 三项合取各自的命中数】（一根可同时命中多项）')
  for (const [key, n] of Object.entries(tally.r2Conjunct).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${key.padEnd(34)} ${String(n).padStart(7)}  ${pct(n).padStart(7)}`)
  }

  lines.push('')
  lines.push('【R2 只差一项】（缺哪一项最多 = 真正卡住它的是谁）')
  const near = Object.entries(tally.r2NearMiss).sort((a, b) => b[1] - a[1])
  if (near.length === 0) lines.push('  （无）')
  for (const [key, n] of near) lines.push(`  ${key.padEnd(34)} ${String(n).padStart(7)}  ${pct(n).padStart(7)}`)

  lines.push('')
  lines.push('【②③ 都成立时，最近一次「收在轨道外」距今几根】')
  lines.push('  ← 这就是 revertLookback 需要多大才救得回来；01 根前只需 window = 2')
  const dist = Object.entries(tally.r2Distance).sort((a, b) => a[0].localeCompare(b[0]))
  if (dist.length === 0) lines.push('  （②③ 从未同时成立 —— 那么 ① 的窗口取多少都无关，参数惰性由此而来）')
  for (const [key, n] of dist) lines.push(`  ${key.padEnd(34)} ${String(n).padStart(7)}`)

  lines.push('')
  lines.push('【R2 触发那一根的共现情况】（组合层要 meanReversion ≥ 2 票，一票 = score ≥ 0.5）')
  for (const [key, n] of Object.entries(tally.r2Vote).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${key.padEnd(34)} ${String(n).padStart(7)}`)
  }
  for (const [key, n] of Object.entries(tally.r2CoOccur).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${key.padEnd(34)} ${String(n).padStart(7)}`)
  }

  lines.push('')
  lines.push(`自检：evaluate() 产出 R2 ${tally.r2Actual} 条，本工具重算「三项都成立」${tally.r2Recomputed} 根`)
  lines.push(`数据不足未跑策略：${tally.unusable} 根（${pct(tally.unusable)}）`)
  lines.push('※ 本工具只统计，不改参数。写回 params.ts 是人的动作（ADR-0003）。')
  return lines.join('\n')
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
      if (!options.quiet && !options.json) {
        process.stdout.write(`[audit] ${code} 累计 ${tally.judged} 根\n`)
      }
    }
    if (audited === 0) throw new Error('没有任何标的有可用日线')

    // 自检：重算的合取项必须与 evaluate() 的真值一致，否则这份报告不可信
    if (tally.r2Recomputed !== tally.r2Actual) {
      throw new Error(
        `重算与 evaluate() 不一致：重算 ${tally.r2Recomputed} vs 实际 ${tally.r2Actual}。` +
          '说明本工具的合取项分解已与 strategies/mean-reversion.ts 漂移，先修工具再看结论。'
      )
    }

    if (options.json) process.stdout.write(`${JSON.stringify({ audited, ...tally }, null, 2)}\n`)
    else process.stdout.write(`${render(tally, params, audited)}\n`)
    if (options.out) {
      mkdirSync(dirname(options.out), { recursive: true })
      writeFileSync(options.out, `${JSON.stringify({ audited, ...tally }, null, 2)}\n`, 'utf8')
    }
    return 0
  } catch (error) {
    process.stderr.write(`[audit] 失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    source.close()
  }
}

const invokedDirectly = process.argv[1]?.endsWith('subsignal-audit.ts') === true
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
