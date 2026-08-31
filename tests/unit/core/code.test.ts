import { describe, expect, it } from 'vitest'
import {
  MAIN_ST_LIMIT_WIDENED_ON,
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

  it('比例：主板 10%、创业/科创 20%、北交所 30%、ETF 10%、指数无', () => {
    const day = '2026-08-31'
    expect(priceLimitRatio('MAIN', false, day)).toBe(0.1)
    expect(priceLimitRatio('GEM', true, day)).toBe(0.2)
    expect(priceLimitRatio('STAR', false, day)).toBe(0.2)
    expect(priceLimitRatio('BSE', false, day)).toBe(0.3)
    expect(priceLimitRatio('ETF', false, day)).toBe(0.1)
    expect(priceLimitRatio('INDEX', false, day)).toBeNull()
  })

  /**
   * 主板 ST 的涨跌幅有**生效日**：2026-07-06 起由 ±5% 放宽到 ±10%
   * （上交所/深交所《交易规则（2026 年修订）》，见 code.ts `MAIN_ST_LIMIT_WIDENED_ON`）。
   *
   * 这一组钉三件事，少一条都会让缺陷悄悄回来：
   *   1. **生效日两侧**（07-03 与 07-06）结论不同 —— 这是「按日期分档」真的生效的唯一证据；
   *   2. **生效日当天算新规则**（不是次日）；
   *   3. **只有主板受影响** —— 创业板/科创板 ST 仍 20%、北交所仍 30%，
   *      两侧逐位相同。写死 0.05 那个版本在第 1 条上失败，
   *      而「顺手把所有板块都改成按日期」的版本在第 3 条上失败。
   */
  it('主板 ST 的涨跌幅按 2026-07-06 分档，且只有主板受影响', () => {
    expect(MAIN_ST_LIMIT_WIDENED_ON).toBe('2026-07-06')
    // 1 + 2：生效日两侧
    expect(priceLimitRatio('MAIN', true, '2026-07-03')).toBe(0.05)
    expect(priceLimitRatio('MAIN', true, '2026-07-06')).toBe(0.1)
    expect(priceLimitRatio('MAIN', true, '2026-08-31')).toBe(0.1)
    // 3：其他板块两侧逐位相同
    for (const day of ['2026-07-03', '2026-07-06']) {
      expect(priceLimitRatio('GEM', true, day)).toBe(0.2)
      expect(priceLimitRatio('STAR', true, day)).toBe(0.2)
      expect(priceLimitRatio('BSE', true, day)).toBe(0.3)
      expect(priceLimitRatio('ETF', true, day)).toBe(0.1)
    }
    // 非 ST 的主板从来是 10%，不受生效日影响
    expect(priceLimitRatio('MAIN', false, '2026-07-03')).toBe(0.1)
  })

  it('涨跌停价跟着生效日走：同一只主板 ST，07-06 之后的涨停价整个变了', () => {
    // 昨收 10.00：旧规则 ±5% ⇒ 10.50 / 9.50；新规则 ±10% ⇒ 11.00 / 9.00
    expect(priceLimits(10, 'MAIN', true, '2026-07-03')).toEqual({ limitUp: 10.5, limitDown: 9.5 })
    expect(priceLimits(10, 'MAIN', true, '2026-07-06')).toEqual({ limitUp: 11, limitDown: 9 })
  })

  // 期望值取自 2026-08-11 录制的腾讯快照 fixture（字段 47/48），
  // 即：本地算的涨跌停价必须与数据源给的一致，否则说明规则表错了
  it.each([
    [9.29, 'MAIN' as const, false, 10.22, 8.36],
    [393.87, 'GEM' as const, false, 472.64, 315.1],
    [4.759, 'ETF' as const, false, 5.235, 4.283],
  ])('昨收 %s 的涨跌停与数据源一致', (preClose, board, isST, up, down) => {
    expect(priceLimits(preClose, board, isST, '2026-08-11')).toEqual({ limitUp: up, limitDown: down })
  })

  it('指数、无昨收、非法昨收一律返回 null 而不是 0', () => {
    expect(priceLimits(3800, 'INDEX', false, '2026-08-31')).toBeNull()
    expect(priceLimits(0, 'MAIN', false, '2026-08-31')).toBeNull()
    expect(priceLimits(Number.NaN, 'MAIN', false, '2026-08-31')).toBeNull()
  })

  it('ST 从名称判', () => {
    expect(isSTName('*ST 长动')).toBe(true)
    expect(isSTName('ST沪科')).toBe(true)
    expect(isSTName('浦发银行')).toBe(false)
  })
})
