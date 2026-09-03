/**
 * 费率：① 用户费率 → 记账用的 `CostModel`；② **从真实成本反解佣金率**（017）。**纯函数。**
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
 * ## 反解（`solveCommissionRate`）
 *
 * 用户抄下券商 App 上那只票的摊薄成本，这里找一个佣金率让流水重放出同一个数。
 * **判据是可核对性**：那个成本价用户每天都在看，是**事实**；而费率不是
 * —— 让他对着四个没有依据的框猜，比让他抄一个数难得多（同 docs/01 §5.5
 * 「设置页不给参数编辑框」那条取舍）。
 *
 * 实现是**二分**，前提是 `成本(费率)` **单调不减**：费率只从 `buyFees` 进成本，
 * 而 `buyFees = max(最低, 金额 × 率) + 金额 × 过户费率` 对率单调不减。
 * 二分而不是解析解，是因为 `max()` 让它分段、且分段点取决于每一笔的金额。
 *
 * ⚠ **三种解不出来的情况必须分开报，不许夹到边界上给个数糊过去**（见 `CostCalibration`）：
 * 每一笔都触到最低佣金（成本对费率完全不敏感）· 差额超出费率能解释的范围
 * （那更可能是漏了一笔流水）· 压根没有会产生费用的流水。
 */

import type { Board } from '@core/types'
import type { CostCalibration, TradeFeeRates } from '@shared/ipc-types'
import type { CostModel } from '../../backtest/costs'
import { ratePerTenThousand } from '@shared/trade-fees'
import { COMMISSION_RATE_MAX } from '../settings/schema'
import { replayLedger, type LedgerReplayRow } from './ledger'

export function ledgerCosts(rates: TradeFeeRates): CostModel {
  return {
    commissionRate: rates.commissionRate,
    minCommission: rates.minCommission,
    stampTaxRate: rates.stampTaxRate,
    transferFeeRate: rates.transferFeeRate,
    // 见头注释：记账不套滑点，这个 0 是刻意的
    slippage: 0,
  }
}

/**
 * 成本价保留 4 位（`round4`）⇒ 判「对上了」的容差取半个末位。
 * 再严就会因为浮点尾巴永远判不通过，再松则会在 1000 股上差出 0.1 元。
 */
const COST_TOL = 1e-4

/** 二分 60 次足够把 [0, 0.005] 收到 1e-20 —— 迭代次数固定，避免「收敛不了就死循环」 */
const BISECT_STEPS = 60

/**
 * 券商报价的粒度：**万分之 0.05**（万 0.85 / 万 1 / 万 2.5 / 万 3 …）。
 *
 * 反解落在一段费率上（成本按 `round4` 落库），段内若有这样一个整档就取它 ——
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
 * 做成拒绝会把一个合法的老账户挡在外面 —— 而那是用户自己能判断的事，
 * 把数摆给他看就够了（真机 2026-09-03 实测：把某只票的成本抬 0.01
 * 就要万 11.45，那个数一眼就知道不对，前提是界面把它印出来）。
 */
const PLAUSIBLE_RATE_MAX = 0.0005

/** 这一行会不会产生**进成本**的费用（= 买入，与「不含费」的建仓） */
function bearsCostFee(row: LedgerReplayRow): boolean {
  if (row.side === 'BUY') return true
  return row.side === 'OPENING' && row.feeIncluded === false
}

export interface SolveResult {
  status: CostCalibration['status']
  message: string
  /** 现行费率下重放出来的成本。没有持仓时为 null */
  costNow: number | null
  /** 反解出来的费率；`OUT_OF_RANGE` 时是被夹住的那个边界（**仅供显示**） */
  rate?: number
  /** 用 `rate` 重放出来的成本 */
  costAt?: number
  minCommissionBound: number
  feeBearing: number
}

/**
 * 从「这只票的真实摊薄成本」反解佣金率。
 *
 * `rows` 必须按 `traded_at` 升序（与 `replayLedger` 同一条前提）。
 * `base` 的另外三项一动不动 —— 一个方程解不了两个未知数，理由在 `TradeFeeRates`。
 */
