/**
 * 「明日预览」：盘后就地算一次 D 的收盘确认结论，答**明天准备买 / 卖 / 减什么**。
 *
 * ## 为什么需要它
 *
 * 影子那份「挂委托」清单（`ShadowSummary.pending`）是 `advance` 第 ⑥ 步的产物，
 * 而 `advance` 只在**次日盘前**那一跳被调用（`tick.ts` 的 `feedShadow` 要求
 * `minuteOfDay < 09:30`）；`settle` 的触发判据又是 `through < ctx.date`，
 * 收盘后 `through === ctx.date` ⇒ **恒不成立**；15:10–16:00 的 `CLOSE_CATCHUP`
 * 只补日线、不跑引擎。⇒ 当天盘后没有任何一处在回答「明天要交易什么」。
 *
 * ## 为什么是**只读预览**，而不是「把收盘确认轮提前到当天」
 *
 * 后者的前提是「当日收盘线已补齐」，而真机实测**那个前提永不成立**（2026-08-21 查库）：
 * `meta.daily_complete_date` **从来没有被置位过**，08-20 那天 `daily_catchup_attempts`
 * 用满 8 轮仍缺 1 只（`SZ002155`）—— 因为 `backfillDaily` 是 all-or-nothing，
 * 一只 FAILED 就返回 false，而总会有一两只停牌/异常的票。
 *
 * 若放宽成「试到底就算数」，那次不完整的补跑会写下 `lastSettledDate` 与
 * `shadow_equity.trade_date` **两道幂等闸门** ⇒ 次日那次完整补跑被整个挡掉，
 * 那只缺线票当天的确认信号**永久缺失**。这正是 2026-08-17 那个静默缺陷的形状
 * （提前推进关掉闸门 ⇒ `shadow_trade` 0 行，而净值曲线笔直、看不出异常）。
 *
 * ⇒ **当日这份结论天生不完整，所以它没有资格当权威记录。**
 * 本模块因此什么都不写，权威记录仍然只有一份：次日盘前那次完整补跑。
 *
 * ## 三条边界
 *
 * 1. **什么都不写。** 靠 `SignalEngine.assess()` 保证 —— 它的契约就是
 *    「不落 `signal` 表、不写指标缓存、不 `bumpPeak`、不跑收盘确认与复活」。
 *    **别改成 `run()`** —— 那会落库、会把 `persistedSignature` 的去重状态搅乱，
 *    于是次日真信号被误判成「没变」而不再落行。
 * 2. **`holding` 用「用户真实持仓」，不是影子组合的持仓。** 这一屏答的是
 *    「**我**明天要交易什么」。⇒ **预览 ≠ 影子明天会挂的委托**，两者持仓不同、
 *    结果可以不一样，界面上不许把它说成影子的委托。
 * 3. **一只都没有当日收盘线 ⇒ `UNAVAILABLE`，不是空列表。** 空列表会被读成
 *    「明天没有要交易的」，而真相是「算不出来」（与 `risk/entry.ts` 的
 *    `UNKNOWN` 不许显示成 `CLEAR` 同一条）。
 *
 * ## 一行判定逻辑都没有
 *
 * 市场适配器照抄 `settleDay`（`getContextThrough` + 不看快照），方向→动作走
 * 影子的 `orderFrom`/`toShadowAction`，归因规则走 `exitRuleOf` ——
 * 与 `settle.ts` 同一条纪律：**这里写判定就会与那两条路分叉，
 * 而「预览说买、明早说不买」到底是行情变了还是口径差异，没有人看得出来。**
 */
import type { SecCode, TradeDate } from '@core/types'
import type { NextDayPreview, NextDayPreviewRow } from '@shared/ipc-types'
import { exitRuleOf, orderFrom, type ShadowOrder } from '../shadow/portfolio'
import type { MarketDataService } from './market-data'
import { createSignalEngine, type SignalEngineDeps } from './signals'
import { CLOSE_MINUTE } from './settle'

