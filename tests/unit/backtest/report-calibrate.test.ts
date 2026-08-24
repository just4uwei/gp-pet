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
  auditKnobs,
  mergeEquity,
  performanceOf,
  renderReport,
  type PerformanceBlock,
} from '@backtest/report'
import { DEFAULT_COSTS } from '@backtest/costs'
import { DEFAULT_SIMULATE_OPTIONS } from '@backtest/simulate'
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
import { DEFAULT_PARAMS, paramsFingerprint } from '@core/params'
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
    poolBlocked: 0,
    unaffordable: 0,
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
    // 除法版：(1+0.05)/(1+0.01) − 1 ≈ 3.96%，比减法版小 —— 基准涨幅越大差得越多（M2 §5.41 ④）
    expect(block.excessReturnRatio).toBeCloseTo(1.05 / 1.01 - 1, 10)
    expect(block.excessReturnRatio!).toBeLessThan(block.excessReturn!)
  })

  it('缺基准时超额（两种）、信息比率与 beta 一律为 null（不以 0 代替）', () => {
    const block = performanceOf(mergeEquity([codeResult()]), [trade()])
    expect(block.benchmarkReturn).toBeNull()
    expect(block.excessReturn).toBeNull()
    expect(block.excessReturnRatio).toBeNull()
    expect(block.informationRatio).toBeNull()
    // beta = 0 会被读成「与大盘无关」，而这里是「没有基准，算不出」
    expect(block.beta).toBeNull()
  })

  /**
   * beta 进报告的理由是它与 `exposure` 互为交叉验证（M2 §5.41 ①）。
   * 这条用例钉的是「它真的按 Cov/Var 算」——用一段净值恰好跟着基准走一半幅度的曲线。
   */
  it('beta 由净值曲线算出，与基准同向半幅 ⇒ 约 0.5', () => {
    const benchmarkByDate = new Map<TradeDate, number>([
      ['2024-01-02', 100],
      ['2024-01-03', 104],
      ['2024-01-04', 102],
      ['2024-01-05', 106],
    ])
    const half = codeResult({
      equity: [
        { date: '2024-01-02', equity: 100_000, benchmark: null },
        { date: '2024-01-03', equity: 102_000, benchmark: null },
        { date: '2024-01-04', equity: 101_019.23, benchmark: null },
        { date: '2024-01-05', equity: 103_000, benchmark: null },
      ],
    })
    const block = performanceOf(mergeEquity([half], benchmarkByDate), [trade()])
    // 三个日收益逐个恰好是基准的一半 ⇒ beta 精确落在 0.500000
    expect(block.beta).not.toBeNull()
    expect(block.beta!).toBeCloseTo(0.5, 5)
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
  // 刻意是**出厂口径**的 meta（真指纹 + 真成本 + 出厂资金）：这样「非出厂口径」那条告警
  // 默认不出现，下面几条偏离用例才测得准。指纹写死一个假串会让每份报告都带那条告警
  const meta = {
    engineVersion: `0.2.0-unvalidated+${paramsFingerprint(DEFAULT_PARAMS)}`,
    paramsFingerprint: paramsFingerprint(DEFAULT_PARAMS),
    generatedAt: 0,
    codes: ['SH600000'],
    from: '2024-01-01',
    to: '2024-12-31',
    dataSource: 'fixtures:test',
    capitalPerCode: DEFAULT_SIMULATE_OPTIONS.capitalPerCode,
    costs: DEFAULT_COSTS,
  }

  /*
    预热占窗口（2026-08-22，M2 §5.52）。`abl-valid-base` 那次踩的坑：
    `--from 2024-01-01` 无段前历史 ⇒ 18 个月里前 15 个月净值一动不动，
    而报告上只显示「建仓 34 / 夏普 1.19」，看起来完全正常。
    这三条钉的是「什么时候该说」「什么时候别乱说」，以及那个越界边界。
  */
  describe('预热占窗口告警', () => {
    /** 前 `idle` 根不动、之后每根都动的净值曲线 */
    const curve = (total: number, idle: number): CodeResult['equity'] =>
      Array.from({ length: total }, (_, i) => ({
        date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        equity: i < idle ? 100_000 : 100_000 + (i - idle + 1) * 100,
        benchmark: null,
      }))

    it('预热占 > 80% ⇒ 强告警，点名首个净值变动日', () => {
      const report = assembleReport({
        results: [codeResult({ equity: curve(100, 90) })],
        meta,
      })
      const text = report.warnings.join(' ')
      expect(text).toContain('预热占窗口 90%')
      expect(text).toContain('绩效数字不可用')
      expect(text).toContain('第 91/100 根')
    })

    it('预热占 50–80% ⇒ 弱告警（评估期偏短，但不说数字不可用）', () => {
      const report = assembleReport({
        results: [codeResult({ equity: curve(100, 60) })],
        meta,
      })
      const text = report.warnings.join(' ')
      expect(text).toContain('预热占窗口 60%')
      expect(text).toContain('评估期偏短')
      expect(text).not.toContain('绩效数字不可用')
    })

    it('正常预热（20%）不告警 —— 300 根预热 + 1157 根评估是合法形状，不许误报', () => {
      const report = assembleReport({
        results: [codeResult({ equity: curve(100, 20) })],
        meta,
      })
      expect(report.warnings.join(' ')).not.toContain('预热占窗口')
    })

    it('整段一次没动过时不越界 —— 不许印出「第 101/100 根」', () => {
      const report = assembleReport({
        results: [codeResult({ equity: curve(100, 100), trades: [] })],
        meta,
      })
      const text = report.warnings.join(' ')
      expect(text).toContain('预热占窗口 100%')
      expect(text).toContain('整段净值一次都没动过')
      expect(text).not.toMatch(/第 \d+\/100 根/)
    })
  })

  /*
    显著性门槛与 HAC 标准误（M2 §5.48/§5.50）。两个都**与策略无关**——
    门槛只由 T 与高阶矩决定。钉这一条是因为「只印不当门槛」这个定位很容易被
    下一个人读成「过不了这条线就不写回」，而写回门槛判的是逐折配对 Δ。
  */
  it('显著性门槛只由窗口长度决定，与策略收益无关', () => {
    const equity = Array.from({ length: 300 }, (_, i) => ({
      date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      equity: 100_000 + Math.sin(i / 3) * 500 + i * 10,
      benchmark: null,
    }))
    const good = assembleReport({ results: [codeResult({ equity })], meta })
    // 同一条曲线整体放大收益 ⇒ 夏普变了，门槛不该跟着变
    const scaled = equity.map((p, i) => ({ ...p, equity: 100_000 + (p.equity - 100_000) * 3 + i * 50 }))
    const better = assembleReport({ results: [codeResult({ equity: scaled })], meta })

    expect(good.performance.sharpeThreshold).not.toBeNull()
    expect(good.performance.sharpe).not.toBe(better.performance.sharpe)
    // 门槛只随 T 与高阶矩动；两条曲线 T 相同、形状相近 ⇒ 门槛应当很接近
    expect(good.performance.sharpeThreshold!).toBeCloseTo(better.performance.sharpeThreshold!, 1)
  })

  it('样本太短时门槛给 null，不用 0 冒充', () => {
    const report = assembleReport({ results: [codeResult()], meta })
    // codeResult 默认只有 2 个净值点 ⇒ 1 个收益率 ⇒ 算不出
    expect(report.performance.sharpeThreshold).toBeNull()
  })

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

  /*
    M2 §5.40：后复权价位让主池 10 只标的一手都买不起 ⇒ 整段 0 笔，而报告上与
    「引擎没给信号」无法区分。处置 A 是「只让它可见」——**告警没了，缺陷就重新隐身**，
    所以这两条钉的是「有它就必须说」与「没有就别乱说」。
  */
  it('一手都买不起会告警，并点名标的与次数（no silent caps）', () => {
    const report = assembleReport({
      results: [
        codeResult({ code: 'SZ000001', trades: [], unaffordable: 12 }),
        codeResult({ code: 'SH600309', trades: [], unaffordable: 3 }),
      ],
      meta,
    })
    const text = report.warnings.join(' ')
    expect(text).toContain('买不起')
    expect(text).toContain('SZ000001×12')
    expect(text).toContain('SH600309×3')
    // 「0 笔 ≠ 没给信号」这句话必须在，它才是这条告警存在的理由
    expect(text).toContain('不代表引擎没给信号')
  })

  it('没有买不起的情形时不出这条告警', () => {
    const report = assembleReport({ results: [codeResult()], meta })
    expect(report.warnings.join(' ')).not.toContain('买不起')
  })

  /*
    口径核对（2026-08-20）。踩过的事：迭代看板把 §5.44 候选 B 的 5× 资金实验跑当
    「回测基线」显示了一整天（1114 建仓 / 43.81%，而出厂那份是 1097 / 43.21%）。
    三个旋钮里 `costs` 此前**完全没记** ⇒ `--slippage 0` 的跑在归档里结构上认不出来。
    钉三件事：出厂口径不出告警 · 每个旋钮偏离都出 · 未记录 ≠ 等于出厂。
  */
  describe('非出厂口径的核对（auditKnobs）', () => {
    it('出厂口径不出这条告警', () => {
      const report = assembleReport({ results: [codeResult()], meta })
      expect(report.warnings.join(' ')).not.toContain('非出厂口径')
      expect(auditKnobs(meta).deviations).toEqual([])
      expect(auditKnobs(meta).unverifiable).toEqual([])
    })

    it('资金偏离出厂值会告警并带上两个数', () => {
      const report = assembleReport({
        results: [codeResult()],
        meta: { ...meta, capitalPerCode: 500_000 },
      })
      const text = report.warnings.join(' ')
      expect(text).toContain('非出厂口径')
      expect(text).toContain('500000')
      expect(text).toContain(String(DEFAULT_SIMULATE_OPTIONS.capitalPerCode))
    })

    it('滑点归零（--slippage 0）会被认出来 —— 这是此前完全测不到的那一种', () => {
      const audit = auditKnobs({ ...meta, costs: { ...DEFAULT_COSTS, slippage: 0 } })
      expect(audit.deviations.map((d) => d.knob)).toEqual(['costs'])
      expect(audit.deviations[0]?.detail).toContain('slippage')
    })

    it('参数指纹不同（--params / 消融跑）会被认出来', () => {
      const audit = auditKnobs({ ...meta, paramsFingerprint: 'deadbeef' })
      expect(audit.deviations.map((d) => d.knob)).toEqual(['params'])
    })

    /*
      这一条是整组里最重要的：2026-08-20 之前的报告都没有 `meta.costs`。
      把「没记」判成「等于出厂」会让 `noslip-train.json`（−1.21% vs 出厂 −1.99%）
      静默通过 —— 与「用 0 冒充未预热的指标值」是同一个错误方向（约束 4 的精神）。
    */
    it('没记成本的老报告落在 unverifiable，不算「没有偏离」', () => {
      const audit = auditKnobs({
        capitalPerCode: meta.capitalPerCode,
        paramsFingerprint: meta.paramsFingerprint,
      })
      expect(audit.deviations).toEqual([])
      expect(audit.unverifiable).toHaveLength(1)
      expect(audit.unverifiable[0]).toContain('成本')
    })

    it('渲染出的报告带口径行（资金与四项费率）', () => {
      const text = renderReport(assembleReport({ results: [codeResult()], meta }))
      expect(text).toContain(String(DEFAULT_SIMULATE_OPTIONS.capitalPerCode))
      expect(text).toContain('滑点')
      expect(text).toContain('印花税')
    })
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
    sharpeNet: null,
    benchmarkReturn: null,
    excessReturn: null,
    excessReturnRatio: null,
    sameRiskPassive: null,
    informationRatio: null,
    exposure: 0.2,
    beta: null,
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
    sharpeThreshold: null,
    sharpeSeHac: null,
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
