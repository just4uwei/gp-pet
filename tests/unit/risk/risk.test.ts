/**
 * 风控层规则表（docs/05 §2、§3）。
 *
 * 表驱动：每条规则一个用例 + 一个边界用例。这一层的错误后果最直接 ——
 * 漏一条硬抑制，用户会收到「买入」提醒却买不到；漏一条持仓强制规则，止损不响。
 *
 * 措辞纪律（CLAUDE.md）也在这里验：文案里不得出现「胜率」「必涨」「抄底」一类词。
 */

import { describe, expect, it } from 'vitest'
import {
  belowStopLine,
  downgrade,
  downgrades,
  gateSignal,
  hardSuppressions,
  positionVerdict,
  type GateInput,
} from '@core/risk'
import { composeHeadline, confidenceText, describeSubSignal, topReasons } from '@core/risk/text'
import { DEFAULT_PARAMS } from '@core/params'
import type {
  CombinedSignal,
  Direction,
  Position,
  SecProfile,
  SignalStage,
  Snapshot,
  SubSignal,
} from '@core/types'
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
}

function sub(id: string, direction: Direction, score = 0.9, weight = 0.25): SubSignal {
  return { id, strategy: 'TREND', direction, score, weight, evidence: { volRatio: 1.4, rsi: 22, adx: 30 } }
}

