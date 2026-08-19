/**
 * 回测模拟器（docs/07 §2.2）。
 *
 * 「陷阱 → 对策」逐条落地，每一条都是常见的自欺来源：
 *
 * | 陷阱 | 本文件里的对策 |
 * |---|---|
 * | 未来函数 | 引擎只拿到 `candles.slice(…, i+1)`，且数组被 `Object.freeze`；`assertNoFuture` 再兜一道 |
 * | 信号当日成交 | 第 i 根收盘产生的信号，成交价用第 **i+1 根开盘价** |
 * | T+1 | 买入在 i+1 开盘成交，卖出信号最早在 i+1 收盘产生、i+2 开盘成交 → 天然满足 |
 * | 涨跌停无法成交 | 次日开盘触及涨停 → 买单作废；触及跌停 → 卖单**顺延**到下一根 |
 * | 缺口 | `hasGap` 的那根跳过成交与判定（docs/07 §4） |
 * | 复权 | 资金按 `*Adj` 价计价 → 收益率已含除权影响；持仓成本另存**不复权**价供风控用 |
 * | 成本与滑点 | 见 costs.ts，双边佣金 + 印花税 + 过户费 + 滑点，全部可配 |
 * | 幸存者偏差 | 标的池由用户自选股决定 → 报告里明确标注「不代表全市场表现」 |
 *
 * ⚠ **`*Adj` 在回测 fixture 里是「后复权」，不是前复权**（2026-08-12 换的，
 * 见 `scripts/fetch-history.mjs` 头注释：腾讯的前复权是加性的、高分红股会变负数）。
 * 这一行以前写作「前复权」，是换轨时漏改的措辞 —— 而这两个词在这里**不是同义词**，
 * 见下面那条。**应用内（`engine/market-data.ts` 的 `ADJUST = 'qfq'`）仍是前复权**，
 * 两边只在「同一窗口内按比例缩放」这个意义上等价：比值型判定（穿越、RSI、BBW、ATR/close）
 * 逐位相同，**价位本身不同**。
 *
 * **仓位模型**：每只标的一个等额独立仓位（默认 10 万元），组合净值 = 各仓位净值之和。
 * 这不是资金管理策略，只是让「信号本身值不值钱」可比 —— 引入调仓与权重优化
 * 会让绩效差异分不清是策略的还是资金管理的。
 *
 * ⚠⚠ **但「10 万元」是拿后复权价花的，而后复权价可以是真实价的一两百倍**
 * （平安银行 2018 年首根：真实 13.7 元、后复权 **2121 元** ⇒ 一手 21.2 万 > 10 万）。
 * 于是 `lotsAffordable` 返回 0 手，那只票**整段一笔都不建仓**，
 * 而报告上只显示「收益 0.00% / 0 笔」—— 与「引擎没给信号」长得一模一样，**不进任何计数器**。
 * 实测主池 261 只里 **10 只**受影响（`SZ000001` 全程、`SH600309` 96.2%、`SZ000858` 94.1%…），
 * 按「标的·交易日」加权 **1.48%**。命中的恰恰是分红送转历史最长的那批大盘股。
 * 详情、方向与两个候选处置见 [M2 §5.40](../../docs/notes/M2-偏差报告.md)。**没有改动，先记着。**
 */

import { evaluate } from '../core/engine'
import { aggregateWeekly } from '../core/indicators/weekly'
import { priceLimits } from '../core/code'
import { CONTINUOUS_MINUTES } from '../core/session'
import type { EngineParams } from '../core/params'
import type {
  Candle,
  EngineContext,
  GatedDirection,
  Position,
  Regime,
  SecCode,
  TradeDate,
} from '../core/types'
import { DEFAULT_COSTS, buyFees, buyFill, lotsAffordable, sellFees, sellFill, type CostModel } from './costs'
import type { EquityPoint } from './metrics'
import type { LoadedSeries } from './data'

