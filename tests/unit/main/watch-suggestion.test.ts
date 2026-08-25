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
        conditions: [{ metric: 'PRICE', op: 'LTE', threshold: 8.2 }],
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
    expect(out[1]?.conditions).toEqual([{ metric: 'rsi', op: 'GTE', threshold: 70 }])
  })

  /**
   * **不带 `组` 的行为逐位不变**（回归护栏）。组合条件是 2026-08-25 加的，
   * 而绝大多数解读仍然只给一条 —— 那条路径上多一个字都不该变。
   */
  it('不带「组」的两行仍是两条各自独立的建议，每条一个条件', () => {
    const out = parseWatchSuggestions(`<观察点建议>
metric=PRICE op=LTE threshold=8.2
metric=rsi op=GTE threshold=70
</观察点建议>`)
    expect(out.map((s) => s.conditions.length)).toEqual([1, 1])
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
    expect(out[0]?.conditions[0]?.op).toBe('GTE')
    expect(out[0]?.meaning).toBe('CONFIRM')
  })

  it('meaning 缺省时按 INVALIDATE —— 第四段问的本来就是「判断错了会怎样」', () => {
    const out = parseWatchSuggestions('<观察点建议>\nmetric=PRICE op=LTE threshold=8.2\n</观察点建议>')
    expect(out[0]?.meaning).toBe('INVALIDATE')
  })

  it('负数阈值也接受（MACD DIF 可以是负的）', () => {
    const out = parseWatchSuggestions('<观察点建议>\nmetric=dif op=LTE threshold=-0.15\n</观察点建议>')
    expect(out[0]?.conditions[0]?.threshold).toBeCloseTo(-0.15)
  })
})

/**
 * 组合条件（`组=`，2026-08-25）。
 *
 * 同一个 `组` 的行合成**一个**观察点，条件之间是「且」。没写 `组` 的行各自成条 ——
 * 那条回归护栏在上面那个 describe 里。
 */
describe('组合条件（组=）', () => {
  const block = (body: string): string => `<观察点建议>\n${body}\n</观察点建议>`

  it('同组两行 → 一条建议两个条件，meaning 与说明取第一行的', () => {
    const out = parseWatchSuggestions(
      block(`metric=PRICE op=LTE threshold=8.2 meaning=INVALIDATE 组=1 说明=跌破均线支撑
metric=rsi op=LTE threshold=30 meaning=CONFIRM 组=1 说明=后面这句会被忽略`)
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.conditions).toEqual([
      { metric: 'PRICE', op: 'LTE', threshold: 8.2 },
      { metric: 'rsi', op: 'LTE', threshold: 30 },
    ])
    // 一个观察点只有一个语义：让第二行改它，用户会在表单里看到一个他没读过的结论
    expect(out[0]?.meaning).toBe('INVALIDATE')
    expect(out[0]?.note).toBe('跌破均线支撑')
  })

  it('两个组 = 两条建议；组与非组可以混着写', () => {
    const out = parseWatchSuggestions(
      block(`metric=PRICE op=LTE threshold=8.2 组=a
metric=rsi op=LTE threshold=30 组=a
metric=adx op=GTE threshold=25`)
    )
    expect(out.map((s) => s.conditions.length)).toEqual([2, 1])
  })

  it('组内超过 3 条 → 多的**丢弃**，不另起一条建议（另起会把「且」拆成两个独立观察点）', () => {
    const out = parseWatchSuggestions(
      block(`metric=PRICE op=LTE threshold=8.2 组=1
metric=rsi op=LTE threshold=30 组=1
metric=adx op=GTE threshold=25 组=1
metric=ma20 op=LTE threshold=9 组=1`)
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.conditions).toHaveLength(3)
  })

  it('超过两个组时后面的整组丢掉', () => {
    const out = parseWatchSuggestions(
      block(`metric=PRICE op=LTE threshold=8.2 组=1
metric=rsi op=LTE threshold=30 组=2
metric=adx op=GTE threshold=25 组=3`)
    )
    expect(out).toHaveLength(2)
  })

  it('组里有一行 metric 不在白名单 → 只丢那一行，组存活', () => {
    const out = parseWatchSuggestions(
      block(`metric=PRICE op=LTE threshold=8.2 组=1
metric=北向资金 op=GTE threshold=5 组=1`)
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.conditions).toEqual([{ metric: 'PRICE', op: 'LTE', threshold: 8.2 }])
  })

  /**
   * 与「metric 不在白名单」同一处置：一个**永远不会命中**的建议比没有建议糟得多 ——
   * 它看起来完全正常，用户会确认下去，然后一直等一个不会来的提醒。
   */
  it('组内条件自相矛盾（≤8.2 且 ≥9）→ 整组丢弃', () => {
    const out = parseWatchSuggestions(
      block(`metric=PRICE op=LTE threshold=8.2 组=1
metric=PRICE op=GTE threshold=9 组=1`)
    )
    expect(out).toEqual([])
  })

  it('判断行照样套到每个组上', () => {
    const out = parseWatchSuggestions(
      block(`判断=下跌
metric=PRICE op=LTE threshold=8.2 组=1
metric=rsi op=LTE threshold=30 组=1`)
    )
    expect(out[0]?.verdict).toBe('DOWN')
    expect(out[0]?.conditions).toHaveLength(2)
  })
})

describe('判断结论（005_watch_verdict.sql）', () => {
  const block = (body: string): string => `<观察点建议>
${body}
</观察点建议>`

  it('独占一行的「判断=」归一化后套到该块的每条建议上', () => {
    const out = parseWatchSuggestions(
      block(`判断=上涨
metric=PRICE op=LTE threshold=8.2
metric=rsi op=GTE threshold=70`)
    )
    expect(out).toHaveLength(2)
    expect(out.every((s) => s.verdict === 'UP')).toBe(true)
    expect(out[0]?.verdictText).toBe('上涨')
  })

  it('归不了类时 verdict 留空、但原文照存 —— 认不出不是错误，猜才是', () => {
    // 「继续走高一线」不在白名单里。硬归成 UP 会让用户在观察点列表上
    // 看到一个他从没确认过的方向，而他多半不会去核对
    const out = parseWatchSuggestions(block(`判断=后市有待观察一线
metric=PRICE op=LTE threshold=8.2`))
    expect(out[0]?.verdict).toBeUndefined()
    expect(out[0]?.verdictText).toBe('后市有待观察一线')
  })

  it('说不清方向的说法归到 RANGE，不许被「上行」二字带成 UP', () => {
    const out = parseWatchSuggestions(block(`判断=震荡上行
metric=PRICE op=LTE threshold=8.2`))
    expect(out[0]?.verdict).toBe('RANGE')
  })

  it('没有判断行时观察点照样能建 —— 它是可选的', () => {
    const out = parseWatchSuggestions(block('metric=PRICE op=LTE threshold=8.2'))
    expect(out).toHaveLength(1)
    expect(out[0]?.verdict).toBeUndefined()
    expect(out[0]?.verdictText).toBeUndefined()
  })

  it('判断行本身不会被当成一条建议', () => {
    const out = parseWatchSuggestions(block(`判断=下跌
metric=PRICE op=LTE threshold=8.2`))
    expect(out).toHaveLength(1)
    expect(out[0]?.verdict).toBe('DOWN')
  })

  it('原文截到 40 字 —— 模型会把整段正文塞进来', () => {
    const long = '很'.repeat(80)
    const out = parseWatchSuggestions(block(`判断=${long}
metric=PRICE op=LTE threshold=8.2`))
    expect(out[0]?.verdictText).toHaveLength(40)
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
