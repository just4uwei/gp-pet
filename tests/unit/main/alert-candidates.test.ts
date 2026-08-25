/**
 * 评估结果 → 分发候选（src/main/alerts/candidates.ts）。
 *
 * 这一层的每条取舍都是**少发/多发的分岔点**，而两个方向的错误不对称：
 * 多发会被立刻抱怨，少发（尤其漏掉止损）用户根本不知道。所以下面这几条比其他用例更严：
 *   - 硬抑制的信号不进提醒层（它已经在 signal 表里带着原因）
 *   - 用户的整体级别偏移**不作用于**持仓强制类
 *   - 强制类要带上 `forced` 与 `lossPct`，否则分发器的 2% 台阶无从判起
 *   - 收盘失效提示的方向必须是 NONE，否则会被原方向的冷却吃掉
 */

import { describe, expect, it } from 'vitest'
import type { Evaluation } from '@core/engine'
import type { AlertLevel, GatedDirection, RiskVerdict, SecCode, SubSignal } from '@core/types'
import { buildAlerts, shiftLevel, topSubSignalId } from '@main/alerts/candidates'
import type { SignalOutcome } from '@main/engine/signals'

const AT = 1_700_000_000_000

/**
 * 只构造 `buildAlerts` 真正读到的那几个字段。
 * 造一个完整的 Evaluation 要跑一遍五层引擎，那测的就不是这一层了。
 */
function evaluation(options: {
  code?: SecCode
  direction?: GatedDirection
  level?: AlertLevel
  suppressed?: boolean
  score?: number
  subSignals?: SubSignal[]
  verdicts?: RiskVerdict[]
  reasons?: string[]
  close?: number
} = {}): Evaluation {
  const value = {
    code: options.code ?? ('SH600000' as SecCode),
    candle: { close: options.close ?? 12.34 },
    signal: { score: options.score ?? 0.8, subSignals: options.subSignals ?? [] },
    gated: {
      direction: options.direction ?? 'BUY',
      level: options.level ?? 'L2',
      suppressed: options.suppressed ?? false,
      headline: '均线金叉 · 上升趋势',
      reasons: options.reasons ?? ['均线金叉', 'MACD 零轴上金叉', '放量 1.4 倍', '第四条不该出现在气泡里'],
      verdicts: options.verdicts ?? [],
    },
  }
  return value as unknown as Evaluation
}

function outcome(overrides: Partial<SignalOutcome> = {}): SignalOutcome {
  return {
    evaluation: evaluation(),
    name: '浦发银行',
    persisted: true,
    signalId: 'sig-1',
    ...overrides,
  }
}

function sub(id: string, direction: 'BUY' | 'SELL', score: number, weight: number): SubSignal {
  return { id, strategy: 'TREND', direction, score, weight, evidence: {} }
}

describe('shiftLevel', () => {
  it('上下各一档，L1 是地板 L3 是天花板', () => {
    expect(shiftLevel('L1', 1)).toBe('L2')
    expect(shiftLevel('L2', -1)).toBe('L1')
    expect(shiftLevel('L1', -1)).toBe('L1')
    expect(shiftLevel('L3', 1)).toBe('L3')
    expect(shiftLevel('L2', 0)).toBe('L2')
  })
})

describe('topSubSignalId：防抖键的那一半', () => {
  it('取与最终方向一致的最强子信号（强度 × 权重）', () => {
    const subs = [sub('T1_MA_CROSS', 'BUY', 0.5, 0.2), sub('T3_BREAKOUT', 'BUY', 0.9, 0.3)]
    expect(topSubSignalId(subs, 'BUY')).toBe('T3_BREAKOUT')
  })

  it('反方向那条再强也不算 —— 它换成别的不该让买入的连续计数清零', () => {
    const subs = [sub('R1_RSI_BAND', 'SELL', 1, 1), sub('T1_MA_CROSS', 'BUY', 0.1, 0.1)]
    expect(topSubSignalId(subs, 'BUY')).toBe('T1_MA_CROSS')
  })

  it('REDUCE 按卖出侧取', () => {
    const subs = [sub('R1_RSI_BAND', 'SELL', 0.7, 0.5)]
    expect(topSubSignalId(subs, 'REDUCE')).toBe('R1_RSI_BAND')
  })

  it('一条一致的都没有时给一个稳定占位，不是 undefined', () => {
    expect(topSubSignalId([], 'BUY')).toBe('NONE')
  })
})

