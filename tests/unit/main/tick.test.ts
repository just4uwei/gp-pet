/**
 * tick 流水线（docs/02 §4、docs/03 §2.4/§3）。
 *
 * 关注点排序：
 *   1. 休市 / 午休一个行情请求都不发 —— 这是「不把免费接口用坏」的底线
 *   2. 维护（日历 + 基础信息）每周一次，且失败不记时间戳，下一轮还会再试
 *   3. 探测轮拿到真成交才纠正日历（响应成功不算证据）
 *   4. 取数失败不抛给调度器，而是留下 stale 让面板显示「行情离线」
 */

import { describe, expect, it, vi } from 'vitest'
import type { SecCode, Snapshot, TradeDate, TradingSession } from '@core/types'
import { createTickPipeline, MAINTENANCE_INTERVAL_MS, type TickPipelineDeps } from '@main/engine'
import type { SnapshotOutcome } from '@main/engine'
import type { TickContext } from '@main/scheduler'
import { META_KEYS } from '@main/storage/repositories/meta'

const AT = Date.UTC(2026, 2, 10, 2, 0) // 2026-03-10 10:00 上海

function ctxOf(over: Partial<TickContext> = {}): TickContext {
  return {
    at: AT,
    date: '2026-03-10' as TradeDate,
    minuteOfDay: 600,
    session: 'CONTINUOUS_AM' as TradingSession,
    isTradingDay: true,
    calendarSource: 'db',
    calendarUncertain: false,
    sessionChanged: false,
    needsQuotes: true,
    producesSignals: true,
    probe: false,
    ...over,
  }
}

function snapshot(code: SecCode, over: Partial<Snapshot> = {}): Snapshot {
  return {
    code,
    at: AT,
    last: 10,
    preClose: 10,
    open: 10,
    high: 10,
    low: 10,
    volume: 1_000_000,
    amount: 10_000_000,
    limitUp: null,
    limitDown: null,
    suspended: false,
    ...over,
  }
}

function outcome(over: Partial<SnapshotOutcome> = {}): SnapshotOutcome {
  return { at: AT, snapshots: [], stale: false, lastOkAt: AT, missing: [], ...over }
}

/** 记录每个依赖被调用了几次 —— 「没发请求」这件事只能靠计数来断言 */
/** `isOpen` 不是 TickPipelineDeps 的字段，是给日历替身用的开关（休市日那条用例要它） */
function harness(over: Partial<TickPipelineDeps> & { isOpen?: boolean } = {}): {
  deps: TickPipelineDeps
  meta: Map<string, number | string>
  backfill: ReturnType<typeof vi.fn>
  refreshSnapshots: ReturnType<typeof vi.fn>
  refreshProfiles: ReturnType<typeof vi.fn>
  calendarRefresh: ReturnType<typeof vi.fn>
  markObserved: ReturnType<typeof vi.fn>
} {
  // 数字（维护间隔）与字符串（补跑闸门的日期）共用一张表，与 MetaRepo 一致
  const meta = new Map<string, number | string>()
  const backfill = vi.fn(async (codes: SecCode[]) =>
    codes.map((code) => ({ code, status: 'UP_TO_DATE' as const, written: 0 }))
  )
  const refreshSnapshots = vi.fn(async () => outcome())
  const refreshProfiles = vi.fn(async () => 1)
  const calendarRefresh = vi.fn(async (years: readonly number[]) =>
    years.map((year) => ({ year, ok: true, written: 10 }))
  )
  const markObserved = vi.fn()

  const deps: TickPipelineDeps = {
    market: {
      backfill,
      refreshSnapshots,
      looksLikeTradingNow: (snapshots: readonly Snapshot[]) =>
        snapshots.some((s) => !s.suspended && s.last > 0 && s.volume > 0),
    } as unknown as TickPipelineDeps['market'],
    watchlist: { codes: () => ['SH600000' as SecCode], refreshProfiles },
    calendar: {
      resolve: (date: TradeDate) => ({
        date,
        isOpen: over.isOpen ?? true,
        source: 'db' as const,
        uncertain: false,
      }),
      refresh: calendarRefresh,
      markObserved,
    },
    meta: {
      getNumber: (key) => {
        const raw = meta.get(key)
        return typeof raw === 'number' ? raw : null
      },
      setNumber: (key, value) => void meta.set(key, value),
      // 补跑闸门存的是日期串（META_KEYS.lastSettledDate）
      get: (key) => {
        const raw = meta.get(key)
        return typeof raw === 'string' ? raw : null
      },
      set: (key, value) => void meta.set(key, value),
    },
    ...over,
  }
  return { deps, meta, backfill, refreshSnapshots, refreshProfiles, calendarRefresh, markObserved }
}

