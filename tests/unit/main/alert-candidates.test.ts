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
