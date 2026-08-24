/**
 * 报告组装与渲染（docs/07 §2.2）。
 *
 * 最重要的一节是 **分 Regime 归因**：它是「市场状态判定是否有用」的唯一证据来源，
 * 也是回答「哪个状态下的信号该被更谨慎对待」的入口。
 *
 * 这里曾经还有一栏「动态权重 vs 固定 0.5/0.5 对照」—— 那是整套设计核心假设的验收位。
 * 假设在 2026-08-12 被推翻（两轮实测都看不出效果），权重表已删除，这一栏随之失去靶子，
 * 一并删掉。判据见 M2 偏差报告 §5.5–§5.8，决策记录见 docs/08 关键决策点 2。
 *
 * 报告头部固定三句免责：标的池偏差、参数未标定、回测≠实盘。
 */

import { DEFAULT_PARAMS, ENGINE_VERSION, paramsFingerprint } from '../core/params'
import type { Regime, SecCode, TradeDate } from '../core/types'
import { DEFAULT_COSTS, type CostModel } from './costs'
import { DEFAULT_SIMULATE_OPTIONS, type BacktestTrade, type CodeResult } from './simulate'
import {
  BARS_PER_YEAR,
  alignedReturns,
  annualizedReturn,
  averageExposure,
  betaOf,
  groupPositions,
  informationRatio,
  maxDrawdown,
  ratioExcessReturn,
  returnsOf,
  riskFreeAdjustedSharpe,
  sameRiskPassive,
  sharpeRatio,
  sharpeRatioHac,
  sharpeSignificanceThreshold,
  summarizeTrades,
  type EquityPoint,
  type PositionStats,
  type SameRiskPassive,
  type TradeStats,
} from './metrics'
import { andrewsLag } from './ic-audit'

export interface PerformanceBlock {
  bars: number
  totalReturn: number
  annualized: number | null
  maxDrawdown: number
  drawdownBars: number
  drawdownRecoveryBars: number | null
  /** 年化夏普，**恒为 rf = 0**。这个字段的口径从来没变过，老报告可以逐份横向比 */
  sharpe: number | null
  /**
   * 机会成本调整后的夏普（2026-08-21 加，`--rf` 默认 0 ⇒ 默认 null）。
   *
   * rf 只对**持仓那部分**收（`riskFreeAdjustedSharpe` 头注释讲了为什么不是直接减：
   * 直接减是罚两次，实测差 2.4 个夏普）。它**只改这一个字段** —— 净值曲线、
   * 收益、回撤、Calmar 一个都不动，所以带 `--rf` 的跑仍然可以当基线引用。
   * `rf` 的取值在 `meta.riskFree`，**引用这个数必须带上它**（自由参数，同 DSR 的 N）。
   */
  sharpeNet: number | null
  /** 基准缺失时为 null —— 不用 0 冒充「无超额」 */
  benchmarkReturn: number | null
  /** **减法版**超额 `Rp − Rm`。历史上所有引用都是这个口径，所以它留着不动 */
  excessReturn: number | null
  /**
   * **除法版**超额 `(1+Rp)/(1+Rm) − 1`（2026-08-19 加，M2 §5.41 ④）。
   * 基准涨幅大的窗口上减法版会给出读不出意思的数（单指数 2005–2017：减法 −277.56%、
   * 除法 −69.10% = 净值只有被动的 30.9%）。**引用超额时用这个**，两个并存是刻意的。
   */
  excessReturnRatio: number | null
  /**
   * **同风险参照**：`GH1 = R_p − R_{基准@σ_p}`（Graham & Harvey 1996/1997，2026-08-24 加）。
   * 上面那两个「超额」都是跟**满仓**基准比的，而我们平均占用只有 3.5%
   * ⇒ 它们回答不了「这些钱换成被动持有会怎样」（差距文档 §2.2 那个真空）。
   *
   * ⚠ **引用超额时必须与 `excessReturnRatio` 一起给**：两句同时为真且**符号相反**
   * （训练窗口 +16.75pp vs **−1.71pp**，M2 §5.52）。
   * 匹配口径**按 σ**，2026-08-24 拍板、**不许每次挑**（占用匹配能翻符号）——
   * 理由与另一个候选的代价在 `metrics.ts` 的 `sameRiskPassive` 头注释。
   */
  sameRiskPassive: SameRiskPassive | null
  informationRatio: number | null
  /**
   * 平均资金占用率 0..1。**读 `excessReturn` 之前先读它**：基准是满仓的，
   * 策略绝大多数时间空仓，两者的收益率不在同一个口径上（见 `averageExposure` 的注释）。
   */
  exposure: number | null
  /**
   * 市场 beta（2026-08-19 加）——「暴露」的第二种量法，与 `exposure` 互为交叉验证，
   * 且不含任何参数。实测两者逐份同向（M2 §5.41 ①）。
   *
   * ⚠ **刻意没有 alpha 与日胜率**：前者的符号由 `Rf` 决定（低暴露策略上 rf=0 与 rf=4%
   * 能给出相反结论），后者约等于「基准下跌天数占比」⇒ 两个都是零信息或误导，
   * 判据不采纳，理由在 `metrics.ts` 的 `betaOf` 头注释。别往这里补。
   */
  beta: number | null
  trades: TradeStats
  /**
   * 建仓级统计（把减仓拆出来的多行归并回一次建仓）。
   *
   * **「胜率」要看这个，不要看 `trades.winRate`。** 后者按行算，而回撤减仓会把一次建仓
   * 拆成两三行 —— 实测出厂参数下按行 33.16%、按建仓 49.3%，差了 16 个百分点。
   * 用户体验到的是「我按提醒买了一次，最后赚没赚」，那是建仓级（M2 §5.18）。
   */
  positions: PositionStats
  /**
   * PSR 框架下的显著性门槛：**这个窗口长度下年化夏普 ≥ X 才算 95% 显著**
   *（`SR*`=0，单侧，M2 §5.48/§5.49）。**只由 `T` 与高阶矩决定、与策略无关** ⇒
   * 调不动、不重判任何既有结果、**不当门槛**（只印）。T 不足或肥尾过重时 null。
   */
  sharpeThreshold: number | null
  /**
   * 夏普的 **HAC 年化标准误**（Lo 2002 的 `V_GMM`，M2 §5.50）。与 `sharpe` 配合：
   * `|t| = sharpe / sharpeSeHac`。它**不参与任何门槛**，只是把「不显著」写成一个数。
   */
  sharpeSeHac: number | null
}

