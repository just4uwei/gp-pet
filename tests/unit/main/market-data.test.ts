/**
 * MarketDataService（docs/03 §2.3/§2.4、docs/07 §4）。
 *
 * 关注点排序：
 *   1. 不该发的请求一次都不发（无缺口整轮跳过）
 *   2. 该发的请求区间要对（首轮 ≥ 300 根、增量带重叠段）
 *   3. 坏数据不入库、复权口径变了要整只重拉
 *   4. 全部源挂掉时返回缓存 + stale，而不是把异常丢给调度器
 */

import { describe, expect, it, vi } from 'vitest'
import type { Candle, SecCode, Snapshot, TradeDate } from '@core/types'
import { addDays } from '@core/date'
import { AllProvidersUnavailableError } from '@main/providers'
import {
  DEFAULT_MARKET_DATA_OPTIONS,
  type KlineStore,
  type MarketDataDeps,
  calendarSpanFor,
  createMarketDataService,
  expectedLastBar,
} from '@main/engine'

function candle(date: TradeDate, close: number, factor = 1, over: Partial<Candle> = {}): Candle {
  return {
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
    ...over,
  }
}

function snapshot(code: SecCode, over: Partial<Snapshot> = {}): Snapshot {
  return {
    code,
    at: 1_754_900_000_000,
    last: 10.5,
    open: 10.1,
    high: 10.6,
    low: 10.0,
    preClose: 10.2,
    volume: 3_000_000,
    amount: 31_000_000,
    limitUp: 11.22,
    limitDown: 9.18,
    suspended: false,
    ...over,
  }
}

/** 内存日线库，结构上满足 KlineStore */
function klineStore(seed: Record<string, Candle[]> = {}) {
  const rows = new Map<SecCode, Candle[]>(Object.entries(seed))
  const calls: string[] = []
  const store: KlineStore & { rows: typeof rows; calls: string[] } = {
    rows,
    calls,
    upsertMany(code, candles, provider) {
      calls.push(`upsert:${code}:${provider}`)
      const kept = candles.filter((c) => c.provisional !== true)
      const merged = new Map((rows.get(code) ?? []).map((c) => [c.date, c]))
      for (const c of kept) merged.set(c.date, c)
      rows.set(
        code,
        [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
      )
      return kept.length
    },
    lastDate: (code) => rows.get(code)?.at(-1)?.date ?? null,
    recent: (code, limit) => (rows.get(code) ?? []).slice(-limit),
    range: (code, from, to) => (rows.get(code) ?? []).filter((c) => c.date >= from && c.date <= to),
    deleteAll(code) {
      calls.push(`deleteAll:${code}`)
      const n = rows.get(code)?.length ?? 0
      rows.delete(code)
      return n
    },
  }
  return store
}

const openCalendar = {
  resolve: (date: TradeDate) => ({ date, isOpen: true, source: 'db' as const, uncertain: false }),
}

/** 只有周一至周五开市的日历，用来验证「交易日口径」确实被传给了质量校验 */
const weekdayCalendar = {
  resolve: (date: TradeDate) => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay()
    const isOpen = day !== 0 && day !== 6
    return { date, isOpen, source: 'weekday' as const, uncertain: false }
  },
}

function daily(candles: Candle[], provider = 'eastmoney', degraded = false) {
  return vi.fn().mockResolvedValue({ value: candles, provider, degraded, attempts: [] })
}

describe('expectedLastBar', () => {
  it('收盘前目标是上一个交易日 —— 当日线还没定稿', () => {
    // 2026-08-11 周二，10:00
    expect(expectedLastBar(weekdayCalendar, '2026-08-11', 10 * 60)).toBe('2026-08-10')
  })

  it('15:00 起目标是当日', () => {
    expect(expectedLastBar(weekdayCalendar, '2026-08-11', 15 * 60)).toBe('2026-08-11')
    expect(expectedLastBar(weekdayCalendar, '2026-08-11', 15 * 60 - 1)).toBe('2026-08-10')
  })

  it('周末/休市日往前找最近的交易日', () => {
    // 2026-08-15 周六 → 周五
    expect(expectedLastBar(weekdayCalendar, '2026-08-15', 20 * 60)).toBe('2026-08-14')
    // 2026-08-16 周日 → 周五
    expect(expectedLastBar(weekdayCalendar, '2026-08-16', 9 * 60)).toBe('2026-08-14')
  })

  it('日历一直说休市（表坏了）时返回 null，而不是硬给一个日期', () => {
    const closed = {
      resolve: (date: TradeDate) => ({ date, isOpen: false, source: 'db' as const, uncertain: false }),
    }
    expect(expectedLastBar(closed, '2026-08-11', 16 * 60)).toBeNull()
  })
})

