import { describe, expect, it } from 'vitest'
import { canReorderWatch, reorderWatchItems, splitWatchItems, watchTabOf } from '@shared/watch-split'
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

/**
 * 拖动排序（2026-08-24）。渲染层没有测试，所以「能不能拖」「拖到哪」全钉在这里。
 */
describe('reorderWatchItems', () => {
  const row = (code: string, hasPosition = false): { code: SecCode; hasPosition: boolean } => ({
    code: code as SecCode,
    hasPosition,
  })
  const codes = (rows: readonly { code: SecCode }[] | null): string[] | null =>
    rows ? rows.map((r) => r.code) : null

  // A B C D 四只同段（都在个股屏、都无持仓）
  const four = [row('SH600000'), row('SZ000001'), row('SZ300750'), row('SH601318')]

  it('往下拖：落在目标之后', () => {
    expect(codes(reorderWatchItems(four, 'SH600000' as SecCode, 'SZ300750' as SecCode))).toEqual([
      'SZ000001',
      'SZ300750',
      'SH600000',
      'SH601318',
    ])
  })

  it('往上拖：落在目标之前', () => {
    expect(codes(reorderWatchItems(four, 'SH601318' as SecCode, 'SZ000001' as SecCode))).toEqual([
      'SH600000',
      'SH601318',
      'SZ000001',
      'SZ300750',
    ])
  })

  /**
   * 这一条是落点语义的锚：拖到相邻那一行上，必须与点一次上移/下移**逐位相同**。
   * 「一律插在目标之前」的写法会让往下拖一格变成原地不动 —— 表现是「拖了没反应」。
   */
  it('拖到相邻一行 = 上移/下移一次', () => {
    expect(codes(reorderWatchItems(four, 'SH600000' as SecCode, 'SZ000001' as SecCode))).toEqual([
      'SZ000001',
      'SH600000',
      'SZ300750',
      'SH601318',
    ])
    expect(codes(reorderWatchItems(four, 'SZ000001' as SecCode, 'SH600000' as SecCode))).toEqual([
      'SZ000001',
      'SH600000',
      'SZ300750',
      'SH601318',
    ])
  })

  it('跨持仓边界一律拒绝 —— 持仓优先是派生的事实，不是能拖出来的状态', () => {
    const items = [row('SH600000', true), row('SZ000001'), row('SZ300750')]
    expect(reorderWatchItems(items, 'SZ300750' as SecCode, 'SH600000' as SecCode)).toBeNull()
    expect(reorderWatchItems(items, 'SH600000' as SecCode, 'SZ000001' as SecCode)).toBeNull()
  })

  it('跨屏一律拒绝：股票拖不到 ETF 屏里去', () => {
    const items = [row('SH600000'), row('SH512800')]
    expect(reorderWatchItems(items, 'SH600000' as SecCode, 'SH512800' as SecCode)).toBeNull()
  })

  it('拖回自己、或代码不在列表里 → null', () => {
    expect(reorderWatchItems(four, 'SH600000' as SecCode, 'SH600000' as SecCode)).toBeNull()
    expect(reorderWatchItems(four, 'SH600000' as SecCode, 'SH999999' as SecCode)).toBeNull()
  })

  /**
   * 只重排那一段占的下标，别的行一个都不挪 —— 否则「在 ETF 屏拖一下」会把
   * 个股屏的顺序也搅了，而用户在另一屏上根本看不到自己改了什么。
   */
  it('只动本段：另一屏与另一段的行原地不动', () => {
    const items = [
      row('SH600000'), // 个股·无持仓
      row('SH512800'), // ETF·无持仓
      row('SZ000001', true), // 个股·持仓
      row('SZ300750'), // 个股·无持仓
      row('SZ159755'), // ETF·无持仓
      row('SH601318'), // 个股·无持仓
    ]
    // 把 SH601318 拖到 SH600000 上（同段：个股·无持仓）
    expect(codes(reorderWatchItems(items, 'SH601318' as SecCode, 'SH600000' as SecCode))).toEqual([
      'SH601318',
      'SH512800', // 另一屏，下标没动
      'SZ000001', // 另一段，下标没动
      'SH600000',
      'SZ159755', // 另一屏，下标没动
      'SZ300750',
    ])
  })

  it('新顺序过一遍 splitWatchItems 就是屏上看到的样子', () => {
    const items = [row('SH600000', true), row('SZ000001'), row('SZ300750'), row('SH601318')]
    const next = reorderWatchItems(items, 'SH601318' as SecCode, 'SZ000001' as SecCode)
    expect(next).not.toBeNull()
    expect(splitWatchItems(next ?? []).stock.map((r) => r.code)).toEqual([
      'SH600000', // 持仓仍然在最前
      'SH601318',
      'SZ000001',
      'SZ300750',
    ])
  })

  it('不改入参', () => {
    const snapshot = four.map((r) => r.code)
    reorderWatchItems(four, 'SH600000' as SecCode, 'SH601318' as SecCode)
    expect(four.map((r) => r.code)).toEqual(snapshot)
  })
})

describe('canReorderWatch', () => {
  const row = (code: string, hasPosition = false): { code: SecCode; hasPosition: boolean } => ({
    code: code as SecCode,
    hasPosition,
  })

  it('同段可以，跨段/自己/缺失都不行', () => {
    expect(canReorderWatch(row('SH600000'), row('SZ000001'))).toBe(true)
    expect(canReorderWatch(row('SH512800'), row('SZ159755'))).toBe(true)
    expect(canReorderWatch(row('SH600000'), row('SH512800'))).toBe(false)
    expect(canReorderWatch(row('SH600000'), row('SZ000001', true))).toBe(false)
    expect(canReorderWatch(row('SH600000'), row('SH600000'))).toBe(false)
    expect(canReorderWatch(row('SH600000'), undefined)).toBe(false)
    expect(canReorderWatch(undefined, row('SH600000'))).toBe(false)
  })
})
