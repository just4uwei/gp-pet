/**
 * 影子组合的记账逻辑（docs/07 §2.3）—— **纯函数，不碰数据库、不读时钟**。
 *
 * 「影子运行」= 每条信号自动记录「若按此信号操作」的模拟持仓，前向累积。
 * 它比任何历史回测都可信，前提是它**真的是前向的**。三条纪律因此写死在这里：
 *
 * 1. **不补跑历史。** 只处理「今天」这一根，永远看不到明天。想拿三年前的 K 线
 *    把影子曲线补长，那不是影子运行，是回测 —— 而它会带着一份看起来像实盘的报告。
 * 2. **成交价用次日开盘。** T 日收盘确认的信号在 T+1 开盘成交，与
 *    `backtest/simulate.ts` 同源。用当日收盘价成交会凭空多出一段收益：
 *    15:00 之后的收盘确认轮里，那个价格已经买不到了。
 * 3. **成本照扣。** 双边佣金 + 印花税 + 过户费 + 滑点，复用回测那一套
 *    （`backtest/costs.ts`）。来回摩擦约 0.3%，不扣成本的影子绩效不是乐观，是错的。
 *
 * ## 为什么复用 `src/backtest` 而不是新写一套
 *
 * 影子运行与回测量的是同一件事，只是数据来源一个是前向一个是历史。成本模型、
 * 手数取整、绩效口径各写一份，两边的数字就再也对不上 —— 而「回测说赚、影子说亏」
 * 到底是策略退化还是口径差异，会变成一个查不清的问题。
 * `src/backtest/index.ts` 的头注释本来就写着「供……应用内影子运行复用」。
 *
 * ## 仓位模型：单一现金池 + 每笔固定名义金额
 *
 * 回测是「每只标的一份等额独立资金」（那里标的池是固定的）。影子运行不能这么记：
 * 自选股随时增删，按标的分账会让总资金跟着自选数量变，净值曲线的分母自己在动。
 * 所以这里是**一个现金池 + 每笔固定名义金额**，钱不够就不开仓并计一次
 * `skippedNoCash` —— 那个计数必须报出来，静默跳过会让「信号密集期的收益」凭空消失
 * 而报告上看不出来。
 *
 * 这仍然不是资金管理策略。它只是让「信号本身值不值钱」有一个明确定义的分母。
 */

import { priceLimits } from '@core/code'
import { forcedExit } from '@core/risk'
import type { EngineParams } from '@core/params'
import type { Board, Candle, GatedDirection, GatedSignal, Regime, SecCode, TradeDate } from '@core/types'
import {
  buyFees,
  buyFill,
  lotsAffordable,
  sellFees,
  sellFill,
  type CostModel,
} from '../../backtest/costs'

export type ShadowAction = 'BUY' | 'SELL' | 'REDUCE'

/** 待成交委托：T 日收盘产生，T+1 开盘成交 */
export interface ShadowOrder {
  code: SecCode
  action: ShadowAction
  placedDate: TradeDate
  rule: string
  score: number
  regime: Regime
  signalId: string | null
  /** 跌停卖不掉时的顺延次数 */
  deferred: number
}

export interface ShadowPosition {
  code: SecCode
  shares: number
  entryDate: TradeDate
  entryPriceAdj: number
  entryPriceRaw: number
  /** 尚未摊到已平仓部分的买入费用 */
  entryCosts: number
  entryRegime: Regime
  entryScore: number
  entryRule: string
  peakRaw: number
  lastCloseAdj: number
  barsHeld: number
  engineVersion: string
}

export interface ShadowTrade {
  id: string
  code: SecCode
  entryDate: TradeDate
  exitDate: TradeDate
  entryPrice: number
  exitPrice: number
  entryPriceRaw: number
  exitPriceRaw: number
  shares: number
  pnl: number
  pnlPct: number
  holdingBars: number
  costs: number
  regimeAtEntry: Regime
  entryScore: number
  exitRule: string
  partial: boolean
  engineVersion: string
}

/** 卖单最多顺延几根。与回测同一个数：连续跌停超过它就当作「这段根本没法卖」 */
export const MAX_DEFER_BARS = 5

/**
 * 委托能不能下（docs/04 §5 的方向语义）。
 *
 * 与回测的 `toOrder()` 逐字一致，包括「NEXT_DAY_WATCH 在成交模型上就是买入」——
 * 影子运行的成交本来就发生在次日开盘，那正是这个方向想表达的事。
 */
