/**
 * 时段驱动的 tick 调度（docs/03 §3、§2.4）。
 *
 * 用「自重排的 setTimeout」而不是 setInterval：
 *   - 间隔随时段变化（休市 5min ↔ 收盘竞价 10s），setInterval 改不了周期；
 *   - 一次 tick 里的取数可能耗时数秒，setInterval 会让回调堆叠，
 *     免费接口那边看到的是并发翻倍 —— 这正是请求礼节要避免的。
 *
 * 调度器本身不发请求、不碰数据库。它只回答「现在是什么时段、该不该取数」，
 * 具体取什么由 onTick 的实现决定（M1 里是 MarketDataService）。
 */

import type { TradeDate, TradingSession } from '@core/types'
import {
  SESSION_BOUNDS,
  needsQuotes,
  producesSignals,
  sessionAt,
  tickIntervalMs,
} from '@core/session'
import type { CalendarSource, DayVerdict, TradingCalendar } from './calendar'
import { shanghaiTime } from './clock'

export interface TickContext {
  at: number
  date: TradeDate
  minuteOfDay: number
  session: TradingSession
  isTradingDay: boolean
  calendarSource: CalendarSource
  /** 日历依据不硬（见 calendar.ts），UI 应提示「日历可能过期」 */
  calendarUncertain: boolean
  /** 与上一次 tick 相比时段变了。SETTLE 的确认轮就挂在这个标志上 */
  sessionChanged: boolean
  /** 该时段是否应当取数（休市与午休为 false，docs/03 §2.4） */
  needsQuotes: boolean
  /** 该时段是否允许产出信号（竞价阶段为 false，虚价会伪造穿越） */
  producesSignals: boolean
  /**
   * 探测轮：日历说今天休市，但依据是未核对的内置表。
   * 取一次数看看有没有真行情，有就用 calendar.markObserved 纠正日历。
   * 探测轮不产出信号。
   */
  probe: boolean
}

export interface SchedulerOptions {
  calendar: Pick<TradingCalendar, 'resolve' | 'markObserved'>
  /** 每次 tick 现读，设置改了下一跳就生效，不需要重启调度器 */
  pollIntervalSec: () => number
  onTick: (ctx: TickContext) => void | Promise<void>
  /** onTick 抛出时的去处。调度器自己绝不因为一次失败停摆 */
  onError?: (error: unknown, ctx: TickContext) => void
  now?: () => number
  /** 可注入，便于测试用假计时器 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 未核对日历下的探测间隔，默认 30 分钟 */
  probeIntervalMs?: number
}

export interface Scheduler {
  start(): void
  stop(): void
  readonly running: boolean
  /** 立即跑一轮（用户点「刷新」、或启动后的第一轮） */
  tick(): Promise<void>
  /** 当前时段与下一跳间隔，供面板与托盘展示 */
  peek(): { session: TradingSession; verdict: DayVerdict; nextDelayMs: number }
}

export const DEFAULT_PROBE_INTERVAL_MS = 30 * 60_000

export function createScheduler(options: SchedulerOptions): Scheduler {
  const {
    calendar,
    pollIntervalSec,
    onTick,
    onError,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
  } = options

  let running = false
  let handle: unknown = null
  let lastSession: TradingSession | null = null
  let lastProbeAt = Number.NEGATIVE_INFINITY
  /** 正在跑 tick —— 手动刷新与定时到点撞上时不要并发取数 */
  let inFlight = false

  /** 交易时段内（09:30–15:00）才值得探测：别的时间本来就没有行情可看 */
  function withinTradingHours(minuteOfDay: number): boolean {
    return minuteOfDay >= SESSION_BOUNDS.open && minuteOfDay < SESSION_BOUNDS.close
  }

  function build(at: number): { ctx: TickContext; verdict: DayVerdict } {
    const { date, minuteOfDay } = shanghaiTime(at)
    const verdict = calendar.resolve(date)

    const probe =
      !verdict.isOpen &&
      verdict.uncertain &&
      withinTradingHours(minuteOfDay) &&
      at - lastProbeAt >= probeIntervalMs

    // 探测轮借「真交易日」的时段来决定取什么，但不产出信号
    const session = sessionAt(minuteOfDay, verdict.isOpen || probe)

    return {
      verdict,
      ctx: {
        at,
        date,
        minuteOfDay,
        session,
        isTradingDay: verdict.isOpen,
        calendarSource: verdict.source,
        calendarUncertain: verdict.uncertain,
        sessionChanged: lastSession !== session,
        needsQuotes: needsQuotes(session),
        producesSignals: !probe && verdict.isOpen && producesSignals(session),
        probe,
      },
    }
  }

  function nextDelayMs(ctx: TickContext): number {
    // 探测轮结束就回到休市心跳：下一次探测由 probeIntervalMs 决定，
    // 不该因为探测轮借用了交易时段而把心跳加速到 30s
    const session: TradingSession = ctx.probe ? 'CLOSED' : ctx.session
    return tickIntervalMs(session, pollIntervalSec())
  }

  function schedule(ctx: TickContext): void {
    if (!running) return
    handle = setTimer(() => {
      void run()
    }, nextDelayMs(ctx))
  }

  async function run(): Promise<void> {
    if (!running || inFlight) return
    const { ctx } = build(now())
    inFlight = true
    try {
      lastSession = ctx.session
      if (ctx.probe) lastProbeAt = ctx.at
      await onTick(ctx)
    } catch (error) {
      // 一次失败不能让调度停摆 —— 那会表现成「桌宠还在，但再也不更新了」
      onError?.(error, ctx)
    } finally {
      inFlight = false
      schedule(ctx)
    }
  }

  return {
    get running() {
      return running
    },

    start() {
      if (running) return
      running = true
      void run()
    },

    stop() {
      running = false
      if (handle !== null) clearTimer(handle)
      handle = null
      lastSession = null
    },

    tick: run,

    peek() {
      const { ctx, verdict } = build(now())
      return { session: ctx.session, verdict, nextDelayMs: nextDelayMs(ctx) }
    },
  }
}

export { SHANGHAI_OFFSET_MIN, formatShanghaiTime, shanghaiEpochMs, shanghaiTime } from './clock'
export { createClockSync } from './clock-sync'
export type { ClockReport, ClockSample, ClockSync } from './clock-sync'
export { createTradingCalendar, parseHolidayTable } from './calendar'
export type {
  CalendarSource,
  CalendarStore,
  DayVerdict,
  HolidayTable,
  RefreshResult,
  TradingCalendar,
} from './calendar'
export { HOLIDAY_FILE, loadHolidayTable } from './holidays'
