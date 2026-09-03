/**
 * 费率：① 用户费率 → 记账用的 `CostModel`；② **从券商的累计交易税费反解佣金率**（017）。
 * **纯函数。**
 *
 * ## 为什么要 `ledgerCosts` 这么一层
 *
 * `applyTrade` 收的是 `CostModel`，而它比用户费率多一项 **`slippage`**。
 * 那一项是回测在模拟「我不知道会成交在哪，所以往不利方向偏一点」——
 * **记账绝不套滑点**（`ledger.ts` 头注释：用户填的就是真实成交价，
 * 再偏一次等于凭空把他的成交价改坏 0.1%，然后一路进成本、进盈亏、进止损线）。
 *
 * 所以这里显式置 `slippage: 0`，**不是** `...DEFAULT_COSTS` 继承出厂的 0.001。
 * 差别在于「日后有人真的在记账路径上用了滑点」时会发生什么：
 * 置 0 ⇒ 结果不偏（错误可见性差一点，但账是对的）；
 * 继承 ⇒ 每一笔静默偏 0.1%，而没有任何东西会报警。
 *
 * ⚠ `ledgerCosts` **不许被 `src/backtest` 或 `src/main/shadow` 调用**。
 * 那两处一律用 `DEFAULT_COSTS` —— 用户校正一次费率就让影子净值曲线分一段，
 * 而分段前后拆不开就没法引用（同「引擎参数一变立刻停止累积」那条纪律）。
 *
 * ## 反解（`solveFromFeeTotal`）
 *
 * 用户抄下券商 App 上那只票的**累计交易税费**，这里找一个佣金率让同一批流水
 * 算出同一个总数。**判据是可核对性**：那笔钱是券商真的扣走的，是**事实**；
 * 而费率不是 —— 让他对着四个没有依据的框猜，比让他抄一个数难得多
 * （同 docs/01 §5.5「设置页不给参数编辑框」那条取舍）。
 *
 * **⚠ 为什么目标是「税费」而不是「成本」**（2026-09-03 换的，真机逼出来的）：
 * 第一版拿**摊薄成本**当目标，而券商持仓页上那个「成本价」多半是
 * **净成本**（把已实现盈亏折回成本里，见 `ledger.netCostOf`）——
 * 同一只票实测 12.067 vs 12.903，两边**根本不是一个数**。
 * 而「累计交易税费」没有这个歧义：它就是一笔钱。
 *
 * ## 印花税与过户费**不参与反解**，它们是规定
 *
 * 那两项住 `backtest/costs.ts` 并**带生效日期**（`stampTaxRateOn`）。
 * 2026-09-03 之前它们被当成可配的数写死，而印花税 **2023-08-28 起已经减半到 0.05%**
 * ⇒ 一个 2 倍的误差被反解**整个折算进佣金率**，给出「你的佣金是万 1.13、还免最低」
 * 这种看起来精确、实际完全虚构的结论（真机核对：真实是万 2.25 + 最低 5 元）。
 * **规则一旦混进被解的未知数里，解出来的就不是费率而是误差的容器。**
 *
 * ## 最低手续费必须由用户说，解不出来
 *
 * `fee = max(最低, 金额 × 率 + 过户费)` 里有**两个**未知数，而只有一个方程。
 * 所以「免不免最低」做成一个**用户勾的开关**（那是他知道的账户事实），
 * 剩下的一个未知数才解得动。
 *
 * 实现是**二分**，前提是 `费用(费率)` 单调不减 —— `max()` 与线性项都单调。
 * 二分而不是解析解，是因为 `max()` 让它分段、且分段点取决于每一笔的金额。
 *
 * ⚠ **三种解不出来的情况必须分开报，不许夹到边界上给个数糊过去**：
 * 费用对费率完全不敏感（全被最低佣金盖住）· 目标超出费率能解释的范围
 * （那更可能是漏了一笔流水、或者最低佣金那个开关勾反了）· 压根没有会产生费用的流水。
 */

import type { Board, TradeDate } from '@core/types'
import type { FeeCalibration, FeeCalibrationRow, TradeFeeRates } from '@shared/ipc-types'
import {
  TRANSFER_FEE_RATE,
  buyFees,
  sellFees,
  stampTaxRateOn,
  type CostModel,
} from '../../backtest/costs'
import { shanghaiDate } from '@shared/time'
import { ratePerTenThousand } from '@shared/trade-fees'
import { COMMISSION_RATE_MAX } from '../settings/schema'
import type { LedgerSide } from './ledger'

