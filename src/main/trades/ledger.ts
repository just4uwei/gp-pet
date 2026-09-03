/**
 * 成交记账规则（007_trade_log.sql）。**纯函数，不碰数据库、不读时钟。**
 *
 * 这里是持仓变化的唯一实现：UI 的提交前试算与主进程的落库走的是同一个函数。
 * 两处各算一遍必然分叉，而分叉出来的症状是「表单说成本会变成 12.34，存完变成 12.31」
 * —— 用户只会认为软件算错了，而且他没法判断哪个数才是对的。
 *
 * ## 口径
 *
 * - **买入**：成本按加权平均摊薄，**含手续费**（券商的摊薄成本口径）。
 *   含费是有代价的选择：它让成本价略高于成交价，看起来「买贵了」；
 *   但不含费的话止损线会系统性地偏乐观 —— 而止损用的正是这个数（docs/05 §2.3）。
 * - **卖出**：只减股数，**成本价一个字不动**，差额结转成已实现盈亏。
 *   这是先进先出/加权平均都通用的做法，也让「浮盈」与「已实现」两个数各归各的。
 * - **卖出超过持有股数一律拒绝。** 不允许出现负持仓：这个软件不接券商、不支持融券，
 *   一个负数持仓会一路传到风控层，而那边所有规则都假设 shares > 0。
 * - **现金分红**（`DIVIDEND`，017）：**扣减摊薄成本**，不进已实现盈亏。
 *   判据是这张账的价格口径 —— 成本与展示价都是**不复权**的（docs/03 §2.3），
 *   而除权那天价格自己会掉下来。成本不跟着掉 ⇒ 界面显示一段**假浮亏**，
 *   止损缓冲被凭空吃掉。唯一的例外是累计分红把成本摊到了 0：
 *   多出来的那部分记进 `realized`（丢掉等于凭空少一笔钱，让成本变负会让
 *   浮亏百分比与止损线一起失去意义）。
 * - **送股 / 转增**（`SPLIT`，017）：股数增、成本按比例摊薄、**总成本恒定**，
 *   并给出 `peakScale` 让调用方把 `position.peak_price` 一起缩放。
 *   不缩放 peak 的后果不是「多一条提醒」，而是**移动止损立刻读出一个假回撤**
 *   —— 与 009 头注释里 `acceptLoss` 不重设 peak 的那个失效形状一模一样。
 *
 * ## 手续费：真实账单优先于任何公式
 *
 * 费率来自用户自己的设置（`AppSettings.tradeCosts` → `fees.ts` 的 `ledgerCosts`），
 * 逐笔还可以用 `TradeInput.feeOverride` 直接填券商账单上那个数。
 * `feeOverride = 0` 是**合法**的（有券商减免）—— 所以「没填」必须是 `undefined`
 * 而不是 0，否则减免会被下一次「按新费率重算全库」改掉。
 *
 * ## 绝不套用滑点
 *
 * `backtest/costs.ts` 里还有 `buyFill` / `sellFill` 两个函数 —— **这里一个都不能用。**
 * 那两个是给回测的：模拟「我不知道会成交在哪，所以往不利方向偏一点」。
 * 而这里用户填的**就是真实成交价**（他从券商 App 上抄下来的），
 * 再套一层滑点等于凭空把他的成交价改坏 0.1%，然后这个错误会一路进成本、进盈亏、进止损线。
 * 这是这个文件里最容易被「顺手复用」错的地方。
 *
 * 费率复用 `backtest/costs.ts` 是刻意的（CLAUDE.md 里 `main → backtest` 那条横向边的
 * 第二个用例，第一个是影子运行）：口径各写一份，实盘盈亏与影子绩效就再也对不上。
 *
 * ## 机会成本口径（`C_o`）—— **2026-08-24 用户拍板，选 ②「只算 L3 强制类」**
 *
 * 这张账是 implementation shortfall（**Perold 1988**，`IS = C_d + C_i + C_e + C_o`）
 * 的真实那一侧，而 `C_o` = 「想买但没买 / 该卖没卖」那一块。
 * 对 L0 这个「提醒 → 人决策」的形态它是四个分量里**最大的一块**
 * （[M2 §5.53](../../../docs/notes/M2-偏差报告.md) 实测：7 天里引擎 52 条 CONFIRMED、
 * 用户动手 6 次，而 `C_i` 的上界只有滑点 10 bp）。
 *
 * **拍下来的口径**：只有**持仓强制类（L3）**的提醒没被执行才计入 `C_o` 的**金额**
 * —— 止损、移动止损那一类「不做会真的亏钱」的。普通买入建议不计。
 *
 * **为什么不是「全算」**：全算等于假设「提醒即应执行」，而**故意不动手是 L0 设计里
 * 人该有的权力**（docs/06 的零干扰契约整套都建立在这上面）。
 * 把正确的克制记成成本，会让这个指标推着系统去追依从率 —— 那是 L4 的语义，不是 L0 的。
 *
 * **为什么不是「只报计数」**：止损没执行是**真金白银**的损失，只给一个计数等于说不出它多大。
 *
 * ⚠ **两处不许顺手做**：① **非 L3 那些照样要报计数**（口径管的是折不折成金额，
 * 不是要不要可见）；② **L3 与非 L3 的界线本身是个自由度** —— 用户「整体上调/下调一档」
 * 不作用于持仓强制类（`alert-candidates` 有用例钉着），所以这条界线在提醒层是稳定的，
 * **别在 IS 这一侧另立一套 level 判定**。
 * 计算实现在 `scripts/verify/impl-shortfall.ts`。
 *
 * ## 真实成交时刻已落库（2026-08-26，016_trade_decision.sql）
 *
 * 上面那个口径此前「定死了但算不出数」，缺的两样输入现在有了 ——
 * `trade_log` 多了四列：`traded_at_exact`（真实成交时刻，含分钟）·
 * `signal_id`（照哪条提醒做的）· `decision_at` / `decision_price`（决策时刻与决策价的冗余快照）。
 *
 * **四条纪律**（每一条都有对应的坑）：
 *
 * 1. **四列全部可空，NULL 是「不知道」不是 0**（约束 4）。**不许拿 `traded_at` 顶替
 *    `traded_at_exact`** —— 那是把「不记得分钟」写成「中午 12 点成交」，
 *    而 IS 分解会把它当真实时刻用。补录历史成交时用户根本不记得分钟，
 *    所以它**永远是可选的**：少一个样本，好过多一个编出来的时刻。
 * 2. **关联由用户手动选，程序不猜。** 按成交时刻自动挂到「之前最近的一条提醒」
 *    会造出一批看起来有依据、实际是猜的链接 —— 用户完全可能是看了行情自己决定的。
 *    候选列表走 `trade:decisionOptions`（`controller.decisionOptions`）。
 * 3. **快照以库里的为准。** `addTrade` 拿 `signalId` 回 `signal` 表查，
 *    查不到或 `code` 对不上就**报错**（静默落 NULL 的话，用户以为关联上了、
 *    而 IS 那边永远少一个样本，两边都看不出来）。渲染层送来的决策价一概不采信。
 * 4. **`C_i` 仍然测不了，别把这次改动读成「IS 四项齐了」。** 拆 `C_d`/`C_i` 需要
 *    **下单时价**（arrival price），而用户不会记录「几点挂的单 vs 几点成交」。
 *    这次拿到的是另外两样：**决策 → 成交的时间轴精确到分钟**（不再按日），
 *    以及**样本不再静默丢**（M2 §5.53：`SH601788` 08-18 首条信号 13:04 vs 假时刻 13:00，
 *    **差 4 分钟**就让整对配不上，表里只剩一个「—」）。
 *
 * ⚠ **`C_o` 还是算不出数**，但卡的东西换了：不再是缺字段，而是**缺带关联的成交**
 * —— 016 之前的 18 行四列全 NULL（不猜、不回填），得等新的成交攒起来。
 */

