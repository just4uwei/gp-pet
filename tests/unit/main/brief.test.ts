/**
 * 盘前简报的事实层（`src/main/brief/build.ts`，docs/11 N3）。
 *
 * 钉四类**从界面上看不出来的错**：
 *
 *   1. **失败被显示成「今天没有公告」** —— 等于替一个从来没查过的范围担保；
 *   2. **「建议先看」被当成过滤器** —— 藏起来的那些正是用户可能真正关心的；
 *   3. **没有原文链接的条目混进去** —— 「每条都能点回原文」是本功能唯一的防幻觉结构保证；
 *   4. **措辞** —— lines 是陈述不是评价，且绝不能出现「今日无异常」。
 */

import { describe, expect, it } from 'vitest'
import { buildDailyBrief, isSpotlight, linesOf } from '@main/brief/build'
import { FORBIDDEN_WORDS } from '@main/ai/prompt'
import type { AnnouncementView } from '@shared/ipc-types'
import type { SecCode, TradeDate } from '@core/types'

const DATE = '2026-08-17' as TradeDate
const AT = 1_760_000_000_000

function ann(over: Partial<AnnouncementView> = {}): AnnouncementView {
  return {
    id: 'AN001',
    code: 'SH600000' as SecCode,
    name: '浦发银行',
    title: '董事会决议公告',
    category: '董事会决议公告',
    publishedAt: AT - 3600_000,
    noticeDate: DATE,
    url: 'https://data.eastmoney.com/notices/detail/600000/AN001.html',
    ...over,
  }
}

const ITEMS = [
  { code: 'SH600000' as SecCode, name: '浦发银行', hasPosition: false },
  { code: 'SZ000001' as SecCode, name: '平安银行', hasPosition: true },
  { code: 'SZ002594' as SecCode, name: '比亚迪', hasPosition: false },
]

function build(announcements: AnnouncementView[], fetchError?: string) {
  return buildDailyBrief({
    date: DATE,
    at: AT,
    items: ITEMS,
    announcements,
    ...(fetchError === undefined ? {} : { fetchError }),
  })
}

describe('buildDailyBrief', () => {
  it('只列有公告的票；一条都没有时 stocks 为空而不是塞满空壳', () => {
    const brief = build([ann()])
    expect(brief.stocks.map((s) => s.code)).toEqual(['SH600000'])
    expect(brief.counts).toEqual({ stocks: 1, total: 1, spotlight: 0 })
  })

  it('持仓票排在前面 —— 它对用户的实际影响更大', () => {
    const brief = build([ann(), ann({ id: 'B', code: 'SZ000001' as SecCode })])
    expect(brief.stocks.map((s) => s.code)).toEqual(['SZ000001', 'SH600000'])
  })

  it('同为非持仓时，「建议先看」条数多的排前面', () => {
    const brief = build([
      ann({ id: 'A1', code: 'SH600000' as SecCode, category: '董事会决议公告' }),
      ann({ id: 'A2', code: 'SH600000' as SecCode, category: '关联交易' }),
      ann({ id: 'B1', code: 'SZ002594' as SecCode, category: '股东/实际控制人股份减持' }),
    ])
    // 比亚迪只有 1 条但命中白名单；浦发 2 条都没命中
    expect(brief.stocks.map((s) => s.code)).toEqual(['SZ002594', 'SH600000'])
  })

  it('**白名单只标记不过滤** —— 没命中的照样列出来', () => {
    const brief = build([
      ann({ id: 'A', category: '股东/实际控制人股份减持' }),
      ann({ id: 'B', category: '关联交易' }),
    ])
    const items = brief.stocks[0]?.items ?? []
    expect(items).toHaveLength(2)
    expect(items.filter((i) => i.spotlight)).toHaveLength(1)
  })

  it('没有原文链接的条目不进简报', () => {
    const brief = build([ann(), ann({ id: 'B', url: '' })])
    expect(brief.counts.total).toBe(1)
    expect(brief.stocks[0]?.items.every((i) => i.url !== '')).toBe(true)
  })

  it('同一只票的条目新到旧，并列时按 id 定序（顺序抖动的列表读起来像在闪）', () => {
    const mk = (): string[] =>
      build([
        ann({ id: 'old', publishedAt: AT - 7200_000 }),
        ann({ id: 'b', publishedAt: AT }),
        ann({ id: 'a', publishedAt: AT }),
      ]).stocks[0]!.items.map((i) => i.id)
    expect(mk()).toEqual(['a', 'b', 'old'])
    expect(mk()).toEqual(mk())
  })

  it('取数失败时带上 fetchError，且**不许**说成「今天没有公告」', () => {
    const brief = build([], 'other side closed')
    expect(brief.fetchError).toBe('other side closed')
    const text = brief.lines.join('\n')
    expect(text).toContain('没能取到公告')
    expect(text).not.toContain('无新公告')
  })

  it('拿不到分类时 category 是 null，且不算命中白名单', () => {
    const brief = build([ann({ category: null })])
    expect(brief.stocks[0]?.items[0]?.category).toBeNull()
    expect(brief.stocks[0]?.items[0]?.spotlight).toBe(false)
  })
})

