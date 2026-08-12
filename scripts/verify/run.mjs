/**
 * 指标交叉验证 · 黄金用例固化（docs/07 §2.1）。
 *
 * ```bash
 * pnpm verify:indicators          # 重新生成 fixture 与黄金值
 * pnpm verify:indicators -- --check   # 只校验现有黄金值仍与参照实现一致
 * ```
 *
 * 流程：
 *   ① 用固定种子生成 500 根合成日线 → tests/fixtures/klines/synthetic-500.json
 *   ② 用**独立参照实现**（reference.mjs，不 import src/core）算出各指标
 *   ③ 抽样固化为 tests/fixtures/golden/indicators.json
 *   ④ 由 tests/unit/indicators/golden.test.ts 断言生产实现与之一致（容差 1e-6）
 *
 * 于是「我们的实现对不对」这个问题被拆成两半：
 *   - 与另一套独立实现是否一致 → 由本脚本 + 那条用例回答（自动化）
 *   - 口径是否与国内行情软件一致 → 只能人工比对截图，见 README.md（**尚未执行**）
 *
 * 黄金值**只抽样存**（前 30 根、每 25 根、后 30 根）。EMA / Wilder 是递推的，
 * 中段算错必然传到尾部；BBW 分位窗口 250 根，尾部值也覆盖了中段。
 * 全存 500×20 个数只是让 diff 变得没法看。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { referenceIndicators } from './reference.mjs'
import { syntheticCandles } from './synthetic.mjs'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..')
const KLINE_FILE = join(ROOT, 'tests/fixtures/klines/synthetic-500.json')
const GOLDEN_FILE = join(ROOT, 'tests/fixtures/golden/indicators.json')
const BARS = 500
const SEED = 20260811
const TOLERANCE = 1e-6

/**
 * 生成黄金值时用的参数。**必须与 src/core/params.ts 的 DEFAULT_PARAMS 一致** ——
 * 一致性由 golden.test.ts 断言：改了 params.ts 却忘了重跑本脚本时，
 * 那条用例会直接指出「黄金值是用旧参数算的」，而不是给出一堆看不懂的数值差。
 */
const PARAMS = {
  ma: { periods: [5, 10, 20, 60, 120] },
  macd: { fast: 12, slow: 17, signal: 9 },
  boll: { period: 20, k: 2, bbwLookback: 250 },
  adx: { period: 14, baseThreshold: 20, volScale: 8, maxThreshold: 28, rangeGap: 5 },
  rsi: { period: 14 },
  volume: { maPeriod: 20 },
}

function sampleIndices(n) {
  const set = new Set()
  for (let i = 0; i < Math.min(30, n); i++) set.add(i)
  for (let i = Math.max(0, n - 30); i < n; i++) set.add(i)
  for (let i = 0; i < n; i += 25) set.add(i)
  return [...set].sort((a, b) => a - b)
}

function sampleSeries(series, indices) {
  const out = {}
  for (const i of indices) {
    const value = series[i]
    out[i] = value === null || value === undefined ? null : round(value)
  }
  return out
}

/** 存 12 位有效数字：容差是 1e-6 的相对误差，存太多位只是让 JSON 更长 */
function round(value) {
  return Number(value.toPrecision(12))
}

function flatten(indicators, indices) {
  const out = {}
  for (const [period, series] of Object.entries(indicators.ma)) {
    out[`ma${period}`] = sampleSeries(series, indices)
  }
  out['macd.dif'] = sampleSeries(indicators.macd.dif, indices)
  out['macd.dea'] = sampleSeries(indicators.macd.dea, indices)
  out['macd.hist'] = sampleSeries(indicators.macd.hist, indices)
  out['boll.mid'] = sampleSeries(indicators.boll.mid, indices)
  out['boll.upper'] = sampleSeries(indicators.boll.upper, indices)
  out['boll.lower'] = sampleSeries(indicators.boll.lower, indices)
  out['boll.bbw'] = sampleSeries(indicators.boll.bbw, indices)
  out['boll.bbwPct'] = sampleSeries(indicators.boll.bbwPct, indices)
  out['dmi.adx'] = sampleSeries(indicators.dmi.adx, indices)
  out['dmi.plusDI'] = sampleSeries(indicators.dmi.plusDI, indices)
  out['dmi.minusDI'] = sampleSeries(indicators.dmi.minusDI, indices)
  out['dmi.atr'] = sampleSeries(indicators.dmi.atr, indices)
  out['rsi'] = sampleSeries(indicators.rsi, indices)
  out['volMa'] = sampleSeries(indicators.volMa, indices)
  out['volRatio'] = sampleSeries(indicators.volRatio, indices)
  out['thresholds.adxTrend'] = sampleSeries(indicators.thresholds.adxTrend, indices)
  out['thresholds.adxRange'] = sampleSeries(indicators.thresholds.adxRange, indices)
  out['thresholds.volPct'] = sampleSeries(indicators.thresholds.volPct, indices)
  return out
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function compare(expected, actual) {
  const problems = []
  for (const [key, series] of Object.entries(expected)) {
    const other = actual[key]
    if (!other) {
      problems.push(`${key}: 缺失`)
      continue
    }
    for (const [index, value] of Object.entries(series)) {
      const got = other[index]
      if (value === null || got === null) {
        if (value !== got) problems.push(`${key}[${index}]: 期望 ${value}，实际 ${got}`)
        continue
      }
      const denominator = Math.max(1e-12, Math.abs(value))
      if (Math.abs(value - got) / denominator > TOLERANCE) {
        problems.push(`${key}[${index}]: 期望 ${value}，实际 ${got}`)
      }
    }
  }
  return problems
}

function main() {
  const check = process.argv.includes('--check')
  const candles = syntheticCandles(BARS, SEED)
  const indicators = referenceIndicators(candles, PARAMS)
  const indices = sampleIndices(candles.length)
  const golden = {
    generatedBy: 'scripts/verify/run.mjs',
    note: '由 scripts/verify/reference.mjs 的独立参照实现算出，不是从生产代码抄的。改参数后须重跑。',
    seed: SEED,
    bars: BARS,
    tolerance: TOLERANCE,
    params: PARAMS,
    klineFixture: 'tests/fixtures/klines/synthetic-500.json',
    sampleIndices: indices,
    indicators: flatten(indicators, indices),
  }

  if (check) {
    if (!existsSync(GOLDEN_FILE) || !existsSync(KLINE_FILE)) {
      console.error('[verify] 黄金用例或 K 线 fixture 不存在，先跑一次 pnpm verify:indicators')
      process.exitCode = 1
      return
    }
    const storedCandles = JSON.parse(readFileSync(KLINE_FILE, 'utf8'))
    if (JSON.stringify(storedCandles) !== JSON.stringify(candles)) {
      console.error('[verify] K 线 fixture 与固定种子的生成结果不一致 —— fixture 被手改过？')
      process.exitCode = 1
      return
    }
    const stored = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'))
    const problems = compare(stored.indicators, golden.indicators)
    if (problems.length > 0) {
      console.error(`[verify] 黄金值与参照实现不一致（${problems.length} 处）：`)
      for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`[verify] 黄金值与参照实现一致（${Object.keys(golden.indicators).length} 条序列）`)
    return
  }

  writeJson(KLINE_FILE, candles)
  writeJson(GOLDEN_FILE, golden)
  console.log(`[verify] 已写入 ${BARS} 根合成日线与 ${Object.keys(golden.indicators).length} 条黄金序列`)
  console.log('[verify] 生产实现与之的一致性由 tests/unit/indicators/golden.test.ts 断言')
}

main()