import type { Board } from '@core/types'
import type { TradeSide } from '@shared/ipc-types'
import { DEFAULT_COSTS, buyFees, sellFees, type CostModel } from '../../backtest/costs'

/** 五种流水的定义在 `shared/ipc-types.ts` 的 `TradeSide`（一处定义，主/渲染共用） */
export type LedgerSide = TradeSide

export interface LedgerPosition {
  shares: number
  /** 加权平均成本（含费），不复权 */
  cost: number
}

export interface TradeInput {
  side: LedgerSide
  /**
   * - `BUY` / `SELL`：**不复权真实成交价**（**不含**手续费）；
   * - `OPENING`：成本价，含不含费由 `feeIncluded` 说；
   * - `DIVIDEND`：**税后每股派现**；
   * - `SPLIT`：忽略（送股没有成交价，你一分钱没付）。
   */
  price: number
  /** `SPLIT` 时是**新增**股数；`DIVIDEND` 时是分红涉及的股数 */
  shares: number
  /**
   * 板块。**必填**，因为费率靠它区分：场内基金（ETF/LOF）免印花税与过户费。
   *
   * ⚠ 刻意不给缺省值。`costs.ts` 的缺省是「按股票收满」（回测偏保守是安全方向），
   * 但**记账不能靠那个缺省** —— ETF 多扣 0.1% 会让成本价与已实现盈亏系统性偏高，
   * 而这张账存在的意义就是「实盘盈亏与影子绩效可比」。
   * 让它必填 = 调用方漏传时**编译不过**，而不是静默算错。
   */
  board: Board
  /**
   * 仅 `OPENING`：那个 `price` 已经含手续费了吗（017）。
   *
   * - `false`（**新录入的默认**）⇒ 按费率补算一笔，成本 = `(金额 + 费) / 股数`；
   * - `true` ⇒ 那个价直接就是摊薄成本，不再收费（007 迁移与配置导入补的老行是这一种，
   *   它们的 price 取自 `position.cost`，按定义就含费 —— 这不是猜，是那两条路的定义）。
   *
   * ⚠ **缺省按 `true`（老语义）而不是按新默认**。判据是「谁在调用」：
   * 缺这个键的只有 017 之前落库的行，而它们全部是含费的。
   * 反过来把缺省定成 `false`，升级那一刻全库的期初成本会被凭空补一笔费用。
   */
  feeIncluded?: boolean
  /**
   * 用**库里存着的那笔费用**，而不是按 `costs` 现算（017）。
   *
   * ⚠ **这不是「让用户手填手续费」那个功能** —— 用户填不了这个数（2026-09-03 拍板：
   * 对不上时改的是费率，走「校正成本」反解）。它只有一个调用方：`replayLedger`
   * 的非 `refee` 那条路。
   *
   * 为什么必须能覆盖：`cost` 里含着买入那笔费用，所以「重放要沿用旧费用」这件事
   * **不能只在返回值上做** —— 只改报出去的 `fee`、成本仍按新费率算的话，
   * 两个数会当场对不上（`成本 × 股数 − 成交额 ≠ fee`），而这正是本项目最怕的
   * 「一个对不上的数字」。
   *
   * 非有限值或负数一律忽略（退回现算）：那是坏掉的库数据，不是一个决定。
   */
  feeOverride?: number
}

