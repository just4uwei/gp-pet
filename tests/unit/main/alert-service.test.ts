/**
 * 提醒编排（src/main/alerts/service.ts）。
 *
 * 分发器本身的四道闸门在 alerts.test.ts 里已经逐条测过，这里测的是**编排**：
 *   - 每一条候选都写 alert_log，包括被丢弃的（docs/05 §4「不制造信息黑洞」）
 *   - 被丢弃的行记的是它**本来**要发的级别，channel 为空
 *   - 一次最多弹一个气泡，且给得分最高的那条
 *   - 气泡是**唯一**的可见渠道（2026-08-13 起托盘角标与系统通知已移除）
 *   - 被降级成 L1 的仍然点亮状态点、仍然进未读计数，只是不弹气泡
 *   - 落库失败不能把提醒也一起吃掉
 */

import { describe, expect, it, vi } from 'vitest'
import type { Evaluation } from '@core/engine'
import type { AlertLevel, GatedDirection, RiskVerdict, SecCode } from '@core/types'
import type { AlertPayload, AppSettings } from '@shared/ipc-types'
import { AlertDispatcher } from '@main/alerts/dispatcher'
import { createAlertService, type AlertSink } from '@main/alerts/service'
import type { SignalOutcome } from '@main/engine/signals'
import type { AlertJoinedRow, AlertRepo, AlertRow } from '@main/storage/repositories/alert'
import { DEFAULT_SETTINGS } from '@main/settings/schema'

const T0 = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000 + 9 * 3_600_000

function evaluation(options: {
  code?: SecCode
  direction?: GatedDirection
  level?: AlertLevel
  score?: number
  verdicts?: RiskVerdict[]
} = {}): Evaluation {
  return {
    code: options.code ?? ('SH600000' as SecCode),
    candle: { close: 12.34 },
    signal: { score: options.score ?? 0.9, subSignals: [] },
    gated: {
      direction: options.direction ?? 'BUY',
      level: options.level ?? 'L3',
      suppressed: false,
      headline: '均线金叉 · 上升趋势',
      reasons: ['均线金叉'],
      verdicts: options.verdicts ?? [],
    },
  } as unknown as Evaluation
}

function outcome(overrides: Partial<SignalOutcome> = {}): SignalOutcome {
  return { evaluation: evaluation(), name: '浦发银行', persisted: true, signalId: 'sig-1', ...overrides }
}

/** 内存版 alert_log。只实现 service 用到的那几个方法 */
function fakeRepo(): { repo: AlertRepo; rows: AlertRow[] } {
  const rows: AlertRow[] = []
  const repo = {
    insert: (row: AlertRow) => rows.push(row),
    insertMany: (batch: readonly AlertRow[]) => rows.push(...batch),
    query: (): AlertJoinedRow[] => [],
    get: (id: string) => rows.find((r) => r.id === id) ?? null,
    markRead: () => 0,
    markAllRead: () => rows.length,
    unreadCount: () => rows.filter((r) => r.channels.length > 0 && r.readAt === null).length,
    countSince: () => rows.length,
  } as unknown as AlertRepo
  return { repo, rows }
}

function fakeSink(): { sink: AlertSink; bubbles: AlertPayload[]; unread: number[] } {
  const bubbles: AlertPayload[] = []
  const unread: number[] = []
  const sink: AlertSink = {
    bubble: (payload) => bubbles.push(payload),
    unread: (count) => unread.push(count),
    petState: () => {},
  }
  return { sink, bubbles, unread }
}

function harness(settings: Partial<AppSettings> = {}) {
  const { repo, rows } = fakeRepo()
  const sink = fakeSink()
  let counter = 0
  let quiet: { quiet: boolean; reason?: string } = { quiet: false }
  const service = createAlertService({
    repo,
    sink: sink.sink,
    settings: () => ({ ...DEFAULT_SETTINGS, ...settings }),
    quiet: () => quiet,
    // 分发器不防抖：这里测的是编排，防抖已经在 alerts.test.ts 里逐条测过
    dispatcher: new AlertDispatcher({ debounceTicks: 1, startOfDay: (ts) => Math.floor(ts / 86_400_000) * 86_400_000 }),
    newId: () => `alert-${++counter}`,
  })
  return {
    service,
    rows,
    sink,
    setQuiet: (next: { quiet: boolean; reason?: string }) => {
      quiet = next
    },
  }
}

