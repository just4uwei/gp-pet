#!/usr/bin/env node
/**
 * Regime 归因审计。
 *
 * ```bash
 * pnpm audit:regime -- --codes SH600000,SZ000001 --fixtures ./data/history --to 2026-08-11
 * ```
 *
 * **为什么需要这个工具**：2026-08-12 的标定发现引擎 67% 的判定根落在 TRANSITION
 * （docs/notes/M2-偏差报告 §5.4），而 TRANSITION 几乎不出交易。「阈值调不动绩效」
 * 的下一步不是继续调阈值，而是先回答「TRANSITION 到底是怎么来的」——
 * 它有五个互斥的成因，对策完全不同：
 *
 * | 成因 | 含义 | 对策方向 |
 * |---|---|---|
 * | ① 未预热 | `determinate = false`，判定无依据 | 加长预热 / 提高 lookback，与阈值无关 |
 * | ② 突变条件 | ADX/BBW/量能任一突变即强制 TRANSITION | 这三个触发线是否过松（`regime` 块） |
 * | ③ ADX 死区 | ADX 落在 `[adxRange, adxTrend]` 之间 | `rangeGap` 与 `baseThreshold` 的间距 |
 * | ④ 规则不满足 | ADX 够了但排列/DI/MA20 不配合 | 判定条件本身的合理性（docs/04 §2） |
 * | ⑤ 迟滞压制 | 原始判定已切换，但迟滞还没放行 | `hysteresisDays` |
 *
 * 本工具**只统计，不改参数**：输出每个成因的占比、以及「只差一个条件」的近失分布。
 * 它读的是 regime 层自己发布的 `evidence` 字段，而不是复写一遍判定逻辑 ——
 * 复写的话，审计与被审计对象可以一起错。
 *
 * 判定根的取法与 simulate.ts 完全一致（`i >= warmup`、跳过最后一根、跳过 `hasGap`、
 * 窗口是 `lookback` 根切片），否则占比与回测报告对不上号，这份审计就没有意义。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode } from '../core/code'
import { computeIndicators } from '../core/indicators'
import { classifyRegimes } from '../core/regime'
import {
  DEFAULT_PARAMS,
  engineVersionOf,
  withParams,
  type EngineParams,
  type ParamOverrides,
} from '../core/params'
import type { Evidence, Regime, TradeDate } from '../core/types'
import { USAGE, parseArgs, type CliOptions } from './args'
import { openFixtureSource, openSqliteSource, sentimentSeries, type LoadedSeries } from './data'

const REGIMES: readonly Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']

/** Evidence 是宽类型（可能是字符串或布尔），取数值字段要显式收窄 */
function num(evidence: Evidence, key: string): number | null {
  const value = evidence[key]
  return typeof value === 'number' ? value : null
}

type Counter = Record<string, number>

function bump(counter: Counter, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by
}

export interface Tally {
  judged: number
  /** 成因分解，五者互斥且求和等于 judged */
  cause: Counter
  held: Counter
  raw: Counter
  /** 三个突变条件各自的命中数（可同时命中，故求和 ≥ ②） */
  shock: Counter
  /** ADX 相对动态阈值的位置，仅统计 determinate 根 */
  adxBand: Counter
  /** 成因④ 下每条规则各个条件的失败次数 */
  failed: Counter
  /** 成因④ 下「只差一个条件」的规则与条件 */
  nearMiss: Counter
  /** 数值分布：用于判断阈值离实际取值有多远 */
  sums: Counter
  /** 受限模式（bbwPct 恒 null）的根数 —— 这些根 RANGE 不可能成立 */
  bbwNull: number
}

export function emptyTally(): Tally {
  return {
    judged: 0,
    cause: {},
    held: {},
    raw: {},
    shock: {},
    adxBand: {},
    failed: {},
    nearMiss: {},
    sums: {},
    bbwNull: 0,
  }
}

/**
 * 一根判定根的成因归类。
 *
 * 顺序与 rawRegimeAt 的 return 顺序严格一致（预热 → 突变 → TREND_UP → TREND_DOWN
 * → RANGE → 兜底），否则归类会把「被突变抢先」的根算进「规则不满足」。
 */
