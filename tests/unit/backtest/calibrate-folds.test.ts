/**
 * 标定的**判据**（docs/07 §3、M2 §5.15）。
 *
 * 这个文件守的不是「算得对不对」，而是「**结论下得对不对**」。
 * 2026-08-12 之前的标定工具只回答「验证集 Calmar 最高的是谁」，跑了十一轮、
 * 二十来个参数里只写回一个 —— 每一轮都是工具给出优胜者、人看表否掉。
 * 所以下面每一条用例都对应一次真实发生过的误判：
 *
 * - 孤峰当成优胜者 → §5.14 的 `voteThreshold.trend = 4`（0.887，两侧 0.427 / −0.233）
 * - 网格边界当成最优 → §5.10 扩网格重跑，代价是多看一次测试窗口
 * - 差值在噪音带里却排第一 → §5.13 的 ±1pp 与「正负交替」
 * - 「没有候选够格」被读成标定失败 → docs/08 那一格挂了十一轮
 */

import { describe, expect, it } from 'vitest'
import {
  calibrate,
  changedLeaves,
  clusteredStderrOf,
  codeGroups,
  effectiveT,
  pairedDelta,
  timeSlices,
  type PairedDelta,
  type Split,
  type SplitRun,
} from '@backtest/calibrate'
import type { PerformanceBlock } from '@backtest/report'
import { DEFAULT_PARAMS } from '@core/params'
import type { TradeDate } from '@core/types'

const splits: Split[] = [
  { name: 'train', from: '2018-01-01', to: '2023-12-31' },
  { name: 'validation', from: '2024-01-01', to: '2025-06-30' },
  { name: 'test', from: '2025-07-01', to: '2026-06-30' },
]

/**
 * 回撤固定 1 ⇒ Calmar 恒等于年化，而折上比的量是总收益（`cellScore`），
 * 两处都填同一个数，于是用例里可以直接写「这一折的分数」。
 */
function block(annualized: number | null, trades = 50): PerformanceBlock {
  return {
    bars: 300,
    totalReturn: annualized ?? 0,
    annualized,
    maxDrawdown: 1,
    drawdownBars: 5,
    drawdownRecoveryBars: null,
    sharpe: 1,
    sharpeNet: null,
    benchmarkReturn: null,
    excessReturn: null,
    excessReturnRatio: null,
    informationRatio: null,
    exposure: 0.04,
    beta: null,
    trades: {
      count: trades,
      wins: 20,
      losses: 30,
      winRate: 0.4,
      profitFactor: 1.5,
      avgPnlPct: 0.01,
      weightedPnlPct: 0.01,
      avgHoldingBars: 5,
      totalPnl: 1000,
      totalCosts: 100,
    },
    positions: {
      count: 10,
      wins: 5,
      winRate: 0.5,
      avgPnl: 100,
      avgReturn: 0.01,
      payoffRatio: 1.4,
      reduced: 5,
    },
  }
}

function run(overall: number | null, cells: readonly (number | null)[], trades = 50): SplitRun {
  return {
    overall: block(overall, trades),
    cells: cells.map((score, i) => ({ name: `c${i + 1}`, block: block(score, score === null ? 0 : 10) })),
  }
}

/** 出厂值在 `combine.scoreThreshold` 上的取值 —— OFAT 候选的中心，也是每个候选的一侧邻居 */
const CENTRE = String(DEFAULT_PARAMS.combine.scoreThreshold)

/**
 * 按 `combine.scoreThreshold` 建一组 OFAT 候选，每个候选给定「整池分数 + 逐折分数」。
 * 表里不写出厂值那一行时给它一个平淡的基线（工具会自动把它补进候选表）。
 */
function calibrateThresholds(
  table: Record<string, { overall: number; cells: number[] }>,
  options: { touchTest?: boolean; seen?: string[] } = {}
) {
  const rows: Record<string, { overall: number; cells: number[] }> = {
    [CENTRE]: { overall: 0.1, cells: [0.1, 0.1, 0.1, 0.1] },
    ...table,
  }
  return calibrate({
    candidates: Object.keys(table).map((value) => ({ combine: { scoreThreshold: Number(value) } })),
    base: DEFAULT_PARAMS,
    splits,
    ...(options.touchTest === undefined ? {} : { touchTest: options.touchTest }),
    run: (params, split) => {
      options.seen?.push(split.name)
      const key = String(params.combine.scoreThreshold)
      const row = rows[key]
      if (!row) throw new Error(`用例没给 ${key} 的分数`)
      // 训练集一律给个健康的正分：这一组用例测的是验证集侧的判据
      if (split.name !== 'validation') return run(0.2, [])
      return run(row.overall, row.cells)
    },
  })
}