describe('calendarSpanFor', () => {
  it('300 根日线要往前要一年半以上的自然日', () => {
    expect(calendarSpanFor(300)).toBeGreaterThan(450)
    // 默认根数满足 docs/03 §1 的「≥ 300 根」
    expect(DEFAULT_MARKET_DATA_OPTIONS.initialBars).toBeGreaterThanOrEqual(300)
  })
})

describe('backfill · 请求区间', () => {
  it('无缺口整只跳过，一个请求都不发（docs/03 §2.4）', async () => {
    const fetchDaily = daily([])
    const service = createMarketDataService({
      registry: { fetchDaily, fetchSnapshots: vi.fn() },
      kline: klineStore({ SH600000: [candle('2026-08-10', 10)] }),
      calendar: openCalendar,
    })

    const [outcome] = await service.backfill(['SH600000'], '2026-08-10')
    expect(outcome).toMatchObject({ status: 'UP_TO_DATE', written: 0 })
    expect(fetchDaily).not.toHaveBeenCalled()
  })

  it('首轮从「够 initialBars 根」的自然日前拉起，口径是前复权', async () => {
    const fetchDaily = daily([candle('2026-08-10', 10)])
    const service = createMarketDataService({
      registry: { fetchDaily, fetchSnapshots: vi.fn() },
      kline: klineStore(),
      calendar: openCalendar,
    })

    await service.backfill(['SH600000'], '2026-08-10')
    const expectedFrom = addDays('2026-08-10', -calendarSpanFor(DEFAULT_MARKET_DATA_OPTIONS.initialBars))
    expect(fetchDaily).toHaveBeenCalledWith('SH600000', expectedFrom, '2026-08-10', 'qfq')
  })

  it('增量从「本地最后一根 − 重叠天数」拉起 —— 重叠段是复权漂移的唯一检出手段', async () => {
    const fetchDaily = daily([candle('2026-08-11', 10.3)])
    const service = createMarketDataService({
      registry: { fetchDaily, fetchSnapshots: vi.fn() },
      kline: klineStore({ SH600000: [candle('2026-08-10', 10)] }),
      calendar: openCalendar,
      options: { overlapDays: 5 },
    })

    await service.backfill(['SH600000'], '2026-08-11')
    expect(fetchDaily).toHaveBeenCalledWith('SH600000', '2026-08-05', '2026-08-11', 'qfq')
  })

  it('区间内一根都没有不算失败 —— 长期停牌与刚上市都是这样', async () => {
    const service = createMarketDataService({
      registry: { fetchDaily: daily([]), fetchSnapshots: vi.fn() },
      kline: klineStore(),
      calendar: openCalendar,
    })
    const [outcome] = await service.backfill(['SH600000'], '2026-08-10')
    expect(outcome).toMatchObject({ status: 'EMPTY', written: 0, provider: 'eastmoney' })
  })

  it('一只失败不拖累其余，失败原因随结果返回', async () => {
    const fetchDaily = vi.fn(async (code: SecCode) => {
      if (code === 'SZ000001') throw new Error('接口 500')
      return { value: [candle('2026-08-10', 10)], provider: 'eastmoney', degraded: false, attempts: [] }
    })
    const service = createMarketDataService({
      registry: { fetchDaily: fetchDaily as never, fetchSnapshots: vi.fn() },
      kline: klineStore(),
      calendar: openCalendar,
    })

    const outcomes = await service.backfill(['SH600000', 'SZ000001', 'SH510300'], '2026-08-10')
    expect(outcomes.map((o) => o.status)).toEqual(['WRITTEN', 'FAILED', 'WRITTEN'])
    expect(outcomes[1]?.error).toContain('接口 500')
  })

  it('并发按 backfillConcurrency 封顶 —— 排队等闸门会撞上 registry 的 attemptDeadline', async () => {
    let active = 0
    let peak = 0
    const fetchDaily = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return { value: [candle('2026-08-10', 10)], provider: 'eastmoney', degraded: false, attempts: [] }
    })
    const service = createMarketDataService({
      registry: { fetchDaily: fetchDaily as never, fetchSnapshots: vi.fn() },
      kline: klineStore(),
      calendar: openCalendar,
      options: { backfillConcurrency: 2 },
    })

    await service.backfill(['SH600000', 'SZ000001', 'SH510300', 'SZ300750', 'BJ430047'], '2026-08-10')
    expect(fetchDaily).toHaveBeenCalledTimes(5)
    expect(peak).toBe(2)
  })
})