/** `feeOverride` 只在它像个费用时才作数 —— 坏数据退回现算，而不是把负费用摊进成本 */
function overriddenFee(input: TradeInput): number | null {
  const value = input.feeOverride
  if (value === undefined || !Number.isFinite(value) || value < 0) return null
  return round2(value)
}

export interface TradeApplied {
  /** 变化后的持仓。null = 已清仓，调用方应删除持仓行 */
  position: LedgerPosition | null
  fee: number
  /**
   * 本笔结转的已实现盈亏（含费）。买入 / 送转为 null —— **不是 0**（约束 4）。
   *
   * 分红只在「累计分红已经把成本摊到 0」时才有值（超出成本基数的那部分）。
   */
  realized: number | null
  /**
   * 送转带来的股数缩放：`新的 peak_price = 旧的 × peakScale`。**其余 side 恒为 1。**
   *
   * 为什么由这一层给而不是让调用方自己算：它等于 `持股数 / 送转后股数`，
   * 而那两个数只有这里知道（调用方手里只有「送了多少股」）。照抄一遍必然分叉，
   * 而分叉的症状是移动止损的参考点偏掉 —— 一条 L3 强制类规则静默改变触发点。
   */
  peakScale: number
}

export type TradeOutcome = TradeApplied | { error: string }