describe('出厂值永远在候选表里（配对比较的基准）', () => {
  it('网格里没写出厂值时自动补一行，且标成 incumbent', () => {
    const report = calibrateThresholds({
      '0.5': { overall: 0.3, cells: [0.3, 0.3, 0.3] },
    })
    expect(report.incumbent).not.toBeNull()
    expect(report.incumbent?.overrides).toEqual({})
    expect(report.candidates.filter((c) => c.incumbent)).toHaveLength(1)
  })

  it('网格里已经写了出厂值（OFAT 网格的中心行）时不重复跑', () => {
    const seen: string[] = []
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: DEFAULT_PARAMS.combine.scoreThreshold } }],
      base: DEFAULT_PARAMS,
      splits,
      run: (params, split) => {
        if (split.name === 'train') seen.push(String(params.combine.scoreThreshold))
        return run(0.2, [0.2, 0.2, 0.2])
      },
    })
    expect(seen).toEqual([String(DEFAULT_PARAMS.combine.scoreThreshold)])
    expect(report.incumbent?.incumbent).toBe(true)
  })
})

describe('逐折配对比较', () => {
  it('只在两边都有分数的折上算差值，缺分数的折跳过', () => {
    const delta = pairedDelta([0.3, null, 0.5, 0.4], [0.1, 0.2, null, 0.2])
    expect(delta?.cells).toBe(2)
    expect(delta?.mean).toBeCloseTo(0.2, 10)
    expect(delta?.wins).toBe(2)
  })

  it('正负交替 ⇒ 均值接近 0、t 很小 —— 这就是项目一直在口头上用的「噪音」判据', () => {
    const delta = pairedDelta([0.3, -0.3, 0.28, -0.26], [0, 0, 0, 0])
    expect(Math.abs(delta?.mean ?? 1)).toBeLessThan(0.02)
    expect(delta?.t ?? 99).toBeLessThan(1)
  })

  it('一折都对不上时给 null，不给 0 —— 0 会被读成「没有差别」', () => {
    expect(pairedDelta([null, null], [0.1, 0.2])).toBeNull()
  })

  /**
   * 逐折 Δ 完全相同时**估不出离散度**，于是没有 t —— 而不是 t = ∞。
   *
   * 真实数据里不会出现这个形状：四折是四批标的 × 四段行情，改一个阈值不可能在每折上
   * 带来同一个改进量。出现了就说明折不是四次独立测量（重复的 cell、参数其实惰性、
   * 或者 fixture 是手写的）。**合成用例最容易踩**：随手写 0.3 / 0.4 两行，
   * 差值恒为 0.1，stderr 只剩浮点误差 ——「t = 6e15」这种数就是这么来的，
   * 它看着极显著，其实一个比特的信息都没有。
   */
  it('逐折 Δ 恒等 ⇒ stderr 与 t 都是 null，不许当成「无穷显著」', () => {
    const delta = pairedDelta([0.3, 0.3, 0.3], [0.2, 0.2, 0.2])
    expect(delta?.cells).toBe(3)
    expect(delta?.mean).toBeCloseTo(0.1, 10)
    expect(delta?.stderr).toBeNull()
    expect(delta?.t).toBeNull()
  })
})

/**
 * 一片高原：0.5 / 0.55 / 出厂 0.6 / 0.65 逐档下行，0.55 处最高但没有任何一档塌掉。
 * 逐折看 0.55 稳定优于出厂值（每折都赢、幅度远大于折间抖动）——
 * 这就是 §5.10 里 `squeezeBbwPct` 16–30 那片高原的形状。
 *
 * **折与折之间的 Δ 必须真的抖一下**（这里是 0.11 / 0.11 / 0.09 / 0.11）。
 * 早先这张表让 0.55 每折都恰好比出厂值高 0.10，于是 stderr 只剩浮点误差、
 * t ≈ 6e15，用例是绿的但测的是 IEEE754 而不是判据 —— 换一组「减得尽」的数
 * （出厂值四折全填 0.2）就会 stderr = 0 → t = null → 裁决无声地变成 KEEP。
 */