describe('backfill · 质量校验与复权', () => {
  it('结构性坏数据不入库，问题上报给 onIssues', async () => {
    const bad = candle('2026-08-11', 10, 1, { high: 9, low: 11, highAdj: 9, lowAdj: 11 })
    const kline = klineStore()
    const issues: string[] = []
    const service = createMarketDataService({
      registry: { fetchDaily: daily([candle('2026-08-10', 10), bad]), fetchSnapshots: vi.fn() },
      kline,
      calendar: openCalendar,
      onIssues: (code, list) => issues.push(...list.map((i) => `${code}:${i.kind}:${i.dropped}`)),
    })

    const [outcome] = await service.backfill(['SH600000'], '2026-08-11')
    expect(outcome).toMatchObject({ status: 'WRITTEN', written: 1 })
    expect(kline.rows.get('SH600000')?.map((c) => c.date)).toEqual(['2026-08-10'])
    expect(issues).toEqual(['SH600000:PRICE_LOGIC:true'])
  })

  it('缺口用交易日历判定（周末不算缺口，工作日缺失才算）', async () => {
    const issues: string[] = []
    const service = createMarketDataService({
      registry: {
        // 2026-08-07 周五 → 2026-08-10 周一：中间只有周末，不是缺口
        fetchDaily: daily([candle('2026-08-07', 10), candle('2026-08-10', 10.1), candle('2026-08-13', 10.2)]),
        fetchSnapshots: vi.fn(),
      },
      kline: klineStore(),
      calendar: weekdayCalendar,
      onIssues: (_code, list) => issues.push(...list.map((i) => `${i.kind}@${i.date}`)),
    })

    await service.backfill(['SH600000'], '2026-08-13')
    // 08-11、08-12 是工作日却没有 K 线 → 缺口打在 08-13 上
    expect(issues).toEqual(['DATE_GAP@2026-08-13'])
  })

  it('复权因子突变 → 清库 + 全量重拉（docs/07 §4）', async () => {
    // 已入库口径 factor = 1，新数据 factor = 0.5
    const kline = klineStore({ SH600000: [candle('2026-08-07', 10), candle('2026-08-10', 10.2)] })
    const fetchDaily = vi
      .fn()
      .mockResolvedValueOnce({
        value: [candle('2026-08-10', 10.2, 0.5), candle('2026-08-11', 10.3, 0.5)],
        provider: 'eastmoney',
        degraded: false,
        attempts: [],
      })
      .mockResolvedValueOnce({
        value: [
          candle('2026-08-07', 10, 0.5),
          candle('2026-08-10', 10.2, 0.5),
          candle('2026-08-11', 10.3, 0.5),
        ],
        provider: 'eastmoney',
        degraded: false,
        attempts: [],
      })
    const service = createMarketDataService({
      registry: { fetchDaily, fetchSnapshots: vi.fn() },
      kline,
      calendar: openCalendar,
      options: { overlapDays: 5 },
    })

    const [outcome] = await service.backfill(['SH600000'], '2026-08-11')
    expect(outcome).toMatchObject({ status: 'REFETCHED', written: 3 })
    expect(outcome?.drift).toMatchObject({ date: '2026-08-10', storedFactor: 1 })
    expect(kline.calls).toContain('deleteAll:SH600000')
    // 全库都是新口径，没有两套混存
    expect(kline.rows.get('SH600000')?.every((c) => Math.abs(c.closeAdj / c.close - 0.5) < 1e-9)).toBe(true)
    // 第二趟的起点是「够 initialBars 根」的完整区间
    expect(fetchDaily.mock.calls[1]?.[1]).toBe(
      addDays('2026-08-11', -calendarSpanFor(DEFAULT_MARKET_DATA_OPTIONS.initialBars))
    )
  })

  it('容差内的因子抖动不触发重拉 —— 除权前的小数舍入不该让每轮都清库', async () => {
    const kline = klineStore({ SH600000: [candle('2026-08-10', 10, 1)] })
    const fetchDaily = daily([candle('2026-08-10', 10, 1.001), candle('2026-08-11', 10.3, 1.001)])
    const service = createMarketDataService({
      registry: { fetchDaily, fetchSnapshots: vi.fn() },
      kline,
      calendar: openCalendar,
    })

    const [outcome] = await service.backfill(['SH600000'], '2026-08-11')
    expect(outcome?.status).toBe('WRITTEN')
    expect(fetchDaily).toHaveBeenCalledTimes(1)
    expect(kline.calls).not.toContain('deleteAll:SH600000')
  })

  it('降级取数会带上 degraded 标记，供面板提示', async () => {
    const service = createMarketDataService({
      registry: { fetchDaily: daily([candle('2026-08-10', 10)], 'tencent', true), fetchSnapshots: vi.fn() },
      kline: klineStore(),
      calendar: openCalendar,
    })
    expect((await service.backfill(['SH600000'], '2026-08-10'))[0]).toMatchObject({
      provider: 'tencent',
      degraded: true,
    })
  })
})