/**
 * 用户费率 + **那一天的规则** → 记账用的 `CostModel`。
 *
 * `asOf` 是**这一笔成交那一天**的日期，**必填**：印花税 2023-08-28 起减半，
 * 给它一个默认值等于让漏传的调用点静默沿用旧规则（与 `priceLimitRatio` 同一条纪律）。
 * 印花税与过户费**不从用户设置读** —— 它们是规定不是偏好，见 `TradeFeeRates` 头注释。
 */
export function ledgerCosts(rates: TradeFeeRates, asOf: TradeDate): CostModel {
  return {
    commissionRate: rates.commissionRate,
    minCommission: rates.minCommission,
    stampTaxRate: stampTaxRateOn(asOf),
    transferFeeRate: TRANSFER_FEE_RATE,
    // 见头注释：记账不套滑点，这个 0 是刻意的
    slippage: 0,
  }
}

/** 成交时刻（epoch ms）→ 北京交易日，喂给 `ledgerCosts` 的第二参 */
export function tradeDateOf(tradedAt: number): TradeDate {
  return shanghaiDate(tradedAt)
}

/** 费用落库时按分取整（`round2`）⇒ 判「对上了」的容差取半分再放宽一点 */
const FEE_TOL = 0.01

/** 二分 60 次足够把 [0, 0.005] 收到 1e-20 —— 迭代次数固定，避免「收敛不了就死循环」 */
const BISECT_STEPS = 60

/**
 * 券商报价的粒度：**万分之 0.05**（万 0.85 / 万 1 / 万 2.5 / 万 3 …）。
 *
 * 反解落在一段费率上（费用按分取整），段内若有这样一个整档就取它 ——
 * 用户能拿它与账单对上，而万 0.7948 这种数他没法核对。
 */
const RATE_STEP = 0.000005

/**
 * 「这还像个佣金率吗」的提示线：**万 5**。
 *
 * 现今 A 股散户的真实档位在 **万 0.85 ~ 万 3**（监管上限是成交额 0.3% = 万 30，
 * 老账户里确实存在千 1.5 这种档），所以万 5 以上**不是不可能，只是很可疑**。
 *
 * ⚠ 它是**提示不是拒绝**，与 `COMMISSION_RATE_MAX` 那条硬线分开：
 * 硬线守的是「数量级填错了」，这条守的是「差额可能压根不是费率造成的」。
 * 做成拒绝会把一个合法的老账户挡在外面 —— 而那是用户自己能判断的事。
 */
const PLAUSIBLE_RATE_MAX = 0.0005

/** 反解要用到的一行。`fee` 是库里存着的那笔（= 现行费率下的数），用来报「现在算出来是多少」 */
export interface FeeRow {
  side: LedgerSide
  price: number
  shares: number
  fee: number
  /** 仅 `OPENING`：价已含费的那种**不产生费用**（它的 price 就是摊薄成本） */
  feeIncluded?: boolean
  /** 成交日，用来按「截止日」切窗口 */
  tradedAt: number
}

/**
 * 这一行在给定费率下会被收多少费。`null` = **这一行不产生费用**
 * （分红 / 送转不是成交；「价已含费」的建仓，它的费用当初就摊在那个价里了）。
 */
function feeOfRow(row: FeeRow, board: Board, rates: TradeFeeRates): number | null {
  const amount = row.price * Math.trunc(row.shares)
  // **按这一行自己的日期取规则** —— 印花税 2023-08-28 起减半，一律用「今天」的
  // 规则去算八年前那笔卖出，是这次要修的东西
  const costs = ledgerCosts(rates, tradeDateOf(row.tradedAt))
  if (row.side === 'BUY') return buyFees(amount, costs, board)
  if (row.side === 'SELL') return sellFees(amount, costs, board)
  if (row.side === 'OPENING') return row.feeIncluded === false ? buyFees(amount, costs, board) : null
  return null
}

/** 一批流水在给定费率下的费用合计（按分取整，与落库口径一致） */
function feeTotalUnder(rows: readonly FeeRow[], board: Board, rates: TradeFeeRates): number {
  let total = 0
  for (const row of rows) {
    const fee = feeOfRow(row, board, rates)
    if (fee !== null) total += Math.round(fee * 100) / 100
  }
  return Math.round(total * 100) / 100
}

export interface SolveResult {
  status: FeeCalibration['status']
  message: string
  /** 现行费率下、同一批流水的费用合计 */
  feeTotalNow: number
  /** 反解出来的费率；`OUT_OF_RANGE` 时是被夹住的那个边界（**仅供显示**） */
  rate?: number
  /** 用 `rate` 算出来的费用合计 */
  feeTotalAt?: number
  /** 参与反解的笔数（会产生费用、且在截止日之内的） */
  feeBearing: number
  /** 被截止日挡在外面的笔数 —— **必须报出来**，否则用户不知道今天那两笔没算进去 */
  excludedByDate: number
  /**
   * 逐笔会变成多少（只含参与反解的那些）。
   *
   * **合计按构造总是对上目标 ⇒ 合计分辨不出配置对不对**，只有逐笔分得出
   * （见 `FeeCalibrationRow`）。`status !== 'OK'` 时为空数组。
   */
  rows: FeeCalibrationRow[]
}

