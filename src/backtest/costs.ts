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

export function buyFees(amount: number, costs: CostModel): number {
  const commission = Math.max(costs.minCommission, amount * costs.commissionRate)
  return commission + amount * costs.transferFeeRate
}

export function sellFees(amount: number, costs: CostModel): number {
  const commission = Math.max(costs.minCommission, amount * costs.commissionRate)
  return commission + amount * costs.transferFeeRate + amount * costs.stampTaxRate
}

/** 一手 = 100 股。买入按整手向下取整 —— 成交 13.7 股的回测是假的 */
export const LOT_SIZE = 100

export function lotsAffordable(cash: number, fillPrice: number, costs: CostModel): number {
  if (fillPrice <= 0 || cash <= 0) return 0
  // 先按不含费估手数，再逐手回退直到费用也放得下（最低佣金在小额时占比不可忽略）
  let shares = Math.floor(cash / fillPrice / LOT_SIZE) * LOT_SIZE
  while (shares > 0 && shares * fillPrice + buyFees(shares * fillPrice, costs) > cash) {
    shares -= LOT_SIZE
  }
  return shares
}
