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
function harness(over: Partial<TickPipelineDeps> = {}): {
  deps: TickPipelineDeps
  meta: Map<string, number>
  backfill: ReturnType<typeof vi.fn>
  refreshSnapshots: ReturnType<typeof vi.fn>
  refreshProfiles: ReturnType<typeof vi.fn>
  calendarRefresh: ReturnType<typeof vi.fn>
  markObserved: ReturnType<typeof vi.fn>
} {
  const meta = new Map<string, number>()
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
      resolve: (date: TradeDate) => ({ date, isOpen: true, source: 'db' as const, uncertain: false }),
      refresh: calendarRefresh,
      markObserved,
    },
    meta: {
      getNumber: (key) => meta.get(key) ?? null,
      setNumber: (key, value) => void meta.set(key, value),
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

  it('影子运行拿到本轮的评估结果，排在提醒之后', async () => {
    const order: string[] = []
    const advance = vi.fn(() => order.push('shadow'))
    const engine = { run: vi.fn(() => [{ tag: 'outcome' }] as never) }
    const h = harness({
      engine,
      onSignals: () => order.push('alerts'),
      shadow: { advance },
    })
    await createTickPipeline(h.deps).run(ctxOf())

    expect(advance).toHaveBeenCalledWith({
      date: '2026-03-10',
      at: AT,
      outcomes: [{ tag: 'outcome' }],
    })
    // 提醒先、影子后：模拟账本比提醒次要，不该抢在它前面
    expect(order).toEqual(['alerts', 'shadow'])
  })

  it('影子推进抛错不影响提醒与取数 —— 两者重要性差一个量级', async () => {
    const onSignals = vi.fn()
    const h = harness({
      engine: { run: vi.fn(() => [] as never) },
      onSignals,
      shadow: {
        advance: () => {
          throw new Error('账本炸了')
        },
      },
    })
    const pipeline = createTickPipeline(h.deps)
    await expect(pipeline.run(ctxOf())).resolves.toBeUndefined()
    expect(onSignals).toHaveBeenCalledOnce()
    expect(h.refreshSnapshots).toHaveBeenCalledOnce()
  })

  it('引擎未接入时影子也不推进（没有评估结果可喂）', async () => {
    const advance = vi.fn()
    const h = harness({ shadow: { advance } })
    await createTickPipeline(h.deps).run(ctxOf())
    expect(advance).not.toHaveBeenCalled()
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