export function classifyCause(evidence: Evidence, params: EngineParams, raw: Regime, tally: Tally): void {
  const adx = num(evidence, 'adx')
  const adxTrend = num(evidence, 'adxTrend')
  const adxRange = num(evidence, 'adxRange')
  const close = num(evidence, 'close')
  const ma20 = num(evidence, 'ma20')
  const bbwPct = num(evidence, 'bbwPct')
  const midDistance = num(evidence, 'midDistance')
  const plusDI = num(evidence, 'plusDI')
  const minusDI = num(evidence, 'minusDI')
  const bullish = num(evidence, 'bullishAlignment') ?? 0
  const bearish = num(evidence, 'bearishAlignment') ?? 0

  if (close === null || adx === null || adxTrend === null || adxRange === null || ma20 === null) {
    bump(tally.cause, '①未预热')
    return
  }

  if (bbwPct === null) tally.bbwNull++
  bump(tally.sums, 'adx', adx)
  bump(tally.sums, 'adxTrend', adxTrend)
  bump(tally.sums, 'adxN')
  bump(
    tally.adxBand,
    adx > adxTrend ? 'ADX > adxTrend（可判趋势）' : adx < adxRange ? 'ADX < adxRange（可判震荡）' : '死区 adxRange..adxTrend'
  )

  const adxJump = num(evidence, 'adxChange3')
  const bbwJump = num(evidence, 'bbwPctChange3')
  const volRatio = num(evidence, 'volRatio')
  const adxShock = adxJump !== null && Math.abs(adxJump) > params.regime.adxSlopeTrigger
  const bbwShock = bbwJump !== null && Math.abs(bbwJump) > params.regime.bbwPctJump
  const volShock = volRatio !== null && volRatio > params.volume.suspiciousRatio
  if (adxShock) bump(tally.shock, `ADX 3 日变化 > ${params.regime.adxSlopeTrigger}`)
  if (bbwShock) bump(tally.shock, `BBW 分位 3 日变化 > ${params.regime.bbwPctJump}`)
  if (volShock) bump(tally.shock, `量比 > ${params.volume.suspiciousRatio}`)

  if (adxShock || bbwShock || volShock) {
    bump(tally.cause, '②突变条件')
    // 只有一个突变命中时，它就是那根的唯一责任人 —— 用于判断哪条触发线最该复核
    const hits = [adxShock, bbwShock, volShock].filter(Boolean).length
    if (hits === 1) {
      bump(tally.shock, `独因：${adxShock ? 'ADX' : bbwShock ? 'BBW' : '量比'}`)
    }
    return
  }

  if (raw !== 'TRANSITION') {
    bump(tally.cause, `命中 ${raw}`)
    return
  }

  // ── 成因③/④：走到这里说明三条规则都不满足，逐条记下缺哪个条件 ──────────
  const rules: { rule: string; conditions: { name: string; ok: boolean }[] }[] = [
    {
      rule: 'TREND_UP',
      conditions: [
        { name: 'ADX > adxTrend', ok: adx > adxTrend },
        { name: '+DI > -DI', ok: plusDI !== null && minusDI !== null && plusDI > minusDI },
        { name: 'close > MA20', ok: close > ma20 },
        { name: '多头排列 ≥ 2', ok: bullish >= 2 },
      ],
    },
    {
      rule: 'TREND_DOWN',
      conditions: [
        { name: 'ADX > adxTrend', ok: adx > adxTrend },
        { name: '-DI > +DI', ok: plusDI !== null && minusDI !== null && minusDI > plusDI },
        { name: 'close < MA20', ok: close < ma20 },
        { name: '空头排列 ≥ 2', ok: bearish >= 2 },
      ],
    },
    {
      rule: 'RANGE',
      conditions: [
        { name: 'ADX < adxRange', ok: adx < adxRange },
        {
          name: `BBW 分位 < ${params.regime.rangeBbwPct}`,
          ok: bbwPct !== null && bbwPct < params.regime.rangeBbwPct,
        },
        {
          name: `|close-MID|/MID < ${params.regime.rangeMidBand}`,
          ok: midDistance !== null && midDistance < params.regime.rangeMidBand,
        },
      ],
    },
  ]

  const adxTrendable = adx > adxTrend
  const adxRangeable = adx < adxRange
  bump(tally.cause, !adxTrendable && !adxRangeable ? '③ADX 死区' : '④规则不满足')

  for (const { rule, conditions } of rules) {
    const missing = conditions.filter((c) => !c.ok)
    for (const condition of missing) bump(tally.failed, `${rule} · ${condition.name}`)
    if (missing.length === 1 && missing[0]) bump(tally.nearMiss, `${rule} · 只差「${missing[0].name}」`)
  }
}