export function toShadowAction(direction: GatedDirection, holding: boolean): ShadowAction | null {
  if (!holding && (direction === 'BUY' || direction === 'NEXT_DAY_WATCH')) return 'BUY'
  if (holding && direction === 'SELL') return 'SELL'
  if (holding && direction === 'REDUCE') return 'REDUCE'
  return null
}

/** 卖出取整手；不足一手的零股一次卖光（否则会留下永远卖不掉的碎股） */
export function quantizeSell(shares: number, fraction: number): number {
  if (fraction >= 1) return shares
  const target = Math.floor((shares * fraction) / 100) * 100
  return target <= 0 || shares - target < 100 ? shares : target
}

export interface FillContext {
  /** 成交那一根（= 委托产生日的次日） */
  bar: Candle
  /** 前一根收盘价，用于算涨跌停 */
  prevClose: number
  board: Board
  isST: boolean
  costs: CostModel
  /** 每笔建仓的名义金额上限 */
  notionalPerTrade: number
  cash: number
  engineVersion: string
  newId: () => string
}

export type FillOutcome =
  | { kind: 'FILLED_BUY'; position: ShadowPosition; cash: number }
  | { kind: 'FILLED_SELL'; trade: ShadowTrade; cash: number; position: ShadowPosition | null }
  /** 跌停卖不掉 → 顺延到下一根，委托留着 */
  | { kind: 'DEFERRED'; order: ShadowOrder }
  /** 作废：涨停买不到、连续跌停超上限、缺口段、钱不够、不够一手 */
  | { kind: 'VOID'; reason: VoidReason }

/**
 * 委托作废的理由。每一种都要被计数并显示：「作废」与「没赚到」在净值上长得一样，
 * 但一个是「这条信号没法执行」、一个是「这条信号不值钱」。
 *
 * `NO_BAR` 是影子运行独有的（回测里不存在）：停牌或 K 线还没回补，
 * 委托会先顺延，连续 `MAX_DEFER_BARS` 天拿不到 K 线才作废。
 */
export type VoidReason =
  | 'LIMIT_UP'
  | 'LIMIT_DOWN'
  | 'GAP'
  | 'NO_CASH'
  | 'NO_LOT'
  | 'NO_POSITION'
  | 'NO_BAR'

/**
 * 执行一张委托。**只看 `bar` 的开盘价** —— 这根的最高最低收盘在开盘那一刻还不知道。
 *
 * 返回 VOID 的每一种理由都要被上层计数并显示。「作废」和「没赚到」在净值上长得一样，
 * 但一个是「这个信号没法执行」、一个是「这个信号不值钱」，混起来会把成交摩擦
 * 记成策略缺陷。
 */