export interface RegimeAttribution {
  regime: Regime
  trades: number
  winRate: number | null
  avgPnlPct: number | null
  totalPnl: number
  /** 处于该状态的判定根数，用于判断样本是否足够 */
  bars: number
  /** 按建仓市值加权的平均收益。**读这个，不要读 `avgPnlPct`**（见 TradeStats 的注释） */
  weightedPnlPct: number | null
  /** 该状态下的建仓级胜率 */
  positionWinRate: number | null
}

export interface BacktestReport {
  meta: {
    engineVersion: string
    paramsFingerprint: string
    generatedAt: number | null
    codes: SecCode[]
    from: TradeDate
    to: TradeDate
    dataSource: string
    capitalPerCode: number
    /**
     * 本次实际用的成本模型（2026-08-20 加）。**必填，不是可选** —— 它此前完全没记，
     * 于是一份 `--slippage 0` 的跑（实测 −1.21% vs 出厂口径 −1.99%）在归档里
     * **结构上认不出来**，而滑点占负期望的 69%（M2 §5.29）。
     * 与 `capitalPerCode` 同一条理由：报告要能自己回答「这是哪套口径下的数」。
     */
    costs: CostModel
    /**
     * 本次 `performance.sharpeNet` 用的年化无风险利率（2026-08-21 加，出厂 0）。
     * 老报告没有这一列 ⇒ `undefined`，而那**不是**「未记录」的那一档：
     * `sharpeNet` 也一起缺，`sharpe` 又恒是 rf=0 ⇒ 没有可被读错的数。
     */
    riskFree?: number | undefined
    /** 出厂参数是否仍未标定（ADR-0003）。true 时任何绩效数字都不得对外宣称 */
    unvalidatedParams: boolean
  }
  disclaimers: string[]
  performance: PerformanceBlock
  regimeAttribution: RegimeAttribution[]
  perCode: {
    code: SecCode
    totalReturn: number
    trades: number
    winRate: number | null
    openPosition: boolean
    /** 仓位是被退市强制平仓结束的（结算价为退市日收盘价，是亏损下界） */
    delistedClose: boolean
    evaluations: number
    gapSkipped: number
    limitBlocked: number
    /**
     * 被池过滤（`--drop-cap-pct` / `--drop-amount-pct`）挡掉的建仓次数。
     * **必须进报告**：只看「建仓数变少了」分不清是过滤剔的还是参数变严了。
     */
    poolBlocked: number
    /**
     * 因「一手都买不起」而没建成的次数（M2 §5.40）。
     * **必须进报告**：不然它与「引擎没给信号」一样都显示成「0 笔」。
     */
    unaffordable: number
  }[]
  suppressions: { rule: string; count: number }[]
  /** 离场规则分布（按次数降序）—— 回答「是策略在卖还是风控在卖」 */
  exitRules: { rule: string; count: number }[]
  trades: BacktestTrade[]
  equity: EquityPoint[]
  warnings: string[]
}

