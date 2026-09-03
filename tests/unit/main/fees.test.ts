import { describe, expect, it } from 'vitest'
import { ledgerCosts, solveFromFeeTotal, type FeeRow } from '@main/trades/fees'
import {
  DEFAULT_COSTS,
  STAMP_TAX_HALVED_ON,
  STAMP_TAX_RATE_AFTER,
  STAMP_TAX_RATE_BEFORE,
  TRANSFER_FEE_RATE,
  buyFees,
  sellFees,
} from '../../../src/backtest/costs'
import type { TradeFeeRates } from '@shared/ipc-types'

/**
 * 费率（017）：记账用的成本模型，以及**从券商的累计交易税费反解佣金率**。
 *
 * 反解错了的症状是**全库的成本价一起偏掉**（费率是账户级的），
 * 而用户只有一个可核对的锚点（券商 App 上那笔钱）—— 所以每一条判据都要有用例钉着。
 *
 * ⚠ 目标是「税费」而不是「成本」（2026-09-03 换的，真机逼出来的）：
 * 券商持仓页上那个「成本价」多半是**净成本**（含已实现盈亏），与我们的加权平均成本
 * 根本不是一个数（实测 12.067 vs 12.903）。而「累计交易税费」没有这个歧义。
 */

const BASE: TradeFeeRates = { commissionRate: 0.00025, minCommission: 5 }
/** 免最低那一档（用户勾了「免 5 元最低佣金」时调用方就是这么给的） */
const WAIVED: TradeFeeRates = { ...BASE, minCommission: 0 }

const T0 = 1_700_000_000_000
const DAY = 24 * 3600_000

const row = (side: FeeRow['side'], shares: number, price: number, day = 0): FeeRow => ({
  side,
  shares,
  price,
  fee: 0,
  tradedAt: T0 + day * DAY,
})

/** 单笔 10 万上下的一买一卖 —— 佣金远高于 5 元最低 ⇒ 费率是可辨识的 */
const BIG: FeeRow[] = [row('BUY', 10_000, 10), row('SELL', 10_000, 11)]

function feeUnder(rates: TradeFeeRates, rows = BIG): number {
  const costs = ledgerCosts(rates, '2026-09-03')
  const r2 = (x: number): number => Math.round(x * 100) / 100
  return r2(
    rows.reduce((sum, r) => {
      const amount = r.price * r.shares
      if (r.side === 'BUY') return sum + r2(buyFees(amount, costs))
      if (r.side === 'SELL') return sum + r2(sellFees(amount, costs))
      if (r.side === 'OPENING' && r.feeIncluded === false) return sum + r2(buyFees(amount, costs))
      return sum
    }, 0)
  )
}

describe('ledgerCosts', () => {
  it('**滑点恒为 0** —— 记账绝不套滑点（用户填的就是真实成交价）', () => {
    expect(ledgerCosts(BASE, '2026-09-03').slippage).toBe(0)
    // 刻意不是继承出厂的 0.001：日后谁真在记账里用了滑点，结果是「不偏」而不是静默偏 0.1%
    expect(DEFAULT_COSTS.slippage).toBe(0.001)
  })

  it('券商那两项原样带过去；印花税与过户费**按日期取规则**，不从设置读', () => {
    const rates: TradeFeeRates = { commissionRate: 0.0001, minCommission: 0 }
    expect(ledgerCosts(rates, '2026-09-03')).toEqual({
      commissionRate: 0.0001,
      minCommission: 0,
      stampTaxRate: STAMP_TAX_RATE_AFTER,
      transferFeeRate: TRANSFER_FEE_RATE,
      slippage: 0,
    })
  })

  /**
   * ⚠ 这一条是 2026-09-03 真机抓到的：我们把印花税写死 0.001，
   * 而它 **2023-08-28 起已经减半到 0.0005** ⇒ 用户账本上每一笔卖出都被多扣一倍。
   * 更坏的是它**污染了反解** —— 那 2 倍的误差被整个折算进佣金率。
   */
  it('印花税按生效日分档：2023-08-28 之前千 1、之后千 0.5', () => {
    const rates: TradeFeeRates = { commissionRate: 0.00025, minCommission: 5 }
    expect(ledgerCosts(rates, '2023-08-25').stampTaxRate).toBe(STAMP_TAX_RATE_BEFORE)
    // 生效当天就是新规
    expect(ledgerCosts(rates, STAMP_TAX_HALVED_ON).stampTaxRate).toBe(STAMP_TAX_RATE_AFTER)
    expect(ledgerCosts(rates, '2026-09-03').stampTaxRate).toBe(STAMP_TAX_RATE_AFTER)
    expect(STAMP_TAX_RATE_BEFORE / STAMP_TAX_RATE_AFTER).toBe(2)
  })
})