describe('refreshSnapshots', () => {
  function service(fetchSnapshots: MarketDataDeps['registry']['fetchSnapshots'], now = () => 1_000) {
    return createMarketDataService({
      registry: { fetchDaily: vi.fn(), fetchSnapshots },
      kline: klineStore(),
      calendar: openCalendar,
      now,
    })
  }

  it('整批下发（分片是 provider 的职责），只收要过的代码', async () => {
    const fetchSnapshots = vi.fn().mockResolvedValue({
      value: [snapshot('SH600000'), snapshot('SZ000001'), snapshot('SH000300')],
      provider: 'eastmoney',
      degraded: false,
      attempts: [],
    })
    const s = service(fetchSnapshots)
    const result = await s.refreshSnapshots(['SH600000', 'SZ000001'])

    expect(fetchSnapshots).toHaveBeenCalledWith(['SH600000', 'SZ000001'])
    expect(result.snapshots.map((x) => x.code)).toEqual(['SH600000', 'SZ000001'])
    expect(result).toMatchObject({ stale: false, missing: [], lastOkAt: 1_000 })
  })

  it('源静默丢掉的代码进 missing —— 不是失败，但面板要能看出「这只没数据」', async () => {
    const fetchSnapshots = vi.fn().mockResolvedValue({
      value: [snapshot('SH600000')],
      provider: 'sina',
      degraded: true,
      attempts: [],
    })
    const result = await service(fetchSnapshots).refreshSnapshots(['SH600000', 'BJ430047'])
    expect(result.missing).toEqual(['BJ430047'])
    expect(result.degraded).toBe(true)
  })

  it('空代码列表不发请求', async () => {
    const fetchSnapshots = vi.fn()
    const result = await service(fetchSnapshots).refreshSnapshots([])
    expect(fetchSnapshots).not.toHaveBeenCalled()
    expect(result).toMatchObject({ snapshots: [], stale: false })
  })

  it('全部源不可用 → 返回上一轮缓存并置 stale，绝不抛给调度器（docs/03 §2.2）', async () => {
    const fetchSnapshots = vi
      .fn()
      .mockResolvedValueOnce({
        value: [snapshot('SH600000', { last: 10.5 })],
        provider: 'eastmoney',
        degraded: false,
        attempts: [],
      })
      .mockRejectedValueOnce(new AllProvidersUnavailableError('snapshot', []))
    const s = service(fetchSnapshots)

    await s.refreshSnapshots(['SH600000', 'SZ000001'])
    const second = await s.refreshSnapshots(['SH600000', 'SZ000001'])

    expect(second.stale).toBe(true)
    expect(second.snapshots.map((x) => x.code)).toEqual(['SH600000'])
    expect(second.missing).toEqual(['SZ000001'])
    expect(second.error).toContain('全部数据源不可用')
    // 上一次成功的时刻仍保留，UI 才能说「行情更新于 …」
    expect(second.lastOkAt).toBe(1_000)
  })

  it('从未成功过时缓存为空，stale 仍然为 true', async () => {
    const fetchSnapshots = vi.fn().mockRejectedValue(new Error('断网'))
    const result = await service(fetchSnapshots).refreshSnapshots(['SH600000'])
    expect(result).toMatchObject({ snapshots: [], stale: true, lastOkAt: null })
    expect(result.error).toBe('断网')
  })
})

