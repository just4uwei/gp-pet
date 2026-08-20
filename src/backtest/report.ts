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
  alignedReturns,
  annualizedReturn,
  averageExposure,
  betaOf,
  groupPositions,
  informationRatio,
  maxDrawdown,
  ratioExcessReturn,
  returnsOf,
  sharpeRatio,
  summarizeTrades,
  type EquityPoint,
  type PositionStats,
  type TradeStats,
} from './metrics'

export interface PerformanceBlock {
  bars: number
  totalReturn: number
  annualized: number | null
  maxDrawdown: number
  drawdownBars: number
  drawdownRecoveryBars: number | null
  sharpe: number | null
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
  const out: EquityPoint[] = []
  let benchmarkBase: number | null = null

  for (const date of dates) {
    let total = 0
    for (let k = 0; k < results.length; k++) {
      const points = results[k]?.equity ?? []
      let cursor = cursors[k] ?? 0
      while (cursor < points.length && (points[cursor]?.date ?? '') <= date) {
        lastValues[k] = points[cursor]?.equity ?? lastValues[k] ?? 0
        cursor++
      }
      cursors[k] = cursor
      total += lastValues[k] ?? 0
    }

    const raw = benchmarkByDate?.get(date)
    if (raw !== undefined && benchmarkBase === null && raw > 0) benchmarkBase = raw
    out.push({
      date,
      equity: total,
      benchmark: raw !== undefined && benchmarkBase !== null && benchmarkBase > 0 ? raw / benchmarkBase : null,
    })
  }

  return out
}

export function performanceOf(equity: readonly EquityPoint[], trades: readonly BacktestTrade[]): PerformanceBlock {
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
    benchmarkReturn,
    excessReturn: benchmarkReturn === null ? null : totalReturn - benchmarkReturn,
    excessReturnRatio: ratioExcessReturn(totalReturn, benchmarkReturn),
    informationRatio:
      paired.benchmark.length > 0 ? informationRatio(paired.strategy, paired.benchmark) : null,
    exposure: averageExposure(trades, first, equity.length),
    beta: betaOf(paired.strategy, paired.benchmark),
    trades: summarizeTrades(trades),
    positions: groupPositions(trades),
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
  const performance = performanceOf(equity, trades)

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