export const DISCLAIMERS: readonly string[] = [
  '本回测的标的池由用户自选股决定，本身带有选择偏差，不代表全市场表现。',
  '参数未经标定时，报告中的全部绩效数字仅用于参数比较，不构成任何预期收益的依据。',
  '回测不含流动性冲击、临停、退市与账户层面的资金约束，实盘结果会更差。',
]

/**
 * 把各标的的独立仓位合并成组合净值曲线。
 *
 * 缺某只当日 K 线时**前值填充**（停牌、上市早晚不一），而不是按缺失处理 ——
 * 停牌期间那部分资金确实还在，净值不该凭空缩水。
 */
export function mergeEquity(
  results: readonly CodeResult[],
  benchmarkByDate?: Map<TradeDate, number>
): EquityPoint[] {
  const dates = [...new Set(results.flatMap((r) => r.equity.map((p) => p.date)))].sort()
  const cursors = results.map(() => 0)
  const lastValues = results.map((r) => (r.equity.length > 0 ? r.equity[0]?.equity ?? 0 : 0))
  // 持仓市值与净值走**同一套前值填充**：停牌期间那部分仓位确实还在
  const lastPositions = results.map((r) => r.equity[0]?.positionValue)
  const out: EquityPoint[] = []
  let benchmarkBase: number | null = null

  for (const date of dates) {
    let total = 0
    let positionTotal = 0
    // 只要有一只缺这一列，整条曲线的占用就不可信 ⇒ 整份不给
    let positionsKnown = true
    for (let k = 0; k < results.length; k++) {
      const points = results[k]?.equity ?? []
      let cursor = cursors[k] ?? 0
      while (cursor < points.length && (points[cursor]?.date ?? '') <= date) {
        lastValues[k] = points[cursor]?.equity ?? lastValues[k] ?? 0
        lastPositions[k] = points[cursor]?.positionValue
        cursor++
      }
      cursors[k] = cursor
      total += lastValues[k] ?? 0
      const held = lastPositions[k]
      if (held === undefined) positionsKnown = false
      else positionTotal += held
    }

    const raw = benchmarkByDate?.get(date)
    if (raw !== undefined && benchmarkBase === null && raw > 0) benchmarkBase = raw
    const point: EquityPoint = {
      date,
      equity: total,
      benchmark: raw !== undefined && benchmarkBase !== null && benchmarkBase > 0 ? raw / benchmarkBase : null,
    }
    if (positionsKnown) point.positionValue = positionTotal
    out.push(point)
  }

  return out
}

export function performanceOf(
  equity: readonly EquityPoint[],
  trades: readonly BacktestTrade[],
  /** 年化无风险利率，只作用于 `sharpeNet`。默认 0 ⇒ 与改动前逐位相同 */
  riskFree = 0
): PerformanceBlock {
  const first = equity[0]?.equity ?? 0
  const last = equity[equity.length - 1]?.equity ?? 0
  const totalReturn = first > 0 ? last / first - 1 : 0
  const drawdown = maxDrawdown(equity)
  const strategyReturns = returnsOf(equity, 'equity')
  // 与基准比的那两个量（信息比率、beta）必须走**严格配对** —— 各算一遍再按下标塞
  // 会在基准列有空洞时错位，而且不报错（`alignedReturns` 头注释里有实例）
  const paired = alignedReturns(equity)

  const benchmarkStart = equity.find((p) => p.benchmark !== null)?.benchmark ?? null
  const benchmarkEnd = [...equity].reverse().find((p) => p.benchmark !== null)?.benchmark ?? null
  const benchmarkReturn =
    benchmarkStart !== null && benchmarkEnd !== null && benchmarkStart > 0
      ? benchmarkEnd / benchmarkStart - 1
      : null

  return {
    bars: equity.length,
    totalReturn,
    annualized: annualizedReturn(totalReturn, equity.length),
    maxDrawdown: drawdown.maxDrawdown,
    drawdownBars: drawdown.durationBars,
    drawdownRecoveryBars: drawdown.recoveryBars,
    sharpe: sharpeRatio(strategyReturns),
    sharpeNet: riskFree === 0 ? null : riskFreeAdjustedSharpe(equity, riskFree),
    benchmarkReturn,
    excessReturn: benchmarkReturn === null ? null : totalReturn - benchmarkReturn,
    excessReturnRatio: ratioExcessReturn(totalReturn, benchmarkReturn),
    sameRiskPassive: sameRiskPassive(equity),
    informationRatio:
      paired.benchmark.length > 0 ? informationRatio(paired.strategy, paired.benchmark) : null,
    exposure: averageExposure(trades, first, equity.length),
    beta: betaOf(paired.strategy, paired.benchmark),
    trades: summarizeTrades(trades),
    positions: groupPositions(trades),
    // 显著性门槛与 HAC 标准误（M2 §5.48–§5.50）。两个都与策略无关、都不当门槛、
    // 只把「不显著」写成一个数。HAC 滞后阶用 Andrews 规则（预承诺，不挑）。
    sharpeThreshold: sharpeSignificanceThreshold(strategyReturns),
    sharpeSeHac: (() => {
      const hac = sharpeRatioHac(strategyReturns, andrewsLag(strategyReturns.length))
      return hac === null ? null : hac.standardError * Math.sqrt(BARS_PER_YEAR)
    })(),
  }
}