describe('getContext', () => {
  it('历史 + 当日临时线，尾部标 provisional', async () => {
    const kline = klineStore({
      SH600000: [candle('2026-08-07', 10, 0.5), candle('2026-08-10', 10.2, 0.5)],
    })
    const fetchSnapshots = vi.fn().mockResolvedValue({
      value: [snapshot('SH600000')],
      provider: 'eastmoney',
      degraded: false,
      attempts: [],
    })
    const s = createMarketDataService({
      registry: { fetchDaily: vi.fn(), fetchSnapshots },
      kline,
      calendar: openCalendar,
    })
    await s.refreshSnapshots(['SH600000'])

    const ctx = s.getContext('SH600000', '2026-08-11')
    expect(ctx.provisional).toBe(true)
    expect(ctx.candles.map((c) => c.date)).toEqual(['2026-08-07', '2026-08-10', '2026-08-11'])
    expect(ctx.storedThrough).toBe('2026-08-10')
    expect(ctx.stale).toBe(false)
  })

  it('没有快照就只有历史，不产出 provisional', () => {
    const s = createMarketDataService({
      registry: { fetchDaily: vi.fn(), fetchSnapshots: vi.fn() },
      kline: klineStore({ SH600000: [candle('2026-08-10', 10)] }),
      calendar: openCalendar,
    })
    const ctx = s.getContext('SH600000', '2026-08-11')
    expect(ctx).toMatchObject({ provisional: false, snapshot: null })
    expect(ctx.candles).toHaveLength(1)
  })

  it('取数失败后的缓存快照会带 stale，让上层知道价格是旧的', async () => {
    const fetchSnapshots = vi
      .fn()
      .mockResolvedValueOnce({
        value: [snapshot('SH600000')],
        provider: 'eastmoney',
        degraded: false,
        attempts: [],
      })
      .mockRejectedValueOnce(new Error('超时'))
    const s = createMarketDataService({
      registry: { fetchDaily: vi.fn(), fetchSnapshots },
      kline: klineStore({ SH600000: [candle('2026-08-10', 10)] }),
      calendar: openCalendar,
    })
    await s.refreshSnapshots(['SH600000'])
    await s.refreshSnapshots(['SH600000'])
    expect(s.getContext('SH600000', '2026-08-11').stale).toBe(true)
    expect(s.snapshotOf('SH600000')?.last).toBe(10.5)
    expect(s.lastSnapshotAt()).not.toBeNull()
  })

  it('bars 限制只影响读多少根历史', () => {
    const s = createMarketDataService({
      registry: { fetchDaily: vi.fn(), fetchSnapshots: vi.fn() },
      kline: klineStore({
        SH600000: [candle('2026-08-07', 10), candle('2026-08-10', 10.2), candle('2026-08-11', 10.3)],
      }),
      calendar: openCalendar,
    })
    expect(s.getContext('SH600000', '2026-08-12', 2).candles.map((c) => c.date)).toEqual([
      '2026-08-10',
      '2026-08-11',
    ])
  })
})

describe('looksLikeTradingNow', () => {
  const s = createMarketDataService({
    registry: { fetchDaily: vi.fn(), fetchSnapshots: vi.fn() },
    kline: klineStore(),
    calendar: openCalendar,
  })

  it('有成交才算证据 —— 休市日接口一样有响应，只是零成交量', () => {
    expect(s.looksLikeTradingNow([snapshot('SH600000', { volume: 0 })])).toBe(false)
    expect(s.looksLikeTradingNow([snapshot('SH600000', { volume: 1 })])).toBe(true)
  })

  it('停牌与非正价格不算证据', () => {
    expect(s.looksLikeTradingNow([snapshot('SH600000', { suspended: true })])).toBe(false)
    expect(s.looksLikeTradingNow([snapshot('SH600000', { last: 0 })])).toBe(false)
    expect(s.looksLikeTradingNow([])).toBe(false)
  })
})
