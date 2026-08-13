/**
 * 影子运行的记账与推进（docs/07 §2.3）。
 *
 * 这些用例守的是「影子绩效**可信**」的前提，每一条都对应一种能让它悄悄失真的写法：
 *
 * | 用例 | 防的是 |
 * |---|---|
 * | 次日开盘成交 | 用当日收盘价成交 —— 15:00 之后那个价格已经买不到了，会凭空多出一段收益 |
 * | 幂等 | 盘后跑好几轮 tick，每轮加一根净值点 |
 * | 引擎版本闸门 | 换灵敏度之后继续往同一条曲线上加点，把两套参数的绩效混在一起 |
 * | 硬抑制不下单 | 把「风控判定无执行意义」的信号算进绩效 |
 * | PROVISIONAL 不下单 | 把提醒层的盘中抖动记成策略绩效 |
 * | 涨停买不到 / 跌停顺延 | 假装能在涨停板上买到 |
 * | 现金池耗尽要计数 | 静默跳过建仓，让「信号密集期的收益」凭空消失且报告上看不出 |
 * | 移出自选就了结 | 一个再也不会有信号、也不会有新 K 线的持仓永远冻在净值里 |
 */

import { describe, expect, it } from 'vitest'
import type { Candle, GatedSignal, SecCode } from '@core/types'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import { SHADOW_KEYS } from '@main/storage/repositories/shadow'
import {
  DEFAULT_SHADOW_NOTIONAL,
  createShadowRunner,
  executeOrder,
  orderFrom,
  quantizeSell,
  toShadowAction,
  type ShadowOrder,
  type ShadowPosition,
} from '@main/shadow'
import { DEFAULT_COSTS } from '@backtest/costs'
import type { SignalOutcome } from '@main/engine'

const DRIVER = 'node:sqlite' as const

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function candle(date: string, price: number, over: Partial<Candle> = {}): Candle {
  return {
    date,
    open: price,
    high: price,
    low: price,
    close: price,
    openAdj: price,
    highAdj: price,
    lowAdj: price,
    closeAdj: price,
    volume: 100_000,
    amount: price * 100_000,
    ...over,
  }
}

function gated(over: Partial<GatedSignal> = {}): GatedSignal {
  return {
    signal: {
      code: 'SH600000',
      date: '2026-08-13',
      direction: 'BUY',
      score: 0.7,
      votes: 3,
      subSignals: [],
      adjustments: [],
      scoreByDirection: { BUY: 0.7, SELL: 0 },
      stage: 'CONFIRMED',
      regime: 'RANGE',
    },
    direction: 'BUY',
    level: 'L2',
    verdicts: [],
    suppressed: false,
    headline: '测试',
    reasons: [],
    ...over,
  } as GatedSignal
}

function order(over: Partial<ShadowOrder> = {}): ShadowOrder {
  return {
    code: 'SH600000',
    action: 'BUY',
    placedDate: '2026-08-12',
    rule: 'T1_MA_CROSS',
    score: 0.7,
    regime: 'RANGE',
    signalId: 'sig-1',
    deferred: 0,
    ...over,
  }
}

function position(over: Partial<ShadowPosition> = {}): ShadowPosition {
  return {
    code: 'SH600000',
    shares: 1000,
    entryDate: '2026-08-01',
    entryPriceAdj: 10,
    entryPriceRaw: 10,
    entryCosts: 10,
    entryRegime: 'RANGE',
    entryScore: 0.7,
    entryRule: 'T1_MA_CROSS',
    peakRaw: 11,
    lastCloseAdj: 10.5,
    barsHeld: 8,
    engineVersion: 'v1',
    ...over,
  }
}

const FILL_BASE = {
  costs: DEFAULT_COSTS,
  notionalPerTrade: DEFAULT_SHADOW_NOTIONAL,
  engineVersion: 'v1',
  newId: () => 'trade-1',
  board: 'MAIN' as const,
  isST: false,
}