export function attributeByRegime(
  trades: readonly BacktestTrade[],
  results: readonly CodeResult[]
): RegimeAttribution[] {
  const regimes: Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']
  return regimes.map((regime) => {
    const subset = trades.filter((t) => t.regimeAtEntry === regime)
    const stats = summarizeTrades(subset)
    const positions = groupPositions(subset)
    const bars = results.reduce((sum, r) => sum + (r.regimeBars.get(regime) ?? 0), 0)
    return {
      regime,
      trades: stats.count,
      winRate: stats.winRate,
      avgPnlPct: stats.avgPnlPct,
      weightedPnlPct: stats.weightedPnlPct,
      positionWinRate: positions.winRate,
      totalPnl: stats.totalPnl,
      bars,
    }
  })
}

export interface KnobDeviation {
  /** 机器可读的旋钮名 —— 看板按它分类，别用文案去 match */
  knob: 'capitalPerCode' | 'costs' | 'params'
  /** 人读的一句：偏在哪、偏多少 */
  detail: string
}

export interface KnobAudit {
  deviations: KnobDeviation[]
  /**
   * **无法核对**的旋钮。目前只有一种情形：2026-08-20 之前的报告没记 `meta.costs`。
   * 它与「没有偏离」是两件事，**不许合并** —— `noslip-train.json`（`--slippage 0`，
   * −1.21% vs 出厂口径 −1.99%）就落在这一档里，把它当成出厂口径正是要防的事。
   */
  unverifiable: string[]
}

/**
 * 这份报告是不是**出厂口径**下跑出来的 —— 三个旋钮逐个比。
 *
 * **为什么要有这个函数**：2026-08-20 发现迭代看板把 `cap-500000.json`（§5.44 候选 B 的
 * 5× 资金实验跑）当「回测基线」显示了一整天 —— 1114 建仓 / 43.81% / 占用 3.61%，
 * 而出厂那份是 1097 / 43.21% / 3.50%。挑选逻辑只看「最新 + 标的数 ≥ 200 + 含 trades」，
 * 三个旋钮一个都不查，而**偏离方向不随机**：资金调大只会让 `unaffordable` 变少、
 * 数字更好看，没有任何一处看起来像坏了。
 *
 * 判据放在这里而不是放在看板里，是为了**只有一个出处**：报告自己按它打 warning、
 * 看板按它挑基线，两边照抄一份的症状是「报告说这是实验跑、看板说这是基线」。
 */
export function auditKnobs(meta: {
  capitalPerCode: number
  paramsFingerprint: string
  /** 老报告没有这一列 ⇒ `undefined` = **未记录**，不是「等于出厂」 */
  costs?: CostModel | undefined
}): KnobAudit {
  const deviations: KnobDeviation[] = []
  const unverifiable: string[] = []

  const factoryCapital = DEFAULT_SIMULATE_OPTIONS.capitalPerCode
  if (meta.capitalPerCode !== factoryCapital) {
    deviations.push({
      knob: 'capitalPerCode',
      detail: `每标的资金 ${meta.capitalPerCode}（出厂 ${factoryCapital}）`,
    })
  }

  const factoryFingerprint = paramsFingerprint(DEFAULT_PARAMS)
  if (meta.paramsFingerprint !== factoryFingerprint) {
    deviations.push({
      knob: 'params',
      detail: `参数指纹 ${meta.paramsFingerprint}（出厂 ${factoryFingerprint}）`,
    })
  }

  if (meta.costs === undefined) {
    unverifiable.push('成本口径（2026-08-20 之前的报告没记 meta.costs）')
  } else {
    const diffs = (Object.keys(DEFAULT_COSTS) as (keyof CostModel)[])
      .filter((key) => meta.costs?.[key] !== DEFAULT_COSTS[key])
      .map((key) => `${key} ${meta.costs?.[key]}（出厂 ${DEFAULT_COSTS[key]}）`)
    if (diffs.length > 0) deviations.push({ knob: 'costs', detail: diffs.join(' · ') })
  }

  return { deviations, unverifiable }
}