describe('哪些信号不进提醒层', () => {
  it('方向 NONE 的不进 —— 没有可提醒的东西', () => {
    expect(buildAlerts([outcome({ evaluation: evaluation({ direction: 'NONE' }) })], { at: AT })).toHaveLength(0)
  })

  it('硬抑制的不进：它已经在 signal 表里带着原因（docs/05 §2.1「仅落库不提醒」）', () => {
    expect(buildAlerts([outcome({ evaluation: evaluation({ suppressed: true }) })], { at: AT })).toHaveLength(0)
  })

  it('拿不到 signalId 的不进 —— alert_log.signal_id 是外键，落不了库就没有审计记录', () => {
    expect(buildAlerts([outcome({ signalId: null })], { at: AT })).toHaveLength(0)
    expect(buildAlerts([outcome({ signalId: '' })], { at: AT })).toHaveLength(0)
  })
})

describe('级别偏移（docs/05 §3）', () => {
  it('策略信号跟着用户的整体偏移走', () => {
    const [item] = buildAlerts([outcome()], { at: AT, levelOffset: -1 })
    expect(item?.candidate.level).toBe('L1')
    expect(item?.payload.level).toBe('L1')
  })

  it('持仓强制类不受偏移影响 —— 把止损从 L3 调成 L2 意味着跌停那天不响', () => {
    const forced: RiskVerdict = {
      rule: 'STOP_LOSS',
      action: 'FORCE_SELL',
      reason: '已亏损 8.6%，触及 8% 止损线',
      evidence: { profitPct: -8.6 },
    }
    const [item] = buildAlerts(
      [outcome({ evaluation: evaluation({ direction: 'SELL', level: 'L3', verdicts: [forced] }) })],
      { at: AT, levelOffset: -1 }
    )
    expect(item?.candidate.level).toBe('L3')
  })
})

describe('持仓强制类', () => {
  const forced: RiskVerdict = {
    rule: 'DRAWDOWN_REDUCE',
    action: 'FORCE_REDUCE',
    reason: '自最高点回撤 7.2%，建议减仓 50%',
    evidence: { profitPct: -3.5 },
  }

  it('带上 forced 与 lossPct（百分数换成小数），台阶判定才有依据', () => {
    const [item] = buildAlerts(
      [outcome({ evaluation: evaluation({ direction: 'REDUCE', level: 'L3', verdicts: [forced] }) })],
      { at: AT }
    )
    expect(item?.candidate.forced).toBe(true)
    expect(item?.candidate.lossPct).toBeCloseTo(-0.035, 10)
    // 防抖键用规则名而不是子信号 —— 强制通道本来就不经过组合层得分
    expect(item?.candidate.topSubSignalId).toBe('DRAWDOWN_REDUCE')
  })

  it('evidence 里没有 profitPct 时不带 lossPct：退化为「不受冷却」，宁可多发一条止损', () => {
    const bare: RiskVerdict = { ...forced, evidence: {} }
    const [item] = buildAlerts(
      [outcome({ evaluation: evaluation({ direction: 'SELL', verdicts: [bare] }) })],
      { at: AT }
    )
    expect(item?.candidate.forced).toBe(true)
    expect(item?.candidate.lossPct).toBeUndefined()
  })
})

describe('展示载荷', () => {
  it('依据行最多 3 条（完整依据在面板展开）', () => {
    const [item] = buildAlerts([outcome()], { at: AT })
    expect(item?.payload.reasons).toHaveLength(3)
    expect(item?.payload.reasons).not.toContain('第四条不该出现在气泡里')
  })

  it('有快照时用最新价与涨跌幅', () => {
    const quotes = new Map([['SH600000' as SecCode, { last: 13.5, changePct: 2.1 }]])
    const [item] = buildAlerts([outcome()], { at: AT, quotes })
    expect(item?.payload.price).toBe(13.5)
    expect(item?.payload.changePct).toBe(2.1)
  })

  it('没有快照时退回那根 K 线的不复权收盘价，涨跌幅不编数字', () => {
    const [item] = buildAlerts([outcome({ evaluation: evaluation({ close: 9.99 }) })], { at: AT })
    expect(item?.payload.price).toBe(9.99)
    expect(item?.payload.changePct).toBe(0)
  })
})

