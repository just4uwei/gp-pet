/**
 * 时段驱动的 tick 调度（docs/03 §3）。
 *
 * 计时器与时钟全部注入，测试里不真的等 30 秒。
 */

import { describe, expect, it } from 'vitest'
import type { TradeDate } from '@core/types'
import type { DayVerdict } from '@main/scheduler/calendar'
import { shanghaiEpochMs } from '@main/scheduler/clock'
import { type TickContext, createScheduler } from '@main/scheduler'

/** 一个可手动推进的假计时器：只记「下一跳多久之后」，由测试决定何时触发 */
function fakeTimers() {
  let pending: { fn: () => void; ms: number } | null = null
  return {
    delays: [] as number[],
    setTimer(this: { delays: number[] }, fn: () => void, ms: number) {
      pending = { fn, ms }
      this.delays.push(ms)
      return 1
    },
    clearTimer() {
      pending = null
    },
    /** 触发已排的那一跳 */
    fire() {
      const next = pending
      pending = null
      next?.fn()
    },
    get scheduled() {
      return pending !== null
    },
  }
}

function at(date: TradeDate, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return shanghaiEpochMs(date, (h ?? 0) * 60 + (m ?? 0)) ?? 0
}

interface Harness {
  clock: number
  ticks: TickContext[]
  observed: [TradeDate, boolean][]
}

function harness(verdictOf: (date: TradeDate) => Partial<DayVerdict>, startAt: number) {
  const state: Harness = { clock: startAt, ticks: [], observed: [] }
  const timers = fakeTimers()
  const calendar = {
    resolve: (date: TradeDate): DayVerdict => ({
      date,
      isOpen: true,
      source: 'db' as const,
      uncertain: false,
      ...verdictOf(date),
    }),
    markObserved: (date: TradeDate, isOpen: boolean) => {
      state.observed.push([date, isOpen])
    },
  }

  const scheduler = createScheduler({
    calendar,
    pollIntervalSec: () => 30,
    onTick: (ctx) => {
      state.ticks.push(ctx)
    },
    now: () => state.clock,
    setTimer: timers.setTimer.bind(timers),
    clearTimer: timers.clearTimer,
    probeIntervalMs: 30 * 60_000,
  })

  return { state, timers, scheduler }
}

const OPEN = () => ({ isOpen: true, source: 'db' as const, uncertain: false })