describe('不制造信息黑洞：每一条候选都留一行', () => {
  it('发出去的那条记下渠道', () => {
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]?.level).toBe('L3')
    expect(h.rows[0]?.channels).toEqual(['PET', 'BUBBLE'])
    expect(h.rows[0]?.suppressedReason).toBeNull()
  })

  it('被冷却挡掉的那条也留一行，记的是它本来要发的级别', () => {
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    h.service.handle([outcome()], { at: T0 + 60_000, debounce: false })

    expect(h.rows).toHaveLength(2)
    const second = h.rows[1]
    expect(second?.channels).toEqual([])
    expect(second?.level).toBe('L3')
    expect(second?.suppressedReason).toContain('冷却')
  })

  it('一条候选都没有时不写库、也不打扰任何渠道', () => {
    const h = harness()
    const summary = h.service.handle([], { at: T0, debounce: false })
    expect(summary).toEqual({ decisions: [], delivered: 0, suppressed: 0 })
    expect(h.rows).toHaveLength(0)
    expect(h.sink.unread).toHaveLength(0)
  })
})

describe('渠道执行', () => {
  it('一次只弹一个气泡，给本轮得分最高的那条', () => {
    const h = harness()
    h.service.handle(
      [
        outcome({ evaluation: evaluation({ code: 'SH600000' as SecCode, score: 0.76 }), signalId: 'a' }),
        outcome({ evaluation: evaluation({ code: 'SZ000001' as SecCode, score: 0.93 }), signalId: 'b' }),
      ],
      { at: T0, debounce: false }
    )
    expect(h.sink.bubbles).toHaveLength(1)
    expect(h.sink.bubbles[0]?.code).toBe('SZ000001')
  })

  it('L2 与 L3 的渠道相同 —— 都是状态点 + 气泡，级别的区别在闸门②③上', () => {
    const h = harness()
    h.service.handle([outcome({ evaluation: evaluation({ level: 'L2' }) })], { at: T0, debounce: false })
    expect(h.rows[0]?.channels).toEqual(['PET', 'BUBBLE'])
    expect(h.sink.bubbles).toHaveLength(1)
  })

  /**
   * 这条钉的是「气泡是唯一的可见渠道」：同一轮里两条都发出去了，
   * 但只有得分最高的那条弹了气泡，另一条**没有任何别的出口**（旧版本会走系统通知）。
   * 它变红意味着有人给 AlertSink 加了第二个可见渠道 —— 那要先过 docs/05 §3。
   */
  it('同一轮两条都发出，可见的仍然只有一个气泡', () => {
    const h = harness()
    h.service.handle(
      [
        outcome({ evaluation: evaluation({ code: 'SH600000' as SecCode, score: 0.7 }), signalId: 'a' }),
        outcome({ evaluation: evaluation({ code: 'SZ000001' as SecCode, score: 0.9 }), signalId: 'b' }),
      ],
      { at: T0, debounce: false }
    )
    expect(h.rows).toHaveLength(2)
    expect(h.rows.every((row) => row.channels.length > 0)).toBe(true)
    expect(h.sink.bubbles).toHaveLength(1)
    expect(h.sink.bubbles[0]?.code).toBe('SZ000001')
  })
})

describe('免打扰下的降级（闸门④）', () => {
  it('降为 L1：不弹气泡，但仍写库、仍进未读计数，且原因写明', () => {
    const h = harness()
    h.setQuiet({ quiet: true, reason: '演示模式' })
    const summary = h.service.handle([outcome()], { at: T0, debounce: false })

    expect(summary.delivered).toBe(1)
    expect(h.sink.bubbles).toHaveLength(0)
    expect(h.rows[0]?.level).toBe('L1')
    expect(h.rows[0]?.channels).toEqual(['PET'])
    expect(h.rows[0]?.suppressedReason).toContain('演示模式')
  })
})

describe('状态点只由实际发出的提醒驱动', () => {
  it('发出去了就点亮高优先级状态', () => {
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    expect(h.service.pet.resolve('IDLE', T0)).toBe('EXCITED')
  })

  it('被闸门挡下时只到 WATCHING，不点亮高优先级状态', () => {
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    h.service.handle([outcome()], { at: T0 + 60_000, debounce: false })
    // 第二轮全被冷却挡掉，此时早已过了 3s 的驻留期
    expect(h.service.pet.resolve('IDLE', T0 + 60_000)).toBe('WATCHING')
  })
})

describe('落库失败不能把提醒一起吃掉', () => {
  it('insertMany 抛错时渠道照常执行，并留一条 warn', () => {
    const sink = fakeSink()
    const warn = vi.fn()
    const repo = {
      insertMany: () => {
        throw new Error('database is locked')
      },
      unreadCount: () => 0,
    } as unknown as AlertRepo
    const service = createAlertService({
      repo,
      sink: sink.sink,
      settings: () => DEFAULT_SETTINGS,
      quiet: () => ({ quiet: false }),
      dispatcher: new AlertDispatcher({ debounceTicks: 1 }),
      log: { info: () => {}, warn },
    })

    const summary = service.handle([outcome()], { at: T0, debounce: false })
    expect(summary.delivered).toBe(1)
    expect(sink.bubbles).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
  })
})
