/**
 * 公告拉取的编排与解析（docs/11 N2）。
 *
 * 钉的都是**从界面上看不出来的错**：
 *
 *   1. **内置行业 ETF 混进请求** —— 15 只观察标的的基金公告会把 7 只真持仓埋掉；
 *   2. **没有原文链接的条目入了库** —— 「每条都能点回原文」是本功能唯一的防幻觉结构保证；
 *   3. **失败被显示成「今天没有公告」** —— 等于替一个没查过的范围担保；
 *   4. **数据源混进未点名的票** —— 用户看到一堆与自己无关的公司；
 *   5. **时刻按本机时区解析** —— 在 UTC+7 的机器上整体偏一小时，而这不会报任何错。
 */

import { describe, expect, it } from 'vitest'
import { fetchAnnouncements, isStorable } from '@main/engine/announcements'
import { parseAnnounceStamp, parseAnnouncements, resolveAnnounceCode } from '@main/providers/eastmoney'
import type { Announcement } from '@main/providers/types'
import type { SecCode, TradeDate } from '@core/types'

const NOW = 1_760_000_000_000
const SINCE = NOW - 86_400_000
const ETF_GROUP = '行业ETF'

function ann(over: Partial<Announcement> = {}): Announcement {
  return {
    id: 'AN001',
    code: 'SH600000' as SecCode,
    name: '浦发银行',
    title: '董事会决议公告',
    category: '董事会决议公告',
    publishedAt: NOW - 3600_000,
    noticeDate: '2026-08-15' as TradeDate,
    url: 'https://data.eastmoney.com/notices/detail/600000/AN001.html',
    ...over,
  }
}

const ITEMS = [
  { code: 'SH600000' as SecCode, group: '自选' },
  { code: 'SZ000001' as SecCode, group: '自选' },
  { code: 'SH512800' as SecCode, group: ETF_GROUP },
  { code: 'SH512880' as SecCode, group: ETF_GROUP },
]

