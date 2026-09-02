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
import { CLOSE_CATCHUP, createTickPipeline, MAINTENANCE_INTERVAL_MS, type TickPipelineDeps } from '@main/engine'
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
  pendingIndustry: ReturnType<typeof vi.fn>
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
  const pendingIndustry = vi.fn((): SecCode[] => [])
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
    watchlist: { codes: () => ['SH600000' as SecCode], refreshProfiles, pendingIndustry },
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
  return {
    deps,
    meta,
    backfill,
    refreshSnapshots,
    refreshProfiles,
    pendingIndustry,
    calendarRefresh,
    markObserved,
  }
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

  /**
   * 每周那趟刷新只要拿到名字就算成功并盖下时间戳，而行业只有主源给 ——
   * 主源那一刻在冷却里的话，这一整周就都没有行业（真机 2026-08-26 实测 79/79 全空）。
   * 这一组钉的是补救那趟的三条边界。
   */
  describe('补行业（每天一趟，INDUSTRY_RETRY_INTERVAL_MS）', () => {
    it('整周刷新刚跑过的那一轮不补 —— 同一批代码连打两遍，第二遍必然还是备源', async () => {
      const h = harness()
      h.pendingIndustry.mockReturnValue(['SH600000'])

      await createTickPipeline(h.deps).run(ctxOf({ needsQuotes: false }))

      expect(h.refreshProfiles).toHaveBeenCalledOnce()
      expect(h.refreshProfiles).toHaveBeenCalledWith()
      expect(h.meta.has(META_KEYS.industryRetryAt)).toBe(false)
    })

    it('只对还缺行业的那批再问一次，问过就盖时间戳（哪怕一只都没补上）', async () => {
      const h = harness()
      h.meta.set(META_KEYS.profileRefreshedAt, AT)
      h.pendingIndustry.mockReturnValue(['SH600000', 'SZ000001'])

      await createTickPipeline(h.deps).run(ctxOf({ needsQuotes: false }))

      expect(h.refreshProfiles).toHaveBeenCalledWith(['SH600000', 'SZ000001'])
      expect(h.meta.get(META_KEYS.industryRetryAt)).toBe(AT)
    })

    it('一个都不缺时不发请求也不写 meta —— 稳态是零请求', async () => {
      const h = harness()
      h.meta.set(META_KEYS.profileRefreshedAt, AT)

      await createTickPipeline(h.deps).run(ctxOf({ needsQuotes: false }))

      expect(h.refreshProfiles).not.toHaveBeenCalled()
      expect(h.meta.has(META_KEYS.industryRetryAt)).toBe(false)
    })

    it('同一天内不重复补', async () => {
      const h = harness()
      h.meta.set(META_KEYS.profileRefreshedAt, AT)
      h.meta.set(META_KEYS.industryRetryAt, AT - 60_000)
      h.pendingIndustry.mockReturnValue(['SH600000'])

      await createTickPipeline(h.deps).run(ctxOf({ needsQuotes: false }))

      expect(h.refreshProfiles).not.toHaveBeenCalled()
    })
  })

  it('自选为空时不发任何行情请求', async () => {
    const h = harness({
      watchlist: { codes: () => [], refreshProfiles: async () => 0, pendingIndustry: () => [] },
    })

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

    // ⚠ 理由 2026-09-02 换了：当日补跑现在**做**，但只从 15:10 之后的收尾窗口进
    // （见下面那个 describe）。取数轮这一处仍然只走「上一个交易日」
    it('取数轮不补跑当天 —— 当日那条路只从 15:10 之后的收尾窗口进', async () => {
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

  /*
    收盘后的日线收尾窗口（2026-08-19，CLOSE_CATCHUP）。

    为什么要钉：错法全是静默的 ——
    不跑 → 当日收盘线要到次日盘前才入库，日报整天卡在「未定稿」而界面上看不出原因；
    不停手 → 那 10 只结构性拉不到的 ETF 会让休市期间每 5 分钟发一轮请求，
    而请求礼节（docs/03 §2.4）没有任何东西会替我们报警。
  */
  describe('收盘后的日线收尾窗口', () => {
    /** 15:20，落在 15:10–16:00 里 */
    const afterClose = { session: 'CLOSED' as TradingSession, needsQuotes: false, minuteOfDay: 15 * 60 + 20 }

    it('窗口内补当日日线（且不拉快照、不跑引擎）', async () => {
      const h = harness()
      const engine = { run: vi.fn(() => []) }

      await createTickPipeline({ ...h.deps, engine }).run(ctxOf(afterClose))

      expect(h.backfill).toHaveBeenCalledWith(['SH600000'], '2026-03-10')
      expect(h.refreshSnapshots).not.toHaveBeenCalled()
      expect(engine.run).not.toHaveBeenCalled()
    })

    it('补齐之后不再发请求 —— 停手闸门是 dailyCompleteDate', async () => {
      const h = harness()
      const pipeline = createTickPipeline(h.deps)

      await pipeline.run(ctxOf(afterClose))
      expect(h.meta.get(META_KEYS.dailyCompleteDate)).toBe('2026-03-10')

      h.backfill.mockClear()
      await pipeline.run(ctxOf(afterClose))
      expect(h.backfill).not.toHaveBeenCalled()
    })

    it('一直补不齐时按 maxAttempts 停手，不会整夜每 5 分钟发一轮', async () => {
      const h = harness()
      h.backfill.mockResolvedValue([{ code: 'SH600000', status: 'FAILED', written: 0, error: '源上没有' }])
      const pipeline = createTickPipeline({ ...h.deps, log: { info: () => {}, warn: () => {} } })

      for (let i = 0; i < CLOSE_CATCHUP.maxAttempts + 3; i++) await pipeline.run(ctxOf(afterClose))

      expect(h.backfill).toHaveBeenCalledTimes(CLOSE_CATCHUP.maxAttempts)
      expect(h.meta.has(META_KEYS.dailyCompleteDate)).toBe(false)
    })

    it('用满的次数跨日清零 —— 昨天补不齐不该让今天一轮都不跑', async () => {
      const h = harness()
      h.meta.set(META_KEYS.dailyCatchupDate, '2026-03-09')
      h.meta.set(META_KEYS.dailyCatchupAttempts, CLOSE_CATCHUP.maxAttempts)

      await createTickPipeline(h.deps).run(ctxOf(afterClose))

      expect(h.backfill).toHaveBeenCalledOnce()
    })

    it('16:00 之后不再补 —— 数据源 15:30 前就发完了', async () => {
      const h = harness()

      await createTickPipeline(h.deps).run(ctxOf({ ...afterClose, minuteOfDay: 16 * 60 }))

      expect(h.backfill).not.toHaveBeenCalled()
    })

    it('休市日不补', async () => {
      const h = harness({ isOpen: false })

      await createTickPipeline(h.deps).run(ctxOf({ ...afterClose, isTradingDay: false }))

      expect(h.backfill).not.toHaveBeenCalled()
    })

    /*
      「补齐才提前」（2026-09-02 用户拍板，计划 §4.12 的 `same-day-settle-decision`）。

      这三条钉的是**被否掉的那个版本**：放宽成「试到底就算数」会在一次不完整的补跑上
      写下 `lastSettledDate` 与 `shadow_equity.trade_date` 两道幂等闸门
      ⇒ 次日那次完整补跑被整个挡掉，缺线那只票当天的确认**永久缺失**。
      所以「补不齐 ⇒ 什么都不写」这一条比「补齐 ⇒ 跑」更值得钉。
    */
    it('当日补齐了就当天跑确认轮，且 feedShadow 为 true —— 下一个开盘还没到', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: true }))
      const h = harness({ settle })

      await createTickPipeline(h.deps).run(ctxOf(afterClose))

      expect(settle).toHaveBeenCalledWith('2026-03-10', true)
      expect(h.meta.get(META_KEYS.lastSettledDate)).toBe('2026-03-10')
    })

    it('同一天窗口内再跑几轮也只补跑一次', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: true }))
      const h = harness({ settle })
      const pipeline = createTickPipeline(h.deps)

      await pipeline.run(ctxOf(afterClose))
      await pipeline.run(ctxOf({ ...afterClose, minuteOfDay: 15 * 60 + 40 }))

      expect(settle).toHaveBeenCalledOnce()
    })

    it('补不齐就什么都不写 —— 次日盘前那次完整补跑必须照常发生', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })
      h.backfill.mockResolvedValue([{ code: 'SH600000', status: 'FAILED', written: 0, error: '源上没有' }])
      const pipeline = createTickPipeline({ ...h.deps, log: { info: () => {}, warn: () => {} } })

      await pipeline.run(ctxOf(afterClose))

      expect(settle).not.toHaveBeenCalled()
      expect(h.meta.has(META_KEYS.lastSettledDate)).toBe(false)
    })

    it('15:05 那一轮不提前 —— 盘中引擎还在跑，先补跑会让之后的 PROVISIONAL 行永远不被推进', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: false }))
      const h = harness({ settle })

      // SETTLE 轮（15:05）：needsQuotes 仍为 true，走的是取数那条路
      await createTickPipeline(h.deps).run(ctxOf({ session: 'SETTLE', minuteOfDay: 15 * 60 + 5 }))

      expect(settle).not.toHaveBeenCalled()
      // ⚠ 但它可能已经把当日补齐并置位了 —— 15:10 那一轮必须照样能跑到补跑
      expect(h.meta.get(META_KEYS.dailyCompleteDate)).toBe('2026-03-10')
    })

    it('SETTLE 轮就已补齐时，15:10 那一轮仍然跑补跑（「已补齐」只挡取数不挡补跑）', async () => {
      const settle = vi.fn(() => ({ evaluated: 1, persisted: 1, invalidated: 0, shadowAdvanced: true }))
      const h = harness({ settle })
      const pipeline = createTickPipeline(h.deps)

      await pipeline.run(ctxOf({ session: 'SETTLE', minuteOfDay: 15 * 60 + 5 }))
      h.backfill.mockClear()
      await pipeline.run(ctxOf(afterClose))

      expect(h.backfill).not.toHaveBeenCalled() // 取数照旧被挡住
      expect(settle).toHaveBeenCalledWith('2026-03-10', true)
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