export function executeOrder(
  order: ShadowOrder,
  position: ShadowPosition | null,
  ctx: FillContext
): FillOutcome {
  // 缺口段不成交：这一段的价格连续性本身就不可信（docs/07 §4）
  if (ctx.bar.hasGap === true) return { kind: 'VOID', reason: 'GAP' }

  const limits = priceLimits(ctx.prevClose, ctx.board, ctx.isST)

  if (order.action === 'BUY') {
    // 开盘即涨停 → 买不到。作废而不是顺延：追高一天买入的成本已经不是这条信号的成本
    if (limits !== null && ctx.bar.open >= limits.limitUp - 0.001) {
      return { kind: 'VOID', reason: 'LIMIT_UP' }
    }
    const fillAdj = buyFill(ctx.bar.openAdj, ctx.costs)
    const budget = Math.min(ctx.cash, ctx.notionalPerTrade)
    const shares = lotsAffordable(budget, fillAdj, ctx.costs, ctx.board)
    if (shares <= 0) {
      // 分清两件事：现金池空了（组合层面的约束）vs 单笔名义金额买不起一手（标的太贵）
      return { kind: 'VOID', reason: ctx.cash < ctx.notionalPerTrade ? 'NO_CASH' : 'NO_LOT' }
    }
    const amount = shares * fillAdj
    const fees = buyFees(amount, ctx.costs, ctx.board)
    const fillRaw = buyFill(ctx.bar.open, ctx.costs)
    return {
      kind: 'FILLED_BUY',
      cash: ctx.cash - amount - fees,
      position: {
        code: order.code,
        shares,
        entryDate: ctx.bar.date,
        entryPriceAdj: fillAdj,
        entryPriceRaw: fillRaw,
        entryCosts: fees,
        entryRegime: order.regime,
        entryScore: order.score,
        entryRule: order.rule,
        peakRaw: Math.max(ctx.bar.high, fillRaw),
        lastCloseAdj: ctx.bar.closeAdj,
        barsHeld: 0,
        engineVersion: ctx.engineVersion,
      },
    }
  }

  if (!position || position.shares <= 0) return { kind: 'VOID', reason: 'NO_POSITION' }

  const limitedDown = limits !== null && ctx.bar.open <= limits.limitDown + 0.001
  if (limitedDown) {
    // 跌停卖不掉 → 顺延，而不是当作已卖出。顺延到上限就承认这段卖不掉并作废
    if (order.deferred < MAX_DEFER_BARS) {
      return { kind: 'DEFERRED', order: { ...order, deferred: order.deferred + 1 } }
    }
    return { kind: 'VOID', reason: 'LIMIT_DOWN' }
  }

  const fraction = order.action === 'REDUCE' ? 0.5 : 1
  const qty = quantizeSell(position.shares, fraction)
  const fillAdj = sellFill(ctx.bar.openAdj, ctx.costs)
  const amount = qty * fillAdj
  const fees = sellFees(amount, ctx.costs, ctx.board)
  // 部分卖出时买入费用按比例摊到这一笔，剩余留给后续那笔
  const allocatedEntryCosts = position.entryCosts * (qty / position.shares)
  const grossPnl = (fillAdj - position.entryPriceAdj) * qty
  const remaining = position.shares - qty

  const trade: ShadowTrade = {
    id: ctx.newId(),
    code: order.code,
    entryDate: position.entryDate,
    exitDate: ctx.bar.date,
    entryPrice: position.entryPriceAdj,
    exitPrice: fillAdj,
    entryPriceRaw: position.entryPriceRaw,
    exitPriceRaw: sellFill(ctx.bar.open, ctx.costs),
    shares: qty,
    pnl: grossPnl - fees - allocatedEntryCosts,
    pnlPct: position.entryPriceAdj > 0 ? (fillAdj - position.entryPriceAdj) / position.entryPriceAdj : 0,
    holdingBars: position.barsHeld,
    costs: fees + allocatedEntryCosts,
    regimeAtEntry: position.entryRegime,
    entryScore: position.entryScore,
    exitRule: order.rule,
    partial: remaining > 0,
    engineVersion: position.engineVersion,
  }

  return {
    kind: 'FILLED_SELL',
    trade,
    cash: ctx.cash + amount - fees,
    position:
      remaining > 0
        ? {
            ...position,
            shares: remaining,
            entryCosts: position.entryCosts - allocatedEntryCosts,
          }
        : null,
  }
}

/**
 * 从一次评估里挑出该下的委托。返回 null = 今天这只什么都不做。
 *
 * **硬抑制的信号不进影子组合**：`suppressed` 意味着风控判它无执行意义
 * （涨跌停、次新股、数据不足…），照它下单等于把「不该执行的信号」的结果算进绩效。
 * 但**被提醒层闸门挡掉的信号照样进** —— 影子量的是策略，不是提醒策略。
 * 这两句话看着像一回事，实际是相反的两个决定，别顺手统一。
 */
export function orderFrom(input: {
  code: SecCode
  gated: GatedSignal
  regime: Regime
  score: number
  /** 触发方向上权重×得分最高的子信号 ID，或命中的强制风控规则 ID */
  rule: string
  signalId: string | null
  date: TradeDate
  holding: boolean
}): ShadowOrder | null {
  if (input.gated.suppressed) return null
  const action = toShadowAction(input.gated.direction, input.holding)
  if (!action) return null
  return {
    code: input.code,
    action,
    placedDate: input.date,
    rule: input.rule,
    score: input.score,
    regime: input.regime,
    signalId: input.signalId,
    deferred: 0,
  }
}

