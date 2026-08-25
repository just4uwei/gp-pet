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
import {
  buildDailyReport,
  highlightsOf,
  reportSubjectDate,
  reportableItems,
  stampsOf,
  toStopPct,
  type BuildReportInput,
} from '@main/report/build'
import { INDUSTRY_ETF_GROUP } from '@shared/industry-etf'
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
/** DATE 那天的北京 15:00。真实值由 `closeMsOf` 算，这里只需要一个可辨认的常量 */
const CLOSE_MS = 1_759_990_000_000

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
    conditions: [{ metric: 'PRICE', op: 'LTE', threshold: 9 }],
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
    closeMs: CLOSE_MS,
    items: [item('SH600000')],
    bars: new Map(),
    snapshots: new Map(),
    signals: [],
    positions: [],
    watchPoints: [],
    alerts: [],
    stopLossPct: 0.08,
    dayStart: DAY_START,
    // 环境是独立的一节，`buildDailyReport` 只透传。它自己的判据在 environment.test.ts
    environment: { benchmark: null, industries: [], breadth: { withQuote: 0, up: 0, down: 0, flat: 0 }, missing: [], lines: [] },
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

/**
 * 日报要算哪些标的（`reportableItems`）。
 *
 * 这一条钉的是一个**看不出来的漏**：持仓中的行业 ETF 若被整组摘掉，
 * 日报上只是少一行，不报错、不留痕，而那一行对应的是真金白银。
 */
describe('reportableItems', () => {
  const etf = (code: string, hasPosition: boolean): WatchItem => ({
    code: code as SecCode,
    name: `ETF-${code}`,
    group: INDUSTRY_ETF_GROUP,
    sortOrder: 0,
    hasPosition,
  })

  it('无持仓的行业ETF 摘掉 —— 15 只观察标的会把自己的票埋掉一多半', () => {
    const kept = reportableItems([item('SH600000'), etf('SH512800', false)], INDUSTRY_ETF_GROUP)
    expect(kept.map((r) => r.code)).toEqual(['SH600000'])
  })

  it('**有持仓的行业ETF 留下** —— 持仓就是「我这些票」', () => {
    const kept = reportableItems([item('SH600000'), etf('SH512800', true)], INDUSTRY_ETF_GROUP)
    expect(kept.map((r) => r.code)).toEqual(['SH600000', 'SH512800'])
  })

  it('自选组一个都不摘，有没有持仓都一样', () => {
    const held: WatchItem = { ...item('SZ000001'), hasPosition: true }
    const kept = reportableItems([item('SH600000'), held], INDUSTRY_ETF_GROUP)
    expect(kept).toHaveLength(2)
  })
})

/*
  日报该报哪一天（`reportSubjectDate`，2026-08-18）。

  这一条钉的是一个**混口径**的错：旧判据是「库里最后一根日线的日期」，
  而当日日线要到次日盘前才入库 ⇒ 整个今天（含盘中）日报都停在昨天、还打「已定稿」，
  而同屏的信号 / 提醒统计按今天的日界切 —— 一份报告里「昨天的价 + 今天的信号」，
  界面上完全看不出来。
*/
describe('reportSubjectDate：报的是当前交易日', () => {
  const TODAY = '2026-08-18' as TradeDate
  const YESTERDAY = '2026-08-17' as TradeDate

  it('交易日开盘之后 → 今天（今天的收盘线还没入库不要紧，那是 stage 在说的事）', () => {
    for (const minuteOfDay of [9 * 60 + 30, 11 * 60, 15 * 60, 22 * 60]) {
      expect(
        reportSubjectDate({ today: TODAY, todayIsOpen: true, minuteOfDay, lastDataDate: YESTERDAY })
      ).toBe(TODAY)
    }
  })

  it('开盘前 → 库里最后一天：那时今天一个数都没有，给昨天的定稿版比给一屏「—」有用', () => {
    for (const minuteOfDay of [0, 9 * 60, 9 * 60 + 29]) {
      expect(
        reportSubjectDate({ today: TODAY, todayIsOpen: true, minuteOfDay, lastDataDate: YESTERDAY })
      ).toBe(YESTERDAY)
    }
  })

  it('休市日（周末 / 节假日）→ 库里最后一天，钟点再晚也一样', () => {
    expect(
      reportSubjectDate({ today: TODAY, todayIsOpen: false, minuteOfDay: 20 * 60, lastDataDate: YESTERDAY })
    ).toBe(YESTERDAY)
  })

  it('一根日线都没有 → 退到今天（报告里全是「—」，而那正是实情）', () => {
    expect(
      reportSubjectDate({ today: TODAY, todayIsOpen: false, minuteOfDay: 20 * 60, lastDataDate: null })
    ).toBe(TODAY)
  })
})