describe('方向 → 委托', () => {
  it('空仓时 BUY 与 NEXT_DAY_WATCH 都是买入 —— 影子的成交本来就在次日开盘', () => {
    expect(toShadowAction('BUY', false)).toBe('BUY')
    expect(toShadowAction('NEXT_DAY_WATCH', false)).toBe('BUY')
  })

  it('已持仓时不重复买入，空仓时不卖出', () => {
    expect(toShadowAction('BUY', true)).toBeNull()
    expect(toShadowAction('SELL', false)).toBeNull()
    expect(toShadowAction('REDUCE', false)).toBeNull()
  })

  it('硬抑制的信号不产生委托 —— 风控已判它无执行意义', () => {
    const built = orderFrom({
      code: 'SH600000',
      gated: gated({ suppressed: true }),
      regime: 'RANGE',
      score: 0.7,
      rule: 'T1',
      signalId: 'sig-1',
      date: '2026-08-13',
      holding: false,
    })
    expect(built).toBeNull()
  })

  it('方向为 NONE 时不产生委托', () => {
    const built = orderFrom({
      code: 'SH600000',
      gated: gated({ direction: 'NONE' }),
      regime: 'RANGE',
      score: 0.2,
      rule: 'T1',
      signalId: 'sig-1',
      date: '2026-08-13',
      holding: false,
    })
    expect(built).toBeNull()
  })
})

describe('成交', () => {
  it('买入用**开盘价 + 滑点**，且整手；费用从现金里扣', () => {
    const outcome = executeOrder(order(), null, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 10, { open: 10, closeAdj: 10.4 }),
      prevClose: 10,
      cash: 1_000_000,
    })
    expect(outcome.kind).toBe('FILLED_BUY')
    if (outcome.kind !== 'FILLED_BUY') return
    // 10 × 1.001 = 10.01；10 万预算 → 9900 股（整手，且要放得下费用）
    expect(outcome.position.entryPriceAdj).toBeCloseTo(10.01, 6)
    expect(outcome.position.shares % 100).toBe(0)
    expect(outcome.position.shares * 10.01).toBeLessThanOrEqual(DEFAULT_SHADOW_NOTIONAL)
    // 现金减少量 = 成交额 + 费用，严格大于成交额
    const spent = 1_000_000 - outcome.cash
    expect(spent).toBeGreaterThan(outcome.position.shares * 10.01)
  })

  it('单笔只用名义金额，不会把现金池一次买空', () => {
    const outcome = executeOrder(order(), null, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 10),
      prevClose: 10,
      cash: 1_000_000,
    })
    if (outcome.kind !== 'FILLED_BUY') throw new Error('应当成交')
    expect(outcome.cash).toBeGreaterThan(1_000_000 - DEFAULT_SHADOW_NOTIONAL - 1)
  })

  it('开盘涨停 → 作废，不是顺延（追高一天的成本已经不是这条信号的成本）', () => {
    // 主板 10%：昨收 10 → 涨停 11
    const outcome = executeOrder(order(), null, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 11, { open: 11 }),
      prevClose: 10,
      cash: 1_000_000,
    })
    expect(outcome).toEqual({ kind: 'VOID', reason: 'LIMIT_UP' })
  })

  it('开盘跌停 → 顺延并累计次数，超上限才作废', () => {
    const ctx = {
      ...FILL_BASE,
      bar: candle('2026-08-13', 9, { open: 9 }),
      prevClose: 10,
      cash: 0,
    }
    const first = executeOrder(order({ action: 'SELL' }), position(), ctx)
    expect(first.kind).toBe('DEFERRED')
    if (first.kind === 'DEFERRED') expect(first.order.deferred).toBe(1)

    const exhausted = executeOrder(order({ action: 'SELL', deferred: 5 }), position(), ctx)
    expect(exhausted).toEqual({ kind: 'VOID', reason: 'LIMIT_DOWN' })
  })

  it('缺口段不成交 —— 那一段的价格连续性本身不可信', () => {
    const outcome = executeOrder(order(), null, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 10, { hasGap: true }),
      prevClose: 10,
      cash: 1_000_000,
    })
    expect(outcome).toEqual({ kind: 'VOID', reason: 'GAP' })
  })

  it('现金不足与「单笔买不起一手」是两种不同的作废理由', () => {
    const noCash = executeOrder(order(), null, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 10),
      prevClose: 10,
      cash: 5,
    })
    expect(noCash).toEqual({ kind: 'VOID', reason: 'NO_CASH' })

    // 现金充足，但单笔名义金额买不起一手（每股 2000 元 × 100 股 = 20 万 > 10 万）
    const noLot = executeOrder(order(), null, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 2000),
      prevClose: 2000,
      cash: 1_000_000,
    })
    expect(noLot).toEqual({ kind: 'VOID', reason: 'NO_LOT' })
  })

  it('REDUCE 卖一半并保留剩余仓位，买入费用按比例摊到这一笔', () => {
    const held = position({ shares: 1000, entryCosts: 20 })
    const outcome = executeOrder(order({ action: 'REDUCE' }), held, {
      ...FILL_BASE,
      bar: candle('2026-08-13', 12, { open: 12 }),
      prevClose: 11.5,
      cash: 0,
    })
    expect(outcome.kind).toBe('FILLED_SELL')
    if (outcome.kind !== 'FILLED_SELL') return
    expect(outcome.trade.shares).toBe(500)
    expect(outcome.trade.partial).toBe(true)
    expect(outcome.position?.shares).toBe(500)
    // 一半的买入费用留给后续那笔，不能在第一笔里全扣掉
    expect(outcome.position?.entryCosts).toBeCloseTo(10, 6)
    expect(outcome.trade.pnl).toBeGreaterThan(0)
  })

  it('SELL 清仓后没有剩余持仓', () => {
    const outcome = executeOrder(order({ action: 'SELL' }), position(), {
      ...FILL_BASE,
      bar: candle('2026-08-13', 12, { open: 12 }),
      prevClose: 11.5,
      cash: 0,
    })
    expect(outcome.kind).toBe('FILLED_SELL')
    if (outcome.kind !== 'FILLED_SELL') return
    expect(outcome.position).toBeNull()
    expect(outcome.trade.partial).toBe(false)
  })

  it('卖出取整手，但剩下不足一手时一次卖光（否则会留下永远卖不掉的碎股）', () => {
    expect(quantizeSell(1000, 0.5)).toBe(500)
    expect(quantizeSell(100, 0.5)).toBe(100)
    expect(quantizeSell(150, 0.5)).toBe(150)
    expect(quantizeSell(1000, 1)).toBe(1000)
  })
})

