/**
 * 形态样本（docs/07 §5 的 `fixtures/klines/`）。
 *
 * 全部**确定性生成**，不用 Math.random：策略测试断言的是「这段 K 线该产出哪些子信号」，
 * 而随机 fixture 会让同一条断言今天过明天不过。
 *
 * 价格路径都用「一段带噪音的横盘 + 一段有意为之的形态」拼出来：
 *   - 横盘段必须**带噪音**（不能真的一条直线）—— 真直线会让 STD=0、BBW 恒为 0，
 *     带宽分位退化成常量 100，于是所有依赖「带宽上升」的规则永远不成立，
 *     测出来的「不触发」是假通过。
 *   - 长度默认 320 根：BBW 分位要 269 根才有首值（见 core/indicators/boll.ts），
 *     短于此的 fixture 会让 T3 / R3 静默失效。
 */

import { addDays, isWeekend } from '@core/date'
import type { Candle, TradeDate } from '@core/types'

export interface BarOverride {
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  amount?: number | null
  provisional?: boolean
  hasGap?: boolean
}

export interface BuildOptions {
  startDate?: TradeDate
  /** 每根的成交量；给函数则按下标取 */
  volume?: number | ((index: number) => number)
  /** 前复权系数（closeAdj / close）。默认 1，即两套价格相同 */
  factor?: number
  overrides?: Record<number, BarOverride>
}

