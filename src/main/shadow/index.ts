/**
 * 影子运行模块的出口（docs/07 §2.3）。
 *
 * 三块各管一件事，刻意分开：
 *   `portfolio.ts` 纯记账（成交、费用、手数、涨跌停）—— 没有 IO，全部可单测
 *   `runner.ts`    一个交易日的推进顺序 + 幂等与引擎版本两道闸门
 *   `summary.ts`   账本 → 面板那一屏，含「满 3 个月前不做正面宣称」的口径
 */

export {
  MAX_DEFER_BARS,
  exitRuleOf,
  executeOrder,
  orderFrom,
  quantizeSell,
  toShadowAction,
} from './portfolio'
export type {
  FillContext,
  FillOutcome,
  ShadowAction,
  ShadowOrder,
  ShadowPosition,
  ShadowTrade,
  VoidReason,
} from './portfolio'
export { DEFAULT_SHADOW_CAPITAL, DEFAULT_SHADOW_NOTIONAL, createShadowRunner } from './runner'
export type { ShadowAdvanceResult, ShadowRunner, ShadowRunnerDeps, ShadowSkip } from './runner'
export { SEASONING_DAYS, emptyShadowSummary, summarize, toTradeView } from './summary'
export type { SummaryInput } from './summary'