// ── 推进器 ──────────────────────────────────────────────────────────

interface Harness {
  storage: Storage
  runner: ReturnType<typeof createShadowRunner>
  version: { value: string }
  tracked: Set<SecCode>
}

async function harness(bars: Record<string, Candle[]> = {}): Promise<Harness> {
  const storage = await openMemory()
  for (const [code, candles] of Object.entries(bars)) {
    storage.klines.upsertMany(code, candles, 'test')
  }
  const version = { value: 'engine-1' }
  const tracked = new Set<SecCode>(['SH600000'])
  let seq = 0
  const runner = createShadowRunner({
    repo: storage.shadow,
    meta: storage.meta,
    klines: storage.klines,
    engineVersion: () => version.value,
    trackedCodes: () => tracked,
    profileOf: () => ({ board: 'MAIN', isST: false }),
    newId: () => `trade-${++seq}`,
  })
  return { storage, runner, version, tracked }
}

function outcome(over: {
  date: string
  stage?: 'CONFIRMED' | 'PROVISIONAL'
  direction?: 'BUY' | 'SELL' | 'NONE'
  suppressed?: boolean
}): SignalOutcome {
  const stage = over.stage ?? 'CONFIRMED'
  const direction = over.direction ?? 'BUY'
  return {
    name: '浦发银行',
    persisted: true,
    signalId: 'sig-1',
    evaluation: {
      code: 'SH600000',
      date: over.date,
      index: 0,
      candle: candle(over.date, 10),
      regime: { regime: 'RANGE', evidence: {} },
      signal: { stage, score: 0.7, votes: 3, subSignals: [], adjustments: [], scoreByDirection: {} },
      gated: gated({ direction, suppressed: over.suppressed ?? false }),
    },
  } as unknown as SignalOutcome
}