/**
 * 影子持仓自己的强制离场（2026-08-28）。返回 null = 这只票今天不用走。
 *
 * ## 为什么需要它 —— 这里补的是一个结构性缺口
 *
 * 闸门那条持仓强制通道（止损 / 移动止损 / 回撤减仓 / 盈利保护）是拿**用户手工录入的
 * `position` 表**算的（`engine/signals.ts` 取 `storage.positions`），而
 * `positionVerdict()` 第一句就是「没有持仓 → null」。于是**影子持有、用户没录入的票，
 * 那四条规则一条都不会触发**；`REDUCE` 更彻底 —— 它只由那条通道产出，
 * 对这类票**永远不可能出现**。即使用户也持有同一只，触发判据用的还是
 * **用户的成本价与峰值**，不是影子的建仓价。
 *
 * 对照回测：`simulate.ts` 喂进闸门的是**模拟持仓自己**，止损照常触发。
 * 而实测 **96.9% 的离场由风控触发**（M2 §5.24，策略卖出子信号全池只有 171 次）
 * ⇒ 缺了这条通路，影子量的**不是回测那套策略**，它的数字与任何一份回测都不可比。
 * 而影子的全部职责就是「量策略值不值钱」（docs/07 §2.3）。
 *
 * 旁证：`peakRaw` 与 `barsHeld` 一直在逐日维护并落库，那正是移动止损与回撤减仓的输入
 * —— 而在这个函数出现之前，**全项目没有任何地方读 `peakRaw`**。
 *
 * ## 三条边界
 *
 * 1. **规则实现只有一份** —— 调 `@core/risk` 的 `forcedExit()`，与闸门、回测同一份代码。
 *    这里绝不许照抄那四条 if。
 * 2. **口径全走不复权**：`entryPriceRaw` 当成本、`peakRaw` 当峰值、入参 `closeRaw`
 *    当现价。混进复权价会在除权那天凭空触发一次止损。
 *    （注意影子的**盈亏**是按 `*Adj` 算的，与回测同源 —— 两套口径各管一件事。）
 * 3. **绝不设 `stopFloor` / `lockedShares`**。`Position` 那两个字段的注释写着
 *    「回测与影子运行绝不设这个字段…… **别去「补上」**」：它们是用户对某一次具体持仓的
 *    决定，让它们影响影子等于把「我扛住了没卖」记成策略绩效。
 *
 * ## `hardSuppressions` 那一整套刻意不在这里跑
 *
 * 逐条理由，别顺手「补全」：
 *   * `T1_SELL_LOCK` —— 那是**用户**这一次建仓的事实，影子的仓不是今天买的；
 *   * `HARD_LIMIT_DOWN` / `GAP` —— 由 `executeOrder()` 在**成交那一刻**处理
 *     （跌停顺延，上限 `MAX_DEFER_BARS`；缺口段 `VOID: GAP`），在这里再判一遍是重复；
 *   * `INSUFFICIENT_DATA` / `NEW_LISTING` —— 在**建仓**那一步就已经挡过了，
 *     能有影子持仓说明当时通过了；
 *   * `STALE_SNAPSHOT` —— 结构上不适用：影子在收盘后决策，不看快照。
 *
 * **只保留 `volume === 0`（停牌）这一条**，判据与 `hardSuppressions` 的 `SUSPENDED` 同源。
 *
 * @param closeRaw 今日**不复权**收盘（决策价；成交价另由次日开盘决定）
 * @param volume   今日成交量。0 = 停牌，不挂单
 */
export function shadowExitOrder(input: {
  position: ShadowPosition
  closeRaw: number
  volume: number
  date: TradeDate
  params: EngineParams
}): ShadowOrder | null {
  const { position, closeRaw, volume, date, params } = input
  // 停牌：与 hardSuppressions 的 SUSPENDED 同一个判据（`candle.volume === 0`）
  if (volume <= 0) return null

  const exit = forcedExit({
    position: {
      shares: position.shares,
      // ⚠ 不复权，且**不带 stopFloor** —— 见上面第 3 条边界
      cost: position.entryPriceRaw,
      peakPrice: position.peakRaw,
    },
    price: closeRaw,
    params,
  })
  if (!exit) return null

  const action = toShadowAction(exit.direction, true)
  if (!action) return null

  return {
    code: position.code,
    action,
    placedDate: date,
    // 归因用风控规则名（STOP_LOSS / TRAILING_STOP / DRAWDOWN_REDUCE / PROFIT_PROTECT），
    // 与 `exitRuleOf` 的强制分支取的是同一个字段
    rule: exit.verdict.rule,
    // 这一单不来自得分。沿用建仓时的得分而不是填 0 ——
    // 0 会在流水上被读成「置信度 0 的信号」，而它压根不是一条信号
    score: position.entryScore,
    regime: position.entryRegime,
    // 没有来源信号：这条委托不由任何一行 `signal` 产生（那正是缺口所在 ——
    // 当天可能一条信号都没有，而成本线已经被击穿）
    signalId: null,
    deferred: 0,
  }
}

/** 卖出委托的归因规则名：强制风控优先，其次是该方向上最强的子信号 */
export function exitRuleOf(
  verdicts: readonly { rule: string; action: string }[],
  subSignals: readonly { id: string; direction: string; score: number; weight: number }[],
  direction: 'BUY' | 'SELL'
): string {
  const forced = verdicts.find((v) => v.action === 'FORCE_SELL' || v.action === 'FORCE_REDUCE')
  if (forced) return forced.rule
  const top = subSignals
    .filter((sub) => sub.direction === direction)
    .slice()
    .sort((a, b) => b.weight * b.score - a.weight * a.score)[0]
  return top?.id ?? direction
}
