/**
 * 建仓体检（`core/risk/entry.ts`，2026-08-19）。
 *
 * 这一层的价值全在「**它没有自己的判断**」上，所以用例主要钉三件事：
 *   1. 每一条都来自一个已经存在的裁决（硬抑制 / 降级 / 持仓强制），不多不少；
 *   2. `verdict` 纯由 items 派生，没有分数、没有加权；
 *   3. 数值区缺输入就**不出现**，不用 0 兜底（约束 4 的同一条）。
 *
 * 措辞纪律也在这里验：不得出现「建议买入 / 可以买 / 抄底 / 必涨」。
 */

import { describe, expect, it } from 'vitest'
import { entryCheck, type GateInput } from '@core/risk'
import { DEFAULT_PARAMS } from '@core/params'
import type { CombinedSignal, Direction, Position, SecProfile, Snapshot, SubSignal } from '@core/types'
import { buildCandles } from '../../fixtures/klines'
import { FULL_SUFFICIENCY, LIMITED_SUFFICIENCY, makeIndicators } from '../../fixtures/indicators'

const P = DEFAULT_PARAMS
const LEN = 400
const LAST = LEN - 1

const PROFILE: SecProfile = {
  code: 'SH600000',
  name: '浦发银行',
  market: 'SH',
  board: 'MAIN',
  isST: false,
  industry: '银行',
}

function sub(id: string, direction: Direction): SubSignal {
  return { id, strategy: 'TREND', direction, score: 0.9, weight: 0.25, evidence: {} }
}

function signalOf(direction: CombinedSignal['direction'], score = 0.8): CombinedSignal {
  return {
    code: PROFILE.code,
    date: '2026-08-19',
    direction,
    score,
    votes: 3,
    regime: 'RANGE',
    stage: 'CONFIRMED',
    subSignals: direction === 'NONE' ? [] : [sub('T1_MA_CROSS', direction)],
    adjustments: [],
    scoreByDirection: { BUY: direction === 'BUY' ? score : 0.1, SELL: direction === 'SELL' ? score : 0.1 },
    sufficiencyPenalty: 1,
  }
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    code: PROFILE.code,
    at: 1_000_000,
    last: 10,
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

function gate(overrides: Partial<GateInput> = {}): GateInput {
  return {
    signal: signalOf('NONE', 0.1),
    profile: PROFILE,
    candles: buildCandles(new Array<number>(LEN).fill(10)),
    ind: makeIndicators(LEN, { bbwPct: 50 }),
    index: LAST,
    sufficiency: { ...FULL_SUFFICIENCY },
    snapshot: snapshot(),
    now: { minuteOfDay: 10 * 60, session: 'CONTINUOUS_AM' },
    params: P,
    ...overrides,
  }
}

function position(overrides: Partial<Position> = {}): Position {
  return { code: PROFILE.code, shares: 1000, cost: 10, peakPrice: 10, openedAt: 0, ...overrides }
}

const rulesOf = (result: { items: { rule: string }[] }): string[] => result.items.map((item) => item.rule)

describe('结论只由 items 派生', () => {
  it('什么都没命中 → CLEAR，且只剩「引擎怎么看」那一条 NOTE', () => {
    const result = entryCheck({ gate: gate() })
    expect(result.verdict).toBe('CLEAR')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.severity).toBe('NOTE')
    expect(result.items[0]?.rule).toBe('ENGINE_VIEW')
  })

  it('硬抑制命中 → BLOCKED（比 WARN 优先）', () => {
    // 涨停：买不到。同一份上下文里再叠一条 ST 降级，验证 BLOCK 压过 WARN
    const result = entryCheck({
      gate: gate({ snapshot: snapshot({ last: 11 }), profile: { ...PROFILE, isST: true } }),
    })
    expect(result.verdict).toBe('BLOCKED')
    expect(rulesOf(result)).toContain('HARD_LIMIT_UP')
    expect(rulesOf(result)).toContain('ST_RISK')
    // BLOCK 排在最前
    expect(result.items[0]?.severity).toBe('BLOCK')
  })

  it('只有降级项 → CAUTION', () => {
    const result = entryCheck({ gate: gate({ profile: { ...PROFILE, isST: true } }) })
    expect(result.verdict).toBe('CAUTION')
    expect(rulesOf(result)).toContain('ST_RISK')
  })

  it('停牌与数据不足都算 BLOCK', () => {
    const suspended = entryCheck({ gate: gate({ snapshot: snapshot({ suspended: true }) }) })
    expect(rulesOf(suspended)).toContain('SUSPENDED')
    const thin = entryCheck({ gate: gate({ sufficiency: { ...LIMITED_SUFFICIENCY, bars: 20, usable: false } }) })
    expect(rulesOf(thin)).toContain('INSUFFICIENT_DATA')
    expect(thin.verdict).toBe('BLOCKED')
  })
})