export function isTradeError(outcome: TradeOutcome): outcome is { error: string } {
  return 'error' in outcome
}

/** 分位取整。避免 0.1 + 0.2 那类浮点尾巴一路累积进成本价 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 成本价多留两位：1000 股上 0.0001 的误差就是 0.1 元，四舍五入到分会肉眼可见地漂 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

export function applyTrade(
  current: LedgerPosition | null,
  input: TradeInput,
  costs: CostModel = DEFAULT_COSTS
): TradeOutcome {
  const shares = Math.trunc(input.shares)
  // 送股没有成交价（你一分钱没付）⇒ 只有它允许 price 为 0，其余四种必须是正数
  if (input.side !== 'SPLIT' && (!Number.isFinite(input.price) || input.price <= 0)) {
    return { error: input.side === 'DIVIDEND' ? '每股派现必须是一个正数' : '成交价必须是一个正数' }
  }
  if (!Number.isFinite(shares) || shares <= 0) return { error: '股数必须是一个正整数' }

  const amount = input.price * shares

  if (input.side === 'OPENING') {
    /*
      建仓 = 账本的起点，**它不叠加在已有持仓上**：整个持仓被这一行重设。
      这正是 007 迁移与配置导入需要的语义，也是用户「我早就持有这只票」时想要的。

      含费与不含费的区别只有一处 —— 要不要补算那笔费用（见 `TradeInput.feeIncluded`）。
      两条边界：① 含费那一种的 `fee` 落 0，而那个 0 是**「不知道」**（007 头注释），
      不是「没有」；② 不含费那一种的 fee 是**算出来的**，所以它会跟着费率重算走。
    */
    const included = input.feeIncluded ?? true
    const fee = included ? 0 : (overriddenFee(input) ?? round2(buyFees(amount, costs, input.board)))
    return {
      position: { shares, cost: included ? round4(input.price) : round4((amount + fee) / shares) },
      fee,
      realized: null,
      peakScale: 1,
    }
  }

  if (input.side === 'BUY') {
    const fee = overriddenFee(input) ?? round2(buyFees(amount, costs, input.board))
    const heldShares = current?.shares ?? 0
    const heldValue = (current?.cost ?? 0) * heldShares
    const nextShares = heldShares + shares
    return {
      position: { shares: nextShares, cost: round4((heldValue + amount + fee) / nextShares) },
      fee,
      realized: null,
      peakScale: 1,
    }
  }

  if (input.side === 'DIVIDEND') {
    /*
      现金分红 → **扣减摊薄成本**（2026-09-03 拍板，017 头注释里那张表）。

      `shares` 是分红涉及的股数（正常等于当时持股数），而**摊到每股上要除以持股数**
      —— 两个数在补录时可能不一致（例如用户按公告的股数填），那时正确的做法仍是
      「到账总额 ÷ 现在持有多少股」：那笔钱是事实，怎么摊只有一种算得对的方式。
    */
    if (!current || current.shares <= 0) return { error: '当前没有持仓，分红无从摊到成本上' }
    const perShare = amount / current.shares
    const raw = current.cost - perShare
    // 成本不许变负：负成本会让浮亏百分比与止损线一起失去意义。
    // 超出成本基数的那部分记成已实现 —— 丢掉等于凭空少一笔钱
    const overflow = raw < 0 ? round2(-raw * current.shares) : null
    return {
      position: { shares: current.shares, cost: round4(Math.max(0, raw)) },
      fee: 0,
      realized: overflow,
      peakScale: 1,
    }
  }

  if (input.side === 'SPLIT') {
    /*
      送股 / 转增：股数增、成本按比例摊薄、**总成本恒定**（你没付钱，所以没有新增成本）。

      `peakScale` 必须一起交出去 —— 不缩放 `position.peak_price` 的后果不是
      「多一条提醒」，而是移动止损立刻读出一个**假回撤**（10 送 10 就是 −50%），
      与 009 头注释里 `acceptLoss` 不重设 peak 的那个失效形状一模一样。
    */
    if (!current || current.shares <= 0) return { error: '当前没有持仓，没有可以送转的股票' }
    const nextShares = current.shares + shares
    return {
      position: { shares: nextShares, cost: round4((current.cost * current.shares) / nextShares) },
      fee: 0,
      realized: null,
      peakScale: current.shares / nextShares,
    }
  }

  if (!current || current.shares <= 0) return { error: '当前没有持仓，无法卖出' }
  if (shares > current.shares) {
    return { error: `卖出 ${shares} 股超过持有的 ${current.shares} 股` }
  }

  const fee = overriddenFee(input) ?? round2(sellFees(amount, costs, input.board))
  const realized = round2((input.price - current.cost) * shares - fee)
  const nextShares = current.shares - shares
  return {
    // 清仓：持仓行删掉，但流水与已实现盈亏留着 —— 那才是「这只票总共赚了多少」的答案
    position: nextShares === 0 ? null : { shares: nextShares, cost: current.cost },
    fee,
    realized,
    peakScale: 1,
  }
}