describe('solveFromFeeTotal', () => {
  it('反解出来的费率能把总费用还原到目标上（往上调）', () => {
    const target = feeUnder({ ...BASE, commissionRate: 0.001 })
    const solved = solveFromFeeTotal({ rows: BIG, board: 'MAIN', base: BASE, targetFeeTotal: target })
    expect(solved.status).toBe('OK')
    expect(solved.rate).toBeCloseTo(0.001, 6)
    expect(solved.feeTotalAt).toBeCloseTo(target, 2)
  })

  it('往下调也解得出（券商比出厂档便宜，这才是常见情形）', () => {
    const target = feeUnder({ ...WAIVED, commissionRate: 0.0001 }, BIG)
    const solved = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: WAIVED,
      targetFeeTotal: target,
    })
    expect(solved.status).toBe('OK')
    expect(solved.rate).toBeCloseTo(0.0001, 6)
  })

  it('落在券商会报出来的整档上（万分之 0.05 的倍数），而不是段的下边界', () => {
    /*
      费用按分取整 ⇒ 同一个总数对应**一整段费率**。取下边界会让反解系统性偏低半段：
      用户的券商报万 1.13，界面写万 1.08，而两个数在这份数据上同样对得上
      —— 那种「对得上但看着不对」最难解释。
    */
    const solved = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: WAIVED,
      targetFeeTotal: feeUnder({ ...WAIVED, commissionRate: 0.000115 }),
    })
    expect(solved.status).toBe('OK')
    expect((solved.rate ?? 0) * 1e4).toBeCloseTo(1.15, 6)
  })

  /**
   * ⚠ 这一条是真机（2026-09-03）逼出来的，是整个设计的分界点。
   *
   * 那个账户**免 5 元最低佣金**，而保留 5 元最低时：即使佣金率归零，8 笔流水的
   * 费用也有 99.56 元，够不到券商给的 85.11 —— **无论怎么解都解不出来**。
   * 所以「免不免最低」必须做成用户勾的开关（一个方程解不了两个未知数），
   * 而且解不出来时那句话要**先指向那个勾**，不是泛泛说「不像费率造成的」。
   */
  it('保留 5 元最低时够不到目标 ⇒ OUT_OF_RANGE，且**先指向那个勾**', () => {
    // 8 笔小额流水：万2.5 下每笔都被 5 元最低盖住
    const many: FeeRow[] = [
      row('BUY', 1000, 10, 0),
      row('SELL', 1000, 10, 1),
      row('BUY', 1000, 10, 2),
      row('SELL', 1000, 10, 3),
    ]
    const reachable = feeUnder({ ...WAIVED, commissionRate: 0.0001 }, many)
    const solved = solveFromFeeTotal({
      rows: many,
      board: 'MAIN',
      base: BASE, // 没勾「免最低」
      targetFeeTotal: reachable,
    })
    expect(solved.status).toBe('OUT_OF_RANGE')
    expect(solved.message).toContain('免 5 元最低佣金')

    // 勾上之后同一个目标就解得出来了 —— 这正是那个开关存在的理由
    const waived = solveFromFeeTotal({
      rows: many,
      board: 'MAIN',
      base: WAIVED,
      targetFeeTotal: reachable,
    })
    expect(waived.status).toBe('OK')
  })

  it('免最低之后每笔都太小 ⇒ 仍然解得出（费用不再对费率免疫）', () => {
    const tiny: FeeRow[] = [row('BUY', 100, 10)]
    const target = feeUnder({ ...WAIVED, commissionRate: 0.0002 }, tiny)
    const solved = solveFromFeeTotal({
      rows: tiny,
      board: 'MAIN',
      base: WAIVED,
      targetFeeTotal: target,
    })
    expect(solved.status).toBe('OK')
  })

  it('保留最低、且每笔都触到最低 ⇒ UNIDENTIFIABLE（费用对费率完全不敏感）', () => {
    // 单笔 500 元：即使佣金率拉到千 5 也只有 2.5 元，永远被 5 元最低盖住
    const tiny: FeeRow[] = [row('BUY', 100, 5), row('BUY', 100, 5, 1)]
    const solved = solveFromFeeTotal({
      rows: tiny,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: 8,
    })
    expect(solved.status).toBe('UNIDENTIFIABLE')
    // 不给一个「差不多能对上」的费率：那会把一个解不出的问题固化成一个荒唐的数
    expect(solved.rate).toBeUndefined()
    expect(solved.message).toContain('免 5 元最低佣金')
  })

  it('目标高到千五佣金都够不着 ⇒ OUT_OF_RANGE，指向漏录的成交', () => {
    const solved = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: feeUnder({ ...BASE, commissionRate: 0.005 }) + 100,
    })
    expect(solved.status).toBe('OUT_OF_RANGE')
    expect(solved.message).toContain('漏录')
  })

  it('截止日把之后的流水挡在外面，并**报出被挡掉几笔**', () => {
    // 今天那两笔券商还没结算，算进我们这一侧会把差额整个记到费率头上
    const withToday: FeeRow[] = [...BIG, row('BUY', 10_000, 12, 5), row('SELL', 10_000, 12, 5)]
    const solved = solveFromFeeTotal({
      rows: withToday,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: feeUnder(BASE, BIG),
      throughMs: T0 + DAY,
    })
    expect(solved.status).toBe('OK')
    expect(solved.feeBearing).toBe(2)
    expect(solved.excludedByDate).toBe(2)
    expect(solved.message).toContain('没有参与反解')
  })

  it('「价已含费」的建仓不产生费用，不参与反解；「不含费」的那种算', () => {
    const included: FeeRow[] = [{ ...row('OPENING', 5100, 14.75), feeIncluded: true }]
    expect(
      solveFromFeeTotal({ rows: included, board: 'MAIN', base: BASE, targetFeeTotal: 10 }).status
    ).toBe('NO_BASIS')

    const bare: FeeRow[] = [{ ...row('OPENING', 5100, 14.75), feeIncluded: false }]
    const solved = solveFromFeeTotal({
      rows: bare,
      board: 'MAIN',
      base: WAIVED,
      targetFeeTotal: feeUnder({ ...WAIVED, commissionRate: 0.0001 }, bare),
    })
    expect(solved.status).toBe('OK')
    expect(solved.feeBearing).toBe(1)
  })

  it('分红与送转不产生费用 —— 只有它们时判 NO_BASIS', () => {
    const rows: FeeRow[] = [row('DIVIDEND', 1000, 0.3), row('SPLIT', 1000, 0, 1)]
    expect(solveFromFeeTotal({ rows, board: 'MAIN', base: BASE, targetFeeTotal: 5 }).status).toBe(
      'NO_BASIS'
    )
  })

  it('目标填成负数时不去解，直接判非法', () => {
    const solved = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: -1,
    })
    expect(solved.status).toBe('OUT_OF_RANGE')
  })

  it('解出来但那个数不像个佣金率时**提示而不拒绝** —— 老账户里千 1.5 真的存在', () => {
    const solved = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: feeUnder({ ...BASE, commissionRate: 0.002 }),
    })
    expect(solved.status).toBe('OK')
    expect(solved.message).toContain('常见档位')
    // 常见档位以内的不该带这句噪音
    const normal = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: feeUnder({ ...BASE, commissionRate: 0.0001 }),
    })
    expect(normal.message).not.toContain('常见档位')
  })

  it('ETF 免印花税与过户费 —— 板块要真的传下去', () => {
    const etf = solveFromFeeTotal({
      rows: BIG,
      board: 'ETF',
      base: WAIVED,
      targetFeeTotal: 1,
    })
    const stock = solveFromFeeTotal({
      rows: BIG,
      board: 'MAIN',
      base: WAIVED,
      targetFeeTotal: 1,
    })
    // 股票那边光印花税就 110 元，1 元这个目标够不到；ETF 免征，解得出来
    expect(stock.status).toBe('OUT_OF_RANGE')
    expect(etf.status).toBe('OK')
  })
})