describe('收盘失效提示（docs/04 §6、docs/05 §3）', () => {
  const invalidated = outcome({
    evaluation: evaluation({ direction: 'NONE' }),
    invalidated: { signalId: 'sig-morning', direction: 'BUY' },
  })

  it('方向用 NONE：沿用原方向会被上午那条买入的冷却吃掉', () => {
    const [item] = buildAlerts([invalidated], { at: AT })
    expect(item?.candidate.direction).toBe('NONE')
    expect(item?.candidate.level).toBe('L1')
    expect(item?.candidate.signalId).toBe('sig-morning')
    expect(item?.payload.headline).toContain('买入')
    expect(item?.payload.headline).toContain('失效')
  })

  it('失效提示与本轮的新信号互不排斥', () => {
    const both = outcome({
      evaluation: evaluation({ direction: 'SELL' }),
      invalidated: { signalId: 'sig-morning', direction: 'BUY' },
    })
    const items = buildAlerts([both], { at: AT })
    expect(items.map((i) => i.candidate.direction)).toEqual(['NONE', 'SELL'])
  })
})

/**
 * 昨日「明日观察」的次日兑现（engine/signals.ts 的 CarryoverNotice）。
 *
 * 这里钉的是**表达方式**而不是判定：判定在引擎那一侧（signals.test.ts 有 8 条）。
 * 提醒层只做两件事 —— 抬到 L2、把来历写进第一条依据，而且**不新发一条**。
 * 多发一条的症状是「同一件事一天提醒两次」，用户只会觉得吵。
 */
describe('明日观察的次日兑现', () => {
  const carried = outcome({
    evaluation: evaluation({ direction: 'BUY', level: 'L1', score: 0.66 }),
    carriedOver: { signalId: 'sig-yesterday', from: '2024-03-14' },
  })

  it('只出一条提醒，不为复活单独再发一条', () => {
    expect(buildAlerts([carried], { at: AT })).toHaveLength(1)
  })

  it('抬到 L2：昨日收盘确认 + 今日盘中仍成立是两次独立成立，值得从状态点升到气泡', () => {
    const [item] = buildAlerts([carried], { at: AT })
    expect(item?.candidate.level).toBe('L2')
    // 外键仍指向**今天**那条：它才是当前依据，昨天那条只在文案里出现
    expect(item?.candidate.signalId).toBe('sig-1')
  })

  it('来历排在依据第一条，且依据总数仍不超过 3 条', () => {
    const [item] = buildAlerts([carried], { at: AT })
    expect(item?.payload.reasons[0]).toContain('2024-03-14')
    expect(item?.payload.reasons[0]).toContain('明日观察')
    expect(item?.payload.reasons).toHaveLength(3)
  })

  it('用户把整体级别上调过一档时不往下压 —— 取两者较高的那个', () => {
    const [item] = buildAlerts([carried], { at: AT, levelOffset: 1 })
    expect(item?.candidate.level).toBe('L2')
    const [strong] = buildAlerts(
      [
        outcome({
          evaluation: evaluation({ direction: 'BUY', level: 'L2' }),
          carriedOver: { signalId: 'sig-yesterday', from: '2024-03-14' },
        }),
      ],
      { at: AT, levelOffset: 1 }
    )
    expect(strong?.candidate.level).toBe('L3')
  })

  it('持仓强制类不受它影响：那一档由风控定，任何佐证都不该动它', () => {
    const forced = outcome({
      evaluation: evaluation({
        direction: 'SELL',
        level: 'L3',
        verdicts: [{ rule: 'STOP_LOSS', action: 'FORCE_SELL', reason: '触及止损线', evidence: {} }],
      }),
      carriedOver: { signalId: 'sig-yesterday', from: '2024-03-14' },
    })
    expect(buildAlerts([forced], { at: AT })[0]?.candidate.level).toBe('L3')
  })
})

/**
 * 观察点命中 —— 提醒层的**第三类来源**（信号 / 收盘失效 / 观察点命中）。
 *
 * 四个字段各有理由，逐条钉住：挂来源信号（外键）、方向 NONE（避开冷却串味）、
 * L2（照过闸门而不是绕过）、文案说清「这是你设的，不是策略让你卖」。
 */
