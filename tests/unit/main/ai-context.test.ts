/**
 * 发给模型的上下文（src/main/ai/context.ts）。
 *
 * **主用例是「参数标定状态那一块必须在」。** 这不是形式检查：
 * 缺了它，模型会默认引擎结论是经过验证的，然后用非常有说服力的语气把一套
 * 未标定的转述阈值讲成定论 —— 那正是 ADR-0003 要防的事，而且从输出上完全看不出
 * 是上下文漏了一块。
 *
 * 另外钉住：
 *   - 指标里的 null **不能**变成 0（约束 4 的同一条纪律）
 *   - 「置信度」的口径说明必须在（不得让模型把它读成胜率）
 *   - 计算口径差异（MACD 柱 2×、布林带除 n）必须在，否则模型会按通用公式重算后报出
 *     与面板不一致的数字
 */

import { describe, expect, it } from 'vitest'
import { buildSignalContext, renderContext } from '@main/ai/context'
import type { ParamRow, SignalEvidence, SignalRecord } from '@shared/ipc-types'

const RECORD: SignalRecord = {
  id: 'sig-1',
  code: 'SH600000',
  name: '浦发银行',
  createdAt: 1_755_000_000_000,
  direction: 'BUY',
  score: 0.66,
  votes: 3,
  regime: 'TREND_UP',
  stage: 'CONFIRMED',
  priceAt: 8.42,
  level: 'L2',
}

const EVIDENCE: SignalEvidence = {
  id: 'sig-1',
  subSignals: [
    { id: 'T1_MA_CROSS', direction: 'BUY', score: 0.8, weight: 1, detail: {} },
    { id: 'T3_BREAKOUT', direction: 'BUY', score: 0.6, weight: 1, detail: {} },
  ],
  adjustments: [{ id: 'M1_WEEK_MACD_DAY_RSI', delta: 0.05 }],
  indicatorsAt: { ma5: 8.3, ma20: 8.1, adx: null, rsi14: 58.2 },
}

const PARAMS: ParamRow[] = [
  { group: 'strategy', key: 'squeezeBbwPct', value: '20', status: 'CALIBRATED' },
  { group: 'adx', key: 'baseThreshold', value: '20', status: 'KEPT' },
  { group: 'strategy', key: 'revertLookback', value: '3', status: 'INERT' },
  { group: 'alert', key: 'bubbleScore', value: '0.75', status: 'UNTESTABLE' },
  { group: 'risk', key: 'stopLossPct', value: '8', status: 'GUESS' },
  { group: 'macd', key: 'fast', value: '12', status: 'GUESS' },
]

function build(overrides: Partial<Parameters<typeof buildSignalContext>[0]> = {}) {
  return buildSignalContext({
    record: RECORD,
    evidence: EVIDENCE,
    params: PARAMS,
    engineVersion: '0.2.6-unvalidated',
    at: '2026-08-13 15:00:12',
    ...overrides,
  })
}

describe('buildSignalContext', () => {
  it('带上参数标定状态：分档计数 + 已标定项逐个列名', () => {
    const context = build()
    expect(context.calibration).toEqual({
      engineVersion: '0.2.6-unvalidated',
      calibrated: 1,
      kept: 1,
      inert: 1,
      untestable: 1,
      guess: 2,
      calibratedKeys: ['strategy.squeezeBbwPct'],
    })
  })

  it('指标里的 null 被丢掉，**不填 0**（约束 4）', () => {
    const context = build()
    expect(context.indicators).toEqual({ ma5: 8.3, ma20: 8.1, rsi14: 58.2 })
    expect(context.indicators).not.toHaveProperty('adx')
  })

  it('子信号用中文短标签，与气泡文案同一份措辞', () => {
    const context = build()
    expect(context.subSignals.map((sub) => sub.label)).toEqual(['均线金叉', '放量突破上轨'])
    expect(context.adjustments[0]?.label).toBe('周线拐头共振')
  })

  it('没有 alert 记录时，闸门那一块退回信号自己的抑制原因', () => {
    const context = build({
      record: { ...RECORD, suppressedReason: '风控硬抑制：ST 股不参与' },
    })
    expect(context.gate.delivered).toBe(false)
    expect(context.gate.reason).toContain('ST')
  })

  it('持仓存在时算浮动盈亏；成本为 0 时给 null 而不是 Infinity', () => {
    const withPosition = build({
      position: { code: 'SH600000', shares: 1000, cost: 8, peakPrice: 9, openedAt: 0 },
    })
    expect(withPosition.position?.pnlPct).toBeCloseTo(5.25, 2)

    const zeroCost = build({
      position: { code: 'SH600000', shares: 1000, cost: 0, peakPrice: 0, openedAt: 0 },
    })
    expect(zeroCost.position?.pnlPct).toBeNull()
  })

  it('没有 params 时如实说「没有任何一项标定过」，不装作有', () => {
    const context = build({ params: [] })
    expect(context.calibration.calibrated).toBe(0)
    expect(context.calibration.calibratedKeys).toEqual([])
    expect(renderContext(context)).toContain('没有任何一项经过本地回测标定')
  })
})

describe('renderContext', () => {
  const text = renderContext(build())

  it('参数标定那一节在正文里，而且点明「一个网格都没跑过」的项数', () => {
    expect(text).toContain('参数标定状态')
    expect(text).toContain('一个网格都没跑过 2 项')
    expect(text).toContain('strategy.squeezeBbwPct')
    expect(text).toContain('把这套规则说成「经过验证」')
  })

  it('置信度带口径说明 —— 不得让模型读成胜率或概率', () => {
    expect(text).toContain('不是胜率也不是概率')
    expect(text).toContain('置信度：66%')
  })

  it('计算口径差异在正文里，防模型按通用公式重算', () => {
    expect(text).toContain('2×(DIF−DEA)')
    expect(text).toContain('除 n，不是 n−1')
    expect(text).toContain('前复权')
  })

  it('null 指标不出现在正文里', () => {
    expect(text).not.toContain('adx')
  })

  it('风控产生的信号（无子信号）如实说明，不留空段', () => {
    const noSub = renderContext(build({ evidence: { ...EVIDENCE, subSignals: [] } }))
    expect(noSub).toContain('该条由风控规则产生')
  })
})