/**
 * 「这笔卖出超过了成交当日的可卖股数」的提示语 —— A 股 T+1，当日买入当日卖不出。
 *
 * ## 为什么是提示而不是拒绝
 *
 * 这个函数**不属于** `applyTrade`，它的结论也不进 `TradeOutcome.error`：
 * 跨境 / 债券 / 黄金 ETF 与可转债确实是 T+0，而用户还可能在补录历史成交、
 * 或者把成交日期填错了。把一条**合法**成交挡在外面，症状是
 * 「我明明这么成交的，软件说存不进去」—— 那比多给一句提示贵得多。
 * 所以它落在 `TradePreview.warning`（琥珀色）而不是 `error`（玫红色）。
 *
 * ## 三个入参的口径
 *
 * - `heldShares` 是**这笔成交之前**的持股数；
 * - `sameDayBuyShares` 是**该成交日**（不是「今天」）买入的股数 ——「补录上周那笔卖出」
 *   是常态，拿今天的日界去卡它会对每一笔历史成交都报一次；
 * - 两者相减就是那天真正卖得掉的量，与风控层的 `sellableShares()` 是同一个算式。
 *
 * 放在这个纯函数模块里而不是 controller 里，是为了让措辞与判据能被用例钉住 ——
 * 它是唯一一处会直接影响用户「要不要按下确认」的文案。
 */
export function t1SellNotice(input: {
  side: TradeSide
  shares: number
  heldShares: number
  sameDayBuyShares: number
}): string | null {
  const { side, shares, heldShares, sameDayBuyShares } = input
  if (side !== 'SELL') return null
  if (heldShares <= 0 || sameDayBuyShares <= 0) return null

  const sellable = Math.max(0, heldShares - sameDayBuyShares)
  if (Math.trunc(shares) <= sellable) return null
  return (
    `成交当日买入过 ${sameDayBuyShares} 股 —— A 股 T+1 下当日买入当日卖不出，` +
    `那天最多卖 ${sellable} 股。确认一下成交日期是否填对。` +
    `（跨境 / 债券 / 黄金 ETF 与可转债是 T+0，不受此限，可以照录）`
  )
}

/**
 * 「这笔是照哪条提醒做的」那个关联的**判据**（016）。
 *
 * ## 为什么是纯函数而不是写在 controller 里
 *
 * 与 `t1SellNotice` 同一个理由：它决定的是**账本里存下什么**，而那要能被用例钉住。
 * controller 只负责去库里把那条信号捞出来，判断在这里做。
 *
 * ## 三条边界
 *
 * 1. **查不到就报错，绝不静默落 NULL。** 静默的症状最坏：用户在表单里明明选了
 *    一条提醒、以为关联上了，而 IS 那边永远少一个样本 —— **两边都看不出来**。
 * 2. **`code` 对不上也报错。** 换票时表单会清空关联，但配置导入、手改库、
 *    以及日后任何一个新入口都可能送来别的票的 id，而挂错的关联比没有关联更坏
 *    （它会被 IS 当成事实用）。
 * 3. **快照一律取库里的 `createdAt` / `priceAt`**，调用方送来的一概不采信。
 *    决策价的正确口径是 `signal.price_at`（引擎判定那一刻真正看到的价，M2 §5.53）
 *    —— 按信号日收盘价当决策价会把 IS 的符号读反。
 */
