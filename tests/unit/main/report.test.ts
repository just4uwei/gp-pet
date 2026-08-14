/**
 * 收盘日报的聚合判据（src/main/report/build.ts）。
 *
 * 钉四类东西，每一类都是**看不出来的错**：
 *
 *   1. **只复述不推导** —— 日报凭空多出一条「明日关注」，与信号层的结论打架，
 *      而用户没有办法判断该信哪个；
 *   2. **两个数据源不混** —— 收盘线配快照的昨收会算出一个哪边都不对的涨跌幅；
 *   3. **没有就是 null，不是 0** —— 0 会让「今天平盘」与「没有数据」长得一样；
 *   4. **措辞** —— highlights 是陈述不是评价，且不得出现禁用词。
 */

import { describe, expect, it } from 'vitest'
import { buildDailyReport, highlightsOf, toStopPct, type BuildReportInput } from '@main/report/build'
import type {
  AlertRecord,
  PositionView,
  SignalRecord,
  WatchItem,
  WatchPointView,
} from '@shared/ipc-types'
import type { Candle, GatedDirection, SecCode, Snapshot, TradeDate } from '@core/types'

const DATE = '2026-08-14' as TradeDate
const AT = 1_760_000_000_000
const DAY_START = 1_759_900_000_000

function item(code: string, name = `票-${code}`, industry?: string): WatchItem {
  return {
    code: code as SecCode,
    name,
    group: '自选',
    sortOrder: 0,
    hasPosition: false,
    ...(industry === undefined ? {} : { industry }),
  }
}

function candle(date: string, close: number, over: Partial<Candle> = {}): Candle {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    openAdj: close,
    highAdj: close,
    lowAdj: close,
    closeAdj: close,
    volume: 1_000_000,
    amount: null,
    ...over,
  }
}

function snapshot(code: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    code: code as SecCode,
    at: AT,
    last: 10,
    open: 10,
    high: 10,
    low: 10,
    preClose: 10,
    volume: 1_000_000,
    amount: 10_000_000,
    limitUp: null,
    limitDown: null,
    suspended: false,
    ...over,
  }
}

function signal(code: string, over: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: `sig-${code}-${over.createdAt ?? 1}`,
    code: code as SecCode,
    name: `票-${code}`,
    createdAt: over.createdAt ?? 1_000,
    direction: 'BUY',
    score: 0.7,
    votes: 3,
    regime: 'TREND_UP',
    stage: 'CONFIRMED',
    priceAt: 10,
    level: 'L2',
    ...over,
  }
}

function point(code: string, over: Partial<WatchPointView> = {}): WatchPointView {
  return {
    id: `w-${code}-${over.status ?? 'ACTIVE'}`,
    code: code as SecCode,
    name: `票-${code}`,
    signalId: 'sig-1',
    source: 'USER_EDITED',
    metric: 'PRICE',
    op: 'LTE',
    threshold: 9,
    meaning: 'INVALIDATE',
    createdAt: 1,
    expiresAt: AT + 86_400_000,
    status: 'ACTIVE',
    ...over,
  }
}

function alert(over: Partial<AlertRecord> = {}): AlertRecord {
  return {
    id: `a-${over.reason ?? 'ok'}-${over.createdAt ?? 1}`,
    signalId: 'sig-1',
    code: 'SH600000' as SecCode,
    name: '票',
    createdAt: 1_000,
    direction: 'BUY',
    score: 0.7,
    regime: 'TREND_UP',
    stage: 'CONFIRMED',
    headline: '',
    level: 'L2',
    channels: ['PET', 'BUBBLE'],
    read: false,
    repeatCount: 1,
    ...over,
  }
}

function input(over: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    date: DATE,
    at: AT,
    items: [item('SH600000')],
    bars: new Map(),
    snapshots: new Map(),
    signals: [],
    positions: [],
    watchPoints: [],
    alerts: [],
    stopLossPct: 0.08,
    dayStart: DAY_START,
    ...over,
  }
}

