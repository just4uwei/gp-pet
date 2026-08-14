/**
 * 成交记账规则（007_trade_log.sql）。**纯函数，不碰数据库、不读时钟。**
 *
 * 这里是持仓变化的唯一实现：UI 的提交前试算与主进程的落库走的是同一个函数。
 * 两处各算一遍必然分叉，而分叉出来的症状是「表单说成本会变成 12.34，存完变成 12.31」
 * —— 用户只会认为软件算错了，而且他没法判断哪个数才是对的。
 *
 * ## 口径
 *
 * - **买入**：成本按加权平均摊薄，**含手续费**（券商的摊薄成本口径）。
 *   含费是有代价的选择：它让成本价略高于成交价，看起来「买贵了」；
 *   但不含费的话止损线会系统性地偏乐观 —— 而止损用的正是这个数（docs/05 §2.3）。
 * - **卖出**：只减股数，**成本价一个字不动**，差额结转成已实现盈亏。
 *   这是先进先出/加权平均都通用的做法，也让「浮盈」与「已实现」两个数各归各的。
 * - **卖出超过持有股数一律拒绝。** 不允许出现负持仓：这个软件不接券商、不支持融券，
 *   一个负数持仓会一路传到风控层，而那边所有规则都假设 shares > 0。
 *
 * ## 绝不套用滑点
 *
 * `backtest/costs.ts` 里还有 `buyFill` / `sellFill` 两个函数 —— **这里一个都不能用。**
 * 那两个是给回测的：模拟「我不知道会成交在哪，所以往不利方向偏一点」。
 * 而这里用户填的**就是真实成交价**（他从券商 App 上抄下来的），
 * 再套一层滑点等于凭空把他的成交价改坏 0.1%，然后这个错误会一路进成本、进盈亏、进止损线。
 * 这是这个文件里最容易被「顺手复用」错的地方。
 *
 * 费率复用 `backtest/costs.ts` 是刻意的（CLAUDE.md 里 `main → backtest` 那条横向边的
 * 第二个用例，第一个是影子运行）：口径各写一份，实盘盈亏与影子绩效就再也对不上。
 */

import { DEFAULT_COSTS, buyFees, sellFees, type CostModel } from '../../backtest/costs'

export type TradeSide = 'BUY' | 'SELL'

export interface LedgerPosition {
  shares: number
  /** 加权平均成本（含费），不复权 */
  cost: number
}

export interface TradeInput {
  side: TradeSide
  /** 不复权真实成交价 */
  price: number
  shares: number
}

export interface TradeApplied {
  /** 变化后的持仓。null = 已清仓，调用方应删除持仓行 */
  position: LedgerPosition | null
  fee: number
  /** 本笔结转的已实现盈亏（含费）。买入为 null —— **不是 0**（约束 4） */
  realized: number | null
}

export type TradeOutcome = TradeApplied | { error: string }

export function isTradeError(outcome: TradeOutcome): outcome is { error: string } {
  return 'error' in outcome
}

/** 分位取整。避免 0.1 + 0.2 那类浮点尾巴一路累积进成本价 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 成本价多留两位：1000 股上 0.0001 的误差就是 0.1 元，四舍五入到分会肉眼可见地漂 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function applyTrade(
  current: LedgerPosition | null,
  input: TradeInput,
  costs: CostModel = DEFAULT_COSTS
): TradeOutcome {
  const shares = Math.trunc(input.shares)
  if (!Number.isFinite(input.price) || input.price <= 0) return { error: '成交价必须是一个正数' }
  if (!Number.isFinite(shares) || shares <= 0) return { error: '股数必须是一个正整数' }

  const amount = input.price * shares

  if (input.side === 'BUY') {
    const fee = round2(buyFees(amount, costs))
    const heldShares = current?.shares ?? 0
    const heldValue = (current?.cost ?? 0) * heldShares
    const nextShares = heldShares + shares
    return {
      position: { shares: nextShares, cost: round4((heldValue + amount + fee) / nextShares) },
      fee,
      realized: null,
    }
  }

  if (!current || current.shares <= 0) return { error: '当前没有持仓，无法卖出' }
  if (shares > current.shares) {
    return { error: `卖出 ${shares} 股超过持有的 ${current.shares} 股` }
  }

  const fee = round2(sellFees(amount, costs))
  const realized = round2((input.price - current.cost) * shares - fee)
  const nextShares = current.shares - shares
  return {
    // 清仓：持仓行删掉，但流水与已实现盈亏留着 —— 那才是「这只票总共赚了多少」的答案
    position: nextShares === 0 ? null : { shares: nextShares, cost: current.cost },
    fee,
    realized,
  }
}

/**
 * 按流水重放出持仓。`trade:remove`（录错了要删）走这条路。
 *
 * **不做反向增量回滚**：在「买入 → 卖出 → 又买入」这类序列上，
 * 删掉中间那笔卖出之后，靠反算是回不到正确成本的（卖出不改成本，所以没有可逆信息）。
 * 重放是唯一算得对的做法，而它的前提是**期初那一笔已经补上了**（007 迁移做的事）。
 *
 * 入参必须按 `traded_at` 升序。遇到算不通的一笔（例如历史数据里超卖）就跳过它并继续，
 * 而不是整条链失败 —— 重建持仓时半路抛错会让用户的持仓凭空消失。
 */
export function replayTrades(
  trades: readonly { side: TradeSide | 'OPENING'; price: number; shares: number }[],
  costs: CostModel = DEFAULT_COSTS
): LedgerPosition | null {
  let position: LedgerPosition | null = null
  for (const trade of trades) {
    if (trade.side === 'OPENING') {
      // 期初建仓不再收一次费：它的 price 就是当初那个已经含费的成本价
      position = { shares: Math.trunc(trade.shares), cost: trade.price }
      continue
    }
    const outcome = applyTrade(position, { side: trade.side, price: trade.price, shares: trade.shares }, costs)
    if (isTradeError(outcome)) continue
    position = outcome.position
  }
  return position
}
