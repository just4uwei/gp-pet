import { describe, expect, it } from 'vitest'
import { ledgerCosts, solveFromFeeTotal, type FeeRow } from '@main/trades/fees'
import { DEFAULT_COSTS, buyFees, sellFees } from '../../../src/backtest/costs'
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

const BASE: TradeFeeRates = {
  commissionRate: 0.00025,
  minCommission: 5,
  stampTaxRate: 0.001,
  transferFeeRate: 0.00001,
}
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
  const costs = ledgerCosts(rates)
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
    expect(ledgerCosts(BASE).slippage).toBe(0)
    // 刻意不是继承出厂的 0.001：日后谁真在记账里用了滑点，结果是「不偏」而不是静默偏 0.1%
    expect(DEFAULT_COSTS.slippage).toBe(0.001)
  })

  it('四项原样带过去，一个都不许悄悄换成出厂值', () => {
    const rates: TradeFeeRates = {
      commissionRate: 0.0001,
      minCommission: 0,
      stampTaxRate: 0.0005,
      transferFeeRate: 0,
    }
    expect(ledgerCosts(rates)).toEqual({ ...rates, slippage: 0 })
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
    const tiny: FeeRow[] = [row('BUY', 100, 10), row('BUY', 100, 10, 1)]
    const solved = solveFromFeeTotal({
      rows: tiny,
      board: 'MAIN',
      base: BASE,
      targetFeeTotal: 11,
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
