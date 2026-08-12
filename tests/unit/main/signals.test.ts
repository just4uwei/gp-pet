/**
 * 信号编排层（src/main/engine/signals.ts）。
 *
 * 用假依赖跑：这一层没有策略判断，要验的是**编排**——
 *   - 竞价时段不产出信号（虚价会伪造穿越）
 *   - 落库去重：盘中每 30s 一轮，不能每轮插一行
 *   - 只缓存收盘指标，临时线的指标不落库
 *   - 收盘确认轮把 PROVISIONAL 推进为 CONFIRMED / INVALIDATED
 *   - 单只算不出来不拖垮整轮
 */

import { describe, expect, it, vi } from 'vitest'
import { createSignalEngine, snapshotOfIndicators, type SignalEngineDeps } from '@main/engine/signals'
import { computeIndicators } from '@core/indicators'
import { DEFAULT_PARAMS, engineVersionOf, withParams } from '@core/params'
import type { Candle, Position, SecCode, SecProfile, Snapshot } from '@core/types'
import type { MarketContext } from '@main/engine/market-data'
import type { WatchEntry } from '@main/storage/repositories/watchlist'
import type { SignalRow } from '@main/storage/repositories/signal'
import { buildCandles, chopCloses, goldenCrossBreakout } from '../../fixtures/klines'

const PROFILE: SecProfile = { code: 'SH600000', name: '浦发银行', market: 'SH', board: 'MAIN', isST: false }

function entry(profile: SecProfile = PROFILE): WatchEntry {
  return { profile, group: '自选', sortOrder: 0, createdAt: 0 }
}

interface Harness {
  deps: SignalEngineDeps
  rows: SignalRow[]
  cached: { code: SecCode; date: string; version: string }[]
  stageUpdates: { id: string; stage: string }[]
  peaks: { code: SecCode; price: number }[]
}

function harness(options: {
  candles?: Candle[]
  entries?: WatchEntry[]
  position?: Position | null
  snapshot?: Snapshot | null
  latestOfDay?: SignalRow | null
  benchmark?: Candle[]
  throwOn?: SecCode
} = {}): Harness {
  const candles = options.candles ?? goldenCrossBreakout().candles
  const rows: SignalRow[] = []
  const cached: { code: SecCode; date: string; version: string }[] = []
  const stageUpdates: { id: string; stage: string }[] = []
  const peaks: { code: SecCode; price: number }[] = []
  let counter = 0

  const context = (code: SecCode): MarketContext => {
    if (options.throwOn === code) throw new Error('模拟取数异常')
    const source = code === 'SH000300' ? (options.benchmark ?? buildCandles(chopCloses(300))) : candles
    return {
      code,
      candles: source,
      provisional: source[source.length - 1]?.provisional === true,
      snapshot: options.snapshot ?? null,
      stale: false,
      storedThrough: source[source.length - 1]?.date ?? null,
    }
  }

  const deps: SignalEngineDeps = {
    market: {
      getContext: (code) => context(code),
      snapshotOf: () => options.snapshot ?? null,
    },
    watchlist: { list: () => options.entries ?? [entry()] },
    positions: {
      get: () => options.position ?? null,
      list: () => (options.position ? [options.position] : []),
      bumpPeak: (code, price) => peaks.push({ code, price }),
    },
    signals: {
      insert: (row) => rows.push(row),
      updateStage: (id, stage) => {
        stageUpdates.push({ id, stage })
        return true
      },
      get: (id) => rows.find((r) => r.id === id) ?? null,
      query: () => [...rows],
      latestOfDay: () => options.latestOfDay ?? null,
      countOfDay: () => rows.length,
    } as unknown as SignalEngineDeps['signals'],
    indicators: {
      get: () => null,
      put: (code, date, _payload, version) => cached.push({ code, date, version }),
      purgeOtherVersions: () => 3,
      count: () => cached.length,
      prune: () => 0,
    } as unknown as SignalEngineDeps['indicators'],
    newId: () => `sig-${++counter}`,
  }

  return { deps, rows, cached, stageUpdates, peaks }
}

const TICK = {
  date: '2024-03-15',
  minuteOfDay: 14 * 60,
  session: 'CONTINUOUS_PM' as const,
  at: 1_700_000_000_000,
  producesSignals: true,
}

describe('时段与开关', () => {
  it('不允许产出信号的时段（竞价、休市）直接空转，不落库', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    expect(engine.run({ ...TICK, producesSignals: false })).toEqual([])
    expect(h.rows).toHaveLength(0)
  })

  it('自选股为空时不做任何事', () => {
    const h = harness({ entries: [] })
    expect(createSignalEngine(h.deps).run(TICK)).toEqual([])
  })

  it('指数不产出交易信号（它是情绪输入，不是可交易品种）', () => {
    const index: SecProfile = { code: 'SH000300', name: '沪深300', market: 'SH', board: 'INDEX', isST: false }
    const h = harness({ entries: [entry(index)] })
    expect(createSignalEngine(h.deps).run(TICK)).toEqual([])
  })

  it('单只评估抛错不拖垮整轮', () => {
    const other: SecProfile = { ...PROFILE, code: 'SZ000001', name: '平安银行' }
    const h = harness({ entries: [entry(), entry(other)], throwOn: 'SH600000' })
    const warn = vi.fn()
    const engine = createSignalEngine({ ...h.deps, log: { info: () => {}, warn } })
    const outcomes = engine.run(TICK)
    expect(outcomes.map((o) => o.evaluation.code)).toEqual(['SZ000001'])
    expect(warn).toHaveBeenCalled()
  })
})