describe('推进器', () => {
  it('T 日的信号挂委托，T+1 开盘才成交', async () => {
    const h = await harness({
      SH600000: [candle('2026-08-12', 10), candle('2026-08-13', 10.2, { open: 10.2 })],
    })

    // T 日（08-12）：K 线只到 08-12，挂单不成交
    const day1 = h.runner.advance({
      date: '2026-08-12',
      at: 1,
      outcomes: [outcome({ date: '2026-08-12' })],
    })
    expect(day1?.placed).toBe(1)
    expect(day1?.opened).toBe(0)
    expect(h.storage.shadow.positions()).toHaveLength(0)

    // T+1（08-13）：用 08-13 的开盘价成交
    const day2 = h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })
    expect(day2?.opened).toBe(1)
    const held = h.storage.shadow.positions()[0]
    expect(held?.entryDate).toBe('2026-08-13')
    expect(held?.entryPriceAdj).toBeCloseTo(10.2 * 1.001, 6)
  })

  it('同一个交易日只推进一次 —— 盘后会跑好几轮 tick', async () => {
    const h = await harness({ SH600000: [candle('2026-08-13', 10)] })
    expect(h.runner.advance({ date: '2026-08-13', at: 1, outcomes: [] })).not.toBeNull()
    expect(h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })).toBeNull()
    expect(h.runner.lastSkip()).toEqual({ kind: 'ALREADY_DONE', date: '2026-08-13' })
    expect(h.storage.shadow.barCount()).toBe(1)
  })

  it('引擎版本变了就停下来，不把两套参数混进同一条曲线', async () => {
    const h = await harness({
      SH600000: [candle('2026-08-12', 10), candle('2026-08-13', 10)],
    })
    h.runner.advance({ date: '2026-08-12', at: 1, outcomes: [] })

    h.version.value = 'engine-2'
    expect(h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })).toBeNull()
    expect(h.runner.lastSkip()).toEqual({
      kind: 'ENGINE_VERSION_CHANGED',
      recorded: 'engine-1',
      current: 'engine-2',
    })
    expect(h.storage.shadow.barCount()).toBe(1)
  })

  it('第一次推进时记下版本，此后同版本照常走', async () => {
    const h = await harness({
      SH600000: [candle('2026-08-12', 10), candle('2026-08-13', 10)],
    })
    h.runner.advance({ date: '2026-08-12', at: 1, outcomes: [] })
    expect(h.storage.meta.get(SHADOW_KEYS.engineVersion)).toBe('engine-1')
    expect(h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })).not.toBeNull()
  })

  it('PROVISIONAL 信号不挂委托 —— 否则会把盘中抖动记成策略绩效', async () => {
    const h = await harness({ SH600000: [candle('2026-08-13', 10)] })
    const result = h.runner.advance({
      date: '2026-08-13',
      at: 1,
      outcomes: [outcome({ date: '2026-08-13', stage: 'PROVISIONAL' })],
    })
    expect(result?.placed).toBe(0)
    expect(h.storage.shadow.orders()).toHaveLength(0)
  })

  it('净值每个交易日一行，持仓按收盘价盯市', async () => {
    const h = await harness({
      SH600000: [
        candle('2026-08-12', 10),
        candle('2026-08-13', 10, { open: 10, closeAdj: 11 }),
      ],
    })
    h.runner.advance({ date: '2026-08-12', at: 1, outcomes: [outcome({ date: '2026-08-12' })] })
    const day2 = h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })

    const equity = h.storage.shadow.equity()
    expect(equity).toHaveLength(2)
    // 建仓当天收盘涨到 11，持仓市值应当反映它
    expect(equity[1]?.positionValue).toBeGreaterThan(0)
    expect(day2?.equity).toBeCloseTo((equity[1]?.cash ?? 0) + (equity[1]?.positionValue ?? 0), 6)
    // 起始 100 万，10 万仓位涨了约 10% → 净值应当高于起点
    expect(day2?.equity).toBeGreaterThan(1_000_000)
  })

  it('拿不到基准 K 线时 benchmark 为 null，**不填 0**', async () => {
    const h = await harness({ SH600000: [candle('2026-08-13', 10)] })
    h.runner.advance({ date: '2026-08-13', at: 1, outcomes: [] })
    expect(h.storage.shadow.equity()[0]?.benchmark).toBeNull()
  })

  it('停牌（当日无 K 线）时委托顺延，连续超上限才作废', async () => {
    const h = await harness({ SH600000: [candle('2026-08-12', 10)] })
    h.runner.advance({ date: '2026-08-12', at: 1, outcomes: [outcome({ date: '2026-08-12' })] })
    expect(h.storage.shadow.orders()).toHaveLength(1)

    // 08-13 起这只没有 K 线了：连推 5 天顺延，第 6 天作废
    for (let day = 13; day <= 17; day++) {
      h.runner.advance({ date: `2026-08-${day}`, at: day, outcomes: [] })
      expect(h.storage.shadow.orders()).toHaveLength(1)
    }
    const last = h.runner.advance({ date: '2026-08-18', at: 18, outcomes: [] })
    expect(h.storage.shadow.orders()).toHaveLength(0)
    expect(last?.voided).toEqual([{ reason: 'NO_BAR', code: 'SH600000' }])
  })

  it('现金池耗尽时计数，不静默跳过', async () => {
    const h = await harness({
      SH600000: [candle('2026-08-12', 10), candle('2026-08-13', 10, { open: 10 })],
    })
    h.runner.advance({ date: '2026-08-12', at: 1, outcomes: [outcome({ date: '2026-08-12' })] })
    // 把现金掏空，模拟「信号密集期钱用完了」
    h.storage.meta.setNumber(SHADOW_KEYS.cash, 3)
    const result = h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })
    expect(result?.voided).toEqual([{ reason: 'NO_CASH', code: 'SH600000' }])
    expect(h.storage.meta.getNumber(SHADOW_KEYS.skippedNoCash)).toBe(1)
  })

  it('移出自选的持仓按最后收盘价了结，并标成 WATCHLIST_REMOVED', async () => {
    const h = await harness({
      SH600000: [
        candle('2026-08-12', 10),
        candle('2026-08-13', 10, { open: 10 }),
        candle('2026-08-14', 10),
      ],
    })
    h.runner.advance({ date: '2026-08-12', at: 1, outcomes: [outcome({ date: '2026-08-12' })] })
    h.runner.advance({ date: '2026-08-13', at: 2, outcomes: [] })
    expect(h.storage.shadow.positions()).toHaveLength(1)

    h.tracked.delete('SH600000')
    const result = h.runner.advance({ date: '2026-08-14', at: 3, outcomes: [] })
    expect(result?.closed).toBe(1)
    expect(h.storage.shadow.positions()).toHaveLength(0)
    const trades = h.storage.shadow.trades()
    expect(trades[0]?.exitRule).toBe('WATCHLIST_REMOVED')
  })

  it('reset() 清空账本且不预设起点 —— 「已清空」不该显示成「已运行 0 天」', async () => {
    const h = await harness({ SH600000: [candle('2026-08-13', 10)] })
    h.runner.advance({ date: '2026-08-13', at: 1, outcomes: [outcome({ date: '2026-08-13' })] })
    expect(h.storage.shadow.barCount()).toBe(1)

    h.runner.reset()
    expect(h.storage.shadow.barCount()).toBe(0)
    expect(h.storage.shadow.orders()).toHaveLength(0)
    expect(h.storage.meta.getNumber(SHADOW_KEYS.startedAt)).toBeNull()
  })
})
