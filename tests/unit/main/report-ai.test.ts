/**
 * 日报的 AI 那一半（上下文 · 指纹 · 目标标识）。
 *
 * 三件都是**从输出上看不出来**的错：
 *   1. 上下文漏了参数标定状态 → 模型默认引擎经过验证，用很有说服力的语气讲成定论；
 *   2. 指纹把生成时刻或派生量算进去 → 「已过期」提示恒亮，等于没有这个功能；
 *   3. 目标标识两边各拼一份 → 日报那条走到解释单条信号的路上，报「该信号已不在库中」。
 */

import { describe, expect, it } from 'vitest'
import { renderReportContext } from '@main/ai/context'
import { reportFactDigest } from '@main/report/digest'
import { isReportTarget, reportDateOf, reportTargetId } from '@shared/ai-target'
import type { DailyReport, ParamRow } from '@shared/ipc-types'
import type { SecCode, TradeDate } from '@core/types'

const DATE = '2026-08-14' as TradeDate
/** DATE 那天的北京 15:00（收盘线的数据时刻） */
const CLOSE_MS = 1_759_990_000_000

function params(): ParamRow[] {
  return [
    { group: 'strategy', key: 'squeezeBbwPct', value: '20', status: 'CALIBRATED', note: '' },
    { group: 'macd', key: 'fast', value: '12', status: 'GUESS', note: '' },
    { group: 'macd', key: 'slow', value: '17', status: 'GUESS', note: '' },
  ] as ParamRow[]
}

function report(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: DATE,
    stage: 'FINAL',
    at: 1_760_000_000_000,
    overview: { watchCount: 2, withSignal: 1, byDirection: [{ direction: 'SELL', count: 1 }], positions: 1, belowStop: 1 },
    stocks: [
      {
        code: 'SH600000' as SecCode,
        name: '浦发银行',
        industry: '银行',
        quote: { close: 10.5, changePct: -2.1, amplitudePct: 3.4, open: 10.7, high: 10.8, low: 10.4, source: 'CLOSE', at: CLOSE_MS },
        signals: { total: 2, actionable: 1, last: { direction: 'SELL', level: 'L3', stage: 'CONFIRMED', score: 0.82 }, suppressedReasons: ['已跌停，卖不掉'] },
        position: { shares: 1000, cost: 12, pnlPct: -12.5, toStopPct: -4.5 },
        watch: { hit: 1, expired: 0, active: 2 },
      },
      {
        code: 'SZ000001' as SecCode,
        name: '平安银行',
        quote: null,
        signals: { total: 0, actionable: 0, last: null, suppressedReasons: [] },
        watch: { hit: 0, expired: 0, active: 0 },
      },
    ],
    alerts: { delivered: 1, gated: 2, reasons: [{ reason: '免打扰时段', count: 2 }] },
    tomorrow: [{ code: 'SH600000' as SecCode, name: '浦发银行', kind: 'POSITION_RISK', note: '持仓未了结', at: 1_759_990_000_000 }],
    data: { withClose: 1, missing: ['SZ000001' as SecCode] },
    highlights: ['2 只自选，其中 1 只今日出现信号（卖出 1 条）。'],
    // 环境是独立的一节（docs/11 N1）。这里给空壳即可 —— 它的判据在 environment.test.ts，
    // 而**指纹刻意不含它**：环境每分钟都在动，算进去会让「已过期」提示恒亮
    environment: { benchmark: null, industries: [], breadth: { withQuote: 0, up: 0, down: 0, flat: 0 }, missing: [], lines: [] },
    // 每节的数据时刻。**同样刻意不进指纹** —— 见下面那条用例
    stamps: { environment: null, stocks: CLOSE_MS, summary: CLOSE_MS, tomorrow: CLOSE_MS, alerts: null },
    ...over,
  }
}

