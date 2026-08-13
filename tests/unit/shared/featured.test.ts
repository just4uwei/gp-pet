import { describe, expect, it } from 'vitest'
import { pickFeatured, type FeaturedQuote, type FeaturedSignal } from '@shared/featured'
import type { SecCode } from '@core/types'

/**
 * 悬浮条只有一行，选错了用户就看不到该看的那只（docs/06 §2.1）。
 *
 * 这里最要紧的一条是**确定性**：没有稳定的兜底排序，两只涨幅相同的票会随
 * 每轮快照的数组顺序来回跳 —— 一条常驻置顶的条子来回闪，比不显示更烦人。
 */
describe('pickFeatured', () => {
  const q = (code: string, changePct: number): FeaturedQuote => ({ code: code as SecCode, changePct })
  const s = (code: string, score: number, suppressedReason?: string): FeaturedSignal =>
    suppressedReason === undefined
      ? { code: code as SecCode, score }
      : { code: code as SecCode, score, suppressedReason }

  it('没有报价时给 null —— 宁可不显示，也不显示一个没有价格的名字', () => {
    expect(pickFeatured([], [s('SH600000', 0.9)])).toBeNull()
  })

  it('没有信号时按 |涨跌幅| 降序：跌 5% 与涨 5% 一样值得看一眼', () => {
    const picked = pickFeatured([q('SH600000', 1.2), q('SZ000001', -5.4), q('SZ300001', 3.1)])
    expect(picked?.code).toBe('SZ000001')
  })

  it('有未静默信号时优先信号，按置信度降序 —— 悬浮条不是行情牌', () => {
    const quotes = [q('SH600000', 0.1), q('SZ000001', -9.9)]
    const picked = pickFeatured(quotes, [s('SH600000', 0.82)])
    // SZ000001 跌得多得多，但没有信号
    expect(picked?.code).toBe('SH600000')
  })

  it('被风控静默的信号不参与 —— 它在日志里可查，但不构成「值得看一眼」', () => {
    const quotes = [q('SH600000', 0.1), q('SZ000001', -9.9)]
    const picked = pickFeatured(quotes, [s('SH600000', 0.95, 'HARD_LIMIT_UP')])
    expect(picked?.code).toBe('SZ000001')
  })

  it('信号所属标的本轮没有报价时跳过它，退回涨跌幅', () => {
    const picked = pickFeatured([q('SZ000001', -2)], [s('SH600000', 0.9)])
    expect(picked?.code).toBe('SZ000001')
  })

  it('多条信号取置信度最高的那只', () => {
    const quotes = [q('SH600000', 0), q('SZ000001', 0), q('SZ300001', 0)]
    const picked = pickFeatured(quotes, [s('SH600000', 0.61), s('SZ300001', 0.88), s('SZ000001', 0.7)])
    expect(picked?.code).toBe('SZ300001')
  })

  it('同置信度按代码升序 —— 否则每轮快照都可能换一只，条子来回闪', () => {
    const quotes = [q('SZ300001', 0), q('SH600000', 0)]
    const signals = [s('SZ300001', 0.8), s('SH600000', 0.8)]
    expect(pickFeatured(quotes, signals)?.code).toBe('SH600000')
    // 换个入参顺序，结论必须一样
    expect(pickFeatured([...quotes].reverse(), [...signals].reverse())?.code).toBe('SH600000')
  })

  it('同涨跌幅也按代码升序，且与入参顺序无关', () => {
    const quotes = [q('SZ300001', 2.5), q('SH600000', -2.5)]
    expect(pickFeatured(quotes)?.code).toBe('SH600000')
    expect(pickFeatured([...quotes].reverse())?.code).toBe('SH600000')
  })

  it('透传调用方的完整对象，不重新构造 —— 渲染层要用上面的名称与价格', () => {
    const rich = { code: 'SH600000' as SecCode, changePct: 1.5, last: 10.28, name: '浦发银行' }
    expect(pickFeatured([rich])).toBe(rich)
  })
})