export interface NextDayPreviewDeps extends Omit<SignalEngineDeps, 'market'> {
  /** 只用 `getContextThrough`：预览不看快照（那是「此刻」的价，与 D 收盘无关） */
  market: Pick<MarketDataService, 'getContextThrough'>
  /**
   * D 收盘那一刻的墙上时刻（ms）。**由调用方给** —— 本模块不读时钟。
   * 用 `settle.ts` 的 `closeMsOf(date)`，别在这里手写时区换算。
   */
  closedAt: number
  /** 用户**真实**持仓判据（`position` 表），见边界 2 */
  holds(code: SecCode): boolean
  /** 那只票在 D 有没有收盘线 —— 覆盖率与 `missing` 用它，不靠 `assess` 返回 null 反推 */
  hasClose(code: SecCode): boolean
}

/**
 * 算一次 D 的收盘确认预览。
 *
 * 只读：不落库、不推进影子、不发提醒。调用方（用户点按钮）想算几次就算几次。
 */
export function previewNextDay(date: TradeDate, deps: NextDayPreviewDeps): NextDayPreview {
  const { closedAt, market, holds, hasClose, ...rest } = deps

  const engine = createSignalEngine({
    ...rest,
    market: {
      // 「D 那天收盘时这只票长什么样」。停牌 / 数据没到时回空序列，引擎自己跳过
      getContext: (code: SecCode, _date: TradeDate, bars?: number) =>
        market.getContextThrough(code, date, bars),
      // 预览不看快照 —— 与 settleDay 同一条
      snapshotOf: () => null,
    },
  })

  const entries = rest.watchlist.list()
  const missing: SecCode[] = []
  let withClose = 0
  const rows: NextDayPreviewRow[] = []

  for (const entry of entries) {
    const code = entry.profile.code
    // 指数不产出交易信号（docs/04 §1.6），也不该进覆盖率的分母
    if (entry.profile.board === 'INDEX') continue

    if (hasClose(code)) withClose++
    else {
      // 缺的必须显式列出来 —— 静默少几行会让「明天没什么要做的」凭空成立
      missing.push(code)
      continue
    }

    const evaluation = engine.assess(code, {
      date,
      minuteOfDay: CLOSE_MINUTE,
      session: 'SETTLE',
      at: closedAt,
      // 用户主动要的一次查看，不是提醒
      producesSignals: true,
    })
    if (!evaluation) continue
    // 末根不是 D（停牌把序列停在更早的一天）⇒ 这不是 D 的收盘结论，不许当它用
    if (evaluation.date !== date) continue

    /*
      方向→动作与「硬抑制的不算」这两件事**刻意走影子那个函数**：
      它是「什么方向 + 什么持仓状态 = 什么动作」的唯一出处，
      在这里照抄一份的症状是日后改了一边、两处给出不同的动作。
    */
    const direction =
      evaluation.gated.direction === 'SELL' || evaluation.gated.direction === 'REDUCE'
        ? 'SELL'
        : 'BUY'
    const order: ShadowOrder | null = orderFrom({
      code,
      gated: evaluation.gated,
      regime: evaluation.regime.regime,
      score: evaluation.signal.score,
      rule: exitRuleOf(evaluation.gated.verdicts, evaluation.signal.subSignals, direction),
      signalId: null,
      date,
      holding: holds(code),
    })
    if (!order) continue

    rows.push({
      code,
      name: entry.profile.name,
      action: order.action,
      // 方向与动作不是一回事：「明日观察」在未持仓时才变成买
      direction: evaluation.gated.direction,
      rule: order.rule,
      score: order.score,
      regime: order.regime,
      level: evaluation.gated.level,
      holding: holds(code),
    })
  }

  const total = withClose + missing.length
  return {
    date,
    // 一只都算不出来时报 UNAVAILABLE —— 见边界 3
    status: withClose === 0 ? 'UNAVAILABLE' : 'READY',
    coverage: { total, withClose, missing },
    rows,
  }
}