const PLATEAU = {
  '0.5': { overall: 0.36, cells: [0.34, 0.37, 0.35, 0.36] },
  '0.55': { overall: 0.4, cells: [0.39, 0.41, 0.38, 0.42] },
  [CENTRE]: { overall: 0.3, cells: [0.28, 0.3, 0.29, 0.31] },
  '0.65': { overall: 0.2, cells: [0.18, 0.2, 0.19, 0.21] },
}

describe('三态裁决', () => {
  /**
   * WRITE_BACK 的形状：改进稳定（每折都赢）、幅度远大于折间抖动、且左右邻居都不塌。
   * 这正是 §5.10 里 `squeezeBbwPct` 10 → 20 那次人工判断的机器化版本。
   */
  it('WRITE_BACK：改进稳定且大于抖动、邻域是高原', () => {
    const report = calibrateThresholds(PLATEAU)
    expect(report.verdict).toBe('WRITE_BACK')
    expect(report.winner?.overrides).toEqual({ combine: { scoreThreshold: 0.55 } })
    expect(report.winner?.delta?.wins).toBe(4)
    // t 要是个**说得出口的量级**（这里约 21）。上界卡的是「fixture 的 Δ 恒等、
    // stderr 只剩浮点误差」那种假显著 —— 那时 t 是 1e15 量级
    expect(report.winner?.delta?.t ?? 0).toBeGreaterThan(2)
    expect(report.winner?.delta?.t ?? Infinity).toBeLessThan(1e3)
    expect(report.notes.join(' ')).toContain('仍需人工复核后写回')
  })

  /**
   * 上面那片高原把每折的 Δ 抖开了；这里是它的退化形 —— 每折 Δ 恰好相同。
   * 改进看着又大又稳（0.4 vs 0.3，四折全赢），但离散度估不出来，
   * 于是**不给优胜者**。合成 fixture 常写成这样，真实数据不会。
   */
  it('逐折 Δ 恒等的候选拿不到 WRITE_BACK —— 四折全赢也不算，因为估不出抖动', () => {
    const report = calibrateThresholds({
      '0.5': { overall: 0.36, cells: [0.36, 0.36, 0.36, 0.36] },
      '0.55': { overall: 0.4, cells: [0.4, 0.4, 0.4, 0.4] },
      [CENTRE]: { overall: 0.3, cells: [0.3, 0.3, 0.3, 0.3] },
      '0.65': { overall: 0.2, cells: [0.2, 0.2, 0.2, 0.2] },
    })
    const peak = report.candidates.find((c) => c.changed[0]?.value === 0.55)
    expect(peak?.delta?.wins).toBe(4)
    expect(peak?.delta?.t).toBeNull()
    expect(report.winner).toBeNull()
    expect(report.verdict).toBe('KEEP')
  })

  /**
   * KEEP 是**结论**，不是「没跑出来」。
   * docs/08 那一格挂了十一轮，很大一部分是因为工具只能把这种情况表达成 `winner: null`。
   */
  it('KEEP：改进方向正负交替 ⇒ 不推荐写回，且给出「要多少折才分辨得出」', () => {
    // 三个候选的整池分数都比出厂值（0.1）高一点，但逐折一看全是正负交替
    const report = calibrateThresholds({
      '0.5': { overall: 0.32, cells: [0.6, -0.3, 0.5, -0.2] },
      '0.55': { overall: 0.31, cells: [-0.3, 0.55, -0.25, 0.45] },
      '0.65': { overall: 0.29, cells: [0.5, -0.2, 0.1, -0.15] },
    })
    expect(report.verdict).toBe('KEEP')
    expect(report.winner).toBeNull()
    expect(report.notes.join(' ')).toContain('这是结论')
    expect(report.resolution?.requiredCells).toBeGreaterThan(report.resolution?.cells ?? 0)
  })

  /**
   * KEEP 有两种强度，报告必须分开说 —— 否则会把「有正面证据」读成「测不出差别」，
   * 白扔掉这个项目最缺的那种证据：
   * ① `combine` 块：15 个候选全部 t < 1.5，出厂值只是没被推翻（M2 §5.15）；
   * ② `adx`/`regime`：6 个候选显著更差、t 最高 4.1，**往任一方向动都有代价**（M2 §5.16）。
   */
  it('KEEP 且有候选显著更差 ⇒ 额外说明「出厂值不是随便取的也一样」', () => {
    const report = calibrateThresholds({
      // 稳定地差一截：t 很大，方向朝下
      '0.5': { overall: 0.3, cells: [0.02, 0.0, 0.01, 0.03] },
      // 正负交替：够不着写回门槛
      '0.55': { overall: 0.31, cells: [0.6, -0.3, 0.5, -0.2] },
    })
    expect(report.verdict).toBe('KEEP')
    const notes = report.notes.join(' ')
    expect(notes).toContain('显著更差')
    expect(notes).toContain('正面证据')
  })

  it('INCONCLUSIVE：出厂值自己被红线淘汰时，KEEP 与 WRITE_BACK 都不能说', () => {
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: 0.5 } }],
      base: DEFAULT_PARAMS,
      splits,
      // 出厂值在训练集上只有 3 笔 → 淘汰；挑战者健康
      run: (params, split) => {
        const incumbent = params.combine.scoreThreshold === DEFAULT_PARAMS.combine.scoreThreshold
        if (split.name === 'train') return run(0.2, [], incumbent ? 3 : 50)
        return run(0.3, [0.3, 0.3, 0.3])
      },
    })
    expect(report.verdict).toBe('INCONCLUSIVE')
    expect(report.incumbent?.rejected).toContain('3 笔')
  })

  it('INCONCLUSIVE：折数不足 3 时不下结论（离散度估不出来）', () => {
    const report = calibrateThresholds({
      [CENTRE]: { overall: 0.1, cells: [0.1, 0.1] },
      '0.5': { overall: 0.9, cells: [0.9, 0.9] },
      '0.55': { overall: 0.8, cells: [0.8, 0.8] },
    })
    expect(report.verdict).toBe('INCONCLUSIVE')
  })
})

