/**
 * 报告组装与参数标定（docs/07 §2.2、§3）。
 *
 * 两处「不许自欺」的地方在这里守住：
 *   - 报告必须带免责声明与告警（交易笔数不足、缺基准、期末仍持仓）
 *   - 标定必须用**验证集**排名，且没有候选通过红线时不许推荐任何参数
 */

import { describe, expect, it } from 'vitest'
import {
  DISCLAIMERS,
  assembleReport,
  attributeByRegime,
  mergeEquity,
  performanceOf,
  renderReport,
  type PerformanceBlock,
} from '@backtest/report'
import {
  DEFAULT_SPLITS,
  calibrate,
  calmar,
  expandGrid,
  renderCalibration,
  sensitivityFlags,
  warmupForSplit,
  type Split,
  type SplitRun,
} from '@backtest/calibrate'
import { DEFAULT_PARAMS } from '@core/params'
import type { BacktestTrade, CodeResult } from '@backtest/simulate'
import type { Regime, TradeDate } from '@core/types'

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    code: 'SH600000',
    entryDate: '2024-01-02',
    exitDate: '2024-01-05',
    entryPrice: 10,
    exitPrice: 11,
    entryPriceRaw: 10,
    exitPriceRaw: 11,
    shares: 1000,
    pnl: 1000,
    pnlPct: 0.1,
    holdingBars: 3,
    costs: 30,
    regimeAtEntry: 'TREND_UP',
    barsInRegimeAtEntry: 5,
    entryScore: 0.8,
    entrySignals: ['T1_MA_CROSS'],
    exitRule: 'T1_MA_CROSS',
    partial: false,
    ...overrides,
  }
}

function codeResult(overrides: Partial<CodeResult> = {}): CodeResult {
  return {
    code: 'SH600000',
    equity: [
      { date: '2024-01-02', equity: 100_000, benchmark: null },
      { date: '2024-01-03', equity: 105_000, benchmark: null },
    ],
    trades: [trade()],
    evaluations: 10,
    actionable: 2,
    suppressed: new Map([['HARD_LIMIT_UP', 2]]),
    limitBlocked: 1,
    gapSkipped: 0,
    regimeBars: new Map<Regime, number>([['TREND_UP', 8]]),
    openPosition: false,
    delistedClose: false,
    ...overrides,
  }
}

describe('净值合并', () => {
  it('多只标的按日期并集相加', () => {
    const a = codeResult()
    const b = codeResult({
      code: 'SZ000001',
      equity: [
        { date: '2024-01-02', equity: 100_000, benchmark: null },
        { date: '2024-01-03', equity: 90_000, benchmark: null },
      ],
    })
    const merged = mergeEquity([a, b])
    expect(merged).toHaveLength(2)
    expect(merged[1]?.equity).toBe(195_000)
  })

  it('某只当日缺 K 线时用前值填充 —— 停牌期间那部分资金还在，净值不该缩水', () => {
    const a = codeResult({
      equity: [
        { date: '2024-01-02', equity: 100_000, benchmark: null },
        { date: '2024-01-04', equity: 110_000, benchmark: null },
      ],
    })
    const b = codeResult({
      code: 'SZ000001',
      equity: [
        { date: '2024-01-02', equity: 100_000, benchmark: null },
        { date: '2024-01-03', equity: 100_000, benchmark: null },
        { date: '2024-01-04', equity: 100_000, benchmark: null },
      ],
    })
    const merged = mergeEquity([a, b])
    expect(merged.map((p) => p.date)).toEqual(['2024-01-02', '2024-01-03', '2024-01-04'])
    expect(merged[1]?.equity).toBe(200_000)
  })

  it('基准归一化到起点，缺失日为 null', () => {
    const benchmark = new Map<TradeDate, number>([
      ['2024-01-02', 4000],
      ['2024-01-03', 4200],
    ])
    const merged = mergeEquity([codeResult()], benchmark)
    expect(merged[0]?.benchmark).toBeCloseTo(1, 10)
    expect(merged[1]?.benchmark).toBeCloseTo(1.05, 10)
  })
})