export interface SimulateOptions {
  params: EngineParams
  costs: CostModel
  /** 每只标的的独立资金，元 */
  capitalPerCode: number
  /**
   * 引擎每次能看到的最大回看根数。与实盘 `MarketDataService.initialBars` 对齐（默认 320）
   * —— 若回测让引擎看 3000 根而实盘只给 320 根，两边的 BBW 分位不是同一个东西。
   */
  lookback: number
  /** 前 N 根只喂数据不判信号。默认取 params.data.fullBars，保证 BBW 分位已预热 */
  warmupBars?: number
  /**
   * 这一天允不允许**建仓**（池层面的流动性/市值过滤，见 `liquidity.ts`）。
   * 不给 = 全允许 ⇒ 行为与以前逐位相同。
   *
   * **只挡建仓**：已持有的仓位照常走止损/减仓/移动止损 ——
   * 挡住卖出会造出永远持有的仓，那是凭空改变风控行为而不是筛标的。
   */
  entryAllowed?: (date: TradeDate) => boolean
  /**
   * 退市日（该标的最后一个交易日）。给了它、且喂进来的序列末根已到达该日，
   * 就在最后一根收盘**强制平仓并记一笔 `trade`**。
   *
   * **不给的时候行为与以前逐位相同** —— 旧结论（M2 §5.20 起的全部数字）可原样复现。
   *
   * ## 为什么必须记这一笔
   *
   * 未平仓的建仓**不产生 `trade` 行**，而建仓级胜率与 `audit:random` 的配对 alpha
   * **都只读 `trades`**（`groupPositions()` 在 metrics.ts 与 random-audit.ts 各有一份，
   * 都按 `code@entryDate` 分组）。退市股若只让亏损进净值、不进 `trades`，
   * 就等于「池子补了、统计口径没补」—— 那正是幸存者偏差的第二重体现，
   * 而它比第一重更隐蔽：报告上的建仓数、胜率、alpha 全都若无其事。
   *
   * ## ⚠ 结算价是最后一个交易日的收盘价，这是个**乐观**假设
   *
   * 真实的退市股在整理期常常连续跌停、**根本卖不掉**，之后进老三板近乎归零。
   * 所以这里算出来的亏损是**下界**，不是真实损失。方向已知且单向，
   * 报告里必须写明（`report.ts` 的 warnings 有一条钉着）。
   *
   * 判据用 `末根.date >= delistedAt` 而不是相等：回测窗口若截在退市日之前
   * （只跑到 2020，而该票 2024 才退市），末根 < delistedAt，**不该**强制平仓 ——
   * 那时它只是「窗口到期未平仓」，是另一回事。
   */
  delistedAt?: TradeDate
}

/** 退市强制平仓那一笔的 `exitRule`。归因时要能把它与风控离场分开 */
export const DELISTED_EXIT_RULE = 'DELISTED'

export const DEFAULT_SIMULATE_OPTIONS: Omit<SimulateOptions, 'params'> = {
  costs: DEFAULT_COSTS,
  capitalPerCode: 100_000,
  lookback: 320,
}

