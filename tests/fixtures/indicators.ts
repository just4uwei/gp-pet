/**
 * 手工构造 `IndicatorSet` 的助手 —— 状态层、策略层、风控层的用例用它。
 *
 * 为什么不都用真实 K 线跑一遍指标：那样一条断言会同时依赖「指标算得对」与
 * 「策略读得对」两件事，失败时分不清是哪一层坏了。指标的正确性已由黄金用例
 * （tests/unit/indicators/golden.test.ts，与独立参照实现比对）保证，
 * 这里要验的是**条件表**（docs/04 §2.1 / §3.1 / §3.2）有没有被如实实现。
 *
 * K 线级别的端到端验证仍然有，在 tests/integration/engine/ ——
 * 那里用 fixtures/klines 的场景样本断言 SubSignal ID 集合（docs/07 §5）。
 */

import type { IndicatorSet, Series } from '@core/types'

/** 数字广播成整条序列；数组按原样用（不足补 null） */
export type SeriesSpec = number | null | readonly (number | null)[]

export interface IndicatorSpec {
  ma?: Record<number, SeriesSpec>
  dif?: SeriesSpec
  dea?: SeriesSpec
  hist?: SeriesSpec
  mid?: SeriesSpec
  upper?: SeriesSpec
  lower?: SeriesSpec
  bbw?: SeriesSpec
  bbwPct?: SeriesSpec
  adx?: SeriesSpec
  plusDI?: SeriesSpec
  minusDI?: SeriesSpec
  atr?: SeriesSpec
  rsi?: SeriesSpec
  volMa?: SeriesSpec
  volRatio?: SeriesSpec
  adxTrend?: SeriesSpec
  adxRange?: SeriesSpec
  rsiOverbought?: SeriesSpec
  rsiOversold?: SeriesSpec
  volPct?: SeriesSpec
}

export function series(length: number, spec: SeriesSpec | undefined): Series {
  const out: Series = new Array<number | null>(length).fill(null)
  if (spec === undefined) return out
  if (spec === null || typeof spec === 'number') return out.fill(spec)
  for (let i = 0; i < length; i++) out[i] = spec[i] ?? null
  return out
}

/**
 * 造一组指标。未指定的序列全为 null —— 这正是「预热未完成」的表示，
 * 于是「忘了给某条序列」的用例会退化成「该条件不成立」，而不是静默地用 0 判定。
 */
export function makeIndicators(length: number, spec: IndicatorSpec = {}): IndicatorSet {
  const ma: Record<number, Series> = {}
  for (const [period, value] of Object.entries(spec.ma ?? {})) {
    ma[Number(period)] = series(length, value)
  }
  return {
    ma,
    macd: {
      dif: series(length, spec.dif),
      dea: series(length, spec.dea),
      hist: series(length, spec.hist),
    },
    boll: {
      mid: series(length, spec.mid),
      upper: series(length, spec.upper),
      lower: series(length, spec.lower),
      bbw: series(length, spec.bbw),
      bbwPct: series(length, spec.bbwPct),
    },
    dmi: {
      adx: series(length, spec.adx),
      plusDI: series(length, spec.plusDI),
      minusDI: series(length, spec.minusDI),
      atr: series(length, spec.atr),
    },
    rsi: series(length, spec.rsi),
    volMa: series(length, spec.volMa),
    volRatio: series(length, spec.volRatio),
    thresholds: {
      adxTrend: series(length, spec.adxTrend ?? 24),
      adxRange: series(length, spec.adxRange ?? 19),
      rsiOverbought: series(length, spec.rsiOverbought ?? 75),
      rsiOversold: series(length, spec.rsiOversold ?? 25),
      volPct: series(length, spec.volPct ?? 0.5),
    },
  }
}

/** 数据充分（无折价）的默认充分性结论 */
export const FULL_SUFFICIENCY = {
  bars: 400,
  usable: true,
  limited: false,
  penalty: 1,
  bbwPercentileReady: true,
  note: null,
} as const

/** 受限模式（不足 300 根）的充分性结论 */
export const LIMITED_SUFFICIENCY = {
  bars: 120,
  usable: true,
  limited: true,
  penalty: 0.8,
  bbwPercentileReady: false,
  note: '日线 120 根（全功能需 300 根），数据不足，信号可靠性降低',
} as const
