/**
 * 参数标定（docs/07 §3）。
 *
 * ```
 * ① 划分数据：训练 / 验证 / 测试三段
 * ② 在训练集上跑粗网格
 * ③ 在验证集上筛掉过拟合候选（训练好、验证崩的直接淘汰）
 * ④ 测试集只跑一次，作为最终报告，不允许据此回头调参
 * ⑤ 入选参数写入 src/core/params.ts，engine_version +1，CHANGELOG 记录依据
 * ```
 *
 * 本文件负责 ①–④。**⑤ 是人的动作**：工具不自动改 params.ts。
 * 自动写回会让「出厂默认值从哪来」变成一个没人复核过的黑箱，而 ADR-0003 的整个立场
 * 就是不接受未经复核的数值。
 *
 * 三条过拟合红线也在这里执行（docs/07 §3）：
 *   - 交易次数 < 30 笔 → 直接淘汰
 *   - 验证集绩效相对训练集断崖下跌 → 标记为疑似过拟合
 *   - 邻域敏感性：最优参数 ±20% 的绩效若崩塌 → 标记为噪音峰值
 */

import { paramsFingerprint, withParams, type EngineParams, type ParamOverrides } from '../core/params'
import type { TradeDate } from '../core/types'
import type { PerformanceBlock } from './report'

export interface GridSpec {
  /** 块名 → 该块的候选取值列表。例：`{ "macd": [{fast:12,slow:17,signal:9}, …] }` */
  [block: string]: Record<string, unknown>[]
}

/** 笛卡尔积展开。块内是整体替换，与 withParams 的语义一致 */
export function expandGrid(spec: GridSpec): ParamOverrides[] {
  const blocks = Object.entries(spec).filter(([, values]) => values.length > 0)
  let combos: ParamOverrides[] = [{}]
  for (const [block, values] of blocks) {
    const next: ParamOverrides[] = []
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [block]: value } as ParamOverrides)
      }
    }
    combos = next
  }
  return combos
}

export interface Split {
  name: 'train' | 'validation' | 'test'
  from: TradeDate
  to: TradeDate
}

/** docs/07 §3 的默认切分。测试集的 `to` 由 CLI 的 --to 覆盖 */
export const DEFAULT_SPLITS: readonly Split[] = [
  { name: 'train', from: '2018-01-01', to: '2023-12-31' },
  { name: 'validation', from: '2024-01-01', to: '2025-06-30' },
  { name: 'test', from: '2025-07-01', to: '2099-12-31' },
]

export interface Candidate {
  overrides: ParamOverrides
  fingerprint: string
  train: PerformanceBlock
  validation: PerformanceBlock | null
  /** 排名分数，越大越好 */
  score: number | null
  /** 淘汰原因；null 表示进入下一轮 */
  rejected: string | null
  flags: string[]
}

/**
 * 候选排序分数：**Calmar 比率**（年化 / 最大回撤）。
 *
 * 为什么不用年化本身：年化最高的那组几乎总是回撤最大的那组，据此定出厂参数
 * 等于把用户的账户押在「一次没赶上的回撤」上。为什么不用夏普：本策略持仓周期短、
 * 交易次数少，日频夏普对少数几笔大盈亏过于敏感。
 *
 * 回撤为 0（几乎没交易）不给 Infinity —— 那会让「什么都不做」排第一。
 */
export function calmar(block: PerformanceBlock): number | null {
  if (block.annualized === null) return null
  if (block.maxDrawdown <= 0) return block.trades.count === 0 ? null : block.annualized
  return block.annualized / block.maxDrawdown
}

export interface CalibrationInput {
  candidates: readonly ParamOverrides[]
  base: EngineParams
  /** 在指定区间上跑一次回测 */
  run(params: EngineParams, split: Split): PerformanceBlock
  splits: readonly Split[]
  /** 交易次数下限，低于此值直接淘汰（docs/07 §3） */
  minTrades?: number
  /** 验证集相对训练集的 Calmar 允许衰减比例，超过即标记疑似过拟合 */
  maxDecay?: number
  log?: (message: string) => void
}

export interface CalibrationReport {
  splits: Split[]
  candidates: Candidate[]
  /** 通过全部红线后 Calmar 最高的候选；无人通过时为 null */
  winner: Candidate | null
  /** 测试集只跑一次的结果（仅对 winner） */
  test: PerformanceBlock | null
  notes: string[]
}