describe('fetchAnnouncements', () => {
  it('内置行业 ETF 在**请求之前**就摘掉 —— 摘晚了等于白发一次请求', async () => {
    let asked: SecCode[] = []
    await fetchAnnouncements({
      items: ITEMS,
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async (codes) => {
        asked = codes
        return []
      },
    })
    expect(asked).toEqual(['SH600000', 'SZ000001'])
  })

  it('用户自己加进「自选」的 ETF 照拉 —— 只摘内置那一组', async () => {
    let asked: SecCode[] = []
    await fetchAnnouncements({
      // 黄金 ETF 被用户放在「自选」里，那是他自己的选择
      items: [{ code: 'SH518880' as SecCode, group: '自选' }, ...ITEMS],
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async (codes) => {
        asked = codes
        return []
      },
    })
    expect(asked).toContain('SH518880')
  })

  it('没有原文链接的条目不入库 —— 这是本功能唯一的防幻觉结构保证', async () => {
    const out = await fetchAnnouncements({
      items: ITEMS,
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async () => [ann(), ann({ id: 'AN002', url: '' })],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.rows.map((r) => r.id)).toEqual(['AN001'])
    expect(out.skipped).toBe(1)
  })

  it('数据源混进未点名的票时丢弃 —— 不能假设它守规矩', async () => {
    const out = await fetchAnnouncements({
      items: ITEMS,
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async () => [ann(), ann({ id: 'AN003', code: 'SZ300750' as SecCode })],
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.rows.map((r) => r.code)).toEqual(['SH600000'])
    expect(out.skipped).toBe(1)
  })

  it('失败是一等结果，不是「今天没有公告」', async () => {
    const out = await fetchAnnouncements({
      items: ITEMS,
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async () => {
        throw new Error('other side closed')
      },
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('other side closed')
  })

  it('一只自选都没有时不发请求，也不报错', async () => {
    let called = false
    const out = await fetchAnnouncements({
      items: [{ code: 'SH512800' as SecCode, group: ETF_GROUP }],
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async () => {
        called = true
        return []
      },
    })
    expect(called).toBe(false)
    expect(out).toEqual({ ok: true, rows: [], skipped: 0 })
  })

  it('同一批里重复的 id 只留一条（翻页边界会重叠）', async () => {
    const out = await fetchAnnouncements({
      items: ITEMS,
      etfGroup: ETF_GROUP,
      sinceMs: SINCE,
      now: NOW,
      provider: 'eastmoney',
      fetch: async () => [ann(), ann()],
    })
    expect(out.ok && out.rows.length).toBe(1)
  })
})

describe('isStorable', () => {
  it('链接是硬条件', () => {
    expect(isStorable(ann())).toBe(true)
    expect(isStorable(ann({ url: '' }))).toBe(false)
    expect(isStorable(ann({ title: '' }))).toBe(false)
    expect(isStorable(ann({ id: '' }))).toBe(false)
    expect(isStorable(ann({ publishedAt: Number.NaN }))).toBe(false)
  })
})

describe('parseAnnounceStamp', () => {
  it('按北京时间解析，不看本机时区', () => {
    // 2026-08-14 17:30:24 +08:00 === 2026-08-14T09:30:24Z
    expect(parseAnnounceStamp('2026-08-14 17:30:24:703')).toBe(Date.UTC(2026, 7, 14, 9, 30, 24))
  })

  it('**Date.parse 不会报错，只会给一个偏掉的时刻** —— 这才是要防的那件事', () => {
    const raw = '2026-08-14 17:30:24:703'
    // V8 对这个格式是宽容的：不是 NaN，所以「用错了会崩」这条指望不上
    expect(Number.isNaN(Date.parse(raw))).toBe(false)
    // 但它按本机时区解析。只在非 +08 的机器上能看出差别 —— 本机 UTC+7 时差一小时。
    // 断言写成「与正确值的差恰好等于本机与北京的时差」，这样它在任何时区的机器上都成立
    const offsetFromShanghaiMs = (new Date().getTimezoneOffset() + 8 * 60) * 60_000
    expect(Date.parse(raw) - (parseAnnounceStamp(raw) ?? 0)).toBe(offsetFromShanghaiMs + 703)
  })

  it('形状不对给 null，不猜', () => {
    expect(parseAnnounceStamp('')).toBeNull()
    expect(parseAnnounceStamp('2026-08-14')).toBeNull()
  })
})

describe('resolveAnnounceCode', () => {
  /**
   * 这一组钉的是 2026-08-15 实测踩到的真 bug：
   * SH 的代码段表里有 `['000','INDEX']`，所以「SH 优先逐个试」会把整个深市 000 段
   * 判成上证指数，公告随后被编排层当成「未点名的票」丢掉，界面上完全看不出来。
   */
  it('深市 000 段不许判成上证指数段', () => {
    expect(resolveAnnounceCode('000157', 'A,SZA')).toBe('SZ000157')
    expect(resolveAnnounceCode('000001', 'A,SZA')).toBe('SZ000001')
    // 连 ann_type 都没有时也要对 —— 靠 parseCode 的「指数段排除在推断之外」
    expect(resolveAnnounceCode('000157', '')).toBe('SZ000157')
    expect(resolveAnnounceCode('000001', '')).toBe('SZ000001')
  })

  it('沪深京三市与创业板都认得', () => {
    expect(resolveAnnounceCode('600660', 'A,SHA')).toBe('SH600660')
    expect(resolveAnnounceCode('300750', 'A,CYB')).toBe('SZ300750')
    expect(resolveAnnounceCode('430047', 'A,BJA')).toBe('BJ430047')
    expect(resolveAnnounceCode('002594', '')).toBe('SZ002594')
  })

  it('认不出来给 null，不猜一个', () => {
    expect(resolveAnnounceCode('999999', '')).toBeNull()
    expect(resolveAnnounceCode('', 'A,SHA')).toBeNull()
  })
})

describe('parseAnnouncements', () => {
  /** 形状取自 2026-08-15 的真实响应（scripts/probe-announcements.mjs） */
  const body = JSON.stringify({
    data: {
      list: [
        {
          art_code: 'AN202608141827991662',
          title: '浦发银行:上海浦东发展银行股份有限公司董事会2026年第八次会议决议公告',
          display_time: '2026-08-14 18:54:17:297',
          notice_date: '2026-08-15 00:00:00',
          codes: [{ stock_code: '600000', short_name: '浦发银行', ann_type: 'A,SHA' }],
          columns: [{ column_code: '001002009', column_name: '董事会决议公告' }],
        },
        // 没有 columns → category 必须是 null，不是「其他」
        {
          art_code: 'AN2',
          title: '某公告',
          display_time: '2026-08-14 16:15:22:215',
          notice_date: '2026-08-15 00:00:00',
          codes: [{ stock_code: '000001', short_name: '平安银行', ann_type: 'A,SZA' }],
        },
        // 缺 art_code → 跳过这一条，不让整页作废
        { title: '坏行', display_time: '2026-08-14 10:00:00:000', codes: [{ stock_code: '600000' }] },
      ],
    },
  })

  it('解析出内部代码、分类与两个时刻', () => {
    const rows = parseAnnouncements(body)
    expect(rows).toHaveLength(2)
    const first = rows[0]
    expect(first?.code).toBe('SH600000')
    expect(first?.category).toBe('董事会决议公告')
    expect(first?.noticeDate).toBe('2026-08-15')
    expect(first?.publishedAt).toBe(Date.UTC(2026, 7, 14, 10, 54, 17))
    expect(first?.url).toContain('AN202608141827991662')
  })

  it('拿不到分类给 null —— 猜一个出来会让下游白名单命中不存在的类型', () => {
    expect(parseAnnouncements(body)[1]?.category).toBeNull()
  })

  it('两个时刻不是同一个：display_time 在 08-14 傍晚，notice_date 是 08-15', () => {
    const row = parseAnnouncements(body)[0]
    // 按 notice_date 切窗口会把昨晚 18:54 发的公告算成今天发的
    expect(row?.noticeDate).toBe('2026-08-15')
    expect(new Date(row?.publishedAt ?? 0).toISOString()).toContain('2026-08-14')
  })

  it('坏行跳过而不是抛错 —— 一条脏数据不该让今天一条公告都看不到', () => {
    expect(parseAnnouncements(body).map((r) => r.id)).toEqual(['AN202608141827991662', 'AN2'])
  })

  it('不是 JSON 时抛错（那是接口变了，必须让人知道）', () => {
    expect(() => parseAnnouncements('<html>502</html>')).toThrow()
  })

  it('list 缺席时返回空数组 —— 「没有公告」是常态，不是错误', () => {
    expect(parseAnnouncements(JSON.stringify({ data: null }))).toEqual([])
  })
})
