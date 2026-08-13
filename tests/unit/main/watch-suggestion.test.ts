/**
 * 从解读正文里抽观察点建议（src/main/watch/suggestion.ts）。
 *
 * **唯一的设计原则：抽不到不是错误。** 模型不照格式输出是常态 ——
 * 换个模型、换个温度、上下文长一点都可能漏。所有失败路径都要落到「没有建议」，
 * 让表单留空由用户自己填。
 *
 * 而**抽错比抽不到糟得多**：抽不到用户会自己填；抽错了用户可能直接点确认，
 * 然后跟踪一个错的条件。所以下面既测容错，也测「不该抽出来的别抽」。
 */

import { describe, expect, it } from 'vitest'
import { parseWatchSuggestions, stripSuggestionBlock } from '@main/watch/suggestion'

const GOOD = `第一段正文。

<观察点建议>
metric=PRICE op=LTE threshold=8.20 meaning=INVALIDATE 说明=跌破 20 日均线支撑
</观察点建议>`

describe('parseWatchSuggestions', () => {
  it('抽出一条完整建议', () => {
    expect(parseWatchSuggestions(GOOD)).toEqual([
      {
        metric: 'PRICE',
        op: 'LTE',
        threshold: 8.2,
        meaning: 'INVALIDATE',
        // 「说明」里带空格也要完整取到 —— 取到行尾为止
        note: '跌破 20 日均线支撑',
      },
    ])
  })

  it('多条各占一行，最多取两条', () => {
    const text = `<观察点建议>
metric=PRICE op=LTE threshold=8.2 meaning=INVALIDATE
metric=rsi op=GTE threshold=70 meaning=CONFIRM
metric=adx op=GTE threshold=25 meaning=CONFIRM
</观察点建议>`
    const out = parseWatchSuggestions(text)
    expect(out).toHaveLength(2)
    expect(out[1]?.metric).toBe('rsi')
  })

  // ── 容错：以下每一条都必须返回空数组，且不抛错 ──────────────────

  it('整块缺失 → 没有建议', () => {
    expect(parseWatchSuggestions('模型这次只写了四段正文，没给数值。')).toEqual([])
  })

  it('空字符串 → 没有建议', () => {
    expect(parseWatchSuggestions('')).toEqual([])
  })

  it('块在但内容是散话 → 没有建议', () => {
    expect(parseWatchSuggestions('<观察点建议>\n跌破 20 日线就说明错了\n</观察点建议>')).toEqual([])
  })

  it('阈值不是数 → 丢掉那一条', () => {
    expect(
      parseWatchSuggestions('<观察点建议>\nmetric=PRICE op=LTE threshold=支撑位 meaning=INVALIDATE\n</观察点建议>')
    ).toEqual([])
  })

  it('缺 threshold → 丢掉那一条', () => {
    expect(
      parseWatchSuggestions('<观察点建议>\nmetric=PRICE op=LTE meaning=INVALIDATE\n</观察点建议>')
    ).toEqual([])
  })

  it('op 不认识 → 丢掉那一条', () => {
    expect(
      parseWatchSuggestions('<观察点建议>\nmetric=PRICE op=CROSS threshold=8.2\n</观察点建议>')
    ).toEqual([])
  })

  /**
   * 这一条是白名单存在的理由：模型可以写出一个**看起来完全合理**、
   * 但本地根本算不出来的指标。用户会确认下去，然后那个观察点永远不会命中。
   */
  it('metric 不在白名单（本地算不出来）→ 丢掉那一条', () => {
    expect(
      parseWatchSuggestions('<观察点建议>\nmetric=资金流入强度 op=GTE threshold=1000 meaning=CONFIRM\n</观察点建议>')
    ).toEqual([])
    expect(
      parseWatchSuggestions('<观察点建议>\nmetric=北向资金 op=GTE threshold=5 meaning=CONFIRM\n</观察点建议>')
    ).toEqual([])
  })

  it('未闭合的块 → 没有建议（宁可不抽，不猜边界）', () => {
    expect(parseWatchSuggestions('<观察点建议>\nmetric=PRICE op=LTE threshold=8.2')).toEqual([])
  })

  // ── 宽容的地方 ──────────────────────────────────────────────────

  it('op / meaning 大小写不敏感', () => {
    const out = parseWatchSuggestions('<观察点建议>\nmetric=rsi op=gte threshold=70 meaning=confirm\n</观察点建议>')
    expect(out[0]).toMatchObject({ op: 'GTE', meaning: 'CONFIRM' })
  })

  it('meaning 缺省时按 INVALIDATE —— 第四段问的本来就是「判断错了会怎样」', () => {
    const out = parseWatchSuggestions('<观察点建议>\nmetric=PRICE op=LTE threshold=8.2\n</观察点建议>')
    expect(out[0]?.meaning).toBe('INVALIDATE')
  })

  it('负数阈值也接受（MACD DIF 可以是负的）', () => {
    const out = parseWatchSuggestions('<观察点建议>\nmetric=dif op=LTE threshold=-0.15\n</观察点建议>')
    expect(out[0]?.threshold).toBeCloseTo(-0.15)
  })
})

describe('stripSuggestionBlock', () => {
  it('把建议块摘掉 —— 它是给程序读的，显示出来只是噪音', () => {
    expect(stripSuggestionBlock(GOOD)).toBe('第一段正文。')
  })

  it('没有块时原样返回', () => {
    expect(stripSuggestionBlock('就四段正文')).toBe('就四段正文')
  })
})