export function resolveDecision(input: {
  /** 用户选的信号 id。`undefined` / 空串 = 未关联（**这是合法的**，不是错误） */
  signalId: string | undefined
  /** 这笔成交的标的 */
  code: string
  /** 从库里捞出来的那条信号；`null` = 没捞到 */
  signal: { code: string; createdAt: number; priceAt: number } | null
}): { decision: { at: number; price: number } | null } | { error: string } {
  const id = input.signalId
  if (id === undefined || id === '') return { decision: null }
  if (input.signal === null) return { error: '关联的那条提醒已经不在库里了，先清空关联再录' }
  if (input.signal.code !== input.code) return { error: '关联的那条提醒不是这只票的' }
  return { decision: { at: input.signal.createdAt, price: input.signal.priceAt } }
}

/** 重放的一行入参。`id` 只用来把重算结果对回去 */
export interface LedgerReplayRow {
  id: string
  side: LedgerSide
  price: number
  shares: number
  /**
   * 库里存着的那笔费用。**缺省 = 让重放按 `costs` 算一遍。**
   *
   * 默认（`refee` 为假）用这个数而不是重算：它是**当时真的按当时的费率算出来的**，
   * 而「删掉一笔不相干的流水」不该顺手把十年前那些费用按今天的费率改一遍。
   */
  fee?: number
  /** 仅 `OPENING`：那个价含不含费（见 `TradeInput.feeIncluded`，缺省按含费） */
  feeIncluded?: boolean
}

export interface LedgerReplayResult {
  position: LedgerPosition | null
  /**
   * 逐行重算出来的派生列，供调用方写回库里。
   *
   * **`realized` 必须跟着重放走**：它依赖它前面每一行（成本是逐步摊出来的）。
   * 只重建持仓、不改 `realized`，症状是删掉第一笔买入之后
   * 「已实现盈亏合计」给出一个按旧成本算的数 —— 而没有任何东西会报警。
   */
  rows: { id: string; fee: number; realized: number | null }[]
  /** 算不通、被跳过的行（历史数据里的超卖、无持仓分红…）。**要能报出来** */
  skipped: { id: string; reason: string }[]
  /** 全部送转累积起来的股数缩放（`新 peak = 旧 peak × 这个数`）。没有送转时为 1 */
  peakScale: number
}

/**
 * 按流水重放出持仓与逐行派生列。`trade:remove` / `trade:update` / 费率重算都走这条路。
 *
 * **不做反向增量回滚**：在「买入 → 卖出 → 又买入」这类序列上，
 * 删掉中间那笔卖出之后，靠反算是回不到正确成本的（卖出不改成本，所以没有可逆信息）。
 * 重放是唯一算得对的做法，而它的前提是**期初那一笔已经补上了**（007 迁移做的事）。
 *
 * 入参必须按 `traded_at` 升序。遇到算不通的一笔就**跳过并继续**，
 * 而不是整条链失败 —— 重建持仓时半路抛错会让用户的持仓凭空消失。
 *
 * `opts.refee` 为真时**按 `costs` 重算每一笔费用**（「校正成本」那条路）。
 * ⚠ 即便如此，「价已含费」的建仓行仍然不动：它的 `price` **就是**摊薄成本，
 * 给它补一笔费用等于凭空改掉用户当初填的那个数。
 */