describe('Scheduler · 时段与间隔', () => {
  it('连续竞价用用户配置的轮询频率', async () => {
    const { state, timers, scheduler } = harness(OPEN, at('2026-08-11', '10:00'))
    scheduler.start()
    await Promise.resolve()

    expect(state.ticks[0]).toMatchObject({
      session: 'CONTINUOUS_AM',
      needsQuotes: true,
      producesSignals: true,
      probe: false,
    })
    expect(timers.delays[0]).toBe(30_000)
  })

  it('各时段的间隔按 docs/03 §3 的表来，不凭手感', async () => {
    const cases: [string, string, number][] = [
      ['09:05', 'PRE_OPEN', 60_000],
      ['09:20', 'AUCTION', 30_000],
      ['09:27', 'PRE_TRADE', 30_000],
      ['12:00', 'LUNCH_BREAK', 300_000],
      ['14:58', 'CLOSING_AUCTION', 10_000],
      ['15:05', 'SETTLE', 300_000],
      ['16:00', 'CLOSED', 300_000],
    ]
    for (const [time, session, delay] of cases) {
      const { state, timers, scheduler } = harness(OPEN, at('2026-08-11', time))
      scheduler.start()
      await Promise.resolve()
      expect([time, state.ticks[0]?.session, timers.delays[0]]).toEqual([time, session, delay])
    }
  })

  it('休市与午休不取数（docs/03 §2.4：休市期间完全不发请求）', async () => {
    for (const time of ['12:00', '16:00', '08:00']) {
      const { state, scheduler } = harness(OPEN, at('2026-08-11', time))
      scheduler.start()
      await Promise.resolve()
      expect(state.ticks[0]?.needsQuotes).toBe(false)
    }
  })

  it('竞价时段只更新价格，不产出信号', async () => {
    for (const time of ['09:20', '09:27', '14:58']) {
      const { state, scheduler } = harness(OPEN, at('2026-08-11', time))
      scheduler.start()
      await Promise.resolve()
      expect(state.ticks[0]).toMatchObject({ needsQuotes: true, producesSignals: false })
    }
  })

  it('非交易日只留 5 分钟心跳，不取数也不产信号', async () => {
    const { state, timers, scheduler } = harness(
      () => ({ isOpen: false, source: 'weekday', uncertain: false }),
      at('2026-08-15', '10:00')
    )
    scheduler.start()
    await Promise.resolve()

    expect(state.ticks[0]).toMatchObject({
      session: 'CLOSED',
      isTradingDay: false,
      needsQuotes: false,
      producesSignals: false,
      probe: false,
    })
    expect(timers.delays[0]).toBe(300_000)
  })

  it('SETTLE 确认轮靠 sessionChanged 触发一次，同时段的后续 tick 不再触发', async () => {
    const { state, timers, scheduler } = harness(OPEN, at('2026-08-11', '15:01'))
    scheduler.start()
    await Promise.resolve()
    expect(state.ticks[0]).toMatchObject({ session: 'SETTLE', sessionChanged: true })

    state.clock = at('2026-08-11', '15:06')
    timers.fire()
    await Promise.resolve()
    expect(state.ticks[1]).toMatchObject({ session: 'SETTLE', sessionChanged: false })
  })

  it('时段切换时下一跳间隔跟着变', async () => {
    const { state, timers, scheduler } = harness(OPEN, at('2026-08-11', '14:56'))
    scheduler.start()
    await Promise.resolve()
    expect(timers.delays[0]).toBe(30_000)

    state.clock = at('2026-08-11', '14:57')
    timers.fire()
    await Promise.resolve()
    expect(state.ticks[1]?.session).toBe('CLOSING_AUCTION')
    expect(timers.delays[1]).toBe(10_000)
  })

  it('间隔现读设置：改了轮询频率下一跳就生效，不用重启调度器', async () => {
    let poll = 30
    const timers = fakeTimers()
    let clock = at('2026-08-11', '10:00')
    const scheduler = createScheduler({
      calendar: { resolve: (date) => ({ date, isOpen: true, source: 'db', uncertain: false }), markObserved: () => {} },
      pollIntervalSec: () => poll,
      onTick: () => {},
      now: () => clock,
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer,
    })

    scheduler.start()
    await Promise.resolve()
    expect(timers.delays[0]).toBe(30_000)

    poll = 120
    clock += 30_000
    timers.fire()
    await Promise.resolve()
    expect(timers.delays[1]).toBe(120_000)
  })
})

describe('Scheduler · 健壮性', () => {
  it('onTick 抛错不让调度停摆 —— 那会表现成「桌宠还在但再也不更新」', async () => {
    const timers = fakeTimers()
    const errors: unknown[] = []
    let calls = 0
    const scheduler = createScheduler({
      calendar: { resolve: (date) => ({ date, isOpen: true, source: 'db', uncertain: false }), markObserved: () => {} },
      pollIntervalSec: () => 30,
      onTick: () => {
        calls += 1
        throw new Error('取数炸了')
      },
      onError: (error) => errors.push(error),
      now: () => at('2026-08-11', '10:00'),
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer,
    })

    scheduler.start()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(timers.scheduled).toBe(true)

    timers.fire()
    await Promise.resolve()
    expect(calls).toBe(2)
  })

  it('上一轮还没跑完时不并发取数', async () => {
    const timers = fakeTimers()
    // 初值是空实现而不是 null：赋值发生在回调里，TS 的控制流分析看不到，
    // 断言点上 null 分支会被窄化掉
    let release: () => void = () => {}
    let entered = 0
    const scheduler = createScheduler({
      calendar: { resolve: (date) => ({ date, isOpen: true, source: 'db', uncertain: false }), markObserved: () => {} },
      pollIntervalSec: () => 30,
      onTick: () =>
        new Promise<void>((resolve) => {
          entered += 1
          release = resolve
        }),
      now: () => at('2026-08-11', '10:00'),
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer,
    })

    scheduler.start()
    await Promise.resolve()
    expect(entered).toBe(1)

    // 手动刷新撞上还没结束的一轮
    await scheduler.tick()
    expect(entered).toBe(1)

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(timers.scheduled).toBe(true)
  })

  it('stop 之后不再排下一跳；重复 start 不会排两条', async () => {
    const { state, timers, scheduler } = harness(OPEN, at('2026-08-11', '10:00'))
    scheduler.start()
    scheduler.start()
    await Promise.resolve()
    expect(state.ticks).toHaveLength(1)

    scheduler.stop()
    expect(scheduler.running).toBe(false)
    expect(timers.scheduled).toBe(false)

    await scheduler.tick()
    expect(state.ticks).toHaveLength(1)
  })

  it('peek 不跑 tick，只报当前时段', () => {
    const { state, scheduler } = harness(OPEN, at('2026-08-11', '10:00'))
    expect(scheduler.peek()).toMatchObject({ session: 'CONTINUOUS_AM', nextDelayMs: 30_000 })
    expect(state.ticks).toHaveLength(0)
  })
})

