import { describe, expect, it } from 'vitest'
import {
  isSTName,
  normalizeCode,
  parseCode,
  priceDigits,
  priceLimitRatio,
  priceLimits,
  roundToTick,
  splitCode,
} from '@core/code'

describe('parseCode', () => {
  it.each([
    ['600000', 'SH600000', 'SH', 'MAIN'],
    ['sh600000', 'SH600000', 'SH', 'MAIN'],
    ['SH600000', 'SH600000', 'SH', 'MAIN'],
    ['600000.SH', 'SH600000', 'SH', 'MAIN'],
    ['600000.sh', 'SH600000', 'SH', 'MAIN'],
    ['  601398 ', 'SH601398', 'SH', 'MAIN'],
    ['688981', 'SH688981', 'SH', 'STAR'],
    ['000001', 'SZ000001', 'SZ', 'MAIN'],
    ['002415', 'SZ002415', 'SZ', 'MAIN'],
    ['300750', 'SZ300750', 'SZ', 'GEM'],
    ['301029', 'SZ301029', 'SZ', 'GEM'],
    ['430047', 'BJ430047', 'BJ', 'BSE'],
    ['830799', 'BJ830799', 'BJ', 'BSE'],
    ['920002', 'BJ920002', 'BJ', 'BSE'],
    ['510300', 'SH510300', 'SH', 'ETF'],
    ['563300', 'SH563300', 'SH', 'ETF'],
    ['588000', 'SH588000', 'SH', 'ETF'],
    ['159915', 'SZ159915', 'SZ', 'ETF'],
    ['160119', 'SZ160119', 'SZ', 'ETF'],
  ])('%s → %s', (input, code, market, board) => {
    const result = parseCode(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ code, market, board, digits: input.trim().replace(/\D/g, '') })
  })

  it('指数必须带显式市场：SH000300 认，裸 000300 按表落到深市主板', () => {
    const index = parseCode('SH000300')
    expect(index.ok && index.value.board).toBe('INDEX')

    const bare = parseCode('000300')
    expect(bare.ok && bare.value).toMatchObject({ code: 'SZ000300', board: 'MAIN' })

    const shenzhenIndex = parseCode('sz399300')
    expect(shenzhenIndex.ok && shenzhenIndex.value.board).toBe('INDEX')
  })

  it.each([
    ['', '代码为空'],
    ['   ', '代码为空'],
    ['60000', '6 位'],
    ['6000001', '6 位'],
    ['abc', '无法识别'],
    ['SH600000.SZ', '冲突'],
    ['SZ600000', '没有'],
    ['SH300750', '没有'],
    ['999999', '无法判断'],
  ])('拒绝 %s', (input, fragment) => {
    const result = parseCode(input)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(fragment)
  })

  it('normalizeCode 把拒绝理由抛成可直接展示的错误', () => {
    expect(normalizeCode('sz000001')).toBe('SZ000001')
    expect(() => normalizeCode('SZ600000')).toThrow(/没有/)
  })

  it('splitCode 对非法输入返回 null 而不是抛错', () => {
    expect(splitCode('SH600000')?.board).toBe('MAIN')
    expect(splitCode('nope')).toBeNull()
  })
})

describe('价格档位与涨跌停', () => {
  it('股票 2 位、基金 3 位', () => {
    expect(priceDigits('MAIN')).toBe(2)
    expect(priceDigits('ETF')).toBe(3)
    expect(roundToTick(10.219000000000001, 'MAIN')).toBe(10.22)
    expect(roundToTick(5.2349, 'ETF')).toBe(5.235)
  })

  it('比例：主板 10%、ST 主板 5%、创业/科创 20%、北交所 30%、ETF 10%、指数无', () => {
    expect(priceLimitRatio('MAIN', false)).toBe(0.1)
    expect(priceLimitRatio('MAIN', true)).toBe(0.05)
    expect(priceLimitRatio('GEM', true)).toBe(0.2)
    expect(priceLimitRatio('STAR', false)).toBe(0.2)
    expect(priceLimitRatio('BSE', false)).toBe(0.3)
    expect(priceLimitRatio('ETF', false)).toBe(0.1)
    expect(priceLimitRatio('INDEX', false)).toBeNull()
  })

  // 期望值取自 2026-08-11 录制的腾讯快照 fixture（字段 47/48），
  // 即：本地算的涨跌停价必须与数据源给的一致，否则说明规则表错了
  it.each([
    [9.29, 'MAIN' as const, false, 10.22, 8.36],
    [393.87, 'GEM' as const, false, 472.64, 315.1],
    [4.759, 'ETF' as const, false, 5.235, 4.283],
  ])('昨收 %s 的涨跌停与数据源一致', (preClose, board, isST, up, down) => {
    expect(priceLimits(preClose, board, isST)).toEqual({ limitUp: up, limitDown: down })
  })

  it('指数、无昨收、非法昨收一律返回 null 而不是 0', () => {
    expect(priceLimits(3800, 'INDEX', false)).toBeNull()
    expect(priceLimits(0, 'MAIN', false)).toBeNull()
    expect(priceLimits(Number.NaN, 'MAIN', false)).toBeNull()
  })

  it('ST 从名称判', () => {
    expect(isSTName('*ST 长动')).toBe(true)
    expect(isSTName('ST沪科')).toBe(true)
    expect(isSTName('浦发银行')).toBe(false)
  })
})