export interface AssembleInput {
  results: readonly CodeResult[]
  benchmarkByDate?: Map<TradeDate, number> | undefined
  meta: Omit<BacktestReport['meta'], 'unvalidatedParams'>
}

export function assembleReport(input: AssembleInput): BacktestReport {
  const equity = mergeEquity(input.results, input.benchmarkByDate)
  const trades = input.results.flatMap((r) => r.trades)
  const performance = performanceOf(equity, trades, input.meta.riskFree ?? 0)

  const suppressions = new Map<string, number>()
  for (const result of input.results) {
    for (const [rule, count] of result.suppressed) {
      suppressions.set(rule, (suppressions.get(rule) ?? 0) + count)
    }
  }

  const exitRules = new Map<string, number>()
  for (const trade of trades) exitRules.set(trade.exitRule, (exitRules.get(trade.exitRule) ?? 0) + 1)

  const warnings: string[] = []
  // docs/07 §3 的过拟合红线之一：全样本交易 < 30 笔在统计上无意义
  if (trades.length < 30) {
    warnings.push(`全样本仅 ${trades.length} 笔交易（< 30），统计上无意义，不足以据此选参数。`)
  }
  if (input.results.some((r) => r.openPosition)) {
    warnings.push('期末仍有未平仓标的，总收益中包含浮动盈亏。')
  }
  const delistedCount = input.results.filter((r) => r.delistedClose).length
  if (delistedCount > 0) {
    // 方向已知且单向，所以必须写在报告里而不是只留在代码注释里：
    // 读的人会拿这个亏损当「退市股的真实代价」，而它是下界不是真值
    warnings.push(
      `${delistedCount} 只标的因退市在最后一个交易日强制平仓（exitRule=DELISTED）。` +
        '结算价用的是该日收盘价，而真实退市股在整理期常常连续跌停卖不掉、之后进老三板近乎归零 —— ' +
        '所以这里算出的亏损是**下界**，不是真实损失。'
    )
  }
  if (!input.benchmarkByDate || input.benchmarkByDate.size === 0) {
    warnings.push('缺少基准指数日线，超额收益与信息比率未计算（不以 0 代替）。')
  }
  /*
    非出厂口径的跑要在报告里自己说出来（2026-08-20）。与下面那两条池过滤 / 买不起
    同一个 no-silent-caps 理由，但它更贵：那两条影响的是「这次跑了什么」，
    这一条影响的是「这份数字能不能被当基线引用」。看板真踩过一次（auditKnobs 头注释）。
  */
  const knobs = auditKnobs(input.meta)
  if (knobs.deviations.length > 0) {
    warnings.push(
      `**非出厂口径**：${knobs.deviations.map((d) => d.detail).join(' · ')}。` +
        '这份绩效不可当基线引用，也不可与出厂口径的运行直接横向比较 —— ' +
        '偏离方向通常不随机（调大 --capital 只会让「一手都买不起」变少、数字更好看）。'
    )
  }

  const poolBlocked = input.results.reduce((sum, r) => sum + r.poolBlocked, 0)
  if (poolBlocked > 0) {
    // 不写这一行就是 silent cap：「建仓数变少了」会被读成参数变严，而不是池被筛过
    warnings.push(
      `池过滤（--drop-cap-pct / --drop-amount-pct）挡掉了 ${poolBlocked} 次建仓机会。` +
        '本次绩效因此建立在**筛过的标的池**上，不可与未过滤的运行直接横向比较。'
    )
  }

  /*
    「一手都买不起」的建仓意图。与上面那条池过滤同一个理由（no silent caps），但它更隐蔽：
    池过滤是用户显式加了参数，而这一条是**默认配置下就会发生**的 —— 回测按后复权价成交，
    而后复权价可达真实价的一两百倍（M2 §5.40）。不写这一行，报告上就只有一个「0 笔」，
    与「引擎在这只票上没给过信号」完全无法区分。
  */
  const unaffordable = input.results.reduce((sum, r) => sum + r.unaffordable, 0)
  if (unaffordable > 0) {
    const codes = input.results
      .filter((r) => r.unaffordable > 0)
      .sort((a, b) => b.unaffordable - a.unaffordable)
    const shown = codes
      .slice(0, 5)
      .map((r) => `${r.code}×${r.unaffordable}`)
      .join(' · ')
    warnings.push(
      `${unaffordable} 次建仓意图因**一手都买不起**未成交（涉及 ${codes.length} 只：${shown}` +
        `${codes.length > 5 ? ' …' : ''}）。` +
        '成交价用的是后复权价，而后复权锚在上市日 —— 分红送转多的老票后复权价可达真实价的一两百倍，' +
        '于是一手就超过了 --capital。**这些标的的「0 笔」不代表引擎没给信号**，' +
        '被排除的又恰恰是分红历史最长的大盘股（M2 §5.40）。要它们参与交易需调大 --capital。'
    )
  }

  /*
    预热占窗口比（2026-08-22，M2 §5.52）。`abl-valid-base` 那次踩的坑：
    `--from 2024-01-01` 无段前历史 ⇒ 18 个月里前 15 个月净值一动不动（建仓 34 次），
    而 CLAUDE.md 那条「跑验证窗口必须带段前历史」里写的「34 次」就是拿它写的 -- 一天后又被挑回来用。
    没有这道闸门，报告上只显示「建仓 34 / 夏普 1.19」，看起来完全正常。
    判据：首个净值变动日占全长的比例。> 50% 告警，> 80% 强告警。
    300 根预热 + 1157 根评估 ⇒ 20% ⇒ 不会误报合法的预热。
  */
  if (equity.length > 2) {
    const initial = equity[0]?.equity ?? 0
    if (initial > 0) {
      let firstChange = equity.length
      for (let i = 1; i < equity.length; i++) {
        if (Math.abs((equity[i]?.equity ?? 0) - initial) > 0.01) {
          firstChange = i
          break
        }
      }
      const idleFraction = firstChange / equity.length
      const idlePct = (idleFraction * 100).toFixed(0)
      // firstChange === equity.length ⇒ 整段净值一次都没动过（一笔都没成交）。
      // 这时没有「首个变动日」可报，硬取下标会越界成「第 360/359 根」
      const neverTraded = firstChange >= equity.length
      const where = neverTraded
        ? '**整段净值一次都没动过**'
        : `首个净值变动日在 ${equity[firstChange]?.date ?? '未知'}，即第 ${firstChange + 1}/${equity.length} 根`
      if (idleFraction > 0.8) {
        warnings.push(
          `⚠ **预热占窗口 ${idlePct}%**（${where}）-- 评估期被预热段严重侵蚀，` +
            `绩效数字不可用（M2 §5.52）。` +
            `最可能的原因：\`--from\` 起点在预热段内或之后，需要带段前历史重跑。`
        )
      } else if (idleFraction > 0.5) {
        warnings.push(
          `预热占窗口 ${idlePct}%（${where}）-- ` +
            `评估期偏短、标准误偏大。若 \`--from\` 起点在预热段内，需带段前历史重跑（M2 §5.52）。`
        )
      }
    }
  }

  return {
    meta: { ...input.meta, unvalidatedParams: ENGINE_VERSION.includes('unvalidated') },
    disclaimers: [...DISCLAIMERS],
    performance,
    regimeAttribution: attributeByRegime(trades, input.results),
    perCode: input.results.map((result) => {
      const first = result.equity[0]?.equity ?? 0
      const last = result.equity[result.equity.length - 1]?.equity ?? 0
      const stats = summarizeTrades(result.trades)
      return {
        code: result.code,
        totalReturn: first > 0 ? last / first - 1 : 0,
        trades: stats.count,
        winRate: stats.winRate,
        openPosition: result.openPosition,
        delistedClose: result.delistedClose,
        evaluations: result.evaluations,
        gapSkipped: result.gapSkipped,
        limitBlocked: result.limitBlocked,
        poolBlocked: result.poolBlocked,
        unaffordable: result.unaffordable,
      }
    }),
    suppressions: [...suppressions.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count),
    exitRules: [...exitRules.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count),
    trades,
    equity,
    warnings,
  }
}