/**
 * 折间相关性（迭代计划 §4.6，2026-08-19）。
 *
 * `stdev(Δ)/√n` 的 √n 收敛只在折独立时成立，而 12 个折单元是 4 个标的子集 × 3 个时间片、
 * **从同一次模拟里切出来的**：同一片里的四个子集共享那段行情的市场 beta（A 股同涨同跌），
 * 它们不是四份独立信息。于是朴素 t 系统性偏大。
 *
 * 这一组用例守的是**判据本身**，不是算术：下面第一条与第二条喂的是**逐位相同的分数**，
 * 差别只有「有没有告诉工具哪些折属于同一个时间片」，而裁决从 WRITE_BACK 翻成 KEEP。
 * 这正是 §4.6 要修的那件事 —— 它咬的是未来那个 t = 2.1 勉强过线的候选。
 */
describe('折间相关性：聚类稳健标准误（§4.6）', () => {
  /** 逐折 Δ 在**片内恒定、片间不同** —— 横截面完全同步的极端形，也是最能说明问题的形状 */
  const INCUMBENT_CELLS = [
    0.28, 0.3, 0.29, 0.31, // p1
    0.27, 0.31, 0.3, 0.28, // p2
    0.29, 0.28, 0.32, 0.3, // p3
  ]
  const PER_SLICE_DELTA = [0.03, 0.012, 0.001]
  const CHALLENGER_CELLS = INCUMBENT_CELLS.map(
    (v, i) => v + (PER_SLICE_DELTA[Math.floor(i / 4)] ?? 0)
  )

  /** 12 折 = 4 子集 × 3 时间片；`clustered` 决定要不要给聚类标签 */
  function runCells(overall: number, cells: readonly number[], clustered: boolean): SplitRun {
    return {
      overall: block(overall),
      cells: cells.map((score, i) => ({
        name: `g${(i % 4) + 1}/p${Math.floor(i / 4) + 1}`,
        ...(clustered ? { cluster: `p${Math.floor(i / 4) + 1}` } : {}),
        block: block(score, 10),
      })),
    }
  }

  function report(clustered: boolean) {
    const rows: Record<string, { overall: number; cells: readonly number[] }> = {
      // 0.5 与 0.65 只为让 0.55 两侧都有不塌的邻居（否则会被判孤峰 / 边界）
      '0.5': { overall: 0.36, cells: INCUMBENT_CELLS.map((v) => v + 0.004) },
      '0.55': { overall: 0.4, cells: CHALLENGER_CELLS },
      [CENTRE]: { overall: 0.3, cells: INCUMBENT_CELLS },
      '0.65': { overall: 0.25, cells: INCUMBENT_CELLS.map((v) => v - 0.01) },
    }
    return calibrate({
      candidates: ['0.5', '0.55', '0.65'].map((v) => ({
        combine: { scoreThreshold: Number(v) },
      })),
      base: DEFAULT_PARAMS,
      splits,
      run: (params, split) => {
        const row = rows[String(params.combine.scoreThreshold)]
        if (!row) throw new Error(`用例没给 ${params.combine.scoreThreshold} 的分数`)
        if (split.name !== 'validation') return run(0.2, [])
        return runCells(row.overall, row.cells, clustered)
      },
    })
  }

  it('没有聚类标签时，同一份分数会给出 WRITE_BACK —— 这是修之前的行为', () => {
    const naive = report(false)
    expect(naive.verdict).toBe('WRITE_BACK')
    expect(naive.winner?.overrides).toEqual({ combine: { scoreThreshold: 0.55 } })
    // 朴素 t 把 12 折当成 12 份独立信息 ⇒ 轻松过 2
    expect(naive.winner?.delta?.t ?? 0).toBeGreaterThan(3)
    expect(naive.winner?.delta?.clusters).toBeNull()
  })

  it('**同一份分数**加上聚类标签之后翻成 KEEP —— 折不独立，改进过不了门槛', () => {
    const adjusted = report(true)
    const peak = adjusted.candidates.find((c) => c.changed[0]?.value === 0.55)
    expect(peak?.delta?.clusters).toBe(3)
    // 朴素值不变（保留是为了与历史报告可比），判据换成聚类值之后掉到 2 以下
    expect(peak?.delta?.t ?? 0).toBeGreaterThan(3)
    expect(peak?.delta?.clusteredT ?? 99).toBeLessThan(2)
    expect(adjusted.winner).toBeNull()
    expect(adjusted.verdict).toBe('KEEP')
  })

  /**
   * 等大簇时 CR1 恰好化简为「簇均值的标准误」。
   * 这条把公式钉死，也是上面那个翻转的算术依据：横截面折只让每个簇均值更稳，
   * **不增加独立样本数**。
   */
  it('等大簇 ⇒ 聚类标准误 = stdev(簇均值)/√G，横截面折不贡献 √n', () => {
    const deltas = [1, 1, 1, 1, 3, 3, 3, 3, 5, 5, 5, 5]
    const labels = deltas.map((_, i) => `p${Math.floor(i / 4) + 1}`)
    const { stderr, clusters } = clusteredStderrOf(deltas, labels)
    expect(clusters).toBe(3)
    // 簇均值 1/3/5 ⇒ 样本标准差 2 ⇒ 标准误 2/√3
    expect(stderr ?? 0).toBeCloseTo(2 / Math.sqrt(3), 10)
    // 朴素式子会给出小得多的数（同一份 Δ，12 个样本）
    const naive = pairedDelta(deltas, deltas.map(() => 0))
    expect(naive?.stderr ?? 9).toBeLessThan(stderr ?? 0)
  })

  it('簇数 < 2 ⇒ 给不出聚类标准误，不许悄悄退回朴素值当判据', () => {
    const { stderr, clusters } = clusteredStderrOf([1, 2, 3], ['p1', 'p1', 'p1'])
    expect(clusters).toBe(1)
    expect(stderr).toBeNull()
    const delta = pairedDelta([1, 2, 3], [0, 0, 0], ['p1', 'p1', 'p1'])
    expect(delta?.clusteredT).toBeNull()
    // effectiveT 认「有标签」这件事，所以它跟着是 null —— 而不是回落到偏乐观的朴素 t
    expect(effectiveT(delta as PairedDelta)).toBeNull()
  })

  /**
   * §4.6 记的那条**报告缺陷**：打印 `|Δ|/stderr = 1.4` 时没有任何一行说它未做相关性调整。
   * 有条件地印等于让「没印」重新变成一种可能，所以这两条都断言**每次都印**。
   */
  it('报告每次都说清 t 调整了没有', () => {
    expect(report(true).notes.join(' ')).toContain('聚类稳健')
    expect(report(false).notes.join(' ')).toContain('未调整上界')
  })
})