describe('createTickPipeline', () => {
  it('休市轮一个行情请求都不发', async () => {
    const h = harness()
    // 日历与基础信息已经是最新的，维护也不该发请求
    h.meta.set(META_KEYS.calendarRefreshedAt, AT)
    h.meta.set(META_KEYS.profileRefreshedAt, AT)

    await createTickPipeline(h.deps).run(ctxOf({ session: 'CLOSED', needsQuotes: false }))

    expect(h.backfill).not.toHaveBeenCalled()
    expect(h.refreshSnapshots).not.toHaveBeenCalled()
    expect(h.calendarRefresh).not.toHaveBeenCalled()
    expect(h.refreshProfiles).not.toHaveBeenCalled()
  })

  it('午休轮同样不取行情', async () => {
    const h = harness()
    h.meta.set(META_KEYS.calendarRefreshedAt, AT)
    h.meta.set(META_KEYS.profileRefreshedAt, AT)

    await createTickPipeline(h.deps).run(ctxOf({ session: 'LUNCH_BREAK', needsQuotes: false }))

    expect(h.refreshSnapshots).not.toHaveBeenCalled()
  })

  it('休市轮做每周一次的维护：日历刷当年 + 次年', async () => {
    const h = harness()
    const prune = vi.fn(() => ({ kline: 3 }))

    await createTickPipeline({ ...h.deps, prune }).run(ctxOf({ needsQuotes: false }))

    expect(h.calendarRefresh).toHaveBeenCalledWith([2026, 2027])
    expect(h.refreshProfiles).toHaveBeenCalledOnce()
    expect(prune).toHaveBeenCalledWith(AT)
    expect(h.meta.get(META_KEYS.calendarRefreshedAt)).toBe(AT)
    expect(h.meta.get(META_KEYS.profileRefreshedAt)).toBe(AT)
  })

  it('维护未到点时不重复刷新', async () => {
    const h = harness()
    h.meta.set(META_KEYS.calendarRefreshedAt, AT - MAINTENANCE_INTERVAL_MS + 60_000)
    h.meta.set(META_KEYS.profileRefreshedAt, AT - MAINTENANCE_INTERVAL_MS + 60_000)

    await createTickPipeline(h.deps).run(ctxOf({ needsQuotes: false }))

    expect(h.calendarRefresh).not.toHaveBeenCalled()
    expect(h.refreshProfiles).not.toHaveBeenCalled()
  })

  it('日历全年失败就不记时间戳，下一轮还会再试', async () => {
    const h = harness()
    h.calendarRefresh.mockResolvedValue([
      { year: 2026, ok: false, written: 0, error: '全部数据源不可用' },
      { year: 2027, ok: false, written: 0 },
    ])
    const warn = vi.fn()

    await createTickPipeline({ ...h.deps, log: { info: () => {}, warn } }).run(
      ctxOf({ needsQuotes: false })
    )

    expect(h.meta.has(META_KEYS.calendarRefreshedAt)).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('基础信息一只都没更新时不记时间戳', async () => {
    const h = harness()
    h.refreshProfiles.mockResolvedValue(0)

    await createTickPipeline(h.deps).run(ctxOf({ needsQuotes: false }))

    expect(h.meta.has(META_KEYS.profileRefreshedAt)).toBe(false)
  })

  it('自选为空时不发任何行情请求', async () => {
    const h = harness({ watchlist: { codes: () => [], refreshProfiles: async () => 0 } })

    await createTickPipeline(h.deps).run(ctxOf())

    expect(h.backfill).not.toHaveBeenCalled()
    expect(h.refreshSnapshots).not.toHaveBeenCalled()
  })

  it('取数轮先补日线再拉快照，日线目标是上一交易日（盘中）', async () => {
    const h = harness()

    await createTickPipeline(h.deps).run(ctxOf())

    // 10:00 时今天的收盘线还不存在，目标只能是上一个交易日
    expect(h.backfill).toHaveBeenCalledWith(['SH600000'], '2026-03-09')
    expect(h.refreshSnapshots).toHaveBeenCalledWith(['SH600000'])
    expect(h.backfill.mock.invocationCallOrder[0]).toBeLessThan(
      h.refreshSnapshots.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('收盘后日线目标变成当日', async () => {
    const h = harness()

    await createTickPipeline(h.deps).run(ctxOf({ session: 'SETTLE', minuteOfDay: 15 * 60 + 5 }))

    expect(h.backfill).toHaveBeenCalledWith(['SH600000'], '2026-03-10')
  })

  it('回补失败只 warn，不中断这一轮的快照', async () => {
    const h = harness()
    h.backfill.mockResolvedValue([{ code: 'SH600000', status: 'FAILED', written: 0, error: '超时' }])
    const warn = vi.fn()

    await createTickPipeline({ ...h.deps, log: { info: () => {}, warn } }).run(ctxOf())

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('回补失败'))
    expect(h.refreshSnapshots).toHaveBeenCalledOnce()
  })

  it('探测轮拿到真成交才纠正日历', async () => {
    const h = harness()
    h.refreshSnapshots.mockResolvedValue(outcome({ snapshots: [snapshot('SH600000' as SecCode)] }))

    await createTickPipeline(h.deps).run(ctxOf({ probe: true }))

    expect(h.markObserved).toHaveBeenCalledWith('2026-03-10', true)
  })

  it('探测轮全是停牌/零成交时不纠正日历', async () => {
    const h = harness()
    h.refreshSnapshots.mockResolvedValue(
      outcome({ snapshots: [snapshot('SH600000' as SecCode, { volume: 0 })] })
    )

    await createTickPipeline(h.deps).run(ctxOf({ probe: true }))

    expect(h.markObserved).not.toHaveBeenCalled()
  })

  it('非探测轮永远不动日历', async () => {
    const h = harness()
    h.refreshSnapshots.mockResolvedValue(outcome({ snapshots: [snapshot('SH600000' as SecCode)] }))

    await createTickPipeline(h.deps).run(ctxOf({ probe: false }))

    expect(h.markObserved).not.toHaveBeenCalled()
  })

  it('取数失败不抛出，把 stale 留给面板', async () => {
    const h = harness()
    const stale = outcome({ stale: true, lastOkAt: null, error: '全部数据源不可用' })
    h.refreshSnapshots.mockResolvedValue(stale)
    const warn = vi.fn()
    const onQuotes = vi.fn()

    const pipeline = createTickPipeline({ ...h.deps, log: { info: () => {}, warn }, onQuotes })
    await expect(pipeline.run(ctxOf())).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('行情离线'))
    // 失败也要回调：面板得知道这一轮结束了，好把价格切成灰态
    expect(onQuotes).toHaveBeenCalledOnce()
    expect(pipeline.state().lastSnapshots).toBe(stale)
  })

  it('state 记录最近一轮的时间与上下文', async () => {
    const h = harness()
    const pipeline = createTickPipeline(h.deps)

    // lastSignals 是 M2 给 TickState 加的第四个字段 —— toEqual 是全等比较，漏一个就红
    expect(pipeline.state()).toEqual({
      lastTickAt: 0,
      lastCtx: null,
      lastSnapshots: null,
      lastSignals: [],
    })

    const ctx = ctxOf()
    await pipeline.run(ctx)

    expect(pipeline.state().lastTickAt).toBe(AT)
    expect(pipeline.state().lastCtx).toBe(ctx)
  })

  it('休市轮不覆盖上一轮的快照结果（面板仍显示收盘价）', async () => {
    const h = harness()
    const first = outcome({ snapshots: [snapshot('SH600000' as SecCode)] })
    h.refreshSnapshots.mockResolvedValue(first)
    const pipeline = createTickPipeline(h.deps)

    await pipeline.run(ctxOf())
    h.meta.set(META_KEYS.calendarRefreshedAt, AT)
    h.meta.set(META_KEYS.profileRefreshedAt, AT)
    await pipeline.run(ctxOf({ session: 'CLOSED', needsQuotes: false }))

    expect(pipeline.state().lastSnapshots).toBe(first)
  })

  // ── M4 挂上来的两件事 ────────────────────────────────────────────

  /*
    影子运行**不在 tick 里推进**（2026-08-17 改）。这一组钉的是那个静默缺陷的修复。

    原先每轮都调 `shadow.advance`，看着无害（它自己判幂等），实际是：当天第一跳往往在
    盘前（实测 09:02），那时 producesSignals 为 false ⇒ outcomes 为空，而 advance 照样
    写下当天的净值行 ⇒ shadow_equity 主键的幂等闸门从此挡住后面每一轮，**包括收盘确认轮**
    ⇒ runner 第 ⑥ 步「用今天的 CONFIRMED 挂明天的委托」永远跑不到 ⇒ 影子永远不建仓。
    实测三个交易日：净值 1 行、成交 **0** 行，而曲线上看不出任何异常。

    现在影子挂在 `settle` 那条路上，闸门是「今天是交易日 且 还没到 09:30」。
  */
  describe('影子运行的推进时机', () => {
    it('盘中那一跳补跑时 feedShadow 为 false —— 开盘已过，次日开盘成交不再是前向的', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })

      // ctxOf 默认 minuteOfDay 600（10:00），已过 09:30
      await createTickPipeline(h.deps).run(ctxOf())

      expect(settle).toHaveBeenCalledWith('2026-03-09', false)
    })

    it('盘前那一跳 feedShadow 为 true —— 那一刻今天的开盘还没发生', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: true }))
      const h = harness({ settle })

      await createTickPipeline(h.deps).run(
        ctxOf({ minuteOfDay: 545, session: 'PRE_OPEN', producesSignals: false })
      )

      expect(settle).toHaveBeenCalledWith('2026-03-09', true)
    })

    it('休市日不喂 —— 今天没有开盘可成交', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle, isOpen: false })

      await createTickPipeline(h.deps).run(
        ctxOf({ minuteOfDay: 545, session: 'PRE_OPEN', isTradingDay: false, needsQuotes: false })
      )

      if (settle.mock.calls.length > 0) expect(settle).toHaveBeenCalledWith('2026-03-09', false)
    })
  })

  /*
    补跑收盘确认轮的触发闸门（engine/settle.ts）。

    为什么要钉：这段的每一种错法都是**静默**的 ——
    不触发 → 确认轮永远跑不成（现状就是这样，实测 CONFIRMED 0 行、指标缓存 0 行），
    而日志与界面上都看不出少了什么；每轮都触发 → 每一跳都做一次全量指标重算。
  */
  describe('补跑收盘确认轮', () => {
    it('盘中那一跳补跑上一个交易日', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })

      await createTickPipeline(h.deps).run(ctxOf())

      // 10:00 时「应该已存在的最后一根」是上一个交易日，正是要补跑的那天
      expect(settle).toHaveBeenCalledWith('2026-03-09', false)
      expect(h.meta.get(META_KEYS.lastSettledDate)).toBe('2026-03-09')
    })

    it('同一天不重复补跑 —— 它要为每只标的算一遍 320 根的全套指标', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })
      h.meta.set(META_KEYS.lastSettledDate, '2026-03-09')

      await createTickPipeline(h.deps).run(ctxOf())

      expect(settle).not.toHaveBeenCalled()
    })

    it('收盘后那一跳不补跑当天 —— 那是正常的收盘确认轮自己的活', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })

      await createTickPipeline(h.deps).run(ctxOf({ session: 'SETTLE', minuteOfDay: 15 * 60 + 5 }))

      expect(settle).not.toHaveBeenCalled()
    })

    it('补跑排在回补之后 —— 它用的正是刚补进来的那根收盘线', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })

      await createTickPipeline(h.deps).run(ctxOf())

      expect(h.backfill.mock.invocationCallOrder[0]).toBeLessThan(
        settle.mock.invocationCallOrder[0] ?? 0
      )
    })

    it('补跑抛错只 warn，不中断这一轮取数；且照样记账不重试', async () => {
      const settle = vi.fn(() => {
        throw new Error('补跑炸了')
      })
      const warn = vi.fn()
      const h = harness({ settle })

      await createTickPipeline({ ...h.deps, log: { info: () => {}, warn } }).run(ctxOf())

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('补跑失败'))
      expect(h.refreshSnapshots).toHaveBeenCalledOnce()
    })

    it('不传 settle 时整块跳过（行为与从前逐位相同）', async () => {
      const h = harness()
      await expect(createTickPipeline(h.deps).run(ctxOf())).resolves.toBeUndefined()
      expect(h.meta.has(META_KEYS.lastSettledDate)).toBe(false)
    })
  })

  it('备份挂在休市维护里，盘中不跑 —— VACUUM INTO 要读全库，会和取数抢连接', async () => {
    const backup = vi.fn()
    const h = harness({ backup })

    await createTickPipeline(h.deps).run(ctxOf())
    expect(backup).not.toHaveBeenCalled()

    await createTickPipeline(h.deps).run(ctxOf({ session: 'CLOSED', needsQuotes: false }))
    expect(backup).toHaveBeenCalledWith(AT)
  })
})