/**
 * 从「这只票的累计交易税费」反解佣金率。
 *
 * `minCommission` 由调用方在 `base` 里给定（用户勾的「免最低」开关决定它是 0 还是原值）
 * —— 一个方程解不了两个未知数，理由在头注释。
 */
export function solveFromFeeTotal(input: {
  rows: readonly FeeRow[]
  board: Board
  /** `minCommission` 已由「免最低」开关定好；印花税与过户费按日期取规则，不在这里 */
  base: TradeFeeRates
  targetFeeTotal: number
  /** 截止日（含这一天）。`undefined` = 全部算上 */
  throughMs?: number
}): SolveResult {
  const { board, base, targetFeeTotal } = input
  const through = input.throughMs
  const inWindow =
    through === undefined ? input.rows : input.rows.filter((row) => row.tradedAt <= through)
  const excludedByDate = input.rows.length - inWindow.length
  const bearing = inWindow.filter((row) => feeOfRow(row, board, base) !== null)
  const stats = { feeBearing: bearing.length, excludedByDate, rows: [] as FeeCalibrationRow[] }

  const feeAt = (rate: number): number =>
    feeTotalUnder(bearing, board, { ...base, commissionRate: rate })
  const feeTotalNow = feeAt(base.commissionRate)

  if (bearing.length === 0) {
    return {
      status: 'NO_BASIS',
      message:
        '截止日之内没有任何会产生手续费的流水 —— 只有分红送转、或者只有「价已含费」的建仓。' +
        '把截止日往后挪，或者换一只有买卖记录的票。',
      feeTotalNow,
      ...stats,
    }
  }
  if (!Number.isFinite(targetFeeTotal) || targetFeeTotal < 0) {
    return { status: 'OUT_OF_RANGE', message: '累计税费要填一个非负数。', feeTotalNow, ...stats }
  }

  const low = feeAt(0)
  const high = feeAt(COMMISSION_RATE_MAX)

  // 费用压根不随费率变 ⇒ 解不出东西。**这是数学结论，不是启发式**
  if (high - low < FEE_TOL) {
    return {
      status: 'UNIDENTIFIABLE',
      message:
        `这 ${bearing.length} 笔全都触到了最低手续费（${base.minCommission} 元）` +
        `—— 佣金率对总费用没有影响，反解不出来。` +
        (base.minCommission > 0
          ? '如果你的券商其实免这个最低，勾上「免 5 元最低佣金」再试。'
          : '换一只单笔金额更大的票再试。'),
      feeTotalNow,
      ...stats,
    }
  }

  if (targetFeeTotal < low - FEE_TOL) {
    const hint =
      base.minCommission > 0
        ? `**先检查「免 5 元最低佣金」那个勾**：${bearing.length} 笔里每笔至少 ` +
          `${base.minCommission} 元，光这一项就 ${(base.minCommission * bearing.length).toFixed(2)} 元。`
        : '这个差额不像是费率造成的 —— 更可能是这只票的流水里**多录了一笔**，' +
          '或者券商那个数只统计了一部分时间。'
    return {
      status: 'OUT_OF_RANGE',
      message:
        `即使佣金率为 0，这 ${bearing.length} 笔的费用也有 ${low.toFixed(2)} 元，` +
        `比你填的 ${targetFeeTotal.toFixed(2)} 高 ${(low - targetFeeTotal).toFixed(2)}。${hint}`,
      feeTotalNow,
      rate: 0,
      feeTotalAt: low,
      ...stats,
    }
  }
  if (targetFeeTotal > high + FEE_TOL) {
    return {
      status: 'OUT_OF_RANGE',
      message:
        `即使佣金率拉到千分之五（远高于任何真实档位），这 ${bearing.length} 笔的费用也只有 ` +
        `${high.toFixed(2)} 元，还比你填的 ${targetFeeTotal.toFixed(2)} 低 ` +
        `${(targetFeeTotal - high).toFixed(2)}。这个差额不像是费率造成的 —— ` +
        `更可能是这只票的流水里**漏录了一笔成交**，或者券商那个数还含着别的费用。`,
      feeTotalNow,
      rate: COMMISSION_RATE_MAX,
      feeTotalAt: high,
      ...stats,
    }
  }

  /*
    二分。`费用(费率)` 单调不减，所以取中点比一次就能定方向。

    ⚠ **要的是那一整段的中点，不是第一个够到目标的费率。** 费用按分取整
    ⇒ 同一个总数对应的是**一整段费率**。取下边界的话，反解出来的数会系统性地偏低半段
    —— 用户的券商报的是万 1.13，界面上却写万 1.08，而两个数在这份数据上**同样对得上**。
  */
  const firstRateWhere = (pred: (fee: number) => boolean): number => {
    let lo = 0
    let hi = COMMISSION_RATE_MAX
    for (let i = 0; i < BISECT_STEPS; i += 1) {
      const mid = (lo + hi) / 2
      if (pred(feeAt(mid))) hi = mid
      else lo = mid
    }
    return (lo + hi) / 2
  }
  const lower = firstRateWhere((fee) => fee >= targetFeeTotal)
  const upper = firstRateWhere((fee) => fee > targetFeeTotal)
  let rate = (lower + upper) / 2
  /*
    段内若正好有一个「券商会报出来的档位」，取它。券商的报价粒度是**万分之 0.05**
    （万 0.85 / 万 1 / 万 2.5 / 万 3 …）⇒ 与其给一个万 1.1264 这种谁都没听过的数，
    不如给那个用户能与账单对上的档 —— 两者在这份数据上产生**逐位相同**的费用合计。
    对不上（段太窄，中间没有整档）时保留中点，不硬凑。
  */
  const snapped = Math.round(rate / RATE_STEP) * RATE_STEP
  if (
    snapped >= 0 &&
    snapped <= COMMISSION_RATE_MAX &&
    Math.abs(feeAt(snapped) - targetFeeTotal) <= FEE_TOL
  ) {
    rate = snapped
  }
  const solvedTotal = feeAt(rate)
  /*
    逐笔摊开。**这一列才是判据** —— 合计是反解出来的，它按构造总能对上，
    分辨不出「免最低勾了没有」这种配置错误（真机踩过：同一个 85.11，
    勾与不勾都对得上合计，而逐笔一个 8/8 全错、一个 8/8 零残差）。
  */
  const solvedRates = { ...base, commissionRate: rate }
  const perRow: FeeCalibrationRow[] = bearing.map((row) => ({
    tradedAt: row.tradedAt,
    side: row.side,
    amount: row.price * Math.trunc(row.shares),
    feeNow: Math.round((feeOfRow(row, board, base) ?? 0) * 100) / 100,
    feeAfter: Math.round((feeOfRow(row, board, solvedRates) ?? 0) * 100) / 100,
  }))

  // 解出来了，但那个数不像个佣金率 ⇒ 把疑点说出来，**不替用户否掉**（见 PLAUSIBLE_RATE_MAX）
  const plausibilityNote =
    rate > PLAUSIBLE_RATE_MAX
      ? `⚠ ${ratePerTenThousand(rate)} 远高于现今的常见档位（万 0.85 ~ 万 3）。` +
        `如果你的券商不是这个价，那这点差额更可能来自**漏录的一笔成交**，而不是费率 —— ` +
        `按它应用会把那个漏掉的东西固化成一个假费率，并作用到全部标的上。`
      : ''
  const excludedNote =
    excludedByDate > 0 ? `（截止日之后的 ${excludedByDate} 笔没有参与反解。）` : ''
  /*
    顺带报出**合计费率**（佣金 + 过户费）。券商账单上「佣金」那一栏多半就是这个数 ——
    同花顺把过户费并进佣金里、「其他费用」显示 0.00（2026-09-03 用户实测），
    而我们拆成两项。钱完全一样，但只报净佣金率会让用户拿账单一除就发现「对不上」。
  */
  const allIn = ratePerTenThousand(rate + TRANSFER_FEE_RATE)
  return {
    status: 'OK',
    message:
      `按 ${bearing.length} 笔流水反解出佣金率 ${ratePerTenThousand(rate)}` +
      `（现行 ${ratePerTenThousand(base.commissionRate)}，最低手续费 ` +
      `${base.minCommission === 0 ? '免' : `${base.minCommission} 元`}）。` +
      `连过户费一起算是 ${allIn} —— 券商账单上「佣金」那一栏多半是这个数。` +
      `${excludedNote}${plausibilityNote}`,
    feeTotalNow,
    rate,
    feeTotalAt: solvedTotal,
    ...stats,
    rows: perRow,
  }
}

// 「万几」那个显示口径住 `shared/trade-fees.ts`（主/渲染共用一处定义）。
// 从这里再导出一次，是为了让 controller 只认一个入口
export { ratePerTenThousand }