describe('邻域（高原）自动判定 —— docs/07 §3 的敏感性红线', () => {
  /**
   * 回归 §5.14：`voteThreshold.trend = 4` 的验证集 Calmar 0.887 是第二名的 1.6 倍，
   * 但下侧邻居 3 是 0.427、上侧（2）是 −0.233。人工按「孤峰不采用」否掉了它，
   * 而当时三条红线一条都没拦住。现在这条判据在工具里。
   */
  it('孤峰被标记，不当优胜者', () => {
    const report = calibrateThresholds({
      // 0.55 自己很高，两侧（0.5 与出厂 0.6）都塌到不足一半
      '0.5': { overall: 0.05, cells: [0.05, 0.05, 0.05, 0.05] },
      '0.55': { overall: 0.9, cells: [0.9, 0.92, 0.88, 0.91] },
    })
    const peak = report.candidates.find((c) => c.changed[0]?.value === 0.55)
    expect(peak?.flags.join(' ')).toContain('孤峰')
    expect(report.winner).toBeNull()
    expect(report.verdict).toBe('KEEP')
  })

  it('网格边界上的候选被标「该侧邻域未测」，而不是当成最优', () => {
    const report = calibrateThresholds({
      // 0.7 是网格上边界，没有上侧邻居可比
      '0.65': { overall: 0.3, cells: [0.3, 0.3, 0.3, 0.3] },
      '0.7': { overall: 0.5, cells: [0.5, 0.52, 0.48, 0.51] },
    })
    const edge = report.candidates.find((c) => c.changed[0]?.value === 0.7)
    expect(edge?.flags.join(' ')).toContain('邻域未测')
    expect(report.winner).toBeNull()
  })
})

