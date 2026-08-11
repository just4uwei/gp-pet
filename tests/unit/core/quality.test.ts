import { describe, expect, it } from 'vitest'
import { detectAdjustmentDrift, priceDeviation, screenCandles } from '@core/quality'
import type { Candle, TradeDate } from '@core/types'

/** 造一根内部一致的 K 线；factor 为前复权因子（closeAdj / close） */
function candle(date: TradeDate, close: number, over: Partial<Candle> = {}, factor = 1): Candle {
  const base: Candle = {
    date,
    open: close,
    high: close,
    low: close,
    close,
    openAdj: close * factor,
    highAdj: close * factor,
    lowAdj: close * factor,
    closeAdj: close * factor,
    volume: 1_000_000,
    amount: close * 1_000_000,
  }
  return { ...base, ...over }
}

const kinds = (issues: { kind: string }[]): string[] => issues.map((i) => i.kind)

describe('screenCandles', () => {
  it('干净数据原样通过，不打任何标记', () => {
    const input = [candle('2024-01-08', 10), candle('2024-01-09', 10.2), candle('2024-01-10', 10.1)]
    const { candles, issues } = screenCandles(input)
    expect(issues).toEqual([])
    expect(candles).toHaveLength(3)
    expect(candles.every((c) => c.hasGap === undefined)).toBe(true)
  })

  it('高低价颠倒、收盘越界、非正价格、负成交量一律丢弃', () => {
    const input = [
      candle('2024-01-08', 10),
      candle('2024-01-09', 10, { high: 9, low: 11, highAdj: 9, lowAdj: 11 }),
      candle('2024-01-10', 10, { close: 12 }),
      candle('2024-01-11', 10, { open: 8 }),
      candle('2024-01-12', 0),
      candle('2024-01-15', 10, { close: Number.NaN }),
      candle('2024-01-16', 10, { volume: -1 }),
      candle('2024-01-17', 10.1),
    ]
    const { candles, issues } = screenCandles(input)
    expect(candles.map((c) => c.date)).toEqual(['2024-01-08', '2024-01-17'])
    expect(issues.filter((i) => i.dropped)).toHaveLength(6)
    expect(kinds(issues)).toContain('NON_POSITIVE_PRICE')
    expect(kinds(issues)).toContain('PRICE_LOGIC')
  })

  it('日期非法、重复、乱序都丢弃并报告（不静默排序）', () => {
    const input = [
      candle('2024-01-08', 10),
      candle('2024-01-08', 10.5),
      candle('2024-01-05', 9),
      candle('2024/01/09' as TradeDate, 10),
      candle('2024-01-09', 10.1),
    ]
    const { candles, issues } = screenCandles(input)
    expect(candles.map((c) => c.date)).toEqual(['2024-01-08', '2024-01-09'])
    expect(kinds(issues)).toEqual(['DUPLICATE_DATE', 'OUT_OF_ORDER', 'BAD_DATE'])
  })

  it('跨越交易日的缺口打 hasGap；周末不算缺口', () => {
    // 2024-01-05 周五 → 2024-01-08 周一：不是缺口
    // 2024-01-08 → 2024-01-11：中间夹着 09、10 两个交易日
    const input = [candle('2024-01-05', 10), candle('2024-01-08', 10), candle('2024-01-11', 10)]
    const { candles, issues } = screenCandles(input)
    expect(candles[1]?.hasGap).toBeUndefined()
    expect(candles[2]?.hasGap).toBe(true)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: 'DATE_GAP', date: '2024-01-11' })
    expect(issues[0]?.detail).toContain('2 个交易日')
  })

  it('注入节假日判据后，春节长假不再被当成缺口', () => {
    // 2024 春节休市 02-09（除夕前一交易日收盘）→ 02-19 复牌
    const closed = new Set([
      '2024-02-10',
      '2024-02-11',
      '2024-02-12',
      '2024-02-13',
      '2024-02-14',
      '2024-02-15',
      '2024-02-16',
      '2024-02-17',
      '2024-02-18',
    ])
    const input = [candle('2024-02-09', 10), candle('2024-02-19', 10)]

    // 默认判据（仅排除周末）会把 02-12 ~ 02-16 当成缺失的交易日
    expect(kinds(screenCandles(input).issues)).toEqual(['DATE_GAP'])

    const withCalendar = screenCandles(input, { isTradingDay: (d) => !closed.has(d) })
    expect(withCalendar.issues).toEqual([])
    expect(withCalendar.candles[1]?.hasGap).toBeUndefined()
  })

  it('输入自带的 hasGap 不被信任，由本函数重算', () => {
    const input = [candle('2024-01-08', 10), candle('2024-01-09', 10, { hasGap: true })]
    const { candles } = screenCandles(input)
    expect(candles[1]?.hasGap).toBeUndefined()
  })

  it('零成交量标记可疑但保留', () => {
    const input = [candle('2024-01-08', 10), candle('2024-01-09', 10, { volume: 0 })]
    const { candles, issues } = screenCandles(input)
    expect(candles).toHaveLength(2)
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'ZERO_VOLUME', date: '2024-01-09', dropped: false }),
    ])
  })

  it('跳变按前复权收盘判：除权引起的原始价跳空不误报', () => {
    // 原始价从 10 跌到 5（10 送 10），但前复权序列连续 → 不应报 PRICE_JUMP
    const input = [candle('2024-01-08', 10, {}, 1), candle('2024-01-09', 5, {}, 2)]
    expect(screenCandles(input).issues).toEqual([])

    const real = [candle('2024-01-08', 10), candle('2024-01-09', 13)]
    const { issues } = screenCandles(real)
    expect(issues[0]).toMatchObject({ kind: 'PRICE_JUMP', dropped: false })
    expect(issues[0]?.detail).toContain('30.0%')
  })

  it('缺口段内不报跳变 —— 停牌复牌的价差不是数据错误', () => {
    const input = [candle('2024-01-08', 10), candle('2024-01-11', 14)]
    expect(kinds(screenCandles(input).issues)).toEqual(['DATE_GAP'])
  })

  it('跳变阈值可配', () => {
    const input = [candle('2024-01-08', 10), candle('2024-01-09', 10.5)]
    expect(screenCandles(input, { jumpThreshold: 0.01 }).issues).toHaveLength(1)
  })
})

