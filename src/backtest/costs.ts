/**
 * 交易成本与滑点（docs/07 §2.2）。
 *
 * 默认值取 A 股散户的常见档位：
 *   佣金 双边万 2.5（最低 5 元）· 印花税 卖出千 1 · 过户费 双边万 0.1 · 滑点 0.1%
 *
 * 为什么成本不能省：本策略的信号频率不低，来回一趟的固定摩擦约 0.3%。
 * 一个「年化 17%」的回测，扣掉摩擦后可能只剩个位数 —— 不含成本的回测数字
 * 不是乐观，是错的。
 */

import type { Board } from '../core/types'

/**
 * 场内基金（ETF / LOF）**免印花税，也免过户费**，只收佣金。
 *
 * 判据是**板块**而不是代码前缀 —— 代码分段的事在 `core/code.ts` 一处做（`splitCode`）。
 *
 * ## 缺省按股票算，这是刻意的失败方向
 *
 * 不传 `board` 时按股票收满 —— 回测里多算成本让结论偏保守，少算会让它偏乐观。
 * **但实盘记账不能靠缺省**：那会让 ETF 的成本价与已实现盈亏系统性偏高，
 * 而记账存在的意义就是「实盘盈亏与影子绩效可比」。
 * 所以 `trades/ledger.ts` 的 `TradeInput.board` 是**必填**的。
 *
 * ⚠ 这个区分 2026-08-17 之前不存在：`core/code.ts` 早就认得 ETF 板块，
 * 而这里无条件收印花税。后果是 ETF 回测被多扣 0.1%/卖出
 * （实测 12 只 ETF 池训练窗口：带印花税 +1.63%，免税 +2.14%，**差 0.51pp**），
 * 而实盘记账里那 15 只行业 ETF 的成本与盈亏也一起偏高。
 */
export function isFundBoard(board?: Board): boolean {
  return board === 'ETF'
}

export interface CostModel {
  /** 佣金率（双边） */
  commissionRate: number
  /** 单笔最低佣金，元 */
  minCommission: number
  /** 印花税率，仅卖出 */
  stampTaxRate: number
  /** 过户费率（双边） */
  transferFeeRate: number
  /** 滑点，按成交价的比例双向不利方向偏移 */
  slippage: number
}

export const DEFAULT_COSTS: CostModel = {
  commissionRate: 0.00025,
  minCommission: 5,
  stampTaxRate: 0.001,
  transferFeeRate: 0.00001,
  slippage: 0.001,
}

/** 买入成交价：滑点一律朝不利方向（买贵、卖便宜），不做「有时有利」的假设 */
export function buyFill(price: number, costs: CostModel): number {
  return price * (1 + costs.slippage)
}

export function sellFill(price: number, costs: CostModel): number {
  return price * (1 - costs.slippage)
}

export function buyFees(amount: number, costs: CostModel, board?: Board): number {
  const commission = Math.max(costs.minCommission, amount * costs.commissionRate)
  return commission + (isFundBoard(board) ? 0 : amount * costs.transferFeeRate)
}

export function sellFees(amount: number, costs: CostModel, board?: Board): number {
  const commission = Math.max(costs.minCommission, amount * costs.commissionRate)
  if (isFundBoard(board)) return commission
  return commission + amount * costs.transferFeeRate + amount * costs.stampTaxRate
}

/** 一手 = 100 股。买入按整手向下取整 —— 成交 13.7 股的回测是假的 */
export const LOT_SIZE = 100

export function lotsAffordable(
  cash: number,
  fillPrice: number,
  costs: CostModel,
  board?: Board
): number {
  if (fillPrice <= 0 || cash <= 0) return 0
  // 先按不含费估手数，再逐手回退直到费用也放得下（最低佣金在小额时占比不可忽略）
  let shares = Math.floor(cash / fillPrice / LOT_SIZE) * LOT_SIZE
  while (shares > 0 && shares * fillPrice + buyFees(shares * fillPrice, costs, board) > cash) {
    shares -= LOT_SIZE
  }
  return shares
}