describe('绩效块与分状态归因', () => {
  it('总收益、基准与超额', () => {
    const equity = mergeEquity(
      [codeResult()],
      new Map<TradeDate, number>([
        ['2024-01-02', 4000],
        ['2024-01-03', 4040],
      ])
    )
    const block = performanceOf(equity, [trade()])
    expect(block.totalReturn).toBeCloseTo(0.05, 10)
    expect(block.benchmarkReturn).toBeCloseTo(0.01, 10)
    expect(block.excessReturn).toBeCloseTo(0.04, 10)
  })

  it('缺基准时超额与信息比率为 null（不以 0 代替）', () => {
    const block = performanceOf(mergeEquity([codeResult()]), [trade()])
    expect(block.benchmarkReturn).toBeNull()
    expect(block.excessReturn).toBeNull()
    expect(block.informationRatio).toBeNull()
  })

  it('归因按建仓时的市场状态分组，四种状态都出现（没有交易也要有行）', () => {
    const rows = attributeByRegime(
      [trade(), trade({ regimeAtEntry: 'RANGE', pnl: -500, pnlPct: -0.05 })],
      [codeResult()]
    )
    expect(rows.map((r) => r.regime)).toEqual(['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION'])
    expect(rows.find((r) => r.regime === 'TREND_UP')?.trades).toBe(1)
    expect(rows.find((r) => r.regime === 'RANGE')?.winRate).toBe(0)
    expect(rows.find((r) => r.regime === 'TREND_DOWN')?.trades).toBe(0)
  })
})

describe('报告组装', () => {
  const meta = {
    engineVersion: '0.2.0-unvalidated+abcdef12',
    paramsFingerprint: 'abcdef12',
    generatedAt: 0,
    codes: ['SH600000'],
    from: '2024-01-01',
    to: '2024-12-31',
    dataSource: 'fixtures:test',
    capitalPerCode: 100_000,
  }

  it('免责声明固定三条，并标出参数未标定', () => {
    const report = assembleReport({ results: [codeResult()], meta })
    expect(report.disclaimers).toEqual([...DISCLAIMERS])
    expect(report.meta.unvalidatedParams).toBe(true)
  })

  it('交易笔数不足 30 会告警（docs/07 §3 的红线之一）', () => {
    const report = assembleReport({ results: [codeResult()], meta })
    expect(report.warnings.join(' ')).toContain('30')
  })

  it('期末仍持仓与缺基准都会告警', () => {
    const report = assembleReport({ results: [codeResult({ openPosition: true })], meta })
    expect(report.warnings.join(' ')).toContain('未平仓')
    expect(report.warnings.join(' ')).toContain('基准')
  })

  it('抑制统计按次数降序', () => {
    const many = codeResult({
      suppressed: new Map([
        ['A', 1],
        ['B', 5],
      ]),
    })
    const report = assembleReport({ results: [many], meta })
    expect(report.suppressions[0]).toEqual({ rule: 'B', count: 5 })
  })

  // 这里曾有两条「固定 0.5/0.5 权重对照组」的用例。对照组在 2026-08-12 随权重表一起删除 ——
  // 权重表没了，对照组就是拿引擎和它自己比（M2 偏差报告 §5.5–§5.8）。

  it('渲染出的报告带免责声明与分状态归因', () => {
    const report = assembleReport({ results: [codeResult()], meta })
    const text = renderReport(report)
    expect(text).toContain('回测报告')
    expect(text).toContain('仅供参考，非投资建议')
    expect(text).toContain('分市场状态归因')
  })
})

describe('网格展开与排序分数', () => {
  it('笛卡尔积：2 × 3 = 6 组', () => {
    const combos = expandGrid({
      macd: [
        { fast: 12, slow: 17, signal: 9 },
        { fast: 12, slow: 26, signal: 9 },
      ],
      combine: [{ scoreThreshold: 0.5 }, { scoreThreshold: 0.6 }, { scoreThreshold: 0.72 }],
    })
    expect(combos).toHaveLength(6)
    expect(combos[0]).toHaveProperty('macd')
    expect(combos[0]).toHaveProperty('combine')
  })

  it('空网格给出一个空覆盖（即出厂参数本身）', () => {
    expect(expandGrid({})).toEqual([{}])
    expect(expandGrid({ macd: [] })).toEqual([{}])
  })

  it('Calmar：年化 / 最大回撤；零回撤且零交易不给 Infinity', () => {
    expect(calmar(block({ annualized: 0.2, maxDrawdown: 0.1 }))).toBeCloseTo(2, 10)
    expect(calmar(block({ annualized: 0.2, maxDrawdown: 0, trades: 0 }))).toBeNull()
    expect(calmar(block({ annualized: null }))).toBeNull()
    expect(calmar(block({ annualized: 0.2, maxDrawdown: 0, trades: 5 }))).toBeCloseTo(0.2, 10)
  })

  it('邻域敏感性：邻域断崖下跌即标记为噪音峰值', () => {
    expect(sensitivityFlags(12, [{ value: 14, score: 0.1 }], 1).length).toBe(1)
    expect(sensitivityFlags(12, [{ value: 14, score: 0.9 }], 1)).toEqual([])
    expect(sensitivityFlags(12, [{ value: 14, score: null }], null)).toEqual([])
  })
})

