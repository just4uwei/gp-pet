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

/** 持仓强制类（跌破止损线）。浮亏走 `evidence.profitPct`，是**百分数**不是比率 */
function forcedOutcome(profitPct: number): SignalOutcome {
  return outcome({
    evaluation: evaluation({
      direction: 'SELL',
      verdicts: [
        { rule: 'STOP_LOSS', action: 'FORCE_SELL', evidence: { profitPct } } as unknown as RiskVerdict,
      ],
    }),
  })
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
    bumpRepeat: (id: string, at: number) => {
      const row = rows.find((r) => r.id === id)
      if (!row) return false
      row.repeatCount = (row.repeatCount ?? 1) + 1
      row.lastAt = at
      return true
    },
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

function harness(settings: Partial<AppSettings> = {}, over: { alertable?: (code: SecCode) => boolean } = {}) {
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
    ...(over.alertable ? { alertable: over.alertable } : {}),
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

  it('结论与依据都没变时不新增行，把首行的重复计数 +1', () => {
    // 盘中每 30s 一轮都会对同一个持续中的信号造一次候选、被同键冷却挡一次。
    // 那不是 N 件事，是 1 件事持续了 N 轮（006_alert_repeat.sql）
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    for (let i = 1; i <= 4; i++) {
      h.service.handle([outcome()], { at: T0 + i * 30_000, debounce: false })
    }
    // 第一行是「发出去了」，第二行是「被冷却挡掉」—— 两种裁决，两行；
    // 后面三轮与第二行一模一样，全部并进它
    expect(h.rows).toHaveLength(2)
    expect(h.rows[1]?.repeatCount).toBe(4)
    expect(h.rows[1]?.lastAt).toBe(T0 + 4 * 30_000)
  })

  it('signalId 变了就是新事件，哪怕裁决一模一样也要新行', () => {
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    h.service.handle([outcome()], { at: T0 + 30_000, debounce: false })
    expect(h.rows).toHaveLength(2)
    // 同样是「被冷却挡掉」，但换了一条信号 —— 不能记成同一件事
    h.service.handle([outcome({ signalId: 'sig-2' })], { at: T0 + 60_000, debounce: false })
    expect(h.rows).toHaveLength(3)
    expect(h.rows[2]?.repeatCount).toBeUndefined()
  })

  /*
    2026-08-17：真机一天落了 1590 行 alert_log，而它们只对应约 6 件事。
    两个成因各一条用例 —— 修一个不修另一个，日志照样翻不动。
  */
  it('抑制文案里的连续量变了不算新事件 —— 一条止损台阶只留一行', () => {
    // 「强制提醒台阶：跌幅 −8.3% 未比上次（−7.8%）再扩大 2%」里的跌幅每轮都抖，
    // 旧签名含这句文案 ⇒ 每抖一下就是一行。与 signalSignature 里 reasons[0] 同一形状
    const h = harness()
    h.service.handle([forcedOutcome(-7.8)], { at: T0, debounce: false })
    for (let i = 1; i <= 5; i++) {
      h.service.handle([forcedOutcome(-7.8 - i * 0.1)], { at: T0 + i * 30_000, debounce: false })
    }
    // ① 真发出去那条 ② 被台阶挡住那条（后五轮并进它）
    expect(h.rows).toHaveLength(2)
    expect(h.rows[1]?.repeatCount).toBe(5)
    // 保留的是第一次那句文案（011 的头注释：文案给人读，分组用离散列）
    expect(h.rows[1]?.suppressedReason).toContain('-7.9%')
  })

  it('同一只票两条信号交替出现时去重仍然有效 —— 判重键含 signalId', () => {
    // 跌破止损线的持仓会同时出 SELL 与 REDUCE 两条。旧实现只按 code 记「上一条」，
    // 两条交替来比 ⇒ 永远匹配不上，去重整块失效
    const h = harness()
    const sell = outcome({ signalId: 'sig-sell', evaluation: evaluation({ direction: 'SELL' }) })
    const buy = outcome({ signalId: 'sig-buy', evaluation: evaluation({ direction: 'BUY' }) })
    for (let i = 0; i < 4; i++) {
      h.service.handle([sell, buy], { at: T0 + i * 30_000, debounce: false })
    }
    // 两条各发出一次 + 各被冷却挡住一行（后三轮并进去），而不是 8 行
    expect(h.rows).toHaveLength(4)
    expect(h.rows.filter((row) => row.suppressedReason !== null).every((row) => row.repeatCount === 3)).toBe(
      true
    )
  })

  it('重复不把已读的行改回未读 —— 未读数答的是「有几件新事」', () => {
    const h = harness()
    h.service.handle([outcome()], { at: T0, debounce: false })
    h.service.handle([outcome()], { at: T0 + 30_000, debounce: false })
    const suppressed = h.rows[1]
    if (suppressed) suppressed.readAt = T0 + 40_000
    h.service.handle([outcome()], { at: T0 + 60_000, debounce: false })
    expect(h.rows).toHaveLength(2)
    expect(h.rows[1]?.readAt).toBe(T0 + 40_000)
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

/*
  观察名单（「行业ETF」分组）不进提醒链路（2026-08-15）。

  这一组的每一条都在防同一类错误：**少发**。少发的提醒用户发现不了 ——
  他不会知道自己漏了什么，而日志里也不会有那条记录。所以既要钉「ETF 不发」，
  更要钉「个股照发」与「不留假的拦截记录」。
*/
describe('行业ETF 观察名单：不进提醒闸门', () => {
  const ETF = 'SH512880' as SecCode
  const STOCK = 'SH600000' as SecCode
  /** 真实的判据是「分组是不是 行业ETF」，这里用代码段模拟：SH5128xx 一律当观察名单 */
  const notEtf = (code: SecCode): boolean => !code.startsWith('SH5128')

  it('ETF 的信号不弹气泡、不进 alert_log、不计未读', () => {
    const h = harness({}, { alertable: notEtf })

    const summary = h.service.handle([outcome({ evaluation: evaluation({ code: ETF }) })], {
      at: T0,
      debounce: false,
    })

    expect(summary.delivered).toBe(0)
    expect(h.sink.bubbles).toHaveLength(0)
    // ⚠ 一行都不该有。记一行「被挡」会谎报一个不存在的拦截 ——
    // alert_log 答的是「被哪道闸门挡的」，而这条根本没进过闸门
    expect(h.rows).toHaveLength(0)
  })

  it('同一轮里个股照常发 —— 摘掉的只是 ETF 那几条', () => {
    const h = harness({}, { alertable: notEtf })

    const summary = h.service.handle(
      [
        outcome({ evaluation: evaluation({ code: ETF }), signalId: 'sig-etf' }),
        outcome({ evaluation: evaluation({ code: STOCK }), signalId: 'sig-stock' }),
      ],
      { at: T0, debounce: false }
    )

    expect(summary.delivered).toBe(1)
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]?.signalId).toBe('sig-stock')
    expect(h.sink.bubbles.map((b) => b.code)).toEqual([STOCK])
  })

  it('ETF 不占全局配额：它被摘掉之后个股仍拿得到 L3', () => {
    const h = harness({}, { alertable: notEtf })

    // 先来一批 ETF 信号，再来个股那条。若 ETF 参与了分发，
    // 全局每小时 L2+L3 ≤ 6 会把后面这条降成 L1
    const etfs = Array.from({ length: 8 }, (_, i) =>
      outcome({ evaluation: evaluation({ code: `SH51288${i}` as SecCode }), signalId: `etf-${i}` })
    )
    h.service.handle(etfs, { at: T0, debounce: false })
    h.service.handle([outcome({ evaluation: evaluation({ code: STOCK }), signalId: 'sig-stock' })], {
      at: T0 + 1000,
      debounce: false,
    })

    const stockRow = h.rows.find((r) => r.signalId === 'sig-stock')
    expect(stockRow?.level).toBe('L3')
    expect(stockRow?.channels).toEqual(['PET', 'BUBBLE'])
  })

  it('默认全放行 —— 不传 alertable 时行为一字不变', () => {
    const h = harness()
    h.service.handle([outcome({ evaluation: evaluation({ code: ETF }) })], { at: T0, debounce: false })
    expect(h.rows).toHaveLength(1)
    expect(h.sink.bubbles).toHaveLength(1)
  })
})