describe('Scheduler · 未核对日历的探测轮', () => {
  const uncertainClosed = () => ({ isOpen: false, source: 'builtin' as const, uncertain: true })

  it('内置表说休市但未核对：交易时段内探一次，取数但不产信号', async () => {
    const { state, scheduler } = harness(uncertainClosed, at('2026-10-01', '10:00'))
    scheduler.start()
    await Promise.resolve()

    expect(state.ticks[0]).toMatchObject({
      probe: true,
      isTradingDay: false,
      session: 'CONTINUOUS_AM',
      needsQuotes: true,
      producesSignals: false,
      calendarUncertain: true,
    })
  })

  it('探测轮之后回到休市心跳，不按 30s 加速', async () => {
    const { timers, scheduler } = harness(uncertainClosed, at('2026-10-01', '10:00'))
    scheduler.start()
    await Promise.resolve()
    expect(timers.delays[0]).toBe(300_000)
  })

  it('探测有节制：间隔内的后续 tick 不再探', async () => {
    const { state, timers, scheduler } = harness(uncertainClosed, at('2026-10-01', '10:00'))
    scheduler.start()
    await Promise.resolve()

    state.clock = at('2026-10-01', '10:05')
    timers.fire()
    await Promise.resolve()
    expect(state.ticks[1]).toMatchObject({ probe: false, needsQuotes: false, session: 'CLOSED' })

    state.clock = at('2026-10-01', '10:31')
    timers.fire()
    await Promise.resolve()
    expect(state.ticks[2]?.probe).toBe(true)
  })

  it('交易时段外不探 —— 那时候本来就没有行情可看', async () => {
    for (const time of ['08:00', '09:20', '15:30']) {
      const { state, scheduler } = harness(uncertainClosed, at('2026-10-01', time))
      scheduler.start()
      await Promise.resolve()
      expect([time, state.ticks[0]?.probe]).toEqual([time, false])
    }
  })

  it('依据确定的休市日不探（周末、已核对的节假日）', async () => {
    for (const source of ['weekday', 'builtin', 'db'] as const) {
      const { state, scheduler } = harness(
        () => ({ isOpen: false, source, uncertain: false }),
        at('2026-08-15', '10:00')
      )
      scheduler.start()
      await Promise.resolve()
      expect(state.ticks[0]?.probe).toBe(false)
    }
  })

  it('探测到真行情后由 onTick 调 markObserved 纠正日历，之后恢复正常轮询', async () => {
    let clock = at('2026-10-01', '10:00')
    const timers = fakeTimers()
    const db = new Map<string, boolean>()
    const ticks: TickContext[] = []

    const calendar = {
      resolve: (date: TradeDate): DayVerdict => {
        const fromDb = db.get(date)
        if (fromDb !== undefined) return { date, isOpen: fromDb, source: 'db', uncertain: false }
        return { date, isOpen: false, source: 'builtin', uncertain: true }
      },
      markObserved: (date: TradeDate, isOpen: boolean) => db.set(date, isOpen),
    }

    const scheduler = createScheduler({
      calendar,
      pollIntervalSec: () => 30,
      onTick: (ctx) => {
        ticks.push(ctx)
        // 真实实现里这一步的依据是快照时间戳落在今天
        if (ctx.probe) calendar.markObserved(ctx.date, true)
      },
      now: () => clock,
      setTimer: timers.setTimer.bind(timers),
      clearTimer: timers.clearTimer,
    })

    scheduler.start()
    await Promise.resolve()
    expect(ticks[0]?.probe).toBe(true)

    clock = at('2026-10-01', '10:05')
    timers.fire()
    await Promise.resolve()
    expect(ticks[1]).toMatchObject({
      probe: false,
      isTradingDay: true,
      session: 'CONTINUOUS_AM',
      producesSignals: true,
      calendarSource: 'db',
    })
    expect(timers.delays[1]).toBe(30_000)
  })
})