function signalOf(
  direction: CombinedSignal['direction'],
  score = 0.8,
  stage: SignalStage = 'CONFIRMED'
): CombinedSignal {
  return {
    code: PROFILE.code,
    date: '2026-08-11',
    direction,
    score,
    votes: 3,
    regime: 'TREND_UP',
    stage,
    subSignals: [sub('T1_MA_CROSS', direction === 'SELL' ? 'SELL' : 'BUY'), sub('T3_BREAKOUT', direction === 'SELL' ? 'SELL' : 'BUY')],
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
    high: 10.2,
    low: 9.8,
    preClose: 10,
    volume: 1_000_000,
    amount: 10_000_000,
    limitUp: 11,
    limitDown: 9,
    suspended: false,
    ...overrides,
  }
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    signal: signalOf('BUY'),
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

describe('硬抑制（docs/05 §2.1）', () => {
  it('停牌', () => {
    const verdicts = hardSuppressions(input({ snapshot: snapshot({ suspended: true }) }), 'BUY')
    expect(verdicts.map((v) => v.rule)).toContain('SUSPENDED')
  })

  it('全日零成交也视为无法交易', () => {
    const candles = buildCandles(new Array<number>(LEN).fill(10), { overrides: { [LAST]: { volume: 0 } } })
    expect(hardSuppressions(input({ candles }), 'BUY').map((v) => v.rule)).toContain('SUSPENDED')
  })

  it('涨停时抑制买入，但不抑制卖出', () => {
    const shot = snapshot({ last: 11 })
    expect(hardSuppressions(input({ snapshot: shot }), 'BUY').map((v) => v.rule)).toContain('HARD_LIMIT_UP')
    expect(hardSuppressions(input({ snapshot: shot }), 'SELL').map((v) => v.rule)).not.toContain('HARD_LIMIT_UP')
  })

  it('跌停时抑制卖出与减仓，但不抑制买入', () => {
    const shot = snapshot({ last: 9 })
    expect(hardSuppressions(input({ snapshot: shot }), 'SELL').map((v) => v.rule)).toContain('HARD_LIMIT_DOWN')
    expect(hardSuppressions(input({ snapshot: shot }), 'REDUCE').map((v) => v.rule)).toContain('HARD_LIMIT_DOWN')
    expect(hardSuppressions(input({ snapshot: shot }), 'BUY').map((v) => v.rule)).not.toContain('HARD_LIMIT_DOWN')
  })

  it('快照没给涨跌停价时按板块规则本地算（免费源常给 -1）', () => {
    const shot = snapshot({ last: 11, limitUp: null, limitDown: null, preClose: 10 })
    expect(hardSuppressions(input({ snapshot: shot }), 'BUY').map((v) => v.rule)).toContain('HARD_LIMIT_UP')
  })

  it('指数无涨跌停 → 不产出涨跌停抑制', () => {
    const index: SecProfile = { ...PROFILE, code: 'SH000300', board: 'INDEX' }
    const shot = snapshot({ last: 11, limitUp: null, limitDown: null })
    expect(hardSuppressions(input({ profile: index, snapshot: shot }), 'BUY').map((v) => v.rule)).not.toContain(
      'HARD_LIMIT_UP'
    )
  })

  it('数据不足（< 40 根）', () => {
    const sufficiency = { ...LIMITED_SUFFICIENCY, bars: 20, usable: false }
    expect(hardSuppressions(input({ sufficiency }), 'BUY').map((v) => v.rule)).toContain('INSUFFICIENT_DATA')
  })

  it('次新股（不足 60 个交易日）', () => {
    const sufficiency = { ...LIMITED_SUFFICIENCY, bars: 50 }
    expect(hardSuppressions(input({ sufficiency }), 'BUY').map((v) => v.rule)).toContain('NEW_LISTING')
  })

  it('连续竞价时段里快照超过 5 分钟未更新', () => {
    const stale = input({
      snapshot: snapshot({ at: 0 }),
      now: { minuteOfDay: 10 * 60, session: 'CONTINUOUS_AM', atMs: 6 * 60_000 },
    })
    expect(hardSuppressions(stale, 'BUY').map((v) => v.rule)).toContain('STALE_SNAPSHOT')
  })

  it('收盘后不判快照陈旧 —— 那时快照本来就是旧的', () => {
    const settled = input({
      snapshot: snapshot({ at: 0 }),
      now: { minuteOfDay: 15 * 60, session: 'SETTLE', atMs: 60 * 60_000 },
    })
    expect(hardSuppressions(settled, 'BUY').map((v) => v.rule)).not.toContain('STALE_SNAPSHOT')
  })

  it('没有墙上时刻（回测）时跳过陈旧判定，而不是拿编出来的时刻去比', () => {
    const backtest = input({
      snapshot: snapshot({ at: 0 }),
      now: { minuteOfDay: 10 * 60, session: 'CONTINUOUS_AM' },
    })
    expect(hardSuppressions(backtest, 'BUY').map((v) => v.rule)).not.toContain('STALE_SNAPSHOT')
  })
})

describe('降级（docs/05 §2.2）', () => {
  it('T+1 尾盘：14:50 之后的买入改为明日观察', () => {
    const late = input({ now: { minuteOfDay: 14 * 60 + 55, session: 'CONTINUOUS_PM' } })
    expect(downgrades(late, 'BUY').map((v) => v.rule)).toContain('T1_LATE_BUY')
    const gated = gateSignal(late)
    expect(gated.direction).toBe('NEXT_DAY_WATCH')
  })

  it('T+1 规则只作用于买入 —— 尾盘卖出照常', () => {
    const late = input({
      signal: signalOf('SELL'),
      now: { minuteOfDay: 14 * 60 + 55, session: 'CONTINUOUS_PM' },
    })
    expect(downgrades(late, 'SELL')).toEqual([])
    expect(gateSignal(late).direction).toBe('SELL')
  })

  it('ST 股买入降级并标注风险', () => {
    const st: SecProfile = { ...PROFILE, name: 'ST 浦发', isST: true }
    expect(downgrades(input({ profile: st }), 'BUY').map((v) => v.rule)).toContain('ST_RISK')
  })

  it('名称含 ST 但 isST 标志没给 → 仍然按 ST 处理（数据源不单独给这个标志）', () => {
    const st: SecProfile = { ...PROFILE, name: '*ST 某某', isST: false }
    expect(downgrades(input({ profile: st }), 'BUY').map((v) => v.rule)).toContain('ST_RISK')
  })

  it('行业集中度超上限', () => {
    expect(downgrades(input({ industryShare: 0.35 }), 'BUY').map((v) => v.rule)).toContain(
      'INDUSTRY_CONCENTRATION'
    )
  })

  it('未统计行业占比（undefined）时不触发 —— 不能用 0 顶替「未知」', () => {
    expect(downgrades(input({ industryShare: undefined }), 'BUY')).toEqual([])
  })

  it('波动率处于历史高位时买入降级', () => {
    const wide = input({ ind: makeIndicators(LEN, { bbwPct: 95 }) })
    expect(downgrades(wide, 'BUY').map((v) => v.rule)).toContain('VOLATILITY_EXPANDED')
  })

  it('downgrade() 以 L1 为地板', () => {
    expect(downgrade('L3')).toBe('L2')
    expect(downgrade('L3', 2)).toBe('L1')
    expect(downgrade('L1')).toBe('L1')
    expect(downgrade('L2', 0)).toBe('L2')
  })
})

describe('持仓强制通道（docs/05 §2.3）', () => {
  it('固定止损：亏损触及 8% → 强制卖出 L3', () => {
    const result = positionVerdict(
      input({ position: position({ cost: 11 }), snapshot: snapshot({ last: 10 }) })
    )
    expect(result?.verdict.rule).toBe('STOP_LOSS')
    expect(result?.direction).toBe('SELL')
    expect(result?.level).toBe('L3')
  })

  /*
    用户重画的止损线（`position.stopFloor`，009_position_stop.sql）。

    这一组钉的是它的**判据换了**：从「亏够 `risk.stopLossPct` 这个百分比」
    换成「现价跌破他画的那个绝对价」。两者的差别在深套时最大 ——
    一只成本 20、现价 12 的票（−40%）如果用户把线画在 10，
    **不该再提醒**，因为他已经决定扛到 10；按百分比判的话它每天都响。

    这一段此前一条用例都没有，而它是「重画止损线」这个功能的全部意义所在。
  */
  it('有 stopFloor 时判据是现价 vs 那条线，与成本百分比无关', () => {
    // 成本 20、现价 12 —— 按百分比早就该止损了（−40%），但用户把线画在 10
    const held = position({ cost: 20, peakPrice: 20, stopFloor: 10 })
    const result = positionVerdict(input({ position: held, snapshot: snapshot({ last: 12 }) }))

    expect(result?.verdict.rule).not.toBe('STOP_LOSS')
  })

  it('跌破那条线照样是 L3 强制卖出 —— 重画不等于关掉', () => {
    const held = position({ cost: 20, peakPrice: 20, stopFloor: 10 })
    const result = positionVerdict(input({ position: held, snapshot: snapshot({ last: 9.9 }) }))

    expect(result?.verdict.rule).toBe('STOP_LOSS')
    expect(result?.direction).toBe('SELL')
    expect(result?.level).toBe('L3')
    // 文案要报出他自己画的那个数，否则用户读不出「这是我定的线」
    expect(result?.verdict.reason).toContain('10')
  })

  it('线画在现价下方一点点时不触发 —— 边界是 `price <= floor`', () => {
    const held = position({ cost: 20, peakPrice: 20, stopFloor: 10 })
    expect(
      positionVerdict(input({ position: held, snapshot: snapshot({ last: 10.01 }) }))?.verdict.rule
    ).not.toBe('STOP_LOSS')
    // 恰好等于线：触发（`<=`）
    expect(
      positionVerdict(input({ position: held, snapshot: snapshot({ last: 10 }) }))?.verdict.rule
    ).toBe('STOP_LOSS')
  })

  /*
    用户接受的是「这一段下跌」，不是「所有风控都别响了」。

    ⚠ 回撤减仓这一条尤其容易被改坏：它的「仍盈利或微亏」原先是把固定止损的判据
    抄了一遍（`profit > -stopLossPct`），重画线之后那两者会分叉，
    中间一段**两条都不响**。现在两处共用 `belowStop`，这条用例钉着它。
  */
  it('重画止损线不影响回撤减仓：自峰回撤够了照样响', () => {
    // 与上面那条回撤减仓用例同一组数（成本 10、峰值 11、现价 10.2：浮盈 2%、自峰 −7.3%），
    // 只多一条画在 9 的止损线 —— 远未触及，所以裁决必须一字不变
    const held = position({ cost: 10, peakPrice: 11, stopFloor: 9 })
    const result = positionVerdict(input({ position: held, snapshot: snapshot({ last: 10.2 }) }))

    expect(result?.verdict.rule).toBe('DRAWDOWN_REDUCE')
    expect(result?.direction).toBe('REDUCE')
  })

  /*
    `belowStopLine()` 被导出，是因为它有**两个**调用方：这里的 `positionVerdict()`
    与主进程的 `PositionView.stopBreached`（界面据此决定给不给「重画止损线」的入口）。
    两边各写一遍的症状是「界面说该改止损线了，引擎却还没打算提醒」。

    所以下面这几条直接测那个函数：它一改，两个调用方一起变，不会分叉。
  */
  it('belowStopLine：画过线就比绝对价，没画过才比百分比', () => {
    const withFloor = position({ cost: 20, stopFloor: 10 })
    expect(belowStopLine(10.01, withFloor, P)).toBe(false)
    expect(belowStopLine(10, withFloor, P)).toBe(true)
    expect(belowStopLine(9, withFloor, P)).toBe(true)

    // 没画线：−8% 才算触及（出厂 risk.stopLossPct）
    const noFloor = position({ cost: 10 })
    expect(belowStopLine(9.3, noFloor, P)).toBe(false)
    expect(belowStopLine(9.2, noFloor, P)).toBe(true)
  })

  it('belowStopLine：stopFloor 为 0 / 负数当成「没画过」，不是「跌到 0 才止损」', () => {
    // 0 若被当成线，`price <= 0` 恒假 —— 等于静默关掉整条规则（约束 4 的形状）
    for (const bad of [0, -1]) {
      expect(belowStopLine(9.2, position({ cost: 10, stopFloor: bad }), P)).toBe(true)
    }
  })

  it('移动止损：**当前**仍盈利 ≥ 5%，但自最高点回撤 3%', () => {
    // 成本 10、最高 11、现价 10.6：浮盈 6%，自峰回撤 3.6%
    const result = positionVerdict(
      input({ position: position({ cost: 10, peakPrice: 11 }), snapshot: snapshot({ last: 10.6 }) })
    )
    expect(result?.verdict.rule).toBe('TRAILING_STOP')
    expect(result?.level).toBe('L3')
  })

  it('回撤减仓：自最高点回撤 7%、当前浮盈已不足 5%（否则由移动止损接手）', () => {
    // 成本 10、最高 11、现价 10.2：浮盈 2%，自峰回撤 7.3%
    const result = positionVerdict(
      input({ position: position({ cost: 10, peakPrice: 11 }), snapshot: snapshot({ last: 10.2 }) })
    )
    expect(result?.verdict.rule).toBe('DRAWDOWN_REDUCE')
    expect(result?.direction).toBe('REDUCE')
  })

  it('移动止损与回撤减仓同时成立时，先走「趁还赚着落袋」的移动止损', () => {
    // 浮盈 6%、自峰回撤 8%：两条都成立
    const result = positionVerdict(
      input({ position: position({ cost: 10, peakPrice: 11.52 }), snapshot: snapshot({ last: 10.6 }) })
    )
    expect(result?.verdict.rule).toBe('TRAILING_STOP')
  })

  it('盈利保护：曾达 +5% 后回落到 +2% 以下 → L2 减仓', () => {
    const result = positionVerdict(
      input({ position: position({ cost: 10, peakPrice: 10.6 }), snapshot: snapshot({ last: 10.1 }) })
    )
    expect(result?.verdict.rule).toBe('PROFIT_PROTECT')
    expect(result?.level).toBe('L2')
  })

  it('优先级：同时满足止损与回撤时取更严重的止损', () => {
    const result = positionVerdict(
      input({ position: position({ cost: 12, peakPrice: 13 }), snapshot: snapshot({ last: 10 }) })
    )
    expect(result?.verdict.rule).toBe('STOP_LOSS')
  })

  it('无持仓 / 零股 / 无成本 → 不产出', () => {
    expect(positionVerdict(input())).toBeNull()
    expect(positionVerdict(input({ position: position({ shares: 0 }) }))).toBeNull()
    expect(positionVerdict(input({ position: position({ cost: 0 }) }))).toBeNull()
  })

  it('持仓风控用**不复权**价：没有快照时取当根原始收盘', () => {
    const candles = buildCandles(new Array<number>(LEN).fill(10), {
      factor: 0.5,
      overrides: { [LAST]: { close: 9 } },
    })
    const result = positionVerdict(input({ candles, snapshot: undefined, position: position({ cost: 10 }) }))
    // 前复权价是 4.5，若误用它会算出 -55% 的亏损；用原始价才是 -10%
    expect(result?.verdict.rule).toBe('STOP_LOSS')
    expect(Number(result?.verdict.evidence['profitPct'])).toBeCloseTo(-10, 6)
  })

  it('止损不经过组合层得分：方向为 NONE 时照样强制卖出', () => {
    const gated = gateSignal(
      input({
        signal: signalOf('NONE', 0.1),
        position: position({ cost: 11 }),
        snapshot: snapshot({ last: 10 }),
      })
    )
    expect(gated.direction).toBe('SELL')
    expect(gated.level).toBe('L3')
  })

  it('强制卖出不因 ST / 集中度等降级规则而掉级', () => {
    const st: SecProfile = { ...PROFILE, name: 'ST 某某', isST: true }
    const gated = gateSignal(
      input({ profile: st, position: position({ cost: 11 }), snapshot: snapshot({ last: 10 }) })
    )
    expect(gated.level).toBe('L3')
  })
})

describe('用户确认接受的那一段亏损（009_position_stop.sql）', () => {
  /*
    这一组钉的是「主动关掉一个安全提醒」的边界。三条都是错了之后**用户发现不了**的：
    少发一条止损提醒，他当时什么都察觉不到，事后也归不了因
    （CLAUDE.md 里「少发的错误用户发现不了」说的就是这个）。
  */

  it('有 stopFloor 时按新线判：现价还在线上 → 不提醒', () => {
    // 成本 11、现价 10（亏 9.1%，早就过了 8% 出厂线），但用户把线画在 9.2
    const result = positionVerdict(
      input({
        // peak = 现价：把 ③ 回撤减仓排除掉，这条只测 ① 的判据换了没有
        position: position({ cost: 11, peakPrice: 10, stopFloor: 9.2 }),
        snapshot: snapshot({ last: 10 }),
      })
    )
    expect(result).toBeNull()
  })

  it('跌破那条线照样 L3 强制卖出 —— 确认只换判据，不取消提醒', () => {
    const result = positionVerdict(
      input({
        position: position({ cost: 11, stopFloor: 9.2 }),
        snapshot: snapshot({ last: 9.2 }),
      })
    )
    expect(result?.verdict.rule).toBe('STOP_LOSS')
    expect(result?.level).toBe('L3')
    // 文案要说清是「你确认的那条线」，不是那个百分比 —— 否则用户会以为确认没生效
    expect(result?.verdict.reason).toContain('你确认的止损线')
  })

  it('边界取等：正好等于那条线就算跌破', () => {
    // peakPrice 压到现价附近：否则 ③ 回撤减仓（自峰 −7%）会先抢答，测不到 ① 的边界
    const at = positionVerdict(
      input({
        position: position({ cost: 11, peakPrice: 9.2, stopFloor: 9.2 }),
        snapshot: snapshot({ last: 9.2 }),
      })
    )
    const above = positionVerdict(
      input({
        position: position({ cost: 11, peakPrice: 9.2, stopFloor: 9.2 }),
        snapshot: snapshot({ last: 9.21 }),
      })
    )
    expect(at?.verdict.rule).toBe('STOP_LOSS')
    expect(above).toBeNull()
  })

  it('没有 stopFloor 时出厂行为一个字不变', () => {
    const result = positionVerdict(
      input({ position: position({ cost: 11 }), snapshot: snapshot({ last: 10 }) })
    )
    expect(result?.verdict.reason).toContain('触及 8% 止损线')
  })

  it('stopFloor 为 0 / 负数当成没设 —— 0 会被读成「跌到 0 才止损」', () => {
    // 约束 4 的形状：用 0 表示「没有」会静默关掉整条规则
    const zero = positionVerdict(
      input({ position: position({ cost: 11, stopFloor: 0 }), snapshot: snapshot({ last: 10 }) })
    )
    expect(zero?.verdict.rule).toBe('STOP_LOSS')
  })

  it('**只影响固定止损**：移动止损照旧响', () => {
    // 成本 10、最高 11、现价 10.6：浮盈 6% 且自峰回撤 3.6% → ② 该响，
    // 而它与 stopFloor 无关（用户接受的是下跌，不是「赚着的时候也别提醒」）
    const result = positionVerdict(
      input({
        position: position({ cost: 10, peakPrice: 11, stopFloor: 8 }),
        snapshot: snapshot({ last: 10.6 }),
      })
    )
    expect(result?.verdict.rule).toBe('TRAILING_STOP')
  })

  it('**只影响固定止损**：深亏时回撤减仓仍然响，不能被一起静默', () => {
    /*
      成本 12、最高 13、现价 10：亏 16.7%、自峰回撤 23%。
      用户把止损线画在 9.5，所以 ① 不响 —— 但 ③ 回撤减仓必须照响。

      ③ 原先的条件写成 `profit > -stopLossPct`（把 ① 的判据抄了一遍），
      那份抄写会在 −8% 就把 ③ 关掉，于是这一段两条规则**都不响** ——
      「接受一段亏损」悄悄变成了「回撤减仓也一起静默」，那不是用户答应的事。
    */
    const result = positionVerdict(
      input({
        position: position({ cost: 12, peakPrice: 13, stopFloor: 9.5 }),
        snapshot: snapshot({ last: 10 }),
      })
    )
    expect(result?.verdict.rule).toBe('DRAWDOWN_REDUCE')
  })

  it('线上的深亏 + 没有回撤 → 确实一条都不响（这就是用户要的效果）', () => {
    // 成本 12、**峰 = 现价 10**、线在 9.5：亏 16.7% 但自峰没有回撤 ——
    // 注意 peak 要取现价而不是成本：peak = 成本时「自峰回撤」就是那 16.7%，③ 会响
    const result = positionVerdict(
      input({
        position: position({ cost: 12, peakPrice: 10, stopFloor: 9.5 }),
        snapshot: snapshot({ last: 10 }),
      })
    )
    expect(result).toBeNull()
  })
})

describe('分级（docs/05 §3）', () => {
  it('得分 ≥ 0.75 且已收盘确认 → L3', () => {
    expect(gateSignal(input({ signal: signalOf('BUY', 0.8, 'CONFIRMED') })).level).toBe('L3')
  })

  it('得分 ≥ 0.75 但仍是盘中临时 → 最高 L2', () => {
    expect(gateSignal(input({ signal: signalOf('BUY', 0.8, 'PROVISIONAL') })).level).toBe('L2')
  })

  it('得分不足 0.75 → L1', () => {
    expect(gateSignal(input({ signal: signalOf('BUY', 0.65) })).level).toBe('L1')
  })

  it('每命中一条降级规则退一档', () => {
    const st: SecProfile = { ...PROFILE, name: 'ST 某某', isST: true }
    expect(gateSignal(input({ profile: st, signal: signalOf('BUY', 0.8) })).level).toBe('L2')
  })

  it('被硬抑制后一律 L1，且 suppressed 为真（仍要入库，docs/05 §4）', () => {
    const gated = gateSignal(input({ snapshot: snapshot({ suspended: true }) }))
    expect(gated.level).toBe('L1')
    expect(gated.suppressed).toBe(true)
    // 方向保留，否则面板回答不了「它到底想让我买还是卖」
    expect(gated.direction).toBe('BUY')
    expect(gated.reasons.join(' ')).toContain('停牌')
  })

  it('方向为 NONE 且一切正常 → L1、不抑制、无依据行', () => {
    const gated = gateSignal(input({ signal: signalOf('NONE', 0.2) }))
    expect(gated.direction).toBe('NONE')
    expect(gated.suppressed).toBe(false)
    expect(gated.reasons).toEqual([])
    expect(gated.headline).toBe('无一致信号')
  })

  it('方向为 NONE 但数据不足 → 抑制原因照样记下来', () => {
    // 「这只股票为什么从来不出信号」是面板必须能回答的问题
    const gated = gateSignal(
      input({
        signal: signalOf('NONE', 0),
        sufficiency: { ...LIMITED_SUFFICIENCY, bars: 20, usable: false },
      })
    )
    expect(gated.suppressed).toBe(true)
    expect(gated.verdicts.map((v) => v.rule)).toContain('INSUFFICIENT_DATA')
    expect(gated.headline).toContain('日线')
  })

  it('受限模式会附一条 ANNOTATE 说明，但不改变级别', () => {
    const gated = gateSignal(input({ sufficiency: { ...LIMITED_SUFFICIENCY } }))
    expect(gated.verdicts.map((v) => v.rule)).toContain('LIMITED_DATA')
    expect(gated.reasons.join(' ')).toContain('数据不足')
  })
})

/**
 * 做T建议接进 `gateSignal` 的那两道额外闸门。
 *
 * 判定本身在 `intraday-t.test.ts`（16 条）。这里只钉**接线**：
 * 什么时候不该把它挂上去，以及方向为 NONE 时它照样要在 ——
 * 后者是最容易漏的那条，因为 `gateSignal` 有两个返回点，
 * 而「引擎今天没信号但手里的票冲高了」恰恰是做T最常见的场景。
 */
describe('日内做T建议的接线（intraday-t.ts）', () => {
  /** 昨收 10、今日 9.5–10.5、现价踩在最高点 —— 振幅 10%、位置 100% */
  const atHigh = { last: 10.5, high: 10.5, low: 9.5, preClose: 10 }

  it('持仓 + 盘中 + 日内高位 → 挂上高抛', () => {
    const gated = gateSignal(
      input({ position: position(), snapshot: snapshot(atHigh), signal: signalOf('BUY', 0.8) })
    )
    expect(gated.tTrade?.side).toBe('HIGH_SELL')
  })

  it('方向为 NONE 时照样给 —— 「引擎没说话但我的票冲高了」是最常见的场景', () => {
    const gated = gateSignal(
      input({ position: position(), snapshot: snapshot(atHigh), signal: signalOf('NONE', 0.1) })
    )
    expect(gated.direction).toBe('NONE')
    expect(gated.tTrade?.side).toBe('HIGH_SELL')
  })

  it('持仓强制类命中时不给：止损那一刻该看的是风险，不是日内价差', () => {
    // 成本 12、现价 10.5 → 亏 12.5%，触及 8% 止损线
    const gated = gateSignal(
      input({ position: position({ cost: 12 }), snapshot: snapshot(atHigh), signal: signalOf('BUY', 0.8) })
    )
    expect(gated.verdicts.some((v) => v.rule === 'STOP_LOSS')).toBe(true)
    expect(gated.tTrade).toBeUndefined()
  })

  it('硬抑制命中时不给：「无法执行」与「可考虑高抛」并排出现是自相矛盾', () => {
    const gated = gateSignal(
      input({
        position: position(),
        snapshot: snapshot({ ...atHigh, suspended: true }),
        signal: signalOf('BUY', 0.8),
      })
    )
    expect(gated.suppressed).toBe(true)
    expect(gated.tTrade).toBeUndefined()
  })

  it('没有持仓就没有做T —— 与方向、得分都无关', () => {
    const gated = gateSignal(input({ snapshot: snapshot(atHigh), signal: signalOf('BUY', 0.8) }))
    expect(gated.tTrade).toBeUndefined()
  })
})

describe('文案（docs/05 §5）', () => {
  const subs = [sub('T3_BREAKOUT', 'BUY', 0.9, 0.25), sub('T1_MA_CROSS', 'BUY', 0.6, 0.2)]

  it('headline 形如「首要依据 · 市场状态」', () => {
    expect(composeHeadline(subs, 'BUY', 'TREND_UP')).toBe('放量突破上轨 · 上升趋势')
  })

  it('依据行最多 3 条，按权重×强度排序', () => {
    const reasons = topReasons(
      [...subs, sub('T4_ALIGNMENT', 'BUY', 0.5, 0.15), sub('T5_PULLBACK_HOLD', 'BUY', 0.5, 0.15)],
      'BUY'
    )
    expect(reasons).toHaveLength(3)
    expect(reasons[0]).toContain('放量突破上轨')
  })

  it('依据带关键数值，取不到就只给标签', () => {
    expect(describeSubSignal(sub('T3_BREAKOUT', 'BUY'))).toContain('量比 1.4')
    expect(describeSubSignal({ ...sub('T3_BREAKOUT', 'BUY'), evidence: {} })).toBe('放量突破上轨')
    expect(describeSubSignal(sub('R1_RSI_BAND', 'BUY'))).toContain('RSI 22')
    expect(describeSubSignal(sub('T4_ALIGNMENT', 'BUY'))).toContain('ADX 30')
    expect(describeSubSignal({ ...sub('R4_MID_REVERSION', 'BUY'), evidence: { deviationInStd: -1.8 } })).toContain('1.8σ')
  })

  it('未知 ID 退化为 ID 本身，不抛错', () => {
    expect(describeSubSignal(sub('X9_UNKNOWN', 'BUY'))).toBe('X9_UNKNOWN')
  })

  it('置信度称「置信」，**不得**称胜率或概率（docs/04 §4.3）', () => {
    const text = confidenceText(0.784)
    expect(text).toBe('置信 78%')
    expect(text).not.toContain('胜率')
    expect(text).not.toContain('概率')
  })

  it('全部文案不含禁用词（CLAUDE.md 措辞纪律）', () => {
    const banned = ['必涨', '抄底', '稳赚', '牛股', '胜率']
    const gated = gateSignal(input({ signal: signalOf('BUY', 0.8) }))
    const text = [gated.headline, ...gated.reasons].join(' ')
    for (const word of banned) expect(text).not.toContain(word)
  })
})