describe('测试集预算', () => {
  const winnable = PLATEAU

  it('默认不跑测试集 —— docs/07 §3 ④ 的「只跑一次」以前被每次网格调用消耗一次', () => {
    const seen: string[] = []
    const report = calibrateThresholds(winnable, { seen })
    expect(report.verdict).toBe('WRITE_BACK')
    expect(seen).not.toContain('test')
    expect(report.test).toBeNull()
    expect(report.notes.join(' ')).toContain('测试集本次未跑')
  })

  it('--touch-test 才跑，且报告里明说要记一次触碰', () => {
    const seen: string[] = []
    const report = calibrateThresholds(winnable, { seen, touchTest: true })
    expect(report.verdict).toBe('WRITE_BACK')
    expect(seen).toContain('test')
    expect(report.test).not.toBeNull()
    expect(report.notes.join(' ')).toContain('记一次触碰')
  })
})

describe('changedLeaves', () => {
  it('只报真正与出厂值不同的叶子 —— 网格里照抄的那些不算改动', () => {
    const leaves = changedLeaves(
      {
        combine: {
          scoreThreshold: DEFAULT_PARAMS.combine.scoreThreshold,
          voteThreshold: { trend: 4, meanReversion: DEFAULT_PARAMS.combine.voteThreshold.meanReversion },
        },
      },
      DEFAULT_PARAMS
    )
    expect(leaves).toEqual([{ path: 'combine.voteThreshold.trend', value: 4 }])
  })

  it('出厂参数本身给空数组', () => {
    expect(changedLeaves({}, DEFAULT_PARAMS)).toEqual([])
  })
})

describe('折的切法', () => {
  it('标的按代码升序轮转分组 —— 切段会让某一折全是创业板', () => {
    const groups = codeGroups(['SH600000', 'SH600001', 'SZ300001', 'SZ300002'], 2)
    expect(groups).toEqual([
      ['SH600000', 'SZ300001'],
      ['SH600001', 'SZ300002'],
    ])
  })

  it('折数超过标的数时退化为每折一只，不产出空折', () => {
    expect(codeGroups(['SH600000'], 4)).toEqual([['SH600000']])
  })

  it('时间片按交易日等分且首尾相接、不重叠', () => {
    const dates = Array.from({ length: 10 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}` as TradeDate)
    const slices = timeSlices(dates, 3)
    expect(slices).toHaveLength(3)
    expect(slices[0]?.from).toBe('2024-01-01')
    expect(slices[2]?.to).toBe('2024-01-10')
    for (let i = 1; i < slices.length; i++) {
      expect((slices[i]?.from ?? '') > (slices[i - 1]?.to ?? '')).toBe(true)
    }
  })
})