export function replayLedger(
  rows: readonly LedgerReplayRow[],
  board: Board,
  costs: CostModel = DEFAULT_COSTS,
  opts: { refee?: boolean; refeeIds?: ReadonlySet<string> } = {}
): LedgerReplayResult {
  let position: LedgerPosition | null = null
  let peakScale = 1
  const out: LedgerReplayResult['rows'] = []
  const skipped: LedgerReplayResult['skipped'] = []

  for (const row of rows) {
    /*
      费用取哪个数：
        * `refee`（整库重算）或 `refeeIds` 点名的那几行 ⇒ 按 `costs` 现算；
        * 否则 ⇒ 用库里存着的那笔（当时真的按当时的费率算出来的）。

      ⚠ 必须**从入参走 `feeOverride` 进去**，不能只改返回值里那个 `fee`：
      买入的费用是摊进 `cost` 的，只改报出去的数会让
      `成本 × 股数 − 成交额 ≠ fee` —— 一个当场对不上的账。
      分红与送转恒为 0（不是成交），`applyTrade` 会忽略这一项。

      ⚠ **`refeeIds` 不是可选的优化，它是新录与改动那一笔的唯一出路**
      （2026-09-03 真机抓到）：调用方要先把行落库才能重放，而落库时那一笔的费用
      **还没算出来**（它要等重放）—— 于是先落一个 0 占位。没有这份点名的话，
      那个 0 会被这里当成「库里存着的费用」原样沿用 ⇒ **新录的每一笔手续费恒为 0**，
      而它一路摊进成本，账面上只表现为「费 0.00」这一个不起眼的数字。
    */
    const recompute = opts.refee === true || opts.refeeIds?.has(row.id) === true
    const outcome = applyTrade(
      position,
      {
        side: row.side,
        price: row.price,
        shares: row.shares,
        board,
        ...(row.feeIncluded === undefined ? {} : { feeIncluded: row.feeIncluded }),
        ...(recompute || row.fee === undefined ? {} : { feeOverride: row.fee }),
      },
      costs
    )
    if (isTradeError(outcome)) {
      skipped.push({ id: row.id, reason: outcome.error })
      continue
    }
    position = outcome.position
    peakScale *= outcome.peakScale
    out.push({ id: row.id, fee: outcome.fee, realized: outcome.realized })
  }
  return { position, rows: out, skipped, peakScale }
}

/**
 * **净投入**：`买入金额 + 买入费 − 卖出金额 + 卖出费 − 分红到账`（017）。
 *
 * 除以现持股数就是「**净成本**」——「这些票要涨到多少，我在这只票上才不亏」。
 *
 * ## 它与 `LedgerPosition.cost` 是两个数，而且差得很远
 *
 * `cost` 是**加权平均成本**（卖出不改成本）；净成本把**已实现盈亏折回成本里**。
 * 真机实测（2026-09-03）：同一只票 `cost = 12.067`、净成本 `= 12.903`，
 * 差的 0.84 元/股 × 8700 股 = 7300 元，正好是那 4 次做 T 的累计亏损。
 *
 * **券商持仓页上那个「成本价」多半是净成本这一个**（同花顺/东财默认口径），
 * 所以两个数必须并排显示 —— 只给一个的话用户会以为软件算错了。
 *
 * ⚠ **止损一律用 `cost`，不许换成这个。** 净成本会随已实现亏损**往上跳**
 * ⇒ 每做亏一笔 T，止损线就抬高一格，那是反的。
 *
 * 返回 null = 没有持仓（清仓之后「还要涨到多少」这个问题不成立，
 * 答案在已实现盈亏那一行）。
 */
export function netCostOf(
  rows: readonly { side: LedgerSide; price: number; shares: number; fee: number }[],
  shares: number
): number | null {
  if (shares <= 0) return null
  let net = 0
  for (const row of rows) {
    const amount = row.price * Math.trunc(row.shares)
    if (row.side === 'BUY' || row.side === 'OPENING') net += amount + row.fee
    else if (row.side === 'SELL') net += row.fee - amount
    // 分红是拿回来的钱，从投入里减掉；送转不涉及现金（`price` 为 0，天然不动 net）
    else if (row.side === 'DIVIDEND') net -= amount
  }
  return round4(net / shares)
}

/**
 * 只要最终持仓的那个薄包装（调用点很多，不必每处都解构一个五字段的结果）。
 *
 * ⚠ 与 `replayLedger` 一样**默认沿用库里存着的费用**。
 */
export function replayTrades(
  trades: readonly Omit<LedgerReplayRow, 'id'>[],
  board: Board,
  costs: CostModel = DEFAULT_COSTS
): LedgerPosition | null {
  return replayLedger(
    trades.map((trade, index) => ({ id: String(index), ...trade })),
    board,
    costs
  ).position
}
