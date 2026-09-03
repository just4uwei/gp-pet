import { describe, expect, it } from 'vitest'
import { ledgerCosts, solveCommissionRate } from '@main/trades/fees'
import { replayLedger, type LedgerReplayRow } from '@main/trades/ledger'
import { DEFAULT_COSTS } from '../../../src/backtest/costs'
import type { TradeFeeRates } from '@shared/ipc-types'

/**
 * 费率（017）：记账用的成本模型，以及**从真实摊薄成本反解佣金率**。
 *
 * 反解错了的症状是**全库的成本价一起偏掉**（费率是账户级的），
 * 而用户只有一个可核对的锚点（券商 App 上那个数）—— 所以每一条判据都要有用例钉着。
 */

const BASE: TradeFeeRates = {
  commissionRate: 0.00025,
  minCommission: 5,
  stampTaxRate: 0.001,
  transferFeeRate: 0.00001,
}

/** 单笔 10 万的买入 —— 佣金按万 2.5 是 25 元，远高于 5 元最低 ⇒ 费率是可辨识的 */
const BIG_BUY: LedgerReplayRow[] = [{ id: 'a', side: 'BUY', price: 10, shares: 10_000, fee: 0 }]

function costUnder(rate: number, rows = BIG_BUY): number {
  const result = replayLedger(rows, 'MAIN', ledgerCosts({ ...BASE, commissionRate: rate }), {
    refee: true,
  })
  if (result.position === null) throw new Error('重放不出持仓')
  return result.position.cost
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

describe('solveCommissionRate', () => {
  it('反解出来的费率能把成本还原到目标上（往上调）', () => {
    const target = costUnder(0.001)
    const solved = solveCommissionRate({ rows: BIG_BUY, board: 'MAIN', base: BASE, targetCost: target })
    expect(solved.status).toBe('OK')
    expect(solved.rate).toBeCloseTo(0.001, 6)
    expect(solved.costAt).toBeCloseTo(target, 4)
  })

  it('往下调也解得出（用户的券商比出厂档便宜，这才是常见情形）', () => {
    const target = costUnder(0.00008)
    const solved = solveCommissionRate({ rows: BIG_BUY, board: 'MAIN', base: BASE, targetCost: target })
    expect(solved.status).toBe('OK')
    expect(solved.rate).toBeCloseTo(0.00008, 6)
  })

  it('落在券商会报出来的整档上（万分之 0.05 的倍数），而不是段的下边界', () => {
    /*
      成本按 round4 落库、费用按 round2 ⇒ 同一个成本对应**一整段费率**。
      取下边界会让反解系统性偏低半段：用户的券商报万 0.8，界面写万 0.75，
      而两个数在这份数据上同样对得上 —— 那种「对得上但看着不对」最难解释。
    */
    const solved = solveCommissionRate({
      rows: BIG_BUY,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.00008),
    })
    expect(solved.rate).toBe(0.00008)
    expect((solved.rate ?? 0) / 0.000005).toBeCloseTo(Math.round((solved.rate ?? 0) / 0.000005), 6)
  })

  it('**只动佣金率**，其余三项一个字不改 —— 一个方程解不了两个未知数', () => {
    const solved = solveCommissionRate({
      rows: BIG_BUY,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.0005),
    })
    // 拿反解出的费率重放一遍，用的仍是原来那三项
    expect(costUnder(solved.rate ?? 0)).toBeCloseTo(solved.costAt ?? 0, 4)
  })

  it('每笔都触到最低佣金时判 UNIDENTIFIABLE —— 成本对费率完全不敏感', () => {
    // 单笔 1000 元：万 2.5 只有 0.25 元，永远被 5 元最低盖住
    const tiny: LedgerReplayRow[] = [{ id: 'a', side: 'BUY', price: 10, shares: 100, fee: 0 }]
    const solved = solveCommissionRate({
      rows: tiny,
      board: 'MAIN',
      base: BASE,
      targetCost: 10.5,
    })
    expect(solved.status).toBe('UNIDENTIFIABLE')
    // 不给一个「差不多能对上」的费率：那会把一个解不出的问题固化成一个荒唐的数
    expect(solved.rate).toBeUndefined()
    expect(solved.minCommissionBound).toBe(1)
  })

  it('解出来但那个数不像个佣金率时**提示而不拒绝** —— 老账户里千 1.5 真的存在', () => {
    /*
      真机 2026-09-03 实测：把某只票的成本抬 0.01 就要万 11.45。那个数一眼就知道不对，
      **前提是界面把它印出来**。做成拒绝会把合法的老账户挡在外面，
      而「这是不是我的费率」是用户自己能判断的事。
    */
    const solved = solveCommissionRate({
      rows: BIG_BUY,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.002),
    })
    expect(solved.status).toBe('OK')
    expect(solved.rate).toBeCloseTo(0.002, 6)
    expect(solved.message).toContain('常见档位')
    // 常见档位以内的不该带这句噪音
    const normal = solveCommissionRate({
      rows: BIG_BUY,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.0001),
    })
    expect(normal.message).not.toContain('常见档位')
  })

  it('目标比「零佣金」还低时判 OUT_OF_RANGE，并指向更可能的原因', () => {
    const solved = solveCommissionRate({
      rows: BIG_BUY,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0) - 1,
    })
    expect(solved.status).toBe('OUT_OF_RANGE')
    expect(solved.message).toContain('漏录')
  })

  it('目标高到千五佣金都够不着时同样判 OUT_OF_RANGE', () => {
    const solved = solveCommissionRate({
      rows: BIG_BUY,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.005) + 1,
    })
    expect(solved.status).toBe('OUT_OF_RANGE')
  })

  it('没有会产生费用的买入时判 NO_BASIS（只有「价已含费」的建仓）', () => {
    const solved = solveCommissionRate({
      rows: [{ id: 'a', side: 'OPENING', price: 10, shares: 1000, fee: 0, feeIncluded: true }],
      board: 'MAIN',
      base: BASE,
      targetCost: 10.5,
    })
    expect(solved.status).toBe('NO_BASIS')
    expect(solved.feeBearing).toBe(0)
  })

  it('「价不含费」的建仓算作可反解的依据 —— 它的费用就是按费率补算的', () => {
    const rows: LedgerReplayRow[] = [
      { id: 'a', side: 'OPENING', price: 10, shares: 10_000, fee: 0, feeIncluded: false },
    ]
    const solved = solveCommissionRate({
      rows,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.0004, rows),
    })
    expect(solved.status).toBe('OK')
    expect(solved.feeBearing).toBe(1)
    expect(solved.rate).toBeCloseTo(0.0004, 6)
  })

  it('清仓之后判 NO_POSITION —— 没有「当前成本」可校正', () => {
    const solved = solveCommissionRate({
      rows: [
        { id: 'a', side: 'BUY', price: 10, shares: 1000, fee: 5 },
        { id: 'b', side: 'SELL', price: 11, shares: 1000, fee: 5 },
      ],
      board: 'MAIN',
      base: BASE,
      targetCost: 10,
    })
    expect(solved.status).toBe('NO_POSITION')
    expect(solved.costNow).toBeNull()
  })

  it('目标填成 0 或负数时不去解，直接判非法', () => {
    for (const targetCost of [0, -1, Number.NaN]) {
      const solved = solveCommissionRate({ rows: BIG_BUY, board: 'MAIN', base: BASE, targetCost })
      expect(solved.status).toBe('OUT_OF_RANGE')
    }
  })

  it('卖出的费用不进成本 ⇒ 只有买入侧参与反解', () => {
    const withSell: LedgerReplayRow[] = [
      ...BIG_BUY,
      { id: 'b', side: 'SELL', price: 11, shares: 1000, fee: 0 },
    ]
    const solved = solveCommissionRate({
      rows: withSell,
      board: 'MAIN',
      base: BASE,
      targetCost: costUnder(0.0004, withSell),
    })
    expect(solved.status).toBe('OK')
    // 会产生**进成本**的费用的只有那一笔买入
    expect(solved.feeBearing).toBe(1)
  })
})