function block(overrides: { annualized?: number | null; maxDrawdown?: number; trades?: number } = {}): PerformanceBlock {
  return {
    bars: 100,
    totalReturn: 0.2,
    annualized: overrides.annualized === undefined ? 0.2 : overrides.annualized,
    maxDrawdown: overrides.maxDrawdown ?? 0.1,
    drawdownBars: 5,
    drawdownRecoveryBars: 10,
    sharpe: 1,
    benchmarkReturn: null,
    excessReturn: null,
    informationRatio: null,
    exposure: 0.2,
    trades: {
      count: overrides.trades ?? 50,
      wins: 30,
      losses: 20,
      winRate: 0.6,
      profitFactor: 1.5,
      avgPnlPct: 0.02,
      weightedPnlPct: 0.02,
      avgHoldingBars: 4,
      totalPnl: 20_000,
      totalCosts: 500,
    },
    positions: {
      count: 30,
      wins: 15,
      winRate: 0.5,
      avgPnl: 660,
      avgReturn: 0.0066,
      payoffRatio: 1.4,
      reduced: 12,
    },
  }
}

/** 这一组只测红线与排名口径；折与三态裁决在 calibrate-folds.test.ts */
function splitRun(overall: PerformanceBlock): SplitRun {
  return { overall, cells: [] }
}

describe('标定流程（docs/07 §3）', () => {
  const splits: Split[] = [
    { name: 'train', from: '2018-01-01', to: '2023-12-31' },
    { name: 'validation', from: '2024-01-01', to: '2025-06-30' },
    { name: 'test', from: '2025-07-01', to: '2026-06-30' },
  ]

  it('交易笔数不足的候选直接淘汰，且不跑验证集', () => {
    const seen: string[] = []
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: 0.9 } }],
      base: DEFAULT_PARAMS,
      splits,
      run: (_params, split) => {
        seen.push(split.name)
        return splitRun(block({ trades: 3 }))
      },
    })
    // 出厂值那一行是工具自动补的（配对比较的基准），所以 train 会被跑两次；
    // 这条用例守的是「淘汰在训练集就发生」——验证集一次都不该被碰
    expect(seen).toEqual(['train', 'train'])
    expect(report.candidates.find((c) => !c.incumbent)?.rejected).toContain('3 笔')
    expect(report.winner).toBeNull()
  })

  /**
   * 排名口径是验证集，这本身是对的（用训练集排名等于直接过拟合），
   * 但它留了个盲区：训练集亏钱、验证集正好赚钱的候选会排到很前面。
   * 2026-08-12 标定 combine 块时 `voteThreshold.meanReversion = 1` 就这样排到第 2（M2 §5.14）。
   */
  it('训练集年化为负的候选直接淘汰，且不跑验证集 —— 验证集再好也只是窗口运气', () => {
    const seen: string[] = []
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: 0.5 } }],
      base: DEFAULT_PARAMS,
      splits,
      run: (_params, split) => {
        seen.push(split.name)
        return splitRun(
          split.name === 'train'
            ? block({ annualized: -0.04, maxDrawdown: 0.2 })
            : block({ annualized: 0.3, maxDrawdown: 0.1 })
        )
      },
    })
    expect(seen).toEqual(['train', 'train'])
    expect(report.candidates.find((c) => !c.incumbent)?.rejected).toContain('训练集年化为负')
    expect(report.winner).toBeNull()
  })

  it('验证集年化为负的候选被淘汰', () => {
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: 0.5 } }],
      base: DEFAULT_PARAMS,
      splits,
      run: (_params, split) =>
        splitRun(split.name === 'train' ? block({ annualized: 0.5 }) : block({ annualized: -0.2 })),
    })
    expect(report.candidates[0]?.rejected).toContain('验证集')
    expect(report.winner).toBeNull()
  })

  it('验证集相对训练集断崖衰减 → 标记疑似过拟合，且不当优胜者', () => {
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: 0.5 } }],
      base: DEFAULT_PARAMS,
      splits,
      run: (_params, split) =>
        splitRun(
          split.name === 'train'
            ? block({ annualized: 0.6, maxDrawdown: 0.1 })
            : block({ annualized: 0.05, maxDrawdown: 0.1 })
        ),
    })
    expect(report.candidates[0]?.flags.join(' ')).toContain('过拟合')
    expect(report.winner).toBeNull()
    expect(report.notes.join(' ')).toContain('过拟合')
  })

  /**
   * 排名口径没变（仍是验证集 Calmar），但**优胜者**多了一道配对门槛：
   * 没有折就估不出离散度，于是不给优胜者、裁决 INCONCLUSIVE。
   * 以前这里会直接把分数最高的那组报成优胜者并顺手跑一遍测试集 —— 那是 docs/07 §3 ④
   * 累计被触碰 5 次的直接原因，而那 5 次的优胜者几乎全都最终没被采用。
   */
  it('排名仍按验证集 Calmar，但没有折时不给优胜者、不碰测试集', () => {
    const seen: string[] = []
    const report = calibrate({
      candidates: [{ combine: { scoreThreshold: 0.5 } }, { combine: { scoreThreshold: 0.55 } }],
      base: DEFAULT_PARAMS,
      splits,
      run: (params, split) => {
        seen.push(split.name)
        // 0.55 那组在验证集上更好
        const better = params.combine.scoreThreshold === 0.55
        const annualized = split.name === 'validation' ? (better ? 0.3 : 0.15) : 0.3
        return splitRun(block({ annualized, maxDrawdown: 0.1 }))
      },
    })
    const ranked = [...report.candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    expect(ranked[0]?.overrides).toEqual({ combine: { scoreThreshold: 0.55 } })
    expect(report.verdict).toBe('INCONCLUSIVE')
    expect(report.winner).toBeNull()
    expect(seen).not.toContain('test')
    expect(report.test).toBeNull()
  })

  it('没有训练集区间时直接抛错（配置错了要早发现）', () => {
    expect(() =>
      calibrate({ candidates: [{}], base: DEFAULT_PARAMS, splits: [], run: () => splitRun(block()) })
    ).toThrow(/训练集/)
  })

  it('报告里明确写着「工具不自动改 params.ts」', () => {
    const report = calibrate({
      candidates: [{}],
      base: DEFAULT_PARAMS,
      splits,
      run: () => splitRun(block()),
    })
    expect(report.notes.join(' ')).toContain('不自动改文件')
    expect(renderCalibration(report)).toContain('参数标定报告')
  })

  it('默认切分与 docs/07 §3 一致（训练 / 验证 / 测试三段，互不重叠）', () => {
    expect(DEFAULT_SPLITS.map((s) => s.name)).toEqual(['train', 'validation', 'test'])
    for (let i = 1; i < DEFAULT_SPLITS.length; i++) {
      const previousEnd = DEFAULT_SPLITS[i - 1]?.to ?? ''
      const currentStart = DEFAULT_SPLITS[i]?.from ?? ''
      expect(currentStart > previousEnd, `${currentStart} 应晚于 ${previousEnd}`).toBe(true)
    }
  })
})