/** 从起始日开始的连续工作日（不查节假日 —— 那会引入 hasGap，缺口有自己的用例） */
export function weekdaysFrom(start: TradeDate, count: number): TradeDate[] {
  const dates: TradeDate[] = []
  let cursor = start
  while (dates.length < count) {
    if (!isWeekend(cursor)) dates.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return dates
}

/**
 * 用收盘序列造 K 线。开盘取上一根收盘，高低价按当日振幅外扩 0.5%
 * —— 形状不重要，重要的是 `high ≥ max(open,close)`、`low ≤ min(open,close)`，
 * 否则 core/quality.ts 会判为非法 K 线。
 */
export function buildCandles(closes: readonly number[], options: BuildOptions = {}): Candle[] {
  const { startDate = '2023-01-02', volume = 1_000_000, factor = 1, overrides = {} } = options
  const dates = weekdaysFrom(startDate, closes.length)

  return closes.map((rawClose, i) => {
    const override = overrides[i] ?? {}
    const close = override.close ?? rawClose
    const open = override.open ?? closes[i - 1] ?? close
    const high = override.high ?? Math.max(open, close) * 1.005
    const low = override.low ?? Math.min(open, close) * 0.995
    const vol = override.volume ?? (typeof volume === 'function' ? volume(i) : volume)
    const candle: Candle = {
      date: dates[i] ?? '2023-01-02',
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      openAdj: round(open * factor),
      highAdj: round(high * factor),
      lowAdj: round(low * factor),
      closeAdj: round(close * factor),
      volume: Math.round(vol),
      amount: override.amount === undefined ? Math.round(vol * close) : override.amount,
    }
    if (override.provisional) candle.provisional = true
    if (override.hasGap) candle.hasGap = true
    return candle
  })
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 带噪音的横盘段。振幅约 ±2%，周期是 7 与 3 的错拍 —— 刻意不用正弦，
 * 免得与均线周期（5/10/20）共振出规律的假交叉。
 */
export function chopCloses(count: number, base = 10, amplitude = 0.02): number[] {
  return Array.from({ length: count }, (_, i) => {
    const wave = ((i % 7) - 3) / 3 + ((i % 3) - 1) / 6
    return base * (1 + amplitude * wave)
  })
}

/** 单调上涨段：每根涨 `step` */
export function rampCloses(count: number, start: number, step: number): number[] {
  return Array.from({ length: count }, (_, i) => start * (1 + step) ** i)
}

// ─────────────────────────── 场景 ───────────────────────────

export interface Scenario {
  name: string
  candles: Candle[]
  /** 该场景意在触发（或明确不该触发）的子信号，供用例自我说明 */
  expect: { fires: string[]; silent: string[] }
}

/**
 * 「一段标准的金叉放量突破」：320 根横盘之后连续 6 根放量拉升。
 *
 * 期望：MA5 上穿 MA20（T1）、收盘越上轨且带宽扩张且放量（T3）、均线多头排列（T4）。
 */
export function goldenCrossBreakout(): Scenario {
  const chop = chopCloses(320)
  const last = chop[chop.length - 1] ?? 10
  const surge = Array.from({ length: 6 }, (_, i) => last * 1.035 ** (i + 1))
  const closes = [...chop, ...surge]
  return {
    name: '金叉放量突破',
    candles: buildCandles(closes, {
      // 拉升段放量 3 倍：量比确认项（≥1.2）要真的成立
      volume: (i) => (i >= chop.length ? 3_000_000 : 1_000_000),
    }),
    expect: { fires: ['T1_MA_CROSS', 'T3_BREAKOUT'], silent: [] },
  }
}

/**
 * 「一段假突破」：同样越上轨，但**缩量**。
 *
 * 期望：T3 不成立（量比确认失败）。这是 docs/04 §3.1 里 T3 那条「量比 ≥ 1.2」的反例，
 * 也是最容易被实现漏掉的确认项。
 */
export function falseBreakout(): Scenario {
  const chop = chopCloses(320)
  const last = chop[chop.length - 1] ?? 10
  const surge = Array.from({ length: 6 }, (_, i) => last * 1.035 ** (i + 1))
  const closes = [...chop, ...surge]
  return {
    name: '缩量假突破',
    candles: buildCandles(closes, {
      // 拉升段反而缩量到 0.5 倍
      volume: (i) => (i >= chop.length ? 500_000 : 1_000_000),
    }),
    expect: { fires: [], silent: ['T3_BREAKOUT'] },
  }
}

/** 「一段震荡」：全程横盘，用于 RANGE 判定与 R4 中轨超调 */
export function rangeBound(): Scenario {
  return {
    name: '震荡',
    candles: buildCandles(chopCloses(340)),
    expect: { fires: [], silent: ['T4_ALIGNMENT'] },
  }
}

/**
 * 「连续跌停」：横盘之后连续 4 根 -10%。
 *
 * 期望：卖出方向被硬抑制（跌停卖不掉，docs/05 §2.1）。
 * 注意跌幅要用**不复权**价算 —— 涨跌停是真实价格的规则。
 */
export function limitDownStreak(): Scenario {
  const chop = chopCloses(320)
  const last = chop[chop.length - 1] ?? 10
  const closes = [...chop]
  let price = last
  for (let i = 0; i < 4; i++) {
    price = round(price * 0.9)
    closes.push(price)
  }
  const overrides: Record<number, BarOverride> = {}
  for (let i = chop.length; i < closes.length; i++) {
    const close = closes[i] ?? 0
    // 一字跌停：开=高=低=收
    overrides[i] = { open: close, high: close, low: close, close }
  }
  return {
    name: '连续跌停',
    candles: buildCandles(closes, { overrides }),
    expect: { fires: [], silent: [] },
  }
}

/** 长期下跌：用于 TREND_DOWN 与「均值回归买入被降权」 */
export function downTrend(): Scenario {
  const chop = chopCloses(200)
  const last = chop[chop.length - 1] ?? 10
  const slide = Array.from({ length: 140 }, (_, i) => last * 0.985 ** (i + 1))
  return {
    name: '下跌趋势',
    candles: buildCandles([...chop, ...slide]),
    expect: { fires: [], silent: [] },
  }
}

/** 读取 scripts/verify 生成的 500 根合成日线（含四段行情，覆盖面最广） */
export const SYNTHETIC_FIXTURE = 'tests/fixtures/klines/synthetic-500.json'