describe('renderReportContext', () => {
  const text = (): string =>
    renderReportContext({ report: report(), params: params(), engineVersion: '0.2.7-unvalidated+abc', at: '2026-08-14 15:30' })

  it('**必须带参数标定状态** —— 缺了它模型会替一套未标定的阈值背书', () => {
    const out = text()
    expect(out).toContain('参数标定状态')
    expect(out).toContain('0.2.7-unvalidated+abc')
    expect(out).toContain('一个网格都没跑过 2 项')
    expect(out).toContain('strategy.squeezeBbwPct')
    expect(out).toContain('不得')
  })

  it('把「明日关注」标成引擎的结论，而不是让模型重列一份', () => {
    expect(text()).toContain('不是让你重新列一份')
  })

  it('逐只那一段明确标注「不要复述」', () => {
    expect(text()).toContain('不要复述')
  })

  it('拿不到行情的那只如实说「无行情数据」，不给 0', () => {
    const out = text()
    expect(out).toContain('无行情数据')
    expect(out).not.toContain('收 0.00')
  })

  it('盘中版要在上下文里就说清楚，模型才知道要留余地', () => {
    const out = renderReportContext({
      report: report({ stage: 'PROVISIONAL' }),
      params: params(),
      engineVersion: 'v',
      at: 'x',
    })
    expect(out).toContain('盘中最后一次行情')
  })

  it('不发原始 K 线 —— 只发已经算好的事实层', () => {
    const out = text()
    expect(out).not.toContain('openAdj')
    expect(out).not.toContain('closeAdj')
  })
})

describe('reportFactDigest', () => {
  it('同一份事实 → 同一个指纹', () => {
    expect(reportFactDigest(report())).toBe(reportFactDigest(report()))
  })

  it('**生成时刻不算进去** —— 算进去的话「已过期」提示会恒亮', () => {
    expect(reportFactDigest(report({ at: 1 }))).toBe(reportFactDigest(report({ at: 2 })))
  })

  /*
    2026-08-18 加了「每节数据时刻」（`stamps` / `quote.at` / `tomorrow[].at`）。
    这一条钉住它们**一个都没进指纹** —— 时刻每 30 秒就变，
    进了指纹「这段评价已过期」就恒亮，等于把这个功能废掉。
  */
  it('**每节的数据时刻不算进去** —— 它每轮都变，算进去「已过期」会恒亮', () => {
    const moved = report({
      stamps: { environment: 1, stocks: 2, summary: 3, tomorrow: 4, alerts: 5 },
      tomorrow: [{ code: 'SH600000' as SecCode, name: '浦发银行', kind: 'POSITION_RISK', note: '持仓未了结', at: 99 }],
    })
    expect(reportFactDigest(moved)).toBe(reportFactDigest(report()))
  })

  it('行情的时刻变了但价格没变 → 指纹不变（换的是「几点的」，不是「多少钱」）', () => {
    const base = report()
    const first = base.stocks[0]
    if (!first?.quote) throw new Error('用例数据变了')
    const later = report({
      stocks: [{ ...first, quote: { ...first.quote, at: first.quote.at + 60_000 } }, ...base.stocks.slice(1)],
    })
    expect(reportFactDigest(later)).toBe(reportFactDigest(base))
  })

  it('highlights 是派生量，也不算进去', () => {
    expect(reportFactDigest(report({ highlights: ['换一句话'] }))).toBe(reportFactDigest(report()))
  })

  it('阶段变了（盘中 → 定稿）指纹就变', () => {
    expect(reportFactDigest(report({ stage: 'PROVISIONAL' }))).not.toBe(reportFactDigest(report()))
  })

  it('收盘价变了指纹就变', () => {
    const moved = report()
    const first = moved.stocks[0]
    if (first?.quote) first.quote = { ...first.quote, close: 11.5 }
    expect(reportFactDigest(moved)).not.toBe(reportFactDigest(report()))
  })

  it('信号方向变了指纹就变', () => {
    const moved = report()
    const first = moved.stocks[0]
    if (first?.signals.last) first.signals.last = { ...first.signals.last, direction: 'BUY' }
    expect(reportFactDigest(moved)).not.toBe(reportFactDigest(report()))
  })
})

describe('ai-target：格式只有一处定义', () => {
  it('往返', () => {
    const id = reportTargetId(DATE)
    expect(isReportTarget(id)).toBe(true)
    expect(reportDateOf(id)).toBe(DATE)
  })

  it('信号 id 不会被误判成日报', () => {
    const signalId = 'b3f1c0de-1234-4a5b-8c9d-000000000000'
    expect(isReportTarget(signalId)).toBe(false)
    // **返回 null 而不是空串** —— 空串会一路传下去，最后变成一个查不到的日期
    expect(reportDateOf(signalId)).toBeNull()
  })
})