describe('观察点命中（P2 续）', () => {
  const hit = {
    point: {
      id: 'w1',
      code: 'SH600000' as SecCode,
      signalId: 'sig-source',
      source: 'AI_SUGGESTED' as const,
      conditions: [{ metric: 'PRICE', op: 'LTE' as const, threshold: 8.2 }],
      meaning: 'INVALIDATE' as const,
      note: '跌破 20 日均线支撑',
      engineVersion: '0.2.6-unvalidated',
      createdAt: AT - 86_400_000,
      expiresAt: AT + 86_400_000,
      status: 'ACTIVE' as const,
    },
    values: [8.15],
    name: '浦发银行',
    price: 8.15,
    changePct: -2.1,
  }

  it('挂来源信号的 id —— alert_log.signal_id 是 NOT NULL 外键，不用改表结构', () => {
    const [item] = buildAlerts([], { at: AT, watchHits: [hit] })
    expect(item?.candidate.signalId).toBe('sig-source')
  })

  it('方向用 NONE：沿用原方向会被那条买入提醒的 2h 冷却吃掉', () => {
    const [item] = buildAlerts([], { at: AT, watchHits: [hit] })
    expect(item?.candidate.direction).toBe('NONE')
  })

  it('级别 L2 —— 够得上气泡，但**照过四道闸门**，不是强制类', () => {
    const [item] = buildAlerts([], { at: AT, watchHits: [hit] })
    expect(item?.candidate.level).toBe('L2')
    expect(item?.candidate.forced).toBeUndefined()
    expect(item?.candidate.topSubSignalId).toBe('WATCH_HIT')
  })

  it('文案说清这是用户自己设的，不是策略给的新信号', () => {
    const [item] = buildAlerts([], { at: AT, watchHits: [hit] })
    expect(item?.payload.headline).toContain('失效条件')
    expect(item?.payload.reasons.join(' ')).toContain('不是新的策略信号')
    // 措辞纪律：不许出现「快卖」这类情绪化表达
    expect(item?.payload.headline).not.toContain('卖')
  })

  it('CONFIRM 类的措辞不同 —— 命中意味着判断被确认，不是失效', () => {
    const confirm = { ...hit, point: { ...hit.point, meaning: 'CONFIRM' as const } }
    const [item] = buildAlerts([], { at: AT, watchHits: [confirm] })
    expect(item?.payload.headline).toContain('观察条件已满足')
  })

  /**
   * 组合条件必须**整句**说出来。只报其中一条的症状是用户以为软件提前触发了 ——
   * 而他没有别的地方能看出那条提醒对应的是两个条件。
   */
  it('组合条件的文案含「且」，并逐条给出实际值', () => {
    const multi = {
      ...hit,
      point: {
        ...hit.point,
        conditions: [
          { metric: 'PRICE', op: 'LTE' as const, threshold: 8.2 },
          { metric: 'rsi', op: 'LTE' as const, threshold: 30 },
        ],
      },
      values: [8.15, 28.5],
    }
    const [item] = buildAlerts([], { at: AT, watchHits: [multi] })
    expect(item?.payload.headline).toContain('且')
    expect(item?.payload.headline).toContain('RSI 跌破 30')
    expect(item?.payload.reasons[0]).toContain('28.5')
    // 级别与方向不因条件多了而变
    expect(item?.candidate.level).toBe('L2')
    expect(item?.candidate.direction).toBe('NONE')
  })

  it('命中排在信号之前：用户亲自设的东西优先于引擎自己发现的', () => {
    const items = buildAlerts([outcome({ evaluation: evaluation({ direction: 'BUY' }) })], {
      at: AT,
      watchHits: [hit],
    })
    expect(items).toHaveLength(2)
    expect(items[0]?.candidate.topSubSignalId).toBe('WATCH_HIT')
    expect(items[1]?.candidate.direction).toBe('BUY')
  })

  it('没有命中时不多出任何候选', () => {
    expect(buildAlerts([], { at: AT, watchHits: [] })).toHaveLength(0)
    expect(buildAlerts([], { at: AT })).toHaveLength(0)
  })
})