describe('行情：两个来源不混，拿不到就是 null', () => {
  it('有当日收盘线 → 用它，并按**昨收**算涨跌与振幅', () => {
    const bars = new Map([
      ['SH600000' as SecCode, { day: candle(DATE, 11, { high: 12, low: 9 }), prev: candle('2026-08-13', 10) }],
    ])
    const report = buildDailyReport(input({ bars }))
    const quote = report.stocks[0]?.quote
    expect(quote?.source).toBe('CLOSE')
    expect(quote?.close).toBe(11)
    expect(quote?.changePct).toBeCloseTo(10, 6)
    expect(quote?.amplitudePct).toBeCloseTo(30, 6)
  })

  it('没有收盘线 → 退到快照，并标注来源', () => {
    const snapshots = new Map([['SH600000' as SecCode, snapshot('SH600000', { last: 11, preClose: 10, high: 12, low: 9 })]])
    const report = buildDailyReport(input({ snapshots }))
    expect(report.stocks[0]?.quote?.source).toBe('SNAPSHOT')
    expect(report.stocks[0]?.quote?.changePct).toBeCloseTo(10, 6)
  })

  it('收盘线优先于快照 —— 两者都有时不许混用（分母必须与 close 同源）', () => {
    const bars = new Map([['SH600000' as SecCode, { day: candle(DATE, 11), prev: candle('2026-08-13', 10) }]])
    const snapshots = new Map([['SH600000' as SecCode, snapshot('SH600000', { last: 20, preClose: 5 })]])
    const quote = buildDailyReport(input({ bars, snapshots })).stocks[0]?.quote
    expect(quote?.source).toBe('CLOSE')
    expect(quote?.close).toBe(11)
    expect(quote?.changePct).toBeCloseTo(10, 6)
  })

  it('两个来源都没有 → quote 是 null 且进 missing，**不是一堆 0**', () => {
    const report = buildDailyReport(input())
    expect(report.stocks[0]?.quote).toBeNull()
    expect(report.data.missing).toEqual(['SH600000'])
  })

  it('拿不到昨收时振幅是 null，不拿今开当分母', () => {
    const bars = new Map([['SH600000' as SecCode, { day: candle(DATE, 11, { high: 12, low: 9 }) }]])
    expect(buildDailyReport(input({ bars })).stocks[0]?.quote?.amplitudePct).toBeNull()
  })
})

describe('stage：定稿与否必须看得见', () => {
  const bars = new Map([['SH600000' as SecCode, { day: candle(DATE, 11), prev: candle('2026-08-13', 10) }]])

  it('有数据的都用上了收盘线 → FINAL', () => {
    expect(buildDailyReport(input({ bars })).stage).toBe('FINAL')
  })

  it('只要有一只还在用快照 → PROVISIONAL', () => {
    const report = buildDailyReport(
      input({
        items: [item('SH600000'), item('SZ000001')],
        bars,
        snapshots: new Map([['SZ000001' as SecCode, snapshot('SZ000001')]]),
      })
    )
    expect(report.stage).toBe('PROVISIONAL')
  })

  it('一只都没有数据时也不叫 FINAL —— 那是「什么都还没有」不是「已经确定」', () => {
    expect(buildDailyReport(input()).stage).toBe('PROVISIONAL')
  })
})

describe('信号：与悬浮条同一口径', () => {
  it('取当日**最后一条未静默**信号，被静默的不算', () => {
    const signals = [
      signal('SH600000', { createdAt: 1_000, direction: 'BUY' }),
      signal('SH600000', { createdAt: 2_000, direction: 'SELL' }),
      signal('SH600000', { createdAt: 3_000, direction: 'BUY', suppressedReason: '已涨停，买不到' }),
    ]
    const stock = buildDailyReport(input({ signals })).stocks[0]
    expect(stock?.signals.total).toBe(3)
    expect(stock?.signals.actionable).toBe(2)
    expect(stock?.signals.last?.direction).toBe('SELL')
    expect(stock?.signals.suppressedReasons).toEqual(['已涨停，买不到'])
  })

  it('方向分布只数未静默的', () => {
    const signals = [
      signal('SH600000', { createdAt: 1, direction: 'SELL' }),
      signal('SH600000', { createdAt: 2, direction: 'SELL' }),
      signal('SH600000', { createdAt: 3, direction: 'BUY', suppressedReason: '停牌' }),
    ]
    const report = buildDailyReport(input({ signals }))
    expect(report.overview.byDirection).toEqual([{ direction: 'SELL' as GatedDirection, count: 2 }])
    expect(report.overview.withSignal).toBe(1)
  })
})

