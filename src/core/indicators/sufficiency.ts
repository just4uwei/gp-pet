/**
 * 数据充分性门槛（docs/04 §1.10）。
 *
 * | 需求 | 最少日线 |
 * |---|---|
 * | MA5/MA20 + MACD / ADX | 40 |
 * | BOLL | 25 |
 * | BBW 分位 | 269（见 boll.ts 关于 270 的说明） |
 * | 全功能 | 300 |
 *
 * 不足 300 根（次新股、刚加入自选尚未回补）→ **受限模式**：跳过依赖 BBW 分位的规则，
 * 得分乘惩罚系数，UI 标注「数据不足，信号可靠性降低」。少于 40 根直接不产出信号。
 *
 * 为什么惩罚而不是直接拒绝：次新股与新加自选是常态，一律不给信号等于功能对它们缺失；
 * 而不打折就等于宣称「40 根算出来的 ADX 和 300 根一样可信」。
 */

import type { Series } from '../types'
import { at } from './series'

export interface SufficiencyParams {
  minBars: number
  fullBars: number
  insufficientPenalty: number
}

export interface DataSufficiency {
  bars: number
  /** false → 一条信号都不产出 */
  usable: boolean
  /** true → 受限模式：得分打折、跳过 BBW 分位规则 */
  limited: boolean
  /** 得分乘数，1 表示数据充分 */
  penalty: number
  /** BBW 分位在被判定的那根上是否已有值。受限模式的具体后果，不是另一个开关 */
  bbwPercentileReady: boolean
  /** 面板提示用；null 表示数据充分，无需提示 */
  note: string | null
}

export function assessSufficiency(
  bars: number,
  bbwPct: Series,
  index: number,
  params: SufficiencyParams
): DataSufficiency {
  const bbwPercentileReady = at(bbwPct, index) !== null

  if (bars < params.minBars) {
    return {
      bars,
      usable: false,
      limited: true,
      penalty: params.insufficientPenalty,
      bbwPercentileReady,
      note: `日线仅 ${bars} 根（需 ${params.minBars} 根），暂不产出信号`,
    }
  }

  if (bars < params.fullBars || !bbwPercentileReady) {
    return {
      bars,
      usable: true,
      limited: true,
      penalty: params.insufficientPenalty,
      bbwPercentileReady,
      note: `日线 ${bars} 根（全功能需 ${params.fullBars} 根），数据不足，信号可靠性降低`,
    }
  }

  return { bars, usable: true, limited: false, penalty: 1, bbwPercentileReady, note: null }
}