export function calibrate(input: CalibrationInput): CalibrationReport {
  const minTrades = input.minTrades ?? 30
  const maxDecay = input.maxDecay ?? 0.5
  const log = input.log ?? ((): void => {})
  const train = input.splits.find((s) => s.name === 'train')
  const validation = input.splits.find((s) => s.name === 'validation')
  const test = input.splits.find((s) => s.name === 'test')
  if (!train) throw new Error('缺少训练集区间')

  const candidates: Candidate[] = []

  for (const [i, overrides] of input.candidates.entries()) {
    const params = withParams(overrides, input.base)
    const fingerprint = paramsFingerprint(params)
    log(`[calibrate] ${i + 1}/${input.candidates.length} ${fingerprint}`)

    const trainBlock = input.run(params, train)
    const flags: string[] = []

    if (trainBlock.trades.count < minTrades) {
      candidates.push({
        overrides,
        fingerprint,
        train: trainBlock,
        validation: null,
        score: null,
        rejected: `训练集仅 ${trainBlock.trades.count} 笔交易（< ${minTrades}）`,
        flags,
      })
      continue
    }

    const validationBlock = validation ? input.run(params, validation) : null
    const trainScore = calmar(trainBlock)
    const validationScore = validationBlock ? calmar(validationBlock) : null

    let rejected: string | null = null
    if (validationBlock && validationBlock.trades.count < Math.max(5, Math.floor(minTrades / 4))) {
      rejected = `验证集交易过少（${validationBlock.trades.count} 笔），无法判断稳定性`
    } else if (validationScore !== null && validationScore < 0) {
      rejected = '验证集年化为负，训练集表现不可信'
    } else if (
      trainScore !== null &&
      validationScore !== null &&
      trainScore > 0 &&
      validationScore < trainScore * (1 - maxDecay)
    ) {
      flags.push(
        `验证集 Calmar ${validationScore.toFixed(2)} 相对训练集 ${trainScore.toFixed(2)} 衰减超过 ${(
          maxDecay * 100
        ).toFixed(0)}%，疑似过拟合`
      )
    }

    candidates.push({
      overrides,
      fingerprint,
      train: trainBlock,
      validation: validationBlock,
      // 排名用**验证集**分数：训练集分数只用来筛交易次数，用它排名等于直接过拟合
      score: validationScore ?? trainScore,
      rejected,
      flags,
    })
  }

  const eligible = candidates
    .filter((c) => c.rejected === null && c.flags.length === 0 && c.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const winner = eligible[0] ?? null

  const notes: string[] = []
  if (!winner) {
    notes.push('没有候选参数通过全部红线 —— 出厂默认值应保持不变（ADR-0003）。')
  }
  if (candidates.some((c) => c.flags.length > 0)) {
    notes.push('有候选被标记为疑似过拟合，已排除在优胜者之外，但保留在报告中以备复核。')
  }
  notes.push('测试集只跑一次，且不允许据此回头调参（docs/07 §3 ④）。')
  notes.push('入选参数写回 src/core/params.ts 是人的动作，本工具不自动改文件。')

  const testBlock = winner && test ? input.run(withParams(winner.overrides, input.base), test) : null

  return { splits: [...input.splits], candidates, winner, test: testBlock, notes }
}

/**
 * 邻域敏感性检查（docs/07 §3 的第一条红线）。
 *
 * 把某个数值参数按 ±ratio 扰动后重跑，若绩效断崖下跌，说明落在噪音峰值上。
 * 交给调用方决定扰动哪些参数 —— 不是所有参数都适合线性扰动（比如 voteThreshold 是整数）。
 */
export function sensitivityFlags(
  center: number,
  neighbours: readonly { value: number; score: number | null }[],
  centerScore: number | null,
  cliffRatio = 0.5
): string[] {
  if (centerScore === null || centerScore <= 0) return []
  const flags: string[] = []
  for (const neighbour of neighbours) {
    if (neighbour.score === null || neighbour.score < centerScore * (1 - cliffRatio)) {
      flags.push(
        `邻域 ${neighbour.value}（中心 ${center}）绩效断崖下跌，最优点疑似噪音峰值，不宜采用`
      )
    }
  }
  return flags
}

export function renderCalibration(report: CalibrationReport): string {
  const lines: string[] = []
  lines.push('─'.repeat(64))
  lines.push('参数标定报告')
  for (const split of report.splits) {
    lines.push(`  ${split.name.padEnd(11)} ${split.from} → ${split.to}`)
  }
  lines.push('─'.repeat(64))
  lines.push('候选（按验证集 Calmar 排序）：')

  const sorted = [...report.candidates].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
  for (const candidate of sorted) {
    const label = JSON.stringify(candidate.overrides)
    const status = candidate.rejected
      ? `淘汰：${candidate.rejected}`
      : candidate.flags.length > 0
        ? `标记：${candidate.flags.join('；')}`
        : '通过'
    lines.push(`  ${candidate.fingerprint}  Calmar ${(candidate.score ?? 0).toFixed(2).padStart(7)}  ${status}`)
    lines.push(`      ${label}`)
  }

  lines.push('')
  if (report.winner) {
    lines.push(`优胜候选：${report.winner.fingerprint}  ${JSON.stringify(report.winner.overrides)}`)
    if (report.test) {
      lines.push(
        `测试集：总收益 ${(report.test.totalReturn * 100).toFixed(2)}%  回撤 ${(
          report.test.maxDrawdown * 100
        ).toFixed(2)}%  ${report.test.trades.count} 笔`
      )
    }
  } else {
    lines.push('优胜候选：无')
  }

  lines.push('')
  for (const note of report.notes) lines.push(`※ ${note}`)
  return lines.join('\n')
}