describe('持仓：距止损线', () => {
  const held: PositionView = { code: 'SH600000' as SecCode, shares: 1000, cost: 10, peakPrice: 10, openedAt: 0 }
  const barsAt = (close: number): BuildReportInput['bars'] =>
    new Map([['SH600000' as SecCode, { day: candle(DATE, close), prev: candle('2026-08-13', 10) }]])

  it('按成本的 8% 算：现价 10 时距线 (10−9.2)/10 = 8%', () => {
    const stock = buildDailyReport(input({ positions: [held], bars: barsAt(10) })).stocks[0]
    expect(stock?.position?.toStopPct).toBeCloseTo(8, 6)
    expect(stock?.position?.pnlPct).toBeCloseTo(0, 6)
  })

  it('跌破止损线时是负数，并计入 belowStop', () => {
    const report = buildDailyReport(input({ positions: [held], bars: barsAt(9) }))
    expect(report.stocks[0]?.position?.toStopPct).toBeLessThan(0)
    expect(report.overview.belowStop).toBe(1)
  })

  it('用户重画过线时按**他画的那条**算 —— 照旧按成本算会显示一条早已不适用的距离', () => {
    const acked: PositionView = { ...held, stopAck: { stopFloor: 7, ackAt: 1, ackLossPct: -25 } }
    const stock = buildDailyReport(input({ positions: [acked], bars: barsAt(9) })).stocks[0]
    // 9 相对 7 还有距离 → 不算跌破
    expect(stock?.position?.toStopPct).toBeCloseTo(((9 - 7) / 9) * 100, 6)
    expect(stock?.position?.stopFloor).toBe(7)
  })

  it('拿不到现价时两个数都是 null，不给 0', () => {
    const stock = buildDailyReport(input({ positions: [held] })).stocks[0]
    expect(stock?.position?.pnlPct).toBeNull()
    expect(stock?.position?.toStopPct).toBeNull()
  })

  it('toStopPct 直接可测（价格非法时给 null）', () => {
    expect(toStopPct(held, 0, 0.08)).toBeNull()
    expect(toStopPct(held, null, 0.08)).toBeNull()
  })
})