// ─────────────────────────── 文本渲染 ───────────────────────────

function pct(value: number | null, digits = 2): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`
}

function num(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits)
}

/** 控制台摘要。完整数据在 JSON 里，这里只给能一眼扫完的部分 */
export function renderReport(report: BacktestReport): string {
  const lines: string[] = []
  const p = report.performance

  lines.push('─'.repeat(64))
  lines.push(`回测报告 · ${report.meta.from} → ${report.meta.to} · ${report.meta.codes.length} 只`)
  lines.push(`引擎 ${report.meta.engineVersion} · 数据源 ${report.meta.dataSource}`)
  /*
    口径行（2026-08-20 加）：`.txt` 归档此前不含资金与成本，于是一份实验跑与出厂跑
    在归档里长得一模一样。判「能不能引用」要先能看见口径。
    **费率刻意打原始小数而不是百分比**：`pct()` 保留两位小数，过户费 0.00001 会显示成
    `0.00%` —— 与「这一项是 0」分不开，恰好废掉这一行的用途。原始小数还有一个好处：
    与 `DEFAULT_COSTS` 里的字面量逐位可比。
  */
  const c = report.meta.costs
  lines.push(
    `每标的资金 ${report.meta.capitalPerCode} · 滑点 ${c.slippage} · 佣金 ${c.commissionRate}` +
      `（下限 ${c.minCommission}）· 印花税 ${c.stampTaxRate} · 过户费 ${c.transferFeeRate}`
  )
  if (report.meta.unvalidatedParams) {
    lines.push('⚠ 参数未标定（ADR-0003）：以下数字只可用于参数间比较，不得对外宣称。')
  }
  lines.push('─'.repeat(64))

  lines.push('【组合】')
  lines.push(`  交易日 ${p.bars}  总收益 ${pct(p.totalReturn)}  年化 ${pct(p.annualized)}`)
  lines.push(
    `  最大回撤 ${pct(p.maxDrawdown)}（${p.drawdownBars} 日，收复 ${p.drawdownRecoveryBars ?? '未'}${
      p.drawdownRecoveryBars === null ? '' : ' 日'
    }）`
  )
  // 两种超额并排打印，除法版在后：减法版在基准涨幅大的窗口上会给出 −277.56% 这种
  // 读不出意思的数（M2 §5.41 ④）。老口径不删 —— 历史 M2 里的引用全是减法版。
  lines.push(
    `  基准 ${pct(p.benchmarkReturn)}  超额 ${pct(p.excessReturn)}（除法 ${pct(p.excessReturnRatio)}）` +
      `  信息比率 ${num(p.informationRatio)}`
  )
  /*
    同风险参照（GH1）**必须紧贴上面那行超额** —— 它们符号相反且两句都对：
    训练窗口除法版 +16.75pp 而 GH1 **−1.71pp**（M2 §5.52）。分开打印就会有人只引用一个。
    ⚠ 这一行答的是「同样的风险换成买指数会怎样」，上面那行答的是「跟满仓指数比」。
    匹配口径按 σ（2026-08-24 拍板，不许每次挑；理由见 `metrics.sameRiskPassive`）。
  */
  const srp = p.sameRiskPassive
  lines.push(
    srp === null
      ? '  同风险参照 —（基准缺失或配对不足，不用 0 冒充）'
      : `  同风险参照 GH1 ${pct(srp.gh1)}（基准权重 ${pct(srp.weight)} 混现金 ⇒ 参照 ${pct(srp.referenceReturn)}）`
  )
  // 超额与占用率必须相邻打印：基准满仓、策略多数时间空仓，只看超额会把「没投钱」读成「策略差」。
  // beta 跟在同一行是因为它答的是同一个问题（暴露多少），只是量法不同、且不含参数。
  lines.push(
    `  平均资金占用 ${pct(p.exposure)}  beta ${num(p.beta, 4)}（基准为满仓 100%，超额收益须结合本行读）`
  )
  // 「未做自相关调整」这半句是 2026-08-19 加的（迭代计划 §4.6）：
  // ×√243 假设日收益 iid，而策略净值有自相关（持仓跨日、同池标的同涨同跌）⇒ 这个数偏大。
  // 与折间 t 那处同一个病，只是夏普不参与任何门槛（排名口径是 Calmar），所以按 §4.6 的
  // 「立刻」档处理 —— **如实标注，不改算法**。要改得上 Newey-West/Lo，那是单独一次改动。
  lines.push(`  夏普 ${num(p.sharpe)}（rf = 0，×√243 未做自相关调整 ⇒ 偏大，§4.6）`)
  // rf ≠ 0 时**并排**打印，绝不替换上面那一行：两个数差得很远（实测 −0.412 vs −0.502），
  // 只给一个会让「引用的是哪个口径」重新变成猜的。rf 的取值必须跟在数字后面（自由参数）
  if (p.sharpeNet !== null && report.meta.riskFree !== undefined) {
    lines.push(
      `  夏普 ${num(p.sharpeNet)}（rf = ${pct(report.meta.riskFree)}，机会成本只按逐日持仓占用收 —— ` +
        `直接减 rf 会因为常年空仓而罚两次，见 riskFreeAdjustedSharpe）`
    )
  }
  /*
    显著性门槛与 HAC 标准误（2026-08-22，M2 §5.48/§5.49/§5.50）。
    两个都**与策略无关、都调不动**：门槛只由 T 与高阶矩决定，标准误只由这条曲线决定。
    **只印不当门槛** —— 写回门槛判的是逐折配对 Δ，不是单条曲线的夏普（§5.48 判据 1）。
    印它是因为「这个窗口本来就短到测不出任何东西」是读绩效之前该知道的事。
    老报告没有这两个字段 ⇒ undefined ⇒ 整行不印（不用 0 或「—」冒充）。
  */
  if (p.sharpeThreshold !== null && p.sharpeThreshold !== undefined) {
    const parts = [`本窗口显著性门槛 年化夏普 ≥ ${num(p.sharpeThreshold)}（PSR 95%，SR*=0）`]
    if (p.sharpeSeHac !== null && p.sharpeSeHac !== undefined) {
      const t = p.sharpe === null ? null : p.sharpe / p.sharpeSeHac
      parts.push(
        `HAC 标准误 ±${num(p.sharpeSeHac)}${t === null ? '' : ` ⇒ |t| ${num(Math.abs(t))}`}`
      )
    }
    lines.push(`  ${parts.join('  ·  ')}`)
    lines.push(
      `    └ 两个数都与策略无关、调不动，**只印不当门槛**（写回门槛判的是逐折配对 Δ）`
    )
  }
  lines.push(
    `  卖出 ${p.trades.count} 笔  逐笔胜率 ${pct(p.trades.winRate)}  盈亏比 ${num(
      p.trades.profitFactor
    )}  平均持仓 ${num(p.trades.avgHoldingBars, 1)} 日`
  )
  // 建仓级紧跟着逐笔打：两个「胜率」差十几个百分点，缺了这一行前者一定会被当成用户口径读
  lines.push(
    `  建仓 ${p.positions.count} 次  **建仓胜率 ${pct(p.positions.winRate)}**  盈亏比 ${num(
      p.positions.payoffRatio
    )}  平均每次 ${num(p.positions.avgPnl, 0)} 元（${pct(p.positions.avgReturn)}）  中途减仓 ${
      p.positions.reduced
    } 次`
  )
  lines.push(`  累计成本 ${num(p.trades.totalCosts, 0)} 元  净盈亏 ${num(p.trades.totalPnl, 0)} 元`)

  lines.push('')
  lines.push('【分市场状态归因】（按建仓时的状态；平均按仓位加权，胜率按建仓）')
  for (const row of report.regimeAttribution) {
    lines.push(
      `  ${row.regime.padEnd(12)} ${String(row.trades).padStart(4)} 笔  建仓胜率 ${pct(
        row.positionWinRate
      ).padStart(7)}  平均 ${pct(row.weightedPnlPct).padStart(8)}  盈亏 ${num(row.totalPnl, 0).padStart(
        9
      )} 元  判定 ${row.bars} 根`
    )
  }

  if (report.exitRules.length > 0) {
    lines.push('')
    // 这一栏是「谁在决定离场」。实测 743/769 由风控规则触发、策略卖出信号只占 26 笔 ——
    // 想改「卖点」就得改 risk 块，改策略的卖出子信号几乎没有作用（M2 §5.18）
    lines.push('【离场规则分布】')
    for (const row of report.exitRules) lines.push(`  ${row.rule.padEnd(22)} ${row.count}`)
  }

  if (report.suppressions.length > 0) {
    lines.push('')
    lines.push('【被风控抑制的信号】')
    for (const row of report.suppressions) lines.push(`  ${row.rule.padEnd(22)} ${row.count}`)
  }

  lines.push('')
  lines.push('【逐标的】')
  for (const row of report.perCode) {
    lines.push(
      `  ${row.code}  收益 ${pct(row.totalReturn).padStart(8)}  ${String(row.trades).padStart(3)} 笔  胜率 ${pct(
        row.winRate
      ).padStart(7)}${row.openPosition ? '  （期末持仓）' : ''}${row.delistedClose ? '  （退市平仓）' : ''}`
    )
  }

  if (report.warnings.length > 0) {
    lines.push('')
    lines.push('【告警】')
    for (const warning of report.warnings) lines.push(`  · ${warning}`)
  }

  lines.push('')
  for (const line of report.disclaimers) lines.push(`※ ${line}`)
  lines.push('※ 仅供参考，非投资建议')
  return lines.join('\n')
}