describe('detectAdjustmentDrift', () => {
  const stored = [candle('2024-01-08', 10, {}, 1), candle('2024-01-09', 10, {}, 1)]

  it('历史日期的复权因子稳定 → 不触发重拉', () => {
    const incoming = [candle('2024-01-09', 10, {}, 1), candle('2024-01-10', 11, {}, 1)]
    expect(detectAdjustmentDrift(stored, incoming)).toBeNull()
  })

  it('历史日期的复权因子变了 → 报出首个漂移点', () => {
    const incoming = [candle('2024-01-09', 10, {}, 0.5)]
    expect(detectAdjustmentDrift(stored, incoming)).toMatchObject({ date: '2024-01-09' })
  })

  it('无重叠日期、非正价格都不误报', () => {
    expect(detectAdjustmentDrift(stored, [candle('2024-03-01', 10)])).toBeNull()
    expect(
      detectAdjustmentDrift([{ date: '2024-01-09', close: 0, closeAdj: 0 }], [candle('2024-01-09', 10)])
    ).toBeNull()
  })

  it('容差内的浮点抖动不算漂移', () => {
    const incoming = [candle('2024-01-09', 10, { closeAdj: 10.001 }, 1)]
    expect(detectAdjustmentDrift(stored, incoming)).toBeNull()
  })
})

describe('priceDeviation', () => {
  it('相对偏差，非法输入返回 null', () => {
    expect(priceDeviation(10, 10)).toBe(0)
    expect(priceDeviation(10, 10.2)).toBeCloseTo(0.0198, 4)
    expect(priceDeviation(0, 10)).toBeNull()
    expect(priceDeviation(Number.NaN, 10)).toBeNull()
  })
})