describe('明日关注：只复述，不推导', () => {
  it('今日最后一条是 NEXT_DAY_WATCH → 复述它', () => {
    const signals = [signal('SH600000', { direction: 'NEXT_DAY_WATCH', score: 0.82 })]
    const report = buildDailyReport(input({ signals }))
    expect(report.tomorrow).toHaveLength(1)
    expect(report.tomorrow[0]?.kind).toBe('NEXT_DAY_WATCH')
    expect(report.tomorrow[0]?.note).toContain('明日观察')
  })

  /**
   * 这条是整个模块最要紧的一条：**给一条普通买入信号，不许凭空生出「明日关注」**。
   * 少了它，日报会开始自己下结论，而那个结论与信号层可能相反。
   */
  it('普通买入信号不产生「明日关注」—— 那是 NEXT_DAY_WATCH 在回答的问题', () => {
    const signals = [signal('SH600000', { direction: 'BUY', score: 0.95 })]
    expect(buildDailyReport(input({ signals })).tomorrow).toHaveLength(0)
  })

  it('涨得再多、振幅再大也不产生「明日关注」', () => {
    const bars = new Map([
      ['SH600000' as SecCode, { day: candle(DATE, 20, { high: 20, low: 10 }), prev: candle('2026-08-13', 10) }],
    ])
    expect(buildDailyReport(input({ bars })).tomorrow).toHaveLength(0)
  })

  it('仍在盯的观察点会被复述；已命中/已过期的不进「明日关注」', () => {
    const watchPoints = [
      point('SH600000', { status: 'ACTIVE' }),
      point('SH600000', { status: 'HIT', hitAt: DAY_START + 10 }),
      point('SH600000', { status: 'EXPIRED' }),
    ]
    const report = buildDailyReport(input({ watchPoints }))
    expect(report.tomorrow.filter((t) => t.kind === 'WATCH_POINT')).toHaveLength(1)
    expect(report.stocks[0]?.watch).toEqual({ hit: 1, expired: 1, active: 1 })
  })

  it('持仓未了结时复述**那条信号自己的方向**，不另起结论', () => {
    const held: PositionView = { code: 'SH600000' as SecCode, shares: 1000, cost: 10, peakPrice: 10, openedAt: 0 }
    const signals = [signal('SH600000', { direction: 'SELL' })]
    const report = buildDailyReport(input({ positions: [held], signals }))
    const risk = report.tomorrow.find((t) => t.kind === 'POSITION_RISK')
    expect(risk?.note).toContain('卖出')
  })

  it('昨天的命中不算今天的 —— 命中计数按 dayStart 切', () => {
    const watchPoints = [point('SH600000', { status: 'HIT', hitAt: DAY_START - 1 })]
    expect(buildDailyReport(input({ watchPoints })).stocks[0]?.watch.hit).toBe(0)
  })
})

describe('提醒统计', () => {
  it('发出去的与被挡下的分开数', () => {
    const alerts = [
      alert({ createdAt: 1 }),
      alert({ createdAt: 2, channels: [], reason: '免打扰时段' }),
      alert({ createdAt: 3, channels: [], reason: '免打扰时段' }),
      alert({ createdAt: 4, channels: [], reason: '同键冷却中' }),
    ]
    const report = buildDailyReport(input({ alerts }))
    expect(report.alerts.delivered).toBe(1)
    expect(report.alerts.gated).toBe(3)
    expect(report.alerts.reasons).toEqual([
      { reason: '免打扰时段', count: 2 },
      { reason: '同键冷却中', count: 1 },
    ])
  })
})

describe('highlights：是陈述，不是评价', () => {
  const base = {
    items: [item('SH600000'), item('SZ000001')],
    withSignal: 1,
    byDirection: [{ direction: 'SELL' as GatedDirection, count: 2 }],
    belowStop: 1,
    delivered: 3,
    gated: 2,
    tomorrow: [],
    stage: 'FINAL' as const,
  }

  it('每一句都能从计数里逐字推出来', () => {
    const lines = highlightsOf(base)
    expect(lines.some((l) => l.includes('2 只自选') && l.includes('1 只今日出现信号'))).toBe(true)
    expect(lines.some((l) => l.includes('1 只持仓已跌破止损线'))).toBe(true)
    expect(lines.some((l) => l.includes('发出 3 条提醒') && l.includes('2 条被闸门挡下'))).toBe(true)
  })

  it('没有信号时如实说「无信号」，不换一个像结论的中性词', () => {
    const lines = highlightsOf({ ...base, withSignal: 0, byDirection: [], belowStop: 0 })
    expect(lines[0]).toContain('无信号')
  })

  it('PROVISIONAL 时必须说明数字取自盘中快照', () => {
    const lines = highlightsOf({ ...base, stage: 'PROVISIONAL' })
    expect(lines.some((l) => l.includes('日线尚未入库'))).toBe(true)
  })

  it('不含任何禁用词，也不出现「表现不错」这类没有依据的判断', () => {
    const lines = highlightsOf(base).join(' ')
    for (const word of ['胜率', '概率', '必涨', '必跌', '抄底', '稳赚', '牛股']) {
      expect(lines).not.toContain(word)
    }
    for (const word of ['不错', '很好', '强势', '弱势']) expect(lines).not.toContain(word)
  })

  it('没有自选时只说这一件事', () => {
    expect(highlightsOf({ ...base, items: [] })).toEqual(['还没有自选股。'])
  })
})