function auditSeries(
  series: LoadedSeries,
  params: EngineParams,
  options: CliOptions,
  sentimentAt: (date: TradeDate) => number,
  tally: Tally
): void {
  const candles = series.candles
  const warmup = options.warmup ?? params.data.fullBars

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue
    // 与 simulate.ts 的判定根集合逐条对齐
    if (i < warmup || i >= candles.length - 1) continue
    if (bar.hasGap === true) continue

    const from = Math.max(0, i - options.lookback + 1)
    const window = candles.slice(from, i + 1)
    const indicators = computeIndicators(window, params, {
      sentiment: sentimentAt(bar.date),
      intradayProgress: 1,
    })
    const states = classifyRegimes(window, indicators, params)
    const state = states[states.length - 1]
    if (!state) continue

    tally.judged++
    bump(tally.held, state.regime)
    bump(tally.raw, state.raw)
    classifyCause(state.evidence, params, state.raw, tally)
    if (state.raw !== state.regime) bump(tally.cause, '⑤迟滞压制（原始≠生效）')
    if (state.raw !== 'TRANSITION' && state.regime === 'TRANSITION') {
      bump(tally.cause, '⑤其中：原始已非 TRANSITION，生效仍是')
    }
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

function render(tally: Tally, params: EngineParams, codes: number): string {
  const total = tally.judged
  const pct = (n: number): string => (total === 0 ? '  —  ' : `${((n / total) * 100).toFixed(1)}%`)
  const lines: string[] = []
  const rule = '─'.repeat(70)

  lines.push(rule)
  lines.push(`Regime 归因审计 · ${codes} 只 · ${total} 根判定 · ${engineVersionOf(params)}`)
  lines.push(rule)

  lines.push('【生效状态分布】（带迟滞，策略层看到的就是这个）')
  for (const regime of REGIMES) {
    const n = tally.held[regime] ?? 0
    lines.push(`  ${regime.padEnd(12)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  lines.push('')
  lines.push('【原始判定分布】（不含迟滞）')
  for (const regime of REGIMES) {
    const n = tally.raw[regime] ?? 0
    lines.push(`  ${regime.padEnd(12)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  lines.push('')
  lines.push('【TRANSITION 成因分解】（①–④ 互斥且求和 = 判定根数；⑤ 与前四者交叉，单列）')
  const causeOrder = [
    '①未预热',
    '②突变条件',
    '③ADX 死区',
    '④规则不满足',
    '命中 TREND_UP',
    '命中 TREND_DOWN',
    '命中 RANGE',
    '⑤迟滞压制（原始≠生效）',
    '⑤其中：原始已非 TRANSITION，生效仍是',
  ]
  for (const key of causeOrder) {
    const n = tally.cause[key] ?? 0
    if (n === 0 && !key.startsWith('①')) continue
    lines.push(`  ${key.padEnd(38)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  lines.push('')
  lines.push('【突变条件命中】（可同时命中，故求和 ≥ ②）')
  for (const [key, n] of Object.entries(tally.shock).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${key.padEnd(38)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  lines.push('')
  const adxN = tally.sums['adxN'] ?? 0
  const meanAdx = adxN > 0 ? (tally.sums['adx'] ?? 0) / adxN : null
  const meanTrend = adxN > 0 ? (tally.sums['adxTrend'] ?? 0) / adxN : null
  lines.push('【ADX 相对动态阈值】（仅 determinate 根）')
  lines.push(
    `  ADX 均值 ${meanAdx === null ? '—' : meanAdx.toFixed(2)} · adxTrend 均值 ${
      meanTrend === null ? '—' : meanTrend.toFixed(2)
    } · 死区宽度 rangeGap = ${params.adx.rangeGap}`
  )
  for (const [key, n] of Object.entries(tally.adxBand).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${key.padEnd(38)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  lines.push('')
  lines.push('【成因③/④ 下各条件的失败次数】（一根可同时缺多个条件）')
  for (const [key, n] of Object.entries(tally.failed).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${key.padEnd(38)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  lines.push('')
  lines.push('【只差一个条件】（改哪个阈值最可能把这些根救回来）')
  const nearMiss = Object.entries(tally.nearMiss).sort((a, b) => b[1] - a[1])
  if (nearMiss.length === 0) lines.push('  （无）')
  for (const [key, n] of nearMiss) {
    lines.push(`  ${key.padEnd(46)} ${String(n).padStart(7)}  ${pct(n).padStart(6)}`)
  }

  if (tally.bbwNull > 0) {
    lines.push('')
    lines.push(
      `※ ${tally.bbwNull} 根（${pct(tally.bbwNull)}）的 BBW 分位为 null（受限模式）—— 这些根 RANGE 不可能成立`
    )
  }
  lines.push('※ 本工具只统计，不改参数。阈值写回 params.ts 是人的动作（ADR-0003）。')
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
    // 情绪只影响 RSI 阈值，不影响 regime 判定；但 computeIndicators 要它，所以照实给
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

const invokedDirectly = process.argv[1]?.endsWith('regime-audit.ts') === true
if (invokedDirectly) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