/**
 * 这一组守的是「三段切分是否真的在判定那三段」。
 *
 * 曾经的实现把每段单独切出来喂引擎，于是 300 根预热在每段内部重来一遍：
 * 测试集只有 272 根 < 300 根预热 → 恒为 0 笔交易，而报告上看起来像「策略不出信号」。
 * 这类错误不会抛异常、不会让测试变红，只会让标定结论静静地变成噪音。
 */
describe('warmupForSplit', () => {
  const dates = (from: number, count: number): TradeDate[] =>
    Array.from({ length: count }, (_, i) => `2018-01-${String(from + i).padStart(2, '0')}` as TradeDate)

  it('段前历史充足时，预热到 split.from 为止 —— 判定从该段第一天开始', () => {
    const all = dates(1, 20)
    expect(warmupForSplit(all, { from: '2018-01-11' }, 3)).toBe(10)
  })

  it('段前历史不足 floor 时退回 floor，不会因为「段前只有 2 根」就只预热 2 根', () => {
    const all = dates(1, 20)
    expect(warmupForSplit(all, { from: '2018-01-03' }, 8)).toBe(8)
  })

  it('段起点早于全部数据（训练集常见）时等于 floor', () => {
    const all = dates(5, 10)
    expect(warmupForSplit(all, { from: '2018-01-01' }, 6)).toBe(6)
  })

  it('回归：测试集短于预热时，判定根数不再恒为 0', () => {
    // 1816 根历史 + 272 根测试段，预热 300
    const history = Array.from({ length: 1816 }, (_, i) => `1${String(i).padStart(6, '0')}` as TradeDate)
    const test = Array.from({ length: 272 }, (_, i) => `2${String(i).padStart(6, '0')}` as TradeDate)
    const warmup = warmupForSplit([...history, ...test], { from: '2000000' }, 300)
    expect(warmup).toBe(1816)
    expect(history.length + test.length - warmup).toBe(272)
  })
})
