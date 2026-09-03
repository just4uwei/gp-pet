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

import type { Board, TradeDate } from '../core/types'

/*
  印花税与过户费这几个**规则常量**住 `src/shared/trade-fees.ts`（一处定义）——
  渲染层不能 import `src/backtest`，而设置页要把那个生效日期显示给用户看。
  这里 re-export 一次，让回测与记账两侧都只认一个入口。
*/
export {
  STAMP_TAX_HALVED_ON,
  STAMP_TAX_RATE_AFTER,
  STAMP_TAX_RATE_BEFORE,
  TRANSFER_FEE_RATE,
} from '../shared/trade-fees'
import { STAMP_TAX_HALVED_ON as HALVED_ON, STAMP_TAX_RATE_AFTER as AFTER, STAMP_TAX_RATE_BEFORE as BEFORE } from '../shared/trade-fees'

/**
 * 卖出印花税率。`asOf` 是**这一笔成交那一天**的日期（`YYYY-MM-DD`），**必填** ——
 * 给它一个默认值等于让漏传的调用点静默沿用旧规则，而那正是这次要修的东西
 * （与 `priceLimitRatio` 的第三参同一条纪律）。
 *
 * ⚠ **2026-09-03 之前这里写死 0.001**（`DEFAULT_COSTS.stampTaxRate` 至今仍是），
 * 而它 2023-08-28 起已经减半 ⇒ 用户账本上每一笔卖出都被**多扣一倍印花税**
 * （真机实测三笔卖出：账单 14.63 / 14.92 / 14.10，我们算 24.45 / 25.04 / 23.37，
 * 单只票就多收 29.21 元），而它一路进已实现盈亏。
 * 更坏的是它**污染了反解**：「校正费率」把全部差额都归给佣金率，于是一个 2 倍的
 * 印花税误差被折算成「你的佣金是万 1.13、而且免 5 元最低」—— 一个看起来精确、
 * 实际完全虚构的结论（真实是万 2.25 + 最低 5 元）。
 *
 * ⚠ **回测还没接这个函数**：`DEFAULT_COSTS.stampTaxRate` 仍是 0.001。
 * 接上去会改动 2023-08-28 之后每一笔卖出的成本，也就是**验证窗口的全部绩效数字**
 * —— 那是一次独立的口径变更，要单独决定与记录。
 */
export function stampTaxRateOn(asOf: TradeDate): number {
  return asOf < HALVED_ON ? BEFORE : AFTER
}

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

/**
 * 「最低 5 元」卡的是**佣金 + 过户费**这一整块手续费，不是只卡佣金（2026-09-03 订正）。
 *
 * 依据是真机账单：单笔 19,346 元的买入，券商收 **5.00 元整**。
 * 若最低只卡佣金，过户费另收，那笔应当是 `5 + 1.93 = 5.19` —— 而账单上是 5.00。
 * 三笔小额买入与三笔卖出（剥掉印花税之后）**全部恰好 5.00**，8 笔逐笔零残差。
 *
 * ⚠ **对回测几乎没有影响**：`capitalPerCode` 是 10 万，按万 2.5 算佣金 25 元，
 * 最低那一档**根本咬不住** —— 只有单笔低于约 2 万元时才分得出这两种写法，
 * 而那时差的也只有 `金额 × 万0.1` ≤ 0.2 元。改动前后回测报告逐位复现过。
 * 印花税则是完全另一回事（差一倍），见 `stampTaxRateOn`。
 */
function handlingFee(amount: number, costs: CostModel, board?: Board): number {
  const transfer = isFundBoard(board) ? 0 : amount * costs.transferFeeRate
  return Math.max(costs.minCommission, amount * costs.commissionRate + transfer)
}

export function buyFees(amount: number, costs: CostModel, board?: Board): number {
  return handlingFee(amount, costs, board)
}

export function sellFees(amount: number, costs: CostModel, board?: Board): number {
  // 场内基金免印花税（也免过户费，后者在 handlingFee 里已经处理）
  if (isFundBoard(board)) return handlingFee(amount, costs, board)
  return handlingFee(amount, costs, board) + amount * costs.stampTaxRate
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