describe('落库与去重', () => {
  it('同一条信号连续多轮只落一行', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    const first = h.rows.length
    engine.run({ ...TICK, at: TICK.at + 30_000 })
    engine.run({ ...TICK, at: TICK.at + 60_000 })
    expect(h.rows.length).toBe(first)
  })

  it('方向或级别变化时才落新行', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    const before = h.rows.length
    // 换一段行情 → 结论变化
    const other = harness({ candles: buildCandles(chopCloses(320)) })
    const engine2 = createSignalEngine({ ...h.deps, market: other.deps.market })
    engine2.run(TICK)
    expect(h.rows.length).toBeGreaterThanOrEqual(before)
  })

  it('落库行带上引擎版本与不复权价', () => {
    const h = harness()
    createSignalEngine(h.deps).run(TICK)
    const row = h.rows[0]
    if (row) {
      expect(row.engineVersion).toBe(engineVersionOf(DEFAULT_PARAMS))
      expect(row.priceAt).toBeGreaterThan(0)
      expect(row.evidence.indicatorsAt).toBeDefined()
    }
  })

  it('什么都没发生（NONE 且无风控裁决）时不占一行', () => {
    // 数据不足 40 根：会产生 INSUFFICIENT_DATA 裁决，因此**应当**落一行
    const short = harness({ candles: buildCandles(chopCloses(30)) })
    createSignalEngine(short.deps).run(TICK)
    expect(short.rows.length).toBe(1)
    expect(short.rows[0]?.evidence.verdicts.map((v) => v.rule)).toContain('INSUFFICIENT_DATA')
  })
})

describe('指标缓存与确认轮', () => {
  it('盘中（临时线）不缓存指标', () => {
    const scenario = goldenCrossBreakout()
    const candles = [...scenario.candles]
    const last = candles[candles.length - 1]
    if (last) candles[candles.length - 1] = { ...last, provisional: true }
    const h = harness({ candles })
    createSignalEngine(h.deps).run(TICK)
    expect(h.cached).toHaveLength(0)
  })

  it('收盘后缓存当日指标截面，键含引擎版本', () => {
    const h = harness()
    createSignalEngine(h.deps).run(TICK)
    expect(h.cached[0]?.version).toBe(engineVersionOf(DEFAULT_PARAMS))
  })

  it('参数变化 → 引擎版本变化 → 缓存键随之变化', () => {
    const h = harness()
    const engine = createSignalEngine({
      ...h.deps,
      params: withParams({ macd: { preset: 'Classic', fast: 12, slow: 26, signal: 9 } }),
    })
    engine.run(TICK)
    expect(h.cached[0]?.version).not.toBe(engineVersionOf(DEFAULT_PARAMS))
  })

  it('启动时清理旧版本缓存', () => {
    const h = harness()
    expect(createSignalEngine(h.deps).purgeStaleCache()).toBe(3)
  })

  it('收盘确认轮：当日已有 PROVISIONAL 行 → 推进为 CONFIRMED 或 INVALIDATED', () => {
    const previous = {
      id: 'old',
      code: 'SH600000',
      createdAt: 1,
      tradeDate: goldenCrossBreakout().candles.at(-1)?.date ?? '',
      direction: 'SELL',
      score: 0.7,
      votes: 3,
      regime: 'TREND_UP',
      stage: 'PROVISIONAL',
      priceAt: 10,
      engineVersion: 'v1',
      evidence: {
        level: 'L1',
        headline: '',
        reasons: [],
        suppressed: false,
        subSignals: [],
        adjustments: [],
        verdicts: [],
        scoreByDirection: {},
        indicatorsAt: {},
        regimeEvidence: {},
        sufficiency: { bars: 0, limited: false, penalty: 1, note: null },
      },
    } as unknown as SignalRow

    const h = harness({ latestOfDay: previous })
    createSignalEngine(h.deps).run(TICK)
    // 收盘结论不可能是 SELL（这段是上涨突破），所以那条盘中信号应被判为失效
    expect(h.stageUpdates[0]).toEqual({ id: 'old', stage: 'INVALIDATED' })
  })

  it('持仓峰值在收盘轮按当日最高价更新（docs/05 §2.3）', () => {
    const position: Position = { code: 'SH600000', shares: 1000, cost: 10, peakPrice: 10, openedAt: 0 }
    const h = harness({ position })
    createSignalEngine(h.deps).run(TICK)
    expect(h.peaks[0]?.code).toBe('SH600000')
    expect(h.peaks[0]?.price).toBeGreaterThan(0)
  })
})

describe('查询与解释', () => {
  it('history 带上名称，explain 还原子信号与指标截面', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    const history = engine.history({ limit: 10 })
    expect(history[0]?.name).toBe('浦发银行')
    const id = history[0]?.id
    if (id) {
      const evidence = engine.explain(id)
      expect(evidence?.id).toBe(id)
      expect(Object.keys(evidence?.indicatorsAt ?? {}).length).toBeGreaterThan(0)
    }
    expect(engine.explain('不存在的 id')).toBeNull()
  })

  it('latest() 返回最近一轮的评估结果', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    expect(engine.latest().length).toBe(1)
    engine.run({ ...TICK, producesSignals: false })
    expect(engine.latest()).toEqual([])
  })
})

describe('指标截面', () => {
  it('只留被判定那根的值，且缺失处是 null 不是 0', () => {
    const candles = buildCandles(chopCloses(60))
    const ind = computeIndicators(candles, DEFAULT_PARAMS, { sentiment: 0.5 })
    const snapshot = snapshotOfIndicators(ind, candles.length - 1)
    expect(snapshot['ma5']).not.toBeNull()
    // 60 根远不够 BBW 分位（需 269 根）
    expect(snapshot['bbwPct']).toBeNull()
    expect(snapshot['rsi']).not.toBeNull()
  })
})
