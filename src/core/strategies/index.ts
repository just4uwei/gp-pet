/**
 * 策略层门面（docs/04 §3）。
 *
 * 三个策略互不知晓：趋势与均值回归各自产出 `SubSignal[]`，多周期产出调整项。
 * 「同时有买有卖」是允许且常见的 —— 裁决是组合层的事（docs/04 §4.2），不在这里提前收敛。
 */

import type { WeeklyIndicators } from '../indicators'
import type { MultiTfAdjustment, SubSignal } from '../types'
import { meanReversionSignals } from './mean-reversion'
import { multiTfAdjustments } from './multi-tf'
import { trendSignals } from './trend'
import type { StrategyContext } from './context'

export interface StrategyOutput {
  subSignals: SubSignal[]
  adjustments: MultiTfAdjustment[]
}

export function runStrategies(ctx: StrategyContext, weekly: WeeklyIndicators): StrategyOutput {
  // 消融开关（params.enabledStrategies）：被关掉的策略一个子信号都不产出，
  // 因此它对组合层既不供分也不供票 —— 这是「权重调 0」做不到的（见 params.ts 的说明）。
  const enabled = ctx.params.enabledStrategies
  return {
    subSignals: [
      ...(enabled.trend ? trendSignals(ctx) : []),
      ...(enabled.meanReversion ? meanReversionSignals(ctx) : []),
    ],
    adjustments: multiTfAdjustments(ctx, weekly),
  }
}

export { MEAN_REVERSION_WEIGHTS, meanReversionSignals } from './mean-reversion'
export { multiTfAdjustments } from './multi-tf'
export { TREND_WEIGHTS, trendSignals } from './trend'
export * from './context'