/**
 * **真实账单回归**（同花顺，湖南白银，2026-09-03）。
 *
 * 这一组不是构造出来的：8 笔逐笔费用全部来自券商 App 的截图，
 * 而它一次抓出了两个缺陷 —— 印花税写成了减半前的千 1（差一倍），
 * 以及「最低 5 元」被当成只卡佣金（过户费另加）。
 *
 * ⚠ 它钉的是**逐笔零残差**，不是「总数差不多」：只对总数的话，
 * 一个 2 倍的印花税误差可以被佣金率整个吸收掉，而那正是当时发生的事
 * —— 反解给出「万 1.13 + 免最低」，一个看起来精确、实际完全虚构的结论。
 */
describe('真实账单回归（同花顺 8 笔）', () => {
  const D = (day: string): number => Date.parse(`${day}T04:00:00Z`)
  /** [side, 股数, 价, 账单上的费用] */
  const BILL: [FeeRow['side'], number, number, number, string][] = [
    ['OPENING', 5100, 14.75, 17.71, '2026-01-22'],
    ['BUY', 3600, 10.33, 8.75, '2026-05-19'],
    ['BUY', 1700, 11.38, 5.0, '2026-08-26'],
    ['SELL', 1700, 11.33, 14.63, '2026-08-26'],
    ['BUY', 1700, 11.7, 5.0, '2026-08-28'],
    ['SELL', 1700, 11.67, 14.92, '2026-08-28'],
    ['BUY', 1700, 10.59, 5.0, '2026-08-31'],
    ['SELL', 1700, 10.7, 14.1, '2026-08-31'],
  ]
  const rows: FeeRow[] = BILL.map(([side, shares, price, , day]) => ({
    side,
    shares,
    price,
    fee: 0,
    tradedAt: D(day),
    ...(side === 'OPENING' ? { feeIncluded: false } : {}),
  }))
  /** 账单合计，也就是同花顺那一屏的「交易税费」 */
  const TOTAL = BILL.reduce((sum, [, , , fee]) => sum + fee, 0)

  it('账单合计恰好是券商显示的 85.11', () => {
    expect(TOTAL).toBeCloseTo(85.11, 2)
  })

  it('反解出万 2.25 + 最低 5 元（**不需要勾免最低**）', () => {
    const solved = solveFromFeeTotal({ rows, board: 'MAIN', base: BASE, targetFeeTotal: TOTAL })
    expect(solved.status).toBe('OK')
    expect((solved.rate ?? 0) * 1e4).toBeCloseTo(2.25, 2)
    expect(solved.feeTotalAt).toBeCloseTo(TOTAL, 2)
  })

  /**
   * 券商账单把过户费**并进「佣金」那一栏**（同花顺实测：其他费用 0.00），
   * 而我们拆成「净佣金率 + 过户费率」两项。钱完全一样 ——
   * `金额 × (净佣金率 + 过户费率)` 恒等于 `金额 × 全包率` ——
   * 但只报净佣金率的话，用户拿账单一除（17.71 ÷ 75225 = 万2.354）就会发现「对不上」。
   */
  it('结论里要报出**合计费率**（佣金 + 过户费），那才是账单上「佣金」栏那个数', () => {
    const solved = solveFromFeeTotal({ rows, board: 'MAIN', base: BASE, targetFeeTotal: TOTAL })
    expect(solved.status).toBe('OK')
    // 净佣金率 万2.25，连过户费一起是 万2.35 —— 后者与 17.71 ÷ 75225 对得上
    expect(solved.message).toContain('连过户费一起算是')
    const allIn = (solved.rate ?? 0) + TRANSFER_FEE_RATE
    expect(allIn * 1e4).toBeCloseTo(17.71 / 75225 * 1e4, 2)
  })

  it('**逐笔零残差** —— 只对总数的话，一个 2 倍的印花税误差会被佣金率整个吸收', () => {
    const solved = solveFromFeeTotal({ rows, board: 'MAIN', base: BASE, targetFeeTotal: TOTAL })
    const rates: TradeFeeRates = { ...BASE, commissionRate: solved.rate ?? 0 }
    const r2 = (x: number): number => Math.round(x * 100) / 100
    BILL.forEach(([side, shares, price, actual, day], i) => {
      const costs = ledgerCosts(rates, day)
      const amount = price * shares
      const mine = side === 'SELL' ? r2(sellFees(amount, costs)) : r2(buyFees(amount, costs))
      expect(mine, `第 ${i + 1} 笔 ${day} ${side}`).toBeCloseTo(actual, 2)
    })
  })

  /**
   * ⚠ 真机踩过（2026-09-03）：用户勾了「免 5 元最低佣金」，反解出万 2.488，
   * **合计照样是 85.11** —— 但逐笔变成 4.81 / 4.95 / 4.48，与账单上那三个
   * 5.00 整**一笔都对不上**。
   *
   * 这条用例钉的是**判据本身**：合计按构造总能对上 ⇒ 它分辨不出配置对不对，
   * 只有逐笔分得开。界面因此必须把逐笔摆出来（`FeeCalibration.rows`）。
   */
  it('**合计分辨不出配置对错**：勾与不勾都能对上 85.11，只有逐笔分得开', () => {
    const waived = solveFromFeeTotal({
      rows,
      board: 'MAIN',
      base: { ...BASE, minCommission: 0 },
      targetFeeTotal: TOTAL,
    })
    const kept = solveFromFeeTotal({ rows, board: 'MAIN', base: BASE, targetFeeTotal: TOTAL })

    // 两边都能把**合计**解到目标上 —— 这正是「合计不是判据」的意思
    expect(waived.status).toBe('OK')
    expect(kept.status).toBe('OK')
    expect(waived.feeTotalAt).toBeCloseTo(TOTAL, 1)
    expect(kept.feeTotalAt).toBeCloseTo(TOTAL, 1)

    const offBy = (r: { rows: { feeAfter: number }[] }): number =>
      r.rows.filter((row, i) => Math.abs(row.feeAfter - BILL[i]![3]) > 0.005).length
    // 而**逐笔**一个全错、一个零残差
    expect(offBy(kept)).toBe(0)
    expect(offBy(waived)).toBe(BILL.length)

    // 勾错时的特征：小额那几笔算出来**不足 5 元**，而账单上恰好是 5.00 整
    expect(waived.rows.filter((r) => r.feeAfter < 5)).toHaveLength(3)
    expect(kept.rows.filter((r) => r.feeAfter < 5)).toHaveLength(0)
  })

  it('用减半前的印花税（千 1）算，这 8 笔会多出 29 元 —— 那是修掉的那个缺陷', () => {
    const r2 = (x: number): number => Math.round(x * 100) / 100
    const wrong = BILL.reduce((sum, [side, shares, price, , day]) => {
      // 硬塞一个「不按日期分档」的旧口径：印花税恒为千 1
      const costs = { ...ledgerCosts(BASE, day), stampTaxRate: STAMP_TAX_RATE_BEFORE }
      const amount = price * shares
      return sum + (side === 'SELL' ? r2(sellFees(amount, costs)) : r2(buyFees(amount, costs)))
    }, 0)
    expect(wrong - TOTAL).toBeGreaterThan(28)
  })
})