/*
  每一节的「数据时刻」（`stampsOf`，2026-08-18）。

  口径是**数据时刻**不是重算时刻：全标成生成时刻等于每节都说「刚更新过」，
  而「今日提醒」那一节可能从早上 09:03 起就没变过 —— 那是一个每节相同、且会说谎的数。
*/
describe('stamps：每节标自己的数据时刻', () => {
  const bars = new Map([['SH600000' as SecCode, { day: candle(DATE, 11), prev: candle('2026-08-13', 10) }]])

  it('收盘线那一支的时刻是**那天的收盘**，不是抓取时刻', () => {
    const quote = buildDailyReport(input({ bars })).stocks[0]?.quote
    expect(quote?.source).toBe('CLOSE')
    expect(quote?.at).toBe(CLOSE_MS)
  })

  it('快照那一支用 `Snapshot.at`（最后成交时刻），不是「现在」', () => {
    const at = AT - 3_600_000
    const snapshots = new Map([['SH600000' as SecCode, snapshot('SH600000', { at })]])
    expect(buildDailyReport(input({ snapshots })).stocks[0]?.quote?.at).toBe(at)
  })

  it('逐只那一节取「行情与信号里最新的一条」', () => {
    const signals = [signal('SH600000', { createdAt: CLOSE_MS + 60_000 })]
    const report = buildDailyReport(input({ bars, signals }))
    // 信号比收盘线新 → 取信号
    expect(report.stamps.stocks).toBe(CLOSE_MS + 60_000)
  })

  it('停牌股那个很旧的快照不把整节拉旧 —— 取最新（单只有多旧由那一行自己回答）', () => {
    const stale = AT - 5 * 86_400_000
    const report = buildDailyReport(
      input({
        items: [item('SH600000'), item('SZ000001')],
        bars,
        snapshots: new Map([['SZ000001' as SecCode, snapshot('SZ000001', { at: stale })]]),
      })
    )
    expect(report.stamps.stocks).toBe(CLOSE_MS)
    // 那一行自己仍然带着真实的旧时刻
    expect(report.stocks[1]?.quote?.at).toBe(stale)
  })

  it('一条事实都没有的那节是 null —— 不许退回 0 或生成时刻（那等于替空白内容担保）', () => {
    const report = buildDailyReport(input())
    expect(report.stamps.alerts).toBeNull()
    expect(report.stamps.tomorrow).toBeNull()
    expect(report.stamps.environment).toBeNull()
    expect(report.stamps.stocks).toBeNull()
  })

  it('提醒那一节取当日最后一条提醒的时刻', () => {
    const report = buildDailyReport(input({ alerts: [alert({ createdAt: 5_000 }), alert({ createdAt: 9_000 })] }))
    expect(report.stamps.alerts).toBe(9_000)
  })

  it('「明日关注」每一项都带着被复述那条东西自己的时刻', () => {
    const signals = [signal('SH600000', { direction: 'NEXT_DAY_WATCH', createdAt: 7_777 })]
    const points = [point('SH600000', { createdAt: 8_888 })]
    const report = buildDailyReport(input({ signals, watchPoints: points }))
    const watch = report.tomorrow.find((row) => row.kind === 'NEXT_DAY_WATCH')
    const pointRow = report.tomorrow.find((row) => row.kind === 'WATCH_POINT')
    expect(watch?.at).toBe(7_777)
    expect(pointRow?.at).toBe(8_888)
    expect(report.stamps.tomorrow).toBe(8_888)
  })

  it('今日汇总是派生节：取它复述的那几节里最新的一条', () => {
    const stamps = stampsOf({
      stocks: [],
      environment: { benchmark: null, industries: [], breadth: { withQuote: 0, up: 0, down: 0, flat: 0 }, missing: [], lines: [] },
      lastSignalAt: 100,
      tomorrow: [{ code: 'SH600000' as SecCode, name: '票', kind: 'NEXT_DAY_WATCH', note: '', at: 300 }],
      alerts: [alert({ createdAt: 200 })],
    })
    expect(stamps.summary).toBe(300)
    // 环境那一节与它无关，仍然是 null
    expect(stamps.environment).toBeNull()
  })
})
