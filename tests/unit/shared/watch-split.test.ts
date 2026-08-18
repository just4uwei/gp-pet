import { describe, expect, it } from 'vitest'
import { splitWatchItems, watchTabOf } from '@shared/watch-split'
import { INDUSTRY_ETFS } from '@shared/industry-etf'
import type { SecCode } from '@core/types'

/**
 * 面板左栏两屏的判据（2026-08-18）。渲染层没有测试，所以这三件事全钉在这里：
 * 谁进哪一屏、谁排前面、以及**段内保序**。
 */
describe('watchTabOf', () => {
  it('场内基金进 ETF 屏：SH 的 51/56/58 段与 SZ 的 15/16 段', () => {
    for (const code of ['SH512800', 'SH510300', 'SH563000', 'SH588000', 'SZ159755', 'SZ161725']) {
      expect(watchTabOf(code as SecCode), code).toBe('ETF')
    }
  })

  it('股票进个股屏：主板 / 创业板 / 科创板 / 北交所', () => {
    for (const code of ['SH600000', 'SZ000001', 'SZ300750', 'SH688111', 'BJ430047']) {
      expect(watchTabOf(code as SecCode), code).toBe('STOCK')
    }
  })

  it('内置的 15 只行业 ETF 全都落在 ETF 屏 —— 少一只就是一只票从界面上消失', () => {
    for (const etf of INDUSTRY_ETFS) {
      expect(watchTabOf(etf.code), etf.code).toBe('ETF')
    }
  })

  it('认不出的代码归个股屏，不额外造一屏', () => {
    // 理论上进不了自选（IPC 入口会拒），但兜底不许让它凭空消失
    expect(watchTabOf('' as SecCode)).toBe('STOCK')
    expect(watchTabOf('SH999999' as SecCode)).toBe('STOCK')
  })
})

describe('splitWatchItems', () => {
  const row = (code: string, hasPosition = false): { code: SecCode; hasPosition: boolean } => ({
    code: code as SecCode,
    hasPosition,
  })

  it('按板块拆两屏', () => {
    const { stock, etf } = splitWatchItems([
      row('SH600000'),
      row('SH512800'),
      row('SZ300750'),
      row('SZ159755'),
    ])
    expect(stock.map((r) => r.code)).toEqual(['SH600000', 'SZ300750'])
    expect(etf.map((r) => r.code)).toEqual(['SH512800', 'SZ159755'])
  })

  it('两屏都持仓优先 —— ETF 屏 2026-08-18 起也排', () => {
    const { stock, etf } = splitWatchItems([
      row('SH600000'),
      row('SZ000001', true),
      row('SH512800'),
      row('SZ159755', true),
    ])
    expect(stock.map((r) => r.code)).toEqual(['SZ000001', 'SH600000'])
    expect(etf.map((r) => r.code)).toEqual(['SZ159755', 'SH512800'])
  })

  /**
   * 这一条是全文件最重要的：**段内必须保持入参顺序**（= 用户用上移/下移排出来的
   * 全局 `sort_order`）。整个重排会把那两个按钮的成果抹掉，而用户只会看到
   * 「我排好的顺序自己变回去了」。
   */
  it('段内保持入参顺序', () => {
    const { stock } = splitWatchItems([
      row('SZ000001'),
      row('SH600000', true),
      row('SH601318'),
      row('SZ300750', true),
      row('SH603259'),
    ])
    expect(stock.map((r) => r.code)).toEqual([
      'SH600000',
      'SZ300750', // 持仓段：入参里谁在前谁还在前
      'SZ000001',
      'SH601318',
      'SH603259', // 无持仓段：同上
    ])
  })

  it('不改入参', () => {
    const items = [row('SH600000'), row('SH512800', true)]
    const snapshot = items.map((r) => r.code)
    splitWatchItems(items)
    expect(items.map((r) => r.code)).toEqual(snapshot)
  })

  it('空列表给两个空数组', () => {
    expect(splitWatchItems([])).toEqual({ stock: [], etf: [] })
  })
})