export function solveCommissionRate(input: {
  rows: readonly LedgerReplayRow[]
  board: Board
  base: TradeFeeRates
  targetCost: number
}): SolveResult {
  const { rows, board, base, targetCost } = input

  const costAt = (rate: number): number | null =>
    replayLedger(rows, board, ledgerCosts({ ...base, commissionRate: rate }), { refee: true })
      .position?.cost ?? null

  // 会影响成本的那些行，以及其中有多少笔触到最低佣金（只用来解释，不参与判据）
  const bearing = rows.filter(bearsCostFee)
  const feeBearing = bearing.length
  const minCommissionBound = bearing.filter(
    (row) => row.price * Math.trunc(row.shares) * base.commissionRate <= base.minCommission
  ).length

  const stats = { minCommissionBound, feeBearing }
  const costNow = costAt(base.commissionRate)
  if (costNow === null) {
    return {
      status: 'NO_POSITION',
      message: '这只票现在没有持仓，没有「当前成本」可以校正。',
      costNow: null,
      ...stats,
    }
  }
  if (!Number.isFinite(targetCost) || targetCost <= 0) {
    return { status: 'OUT_OF_RANGE', message: '成本价要填一个正数。', costNow, ...stats }
  }
  if (feeBearing === 0) {
    return {
      status: 'NO_BASIS',
      message:
        '这只票的流水里没有任何会产生手续费的买入 —— ' +
        '只有卖出、分红送转，或者建仓那一笔填的是「价已含费」。反解不出费率。',
      costNow,
      ...stats,
    }
  }

  const low = costAt(0)
  const high = costAt(COMMISSION_RATE_MAX)
  if (low === null || high === null) {
    return { status: 'NO_POSITION', message: '重放不出持仓，校正做不了。', costNow: null, ...stats }
  }

  // 成本压根不随费率变 ⇒ 这只票身上没有可解的东西。**这是数学结论，不是启发式**
  if (high - low < COST_TOL) {
    return {
      status: 'UNIDENTIFIABLE',
      message:
        `这只票 ${feeBearing} 笔买入全都触到了最低佣金（${base.minCommission} 元）` +
        `—— 佣金率对它的成本没有影响，从它身上反解不出费率。` +
        `换一只单笔金额更大的票再试。`,
      costNow,
      ...stats,
    }
  }

  if (targetCost < low - COST_TOL) {
    return {
      status: 'OUT_OF_RANGE',
      message:
        `即使佣金率为 0，这只票的成本也只能降到 ${low.toFixed(3)}，比你填的 ` +
        `${targetCost.toFixed(3)} 还高 ${(low - targetCost).toFixed(3)}。` +
        `这个差额不像是费率造成的 —— 更可能是**漏录了一笔分红**、` +
        `某一笔的成交价填高了，或者漏了一笔卖出。`,
      costNow,
      rate: 0,
      costAt: low,
      ...stats,
    }
  }
  if (targetCost > high + COST_TOL) {
    return {
      status: 'OUT_OF_RANGE',
      message:
        `即使佣金率拉到千分之五（远高于任何真实档位），这只票的成本也只能升到 ` +
        `${high.toFixed(3)}，还比你填的 ${targetCost.toFixed(3)} 低 ` +
        `${(targetCost - high).toFixed(3)}。这个差额不像是费率造成的 —— ` +
        `更可能是**漏录了一笔买入**，或者某一笔的成交价填低了。`,
      costNow,
      rate: COMMISSION_RATE_MAX,
      costAt: high,
      ...stats,
    }
  }

  /*
    二分。`成本(费率)` 单调不减（见头注释），所以取中点比一次就能定方向。

    ⚠ **要的是那一整段的中点，不是第一个够到目标的费率。** 成本按 `round4` 落库
    （费用又是 `round2`）⇒ 同一个成本对应的是**一整段费率**（10 万的单子上宽约
    万 0.1）。取下边界的话，反解出来的数会系统性地偏低半段 —— 用户的券商报的是
    万 0.8，界面上却写万 0.75，而两个数在这份数据上**同样对得上**。
  */
  const firstRateWhere = (pred: (cost: number) => boolean): number => {
    let lo = 0
    let hi = COMMISSION_RATE_MAX
    for (let i = 0; i < BISECT_STEPS; i += 1) {
      const mid = (lo + hi) / 2
      const cost = costAt(mid)
      if (cost === null) break
      if (pred(cost)) hi = mid
      else lo = mid
    }
    return (lo + hi) / 2
  }
  const matches = (rate: number): boolean => {
    const cost = costAt(rate)
    return cost !== null && Math.abs(cost - targetCost) <= COST_TOL
  }

  const lower = firstRateWhere((cost) => cost >= targetCost)
  const upper = firstRateWhere((cost) => cost > targetCost)
  let rate = (lower + upper) / 2
  /*
    段内若正好有一个「券商会报出来的档位」，取它。券商的报价粒度是**万分之 0.05**
    （万 0.85 / 万 1 / 万 2.5 / 万 3 …）⇒ 与其给一个万 0.7948 这种谁都没听过的数，
    不如给那个用户能与账单对上的档 —— 两者在这份数据上产生**逐位相同**的成本。
    对不上（段太窄，中间没有整档）时保留中点，不硬凑。
  */
  const snapped = Math.round(rate / RATE_STEP) * RATE_STEP
  if (snapped >= 0 && snapped <= COMMISSION_RATE_MAX && matches(snapped)) rate = snapped
  const solvedCost = costAt(rate) ?? costNow

  const boundNote =
    minCommissionBound > 0
      ? `（其中 ${minCommissionBound} 笔触到了最低佣金 ${base.minCommission} 元 —— ` +
        `如果你的券商其实免这个最低，反解出来的费率会偏低。）`
      : ''
  // 解出来了，但那个数不像个佣金率 ⇒ 把疑点说出来，**不替用户否掉**（见 PLAUSIBLE_RATE_MAX）
  const plausibilityNote =
    rate > PLAUSIBLE_RATE_MAX
      ? `⚠ ${ratePerTenThousand(rate)} 远高于现今的常见档位（万 0.85 ~ 万 3）。` +
        `如果你的券商不是这个价，那这点差额更可能来自**漏录的一笔流水**` +
        `（分红、送转，或者某一笔的成交价填偏了），而不是费率 —— ` +
        `按它应用会把那个漏掉的东西固化成一个假费率，并作用到全部标的上。`
      : ''
  return {
    status: 'OK',
    message:
      `按 ${feeBearing} 笔买入反解出佣金率 ${ratePerTenThousand(rate)}` +
      `（现行 ${ratePerTenThousand(base.commissionRate)}）。${boundNote}${plausibilityNote}`,
    costNow,
    rate,
    costAt: solvedCost,
    ...stats,
  }
}

// 「万几」那个显示口径住 `shared/trade-fees.ts`（主/渲染共用一处定义）。
// 从这里再导出一次，是为了让 controller 只认一个入口
export { ratePerTenThousand }
