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

import type { Board } from '@core/types'
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
  /**
   * 板块。**必填**，因为费率靠它区分：场内基金（ETF/LOF）免印花税与过户费。
   *
   * ⚠ 刻意不给缺省值。`costs.ts` 的缺省是「按股票收满」（回测偏保守是安全方向），
   * 但**记账不能靠那个缺省** —— ETF 多扣 0.1% 会让成本价与已实现盈亏系统性偏高，
   * 而这张账存在的意义就是「实盘盈亏与影子绩效可比」。
   * 让它必填 = 调用方漏传时**编译不过**，而不是静默算错。
   */
  board: Board
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
    const fee = round2(buyFees(amount, costs, input.board))
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

  const fee = round2(sellFees(amount, costs, input.board))
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
 * 「这笔卖出超过了成交当日的可卖股数」的提示语 —— A 股 T+1，当日买入当日卖不出。
 *
 * ## 为什么是提示而不是拒绝
 *
 * 这个函数**不属于** `applyTrade`，它的结论也不进 `TradeOutcome.error`：
 * 跨境 / 债券 / 黄金 ETF 与可转债确实是 T+0，而用户还可能在补录历史成交、
 * 或者把成交日期填错了。把一条**合法**成交挡在外面，症状是
 * 「我明明这么成交的，软件说存不进去」—— 那比多给一句提示贵得多。
 * 所以它落在 `TradePreview.warning`（琥珀色）而不是 `error`（玫红色）。
 *
 * ## 三个入参的口径
 *
 * - `heldShares` 是**这笔成交之前**的持股数；
 * - `sameDayBuyShares` 是**该成交日**（不是「今天」）买入的股数 ——「补录上周那笔卖出」
 *   是常态，拿今天的日界去卡它会对每一笔历史成交都报一次；
 * - 两者相减就是那天真正卖得掉的量，与风控层的 `sellableShares()` 是同一个算式。
 *
 * 放在这个纯函数模块里而不是 controller 里，是为了让措辞与判据能被用例钉住 ——
 * 它是唯一一处会直接影响用户「要不要按下确认」的文案。
 */
export function t1SellNotice(input: {
  side: TradeSide
  shares: number
  heldShares: number
  sameDayBuyShares: number
}): string | null {
  const { side, shares, heldShares, sameDayBuyShares } = input
  if (side !== 'SELL') return null
  if (heldShares <= 0 || sameDayBuyShares <= 0) return null

  const sellable = Math.max(0, heldShares - sameDayBuyShares)
  if (Math.trunc(shares) <= sellable) return null
  return (
    `成交当日买入过 ${sameDayBuyShares} 股 —— A 股 T+1 下当日买入当日卖不出，` +
    `那天最多卖 ${sellable} 股。确认一下成交日期是否填对。` +
    `（跨境 / 债券 / 黄金 ETF 与可转债是 T+0，不受此限，可以照录）`
  )
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
  board: Board,
  costs: CostModel = DEFAULT_COSTS
): LedgerPosition | null {
  let position: LedgerPosition | null = null
  for (const trade of trades) {
    if (trade.side === 'OPENING') {
      // 期初建仓不再收一次费：它的 price 就是当初那个已经含费的成本价
      position = { shares: Math.trunc(trade.shares), cost: trade.price }
      continue
    }
    const outcome = applyTrade(
      position,
      { side: trade.side, price: trade.price, shares: trade.shares, board },
      costs
    )
    if (isTradeError(outcome)) continue
    position = outcome.position
  }
  return position
}