describe('isSpotlight', () => {
  /**
   * 下面每一个分类名都取自 2026-08-16 的真实抽样（4500 条 / 175 个分类），
   * **不是编出来的** —— 编一个不存在的分类名，用例会绿而线上永远不命中。
   */
  it('命中的是数据源给的**完整分类名**，不是子串', () => {
    expect(isSpotlight('股份质押、冻结')).toBe(true)
    expect(isSpotlight('股东/实际控制人股份减持')).toBe(true)
    expect(isSpotlight('诉讼仲裁')).toBe(true)
    expect(isSpotlight('停牌公告')).toBe(true)
    // 子串写法会命中的，现在不命中
    expect(isSpotlight('股东减持')).toBe(false)
    expect(isSpotlight('关于收到监管关注函的公告')).toBe(false)
  })

  it('**担保类全部不命中** —— 它是原写法最大的误报源（实测占 2.6%）', () => {
    expect(isSpotlight('提供/对外担保公告')).toBe(false)
    expect(isSpotlight('其他担保公告')).toBe(false)
    expect(isSpotlight('担保年度额度预计')).toBe(false)
    expect(isSpotlight('追加担保公告')).toBe(false)
  })

  it('发行流程的「问询与回复」不命中，交易所问询函的回复命中 —— 精确匹配才分得开', () => {
    expect(isSpotlight('创业板IPO问询与回复')).toBe(false)
    expect(isSpotlight('创业板再融资问询与回复')).toBe(false)
    expect(isSpotlight('回复问询函公告')).toBe(true)
  })

  it('程序性的进展类不命中', () => {
    expect(isSpotlight('回购进展情况')).toBe(false)
    expect(isSpotlight('募集资金使用情况报告')).toBe(false)
    expect(isSpotlight('董事会决议公告')).toBe(false)
    expect(isSpotlight('召开股东大会通知')).toBe(false)
    expect(isSpotlight('法律意见书')).toBe(false)
  })

  it('**「股票交易异常波动」不命中** —— 它是价格已经动过的结果，不是原因', () => {
    expect(isSpotlight('股票交易异常波动')).toBe(false)
  })

  it('原先漏报的几类现在命中了', () => {
    expect(isSpotlight('重组进展公告')).toBe(true)
    expect(isSpotlight('终止上市风险提示')).toBe(true)
    expect(isSpotlight('警示函公告')).toBe(true)
    expect(isSpotlight('限售股份上市流通')).toBe(true)
  })

  it('撤销风险警示也命中 —— 再次说明这张表不是方向判据', () => {
    expect(isSpotlight('申请撤销风险警示及特别处理')).toBe(true)
  })

  it('未知分类默认不高亮（安全的失败方向：那一条照样列出，只是不带标记）', () => {
    expect(isSpotlight('数据源明年新加的某个分类')).toBe(false)
    expect(isSpotlight(null)).toBe(false)
    expect(isSpotlight('')).toBe(false)
  })
})

describe('linesOf', () => {
  it('每一句都能从计数里逐字推出', () => {
    expect(linesOf({ watchCount: 7, stocks: 2, total: 5, spotlight: 1 })).toEqual([
      '7 只自选中 2 只有新公告，共 5 条。',
      '其中 1 条属于建议先看的类型。',
    ])
  })

  it('没有公告时说「无新公告」，**不说「今日无异常」**', () => {
    const text = linesOf({ watchCount: 7, stocks: 0, total: 0, spotlight: 0 }).join('\n')
    expect(text).toBe('7 只自选，今日无新公告。')
    // 本功能只覆盖公告这一类，说成「无异常」是替一个没查过的范围担保
    expect(text).not.toContain('无异常')
    expect(text).not.toContain('平安')
  })

  it('失败时只说失败，不顺带说「没有公告」', () => {
    const text = linesOf({ watchCount: 7, stocks: 0, total: 0, spotlight: 0, fetchError: '超时' }).join('\n')
    expect(text).toContain('没能取到公告')
    expect(text).not.toContain('无新公告')
  })

  it('是陈述不是评价：不出现禁用词，也不出现好坏判断', () => {
    const text = [
      ...linesOf({ watchCount: 7, stocks: 3, total: 9, spotlight: 4 }),
      ...linesOf({ watchCount: 7, stocks: 0, total: 0, spotlight: 0 }),
    ].join('\n')
    for (const w of FORBIDDEN_WORDS) expect(text).not.toContain(w)
    for (const w of ['利好', '利空', '风险', '建议关注', '值得', '不错', '注意']) {
      expect(text).not.toContain(w)
    }
  })
})