export interface BacktestTrade {
  code: SecCode
  entryDate: TradeDate
  exitDate: TradeDate
  /** 前复权成交价（净值口径） */
  entryPrice: number
  exitPrice: number
  /** 不复权成交价（用户视角的「我买在多少」） */
  entryPriceRaw: number
  exitPriceRaw: number
  shares: number
  pnl: number
  pnlPct: number
  holdingBars: number
  costs: number
  regimeAtEntry: Regime
  /**
   * 建仓时该 regime 已经连续持续了多少根（含判定当根，最小 1）。
   *
   * 加它是因为 §5.21 把负 alpha 定位到「TREND_UP 里的挑选」之后，还剩一个没量过的维度：
   * **是「刚进入上升趋势就买」还是「趋势走了一段之后买」**。
   * 那是「追高」的时间维度度量，而 §5.20 ⑧ 已有的两个维度（子信号组合、得分档）都答不了。
   *
   * 取的是**引擎自己发布的** `RegimeState.heldDays`，不在这里重算 ——
   * 重算一份的话，「回测统计出来的持续根数」与「引擎判定时用的持续根数」会悄悄分叉，
   * 而分叉之后所有基于它的结论都不可信（与 `audit:regime` 读 `evidence` 而不复写判定逻辑同理）。
   *
   * ⚠ 两条边界：① 单位是**判定根**不是自然日，停牌与节假日天然跳过；
   * ② 上界由 `lookback` 决定（引擎每次只看到 320 根），一段超长趋势会被截断在窗口长度上 ——
   * 这与实盘一致（`MarketDataService.initialBars` 也是 320），
   * 用全序列去算反而会让回测比实盘「多知道」一截。
   */
  barsInRegimeAtEntry: number
  entryScore: number
  /** 触发买入的子信号 ID，归因用 */
  entrySignals: string[]
  /** 卖出原因：子信号 ID 或风控规则 ID */
  exitRule: string
  /** 减仓（非清仓）产生的那笔 */
  partial: boolean
}

export interface SuppressionCount {
  rule: string
  count: number
}

export interface CodeResult {
  code: SecCode
  equity: EquityPoint[]
  trades: BacktestTrade[]
  /** 判定过的 K 线根数 */
  evaluations: number
  /** 产出过可执行方向的次数（未必成交） */
  actionable: number
  suppressed: Map<string, number>
  /** 因涨停买不到 / 跌停卖不掉而作废或顺延的次数 */
  limitBlocked: number
  /** 因 hasGap 跳过的根数 */
  gapSkipped: number
  /**
   * 因池过滤（`entryAllowed`）被挡掉的**建仓**次数。
   * **必须报出来**：静默剔除会让「这次剔了什么」事后查不清（no silent caps）。
   */
  poolBlocked: number
  regimeBars: Map<Regime, number>
  /** 期末仍持仓（未平仓）—— 报告里要单独说明，否则「总收益」里混着浮盈 */
  openPosition: boolean
  /** 该标的的仓位是被退市强制平仓结束的（见 SimulateOptions.delistedAt 的乐观假设说明） */
  delistedClose: boolean
}

interface PendingOrder {
  action: 'BUY' | 'SELL' | 'REDUCE'
  rule: string
  signals: string[]
  score: number
  regime: Regime
  /** 判定当根为止，该 regime 已连续持续的根数（≥ 1） */
  barsInRegime: number
  /** 已顺延的次数（跌停卖不掉时会顺延） */
  deferred: number
}

/** 卖单最多顺延几根。连续跌停超过这个天数就当作「这段时间根本没法卖」，作废并记账 */
const MAX_DEFER_BARS = 5

/**
 * 未来函数的第二道防线。
 *
 * 第一道是物理的（切片本身不含未来）。这一道防的是「切错了」：
 * 比如把 `i+1` 写成 `i+2`、或者把完整数组直接传进去。断言失败即抛错，
 * 宁可回测跑不完，也不要产出一份带未来函数的漂亮报告。
 */
export function assertNoFuture(window: readonly Candle[], asOf: TradeDate): void {
  const last = window[window.length - 1]
  if (!last) throw new Error('回测窗口为空')
  if (last.date !== asOf) {
    throw new Error(`回测窗口末根为 ${last.date}，与判定日 ${asOf} 不符 —— 疑似未来函数`)
  }
  for (const candle of window) {
    if (candle.date > asOf) throw new Error(`回测窗口含未来数据：${candle.date} > ${asOf}`)
  }
}

export interface SentimentLookup {
  /** 截至该日期的大盘情绪 0..1；无基准数据时返回 0.5（中性） */
  at(date: TradeDate): number
}

/** 常量情绪，用于无基准数据的场景 */
export const NEUTRAL_SENTIMENT: SentimentLookup = { at: () => 0.5 }

