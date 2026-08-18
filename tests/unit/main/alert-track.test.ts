import { describe, expect, it } from 'vitest'
import { alertTrackOf } from '@main/alerts/track'
import { INDUSTRY_ETF_GROUP } from '@shared/industry-etf'

/**
 * 走哪条提醒轨（docs/05 §3.2）。判据只有两个输入，但它管的是
 * 「跌破止损那一条会不会弹气泡」——`OBSERVE` 轨日配额只有 2 条且抢不到气泡。
 *
 * 第二条用例是 2026-08-18 加的那个例外，**也是这个文件存在的理由**：
 * 行业 ETF 现在可以真的建仓，留在 OBSERVE 轨的持仓会静默地漏掉止损提醒，
 * 而少发的错误用户发现不了。
 */
describe('alertTrackOf', () => {
  it('无持仓的行业ETF 走 OBSERVE（观察名单，独立配额、不抢气泡）', () => {
    expect(alertTrackOf(INDUSTRY_ETF_GROUP, false, INDUSTRY_ETF_GROUP)).toBe('OBSERVE')
  })

  it('**有持仓就翻回 PRIMARY** —— 持仓的止损不能留在只有 2 条日配额的轨上', () => {
    expect(alertTrackOf(INDUSTRY_ETF_GROUP, true, INDUSTRY_ETF_GROUP)).toBe('PRIMARY')
  })

  it('自选股恒 PRIMARY，有没有持仓都一样', () => {
    expect(alertTrackOf('自选', false, INDUSTRY_ETF_GROUP)).toBe('PRIMARY')
    expect(alertTrackOf('自选', true, INDUSTRY_ETF_GROUP)).toBe('PRIMARY')
  })

  it('查不到分组（空串）按自选股待遇 —— 宁可多提醒，也不静默一只不认识的标的', () => {
    expect(alertTrackOf('', false, INDUSTRY_ETF_GROUP)).toBe('PRIMARY')
  })
})