describe('加仓加在一个已触发止损的持仓上', () => {
  it('持仓强制裁决命中 → CAUTION 并点名那条裁决', () => {
    // 成本 12、现价 10 → 亏 16.7%，触及 8% 止损线
    const result = entryCheck({ gate: gate({ position: position({ cost: 12 }) }) })
    expect(result.verdict).toBe('CAUTION')
    const item = result.items.find((i) => i.rule === 'STOP_LOSS')
    expect(item?.severity).toBe('WARN')
    expect(item?.text).toContain('加仓')
  })

  it('引擎判卖出时算一条 WARN，判买入/无信号时只是 NOTE', () => {
    expect(entryCheck({ gate: gate({ signal: signalOf('SELL') }) }).verdict).toBe('CAUTION')
    expect(entryCheck({ gate: gate({ signal: signalOf('BUY') }) }).verdict).toBe('CLEAR')
    expect(entryCheck({ gate: gate({ signal: signalOf('NONE', 0.1) }) }).verdict).toBe('CLEAR')
  })
})

describe('行业集中度用的是「建仓之后」', () => {
  it('超过出厂上限 → WARN', () => {
    const result = entryCheck({ gate: gate(), industryShareAfter: 0.34 })
    const item = result.items.find((i) => i.rule === 'INDUSTRY_CONCENTRATION_AFTER')
    expect(item?.severity).toBe('WARN')
    expect(item?.text).toContain('34%')
    expect(item?.text).toContain('银行')
  })

  it('没超就不出这一条；undefined（算不出来）也不出 —— 不拿 0 当结论', () => {
    expect(rulesOf(entryCheck({ gate: gate(), industryShareAfter: 0.1 }))).not.toContain(
      'INDUSTRY_CONCENTRATION_AFTER'
    )
    expect(rulesOf(entryCheck({ gate: gate() }))).not.toContain('INDUSTRY_CONCENTRATION_AFTER')
  })
})

describe('数值区：缺输入就不出现', () => {
  it('填了价 → 给止损参考；再填股数 → 给最大亏损与金额', () => {
    const priceOnly = entryCheck({ gate: gate(), intent: { price: 10 } })
    expect(priceOnly.stop?.price).toBeCloseTo(9.2, 6)
    expect(priceOnly.stop?.lossPerShare).toBeCloseTo(0.8, 6)
    expect(priceOnly.stop?.lossAmount).toBeUndefined()
    expect(priceOnly.amount).toBeUndefined()

    const full = entryCheck({ gate: gate(), intent: { price: 10, shares: 1000 } })
    expect(full.stop?.lossAmount).toBeCloseTo(800, 6)
    expect(full.amount).toBeCloseTo(10_000, 6)
  })

  it('没填价就没有止损参考（不是 0）', () => {
    expect(entryCheck({ gate: gate() }).stop).toBeUndefined()
    expect(entryCheck({ gate: gate(), intent: { shares: 1000 } }).stop).toBeUndefined()
  })

  it('用户已重画过止损线的持仓不给参考线 —— 那条线加仓时会被清空', () => {
    const held = position({ stopFloor: 8 })
    expect(entryCheck({ gate: gate({ position: held }), intent: { price: 10 } }).stop).toBeUndefined()
  })

  it('日内位置只报数不判高低；四个快照数缺一个就不给', () => {
    // 昨收 10、今日 9.5–10.5、现价 10.5 → 位置 100%
    const high = entryCheck({ gate: gate({ snapshot: snapshot({ last: 10.5 }) }) })
    expect(high.dayPosition).toBeCloseTo(1, 6)
    // 「位置很高」不许变成一条 WARN
    expect(high.verdict).toBe('CLEAR')

    expect(entryCheck({ gate: gate({ snapshot: snapshot({ preClose: 0 }) }) }).dayPosition).toBeUndefined()
    expect(entryCheck({ gate: gate({ snapshot: undefined }) }).dayPosition).toBeUndefined()
  })
})

describe('措辞纪律（CLAUDE.md）', () => {
  const FORBIDDEN = ['必涨', '抄底', '稳赚', '牛股', '胜率', '概率', '建议买入', '可以买', '值得买']

  it('任何一条 item 都不含禁用词', () => {
    const cases = [
      entryCheck({ gate: gate({ snapshot: snapshot({ last: 11 }), profile: { ...PROFILE, isST: true } }) }),
      entryCheck({ gate: gate({ position: position({ cost: 12 }) }), intent: { price: 10, shares: 1000 } }),
      entryCheck({ gate: gate({ signal: signalOf('SELL') }), industryShareAfter: 0.5 }),
      entryCheck({ gate: gate({ signal: signalOf('BUY') }) }),
    ]
    for (const result of cases) {
      for (const item of result.items) {
        for (const word of FORBIDDEN) expect(item.text).not.toContain(word)
      }
    }
  })

  it('置信度称「置信」', () => {
    const result = entryCheck({ gate: gate({ signal: signalOf('BUY', 0.83) }) })
    expect(result.items.find((i) => i.rule === 'ENGINE_VIEW')?.text).toContain('置信 83%')
  })
})