export function simulateCode(
  series: LoadedSeries,
  options: SimulateOptions,
  sentiment: SentimentLookup = NEUTRAL_SENTIMENT
): CodeResult {
  const { params, costs, capitalPerCode, lookback } = options
  const warmup = options.warmupBars ?? params.data.fullBars
  const candles = series.candles
  const profile = series.profile

  let cash = capitalPerCode
  let shares = 0
  /** 前复权成本价（净值口径） */
  let costAdj = 0
  /** 不复权成本价（风控口径 —— 用户的成本是真实成交价） */
  let costRaw = 0
  let peakRaw = 0
  let entryIndex = -1
  let entryDate: TradeDate = ''
  let entryPriceAdj = 0
  let entryPriceRaw = 0
  let entryCosts = 0
  let entryContext: {
    regime: Regime
    signals: string[]
    score: number
    barsInRegime: number
  } | null = null
  let pending: PendingOrder | null = null

  const result: CodeResult = {
    code: profile.code,
    equity: [],
    trades: [],
    evaluations: 0,
    actionable: 0,
    suppressed: new Map(),
    limitBlocked: 0,
    gapSkipped: 0,
    poolBlocked: 0,
    regimeBars: new Map(),
    openPosition: false,
    delistedClose: false,
  }

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue

    // ── ① 执行上一根产生的委托：用**本根开盘价** ──────────────────────
    if (pending) {
      if (bar.hasGap === true) {
        // 缺口段不成交：这一段的价格连续性本身就不可信（docs/07 §4）
        result.gapSkipped++
        pending = null
      } else {
        // 取出来用局部常量：下面每个分支都会重写 pending，
        // 边读边写同一个变量在类型收窄上也站不住脚（顺延分支会从 order 重建 pending，
        // 不显式标注类型 TS 就得循环推断）
        const order: PendingOrder = pending
        const limits = priceLimits(candles[i - 1]?.close ?? 0, profile.board, profile.isST)
        if (order.action === 'BUY') {
          const limitedUp = limits !== null && bar.open >= limits.limitUp - 0.001
          if (limitedUp) {
            result.limitBlocked++
            pending = null
          } else {
            const fillAdj = buyFill(bar.openAdj, costs)
            const qty = lotsAffordable(cash, fillAdj, costs, profile.board)
            if (qty > 0) {
              const amount = qty * fillAdj
              const fees = buyFees(amount, costs, profile.board)
              cash -= amount + fees
              shares = qty
              costAdj = fillAdj
              costRaw = buyFill(bar.open, costs)
              peakRaw = Math.max(bar.high, costRaw)
              entryIndex = i
              entryDate = bar.date
              entryPriceAdj = fillAdj
              entryPriceRaw = costRaw
              entryCosts = fees
              entryContext = {
                regime: order.regime,
                signals: order.signals,
                score: order.score,
                barsInRegime: order.barsInRegime,
              }
            }
            pending = null
          }
        } else {
          const limitedDown = limits !== null && bar.open <= limits.limitDown + 0.001
          if (limitedDown && order.deferred < MAX_DEFER_BARS) {
            // 跌停卖不掉 → 顺延到下一根，而不是当作已卖出
            result.limitBlocked++
            pending = { ...order, deferred: order.deferred + 1 }
          } else if (limitedDown) {
            result.limitBlocked++
            pending = null
          } else if (shares > 0) {
            const fraction = order.action === 'REDUCE' ? 0.5 : 1
            const qty = quantizeSell(shares, fraction)
            const fillAdj = sellFill(bar.openAdj, costs)
            const amount = qty * fillAdj
            const fees = sellFees(amount, costs, profile.board)
            cash += amount - fees
            // 部分卖出时买入费用按比例摊到这一笔，剩余留给后续那笔
            const allocatedEntryCosts = entryCosts * (qty / shares)
            entryCosts -= allocatedEntryCosts
            const grossPnl = (fillAdj - costAdj) * qty
            result.trades.push({
              code: profile.code,
              entryDate,
              exitDate: bar.date,
              entryPrice: entryPriceAdj,
              exitPrice: fillAdj,
              entryPriceRaw,
              exitPriceRaw: sellFill(bar.open, costs),
              shares: qty,
              pnl: grossPnl - fees - allocatedEntryCosts,
              pnlPct: costAdj > 0 ? (fillAdj - costAdj) / costAdj : 0,
              holdingBars: i - entryIndex,
              costs: fees + allocatedEntryCosts,
              regimeAtEntry: entryContext?.regime ?? 'TRANSITION',
              barsInRegimeAtEntry: entryContext?.barsInRegime ?? 0,
              entryScore: entryContext?.score ?? 0,
              entrySignals: entryContext?.signals ?? [],
              exitRule: order.rule,
              partial: qty < shares,
            })
            shares -= qty
            if (shares === 0) {
              costAdj = 0
              costRaw = 0
              peakRaw = 0
              entryIndex = -1
              entryContext = null
              entryCosts = 0
            }
            pending = null
          } else {
            pending = null
          }
        }
      }
    }

    // ── ② 持仓峰值：每交易日收盘更新（docs/05 §2.3） ────────────────────
    if (shares > 0) peakRaw = Math.max(peakRaw, bar.high)

    // ── ③ 收盘净值 ───────────────────────────────────────────────────
    result.equity.push({
      date: bar.date,
      equity: cash + shares * bar.closeAdj,
      benchmark: null,
    })

    // ── ④ 收盘后判定信号（最后一根不判：没有下一根可成交，判了也只是幻觉） ──
    if (i < warmup || i >= candles.length - 1) continue
    if (bar.hasGap === true) {
      result.gapSkipped++
      continue
    }

    const from = Math.max(0, i - lookback + 1)
    const window = Object.freeze(candles.slice(from, i + 1))
    assertNoFuture(window, bar.date)

    const position: Position | undefined =
      shares > 0
        ? {
            code: profile.code,
            shares,
            cost: costRaw,
            peakPrice: peakRaw,
            openedAt: entryIndex,
          }
        : undefined

    const ctx: EngineContext = {
      profile,
      candles: window,
      weekly: aggregateWeekly(window),
      marketSentiment: sentiment.at(bar.date),
      // 收盘确认口径：连续竞价已走完 240 分钟，时段为 SETTLE（15:00–15:10 的确认轮）
      now: { date: bar.date, minutesSinceOpen: CONTINUOUS_MINUTES, session: 'SETTLE' },
      ...(position ? { position } : {}),
    }

    const evaluation = evaluate(ctx, params)
    if (!evaluation) continue
    result.evaluations++
    result.regimeBars.set(
      evaluation.regime.regime,
      (result.regimeBars.get(evaluation.regime.regime) ?? 0) + 1
    )

    const gated = evaluation.gated
    if (gated.suppressed) {
      for (const verdict of gated.verdicts.filter((v) => v.action === 'SUPPRESS')) {
        result.suppressed.set(verdict.rule, (result.suppressed.get(verdict.rule) ?? 0) + 1)
      }
      continue
    }

    const order = toOrder(gated.direction, shares > 0)
    if (!order) continue
    /*
      池过滤只挡建仓（见 SimulateOptions.entryAllowed）。

      挡在 `actionable++` **之前**：那个数答的是「引擎给出了几次可执行方向」，
      而这一次确实给出了 —— 但它被池规则否掉了，所以计进 `poolBlocked` 而不是
      混进 actionable。两个数分开才回答得了「剔掉的是哪一批」。
    */
    if (order === 'BUY' && options.entryAllowed?.(bar.date) === false) {
      result.poolBlocked++
      continue
    }
    result.actionable++

    const forced = gated.verdicts.find((v) => v.action === 'FORCE_SELL' || v.action === 'FORCE_REDUCE')
    const direction = order === 'BUY' ? 'BUY' : 'SELL'
    pending = {
      action: order,
      rule: forced?.rule ?? topSignalId(evaluation, direction) ?? gated.direction,
      signals: evaluation.signal.subSignals
        .filter((sub) => sub.direction === direction)
        .map((sub) => sub.id),
      score: evaluation.signal.score,
      regime: evaluation.regime.regime,
      barsInRegime: evaluation.regime.heldDays,
      deferred: 0,
    }
  }

  // ── ⑤ 退市：序列到此为止，这个仓位不可能再有出口 ──────────────────────
  // 按最后一根收盘价结算并记一笔 trade。不结算的话这笔亏损只进净值、不进 trades，
  // 而建仓级胜率与配对 alpha 都只读 trades（见 SimulateOptions.delistedAt）
  const lastBar = candles[candles.length - 1]
  if (
    shares > 0 &&
    options.delistedAt !== undefined &&
    lastBar !== undefined &&
    lastBar.date >= options.delistedAt
  ) {
    const fillAdj = sellFill(lastBar.closeAdj, costs)
    const amount = shares * fillAdj
    const fees = sellFees(amount, costs, profile.board)
    cash += amount - fees
    result.trades.push({
      code: profile.code,
      entryDate,
      exitDate: lastBar.date,
      entryPrice: entryPriceAdj,
      exitPrice: fillAdj,
      entryPriceRaw,
      exitPriceRaw: sellFill(lastBar.close, costs),
      shares,
      // 清仓，所以剩余的建仓费用全部摊到这一笔
      pnl: (fillAdj - costAdj) * shares - fees - entryCosts,
      pnlPct: costAdj > 0 ? (fillAdj - costAdj) / costAdj : 0,
      holdingBars: candles.length - 1 - entryIndex,
      costs: fees + entryCosts,
      regimeAtEntry: entryContext?.regime ?? 'TRANSITION',
      barsInRegimeAtEntry: entryContext?.barsInRegime ?? 0,
      entryScore: entryContext?.score ?? 0,
      entrySignals: entryContext?.signals ?? [],
      exitRule: DELISTED_EXIT_RULE,
      partial: false,
    })
    shares = 0
    // 净值最后一点是平仓前算的（cash + shares × closeAdj），与结算后的现金差一个
    // 卖出费用与滑点。不改回来的话净值曲线与 trades 对不上，
    // 而这两者本该是同一件事的两种记法
    const lastPoint = result.equity[result.equity.length - 1]
    if (lastPoint) lastPoint.equity = cash
    result.delistedClose = true
  }

  result.openPosition = shares > 0
  return result
}

/** 「明日开盘观察」在回测里就是买入 —— 回测的成交模型本来就是次日开盘（见文件头） */
function toOrder(direction: GatedDirection, holding: boolean): PendingOrder['action'] | null {
  if (!holding && (direction === 'BUY' || direction === 'NEXT_DAY_WATCH')) return 'BUY'
  if (holding && direction === 'SELL') return 'SELL'
  if (holding && direction === 'REDUCE') return 'REDUCE'
  return null
}

/** 卖出数量取整手；不足一手的零股一次卖光（否则会留下永远卖不掉的碎股） */
function quantizeSell(shares: number, fraction: number): number {
  if (fraction >= 1) return shares
  const target = Math.floor((shares * fraction) / 100) * 100
  return target <= 0 || shares - target < 100 ? shares : target
}

function topSignalId(
  evaluation: NonNullable<ReturnType<typeof evaluate>>,
  direction: 'BUY' | 'SELL'
): string | null {
  const top = evaluation.signal.subSignals
    .filter((sub) => sub.direction === direction)
    .slice()
    .sort((a, b) => b.weight * b.score - a.weight * a.score)[0]
  return top?.id ?? null
}
