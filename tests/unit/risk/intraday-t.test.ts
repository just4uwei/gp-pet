/**
 * 日内做T建议（src/core/risk/intraday-t.ts）。
 *
 * 这一层的每条边界都是**少给 / 多给**的分岔点，而两个方向的错误不对称：
 * 少给一条用户什么都看不到（无所谓），多给一条会让他真的去操作 ——
 * 尤其「尾盘低吸」那条：T+1 下今天买的明天才能卖，过了 14:50 再买进来
 * 卖不掉的那一半就是加仓，而用户以为自己在做T。
 *
 * 判据本身很简单（四个数比大小），所以钉的全是**边界与前提**。
 */

import { describe, expect, it } from 'vitest'
import { tTradeAdvice, type TTradeInput } from '@core/risk/intraday-t'
import { DEFAULT_PARAMS } from '@core/params'
import type { SecCode, Snapshot, TradingSession } from '@core/types'

const CODE = 'SH600000' as SecCode

/**
 * 昨收 10、今日 9.5–10.5 —— 振幅 10%，远在 `minAmplitudePct`（3%）之上。
 * 现价由每条用例自己给：这个 fixture 的全部意义就是「振幅够，位置随便摆」。
 */
function snapshot(last: number, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    code: CODE,
    at: 1_000_000,
    last,
    open: 10,
    high: 10.5,
    low: 9.5,
    preClose: 10,
    volume: 1_000_000,
    amount: 10_000_000,
    limitUp: 11,
    limitDown: 9,
    suspended: false,
    ...overrides,
  }
}

function input(overrides: Partial<TTradeInput> = {}): TTradeInput {
  return {
    snapshot: snapshot(10.5),
    shares: 1000,
    session: 'CONTINUOUS_AM' as TradingSession,
    minuteOfDay: 10 * 60,
    limits: { limitUp: 11, limitDown: 9 },
    params: DEFAULT_PARAMS,
    ...overrides,
  }
}

describe('前提：没有底仓就没有做T', () => {
  it('无持仓 → 不给。同样的判据讲出来是一条开仓建议，那是买入信号的活', () => {
    expect(tTradeAdvice(input({ shares: 0 }))).toBeNull()
    expect(tTradeAdvice(input({ shares: -100 }))).toBeNull()
  })

  it('有底仓且现价在日内高位 → 给高抛', () => {
    const advice = tTradeAdvice(input({ snapshot: snapshot(10.5) }))
    expect(advice?.side).toBe('HIGH_SELL')
    expect(advice?.position).toBeCloseTo(1, 5)
    expect(advice?.amplitude).toBeCloseTo(0.1, 5)
  })

  it('有底仓且现价在日内低位 → 给低吸', () => {
    expect(tTradeAdvice(input({ snapshot: snapshot(9.5) }))?.side).toBe('LOW_BUY')
  })

  it('中间地带不给 —— 「今天没什么好说的」也是一种结论', () => {
    expect(tTradeAdvice(input({ snapshot: snapshot(10) }))).toBeNull()
  })
})

describe('时段', () => {
  const cases: [TradingSession, boolean][] = [
    ['CONTINUOUS_AM', true],
    ['CONTINUOUS_PM', true],
    ['AUCTION', false],
    ['PRE_OPEN', false],
    ['LUNCH_BREAK', false],
    ['CLOSING_AUCTION', false],
    ['SETTLE', false],
    ['CLOSED', false],
  ]

  for (const [session, allowed] of cases) {
    it(`${session} → ${allowed ? '给' : '不给'}`, () => {
      const advice = tTradeAdvice(input({ session }))
      expect(advice === null).toBe(!allowed)
    })
  }

  it('尾盘不给低吸：T+1 下今天买的明天才能卖，那是加仓不是做T', () => {
    // 14:50 = 09:30 + 320 分钟，与 T1_LATE_BUY 同一条线、同一个理由
    const late = { snapshot: snapshot(9.5), minuteOfDay: 14 * 60 + 50 }
    expect(tTradeAdvice(input(late))).toBeNull()
    expect(tTradeAdvice(input({ ...late, minuteOfDay: 14 * 60 + 49 }))?.side).toBe('LOW_BUY')
  })

  it('尾盘照给高抛：卖出随时都能成交，那条线只管买', () => {
    expect(
      tTradeAdvice(input({ snapshot: snapshot(10.5), minuteOfDay: 14 * 60 + 55 }))?.side
    ).toBe('HIGH_SELL')
  })
})

describe('振幅门', () => {
  it('振幅不到 3% 时不给 —— 来回一趟赚的不够手续费与印花税', () => {
    // 9.95–10.05：振幅 1%，而现价正好在最高点（位置 100%）
    const thin = snapshot(10.05, { high: 10.05, low: 9.95 })
    expect(tTradeAdvice(input({ snapshot: thin }))).toBeNull()
  })

  it('刚好到线就给（取等）', () => {
    const exact = snapshot(10.15, { high: 10.15, low: 9.85 }) // 振幅正好 3%
    expect(tTradeAdvice(input({ snapshot: exact }))?.side).toBe('HIGH_SELL')
  })
})

describe('涨跌停与停牌', () => {
  it('涨停不高抛：封住的板卖出去就接不回来，那是清仓不是做T', () => {
    const limitUp = snapshot(11, { high: 11, low: 9.5 })
    expect(tTradeAdvice(input({ snapshot: limitUp }))).toBeNull()
  })

  it('跌停不低吸：接跌停板与做T是两回事', () => {
    const limitDown = snapshot(9, { high: 10.5, low: 9 })
    expect(tTradeAdvice(input({ snapshot: limitDown }))).toBeNull()
  })

  it('取不到涨跌停价时按「没封死」处理 —— 北交所等板块常直接返回 -1', () => {
    const advice = tTradeAdvice(input({ snapshot: snapshot(10.5), limits: null }))
    expect(advice?.side).toBe('HIGH_SELL')
  })

  it('停牌不给', () => {
    expect(tTradeAdvice(input({ snapshot: snapshot(10.5, { suspended: true }) }))).toBeNull()
  })
})

describe('缺数据一律不给，绝不用 0 兜底', () => {
  it('没有快照 → 不给（日线收盘价没有日内路径）', () => {
    expect(tTradeAdvice(input({ snapshot: undefined }))).toBeNull()
  })

  /*
    四个数任缺一个都整条不给。用 0 兜底会算出一个**看起来完全正常**的日内位置 ——
    比如 preClose = 0 时振幅变成 Infinity，`amplitude >= 0.03` 恒真，
    于是每一只票每一轮都在报做T（约束 4 的同一条纪律）。
  */
  const broken: [string, Partial<Snapshot>][] = [
    ['昨收为 0', { preClose: 0 }],
    ['最高价为 0', { high: 0 }],
    ['最低价为 0', { low: 0 }],
    ['现价为 0', { last: 0 }],
    ['最高 = 最低（一字板 / 无成交）', { high: 10, low: 10 }],
  ]
  for (const [label, patch] of broken) {
    it(`${label} → 不给`, () => {
      expect(tTradeAdvice(input({ snapshot: snapshot(10.5, patch) }))).toBeNull()
    })
  }
})
