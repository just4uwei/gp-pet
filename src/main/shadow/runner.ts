/**
 * 影子运行的推进器（docs/07 §2.3、docs/08 M4）。
 *
 * 一个交易日一根，收盘确认轮推进一次：
 *
 * ```
 * ① 幂等闸门（今天已推进过就直接返回）
 * ② 引擎版本闸门（参数变了就停下来，不把两套参数混进同一条曲线）
 * ③ 执行昨天挂下的委托 —— 用**今天的开盘价**
 * ④ 已不在自选的持仓按最后收盘价了结（不再跟踪 = 影子也不再持有）
 * ⑤ 持仓逐日盯市：峰值、最后收盘、持有根数
 * ⑤a 强制离场：按**影子自己的**成本与峰值判四条风控规则，命中就挂明天的卖单
 * ⑥ 用今天的收盘确认信号挂明天的委托（⑤a 已经挂过的跳过 —— 强制离场优先）
 * ⑦ 写一行净值（含沪深300 收盘）
 * ⑧ 把历史上没取到基准的那些天补齐
 * ```
 *
 * **⑧ 不是「补跑历史」。** 前向纪律管的是信号、委托与成交 —— 它们必须按真实时间往前走，
 * 用历史 K 线补出来的叫回测。而沪深300 在某一天的收盘价是一个与我们的决策无关的**事实**，
 * 当时没有它只是取数失败（推进与日线回补在同一跳里，回补先失败 0.2 秒后推进就读到 null），
 * 不是「那天还不知道」。少了这一步，只要收尾那天的基准是 null，
 * `summarize()` 的同期对比整条就是 null —— 影子曲线没有刻度。
 *
 * **不读时钟**：`date` / `at` 全部由调用方传入，与 `src/core` 和提醒层同一条纪律。
 * 「15:00 那一轮会不会重复推进」「跨天唤醒补不补」必须能写成用例。
 *
 * ## 只吃 CONFIRMED
 *
 * 盘中 PROVISIONAL 信号会随最后一根临时 K 线抖动，且可能在收盘确认轮被判 INVALIDATED。
 * 按它下单会把**提醒层的抖动**记成**策略的绩效** —— 影子运行要回答的是
 * 「这套策略值不值钱」，不是「盘中预警准不准」。所以委托只由 CONFIRMED 产生。
 *
 * ## 已知边界
 *
 * - **参数变了就停。** 见 ②。这不是保守，是因为混进去的曲线不属于任何一套参数，
 *   而它无法事后拆开（历史 K 线能重算回测，重算不出前向记录）。
 * - **停牌的委托会顺延。** 拿不到当日 K 线时委托留着并 `deferred++`，
 *   超过 `MAX_DEFER_BARS` 作废 —— 否则退市股会留一张永远挂着的委托。
 * - **影子持仓与用户的真实持仓无关。** 用户手工录入的 `position` 表是风控输入，
 *   这里的 `shadow_position` 是模拟账本，两者刻意不同步：影子要的是「若每条信号都执行」，
 *   而用户只会执行其中一部分。
 *   ⚠ **这句话必须连着后半句读**（2026-08-28）：**离场判据用影子自己的仓**（⑤a）。
 *   此前只有前半句，后果是一个结构性缺口 —— 闸门那条持仓强制通道读的是用户的
 *   `position` 表，于是影子持有、用户没录入的票**一次都不会离场**，
 *   而回测里 96.9% 的离场由风控触发（M2 §5.24）⇒ 影子量的不是回测那套策略。
 *   诊断与三条边界在 `portfolio.ts` 的 `shadowExitOrder` 头注释。
 *
 * ## 那次修复没有清空记录，所以曲线分两段
 *
 * 判据：修复之前 `shadow_trade` **一行都没有**（实测 2026-08-28：9 个净值点、
 * 7 只持仓全在、0 笔往返成交）⇒ 第一段里不存在带着旧口径的成交
 * ⇒ 「两套口径混进同一条曲线、事后拆不开」在那份数据上不成立。
 * 而分界点落在 `SHADOW_KEYS.exitRulesFrom` + 一行 `RULES_CHANGED` 流水里（见 ⓿）
 * —— 「参数一变就停止累积」那条纪律防的是**拆不开**，记下分界点恰好把它拆得开。
 */

import { BENCHMARK_CODE } from '../engine'
import type { SignalOutcome } from '../engine'
import type { Board, Candle, SecCode, TradeDate } from '@core/types'
import type { KlineRepo } from '../storage/repositories/kline'
import type { MetaRepo } from '../storage/repositories/meta'
import type { ShadowJournalEntry, ShadowRepo } from '../storage/repositories/shadow'
import { SHADOW_KEYS } from '../storage/repositories/shadow'
import { DEFAULT_COSTS, costsOn, sellFees, sellFill, type CostModel } from '../../backtest/costs'
import type { EngineParams } from '@core/params'
import {
  MAX_DEFER_BARS,
  exitRuleOf,
  executeOrder,
  orderFrom,
  shadowExitOrder,
  type ShadowOrder,
  type ShadowPosition,
  type VoidReason,
} from './portfolio'

/** 影子组合的起始资金与单笔名义金额。后者与回测的 `capitalPerCode` 对齐，逐笔可比 */
export const DEFAULT_SHADOW_CAPITAL = 1_000_000
export const DEFAULT_SHADOW_NOTIONAL = 100_000

export interface ShadowRunnerDeps {
  repo: ShadowRepo
  meta: MetaRepo
  klines: Pick<KlineRepo, 'recentThrough'>
  /** 当前引擎版本（含参数指纹）。变了就停 */
  engineVersion: () => string
  /** 仍在自选里的代码。不在其中的影子持仓会被了结 */
  trackedCodes: () => ReadonlySet<SecCode>
  /** 标的的板块与 ST 标志，算涨跌停用 */
  profileOf: (code: SecCode) => { board: Board; isST: boolean } | null
  /**
   * 当前引擎参数，强制离场那四条阈值从这里取（2026-08-28）。
   *
   * **必须是函数而不是值**：换灵敏度档位要跟着走。不过那本来就会改变
   * `engineVersion()` ⇒ 闸门 ② 会停止累积，所以这里不会出现「用新阈值续旧曲线」。
   */
  params: () => EngineParams
  costs?: CostModel
  startCapital?: number
  notionalPerTrade?: number
  benchmarkCode?: SecCode
  newId: () => string
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export interface ShadowAdvanceResult {
  date: TradeDate
  /** 本轮成交的建仓数 / 平仓数 */
  opened: number
  closed: number
  /** 新挂的委托数 */
  placed: number
  voided: { reason: VoidReason; code: SecCode }[]
  equity: number
  cash: number
}

/** 攒在内存里的一行流水（落盘时由 repo 补上 date 与 seq） */
type JournalDraft = Omit<ShadowJournalEntry, 'date' | 'seq'>

/**
 * 委托作废理由的人话。**每一种都要显示** —— 「作废」与「没赚到」在净值上长得一样，
 * 但一个是「这条信号没法执行」、一个是「这条信号不值钱」（portfolio.ts 的 `VoidReason`）。
 */
const VOID_TEXT: Record<VoidReason, string> = {
  LIMIT_UP: '开盘涨停买不到（追高一天的成本已经不是这条信号的成本）',
  LIMIT_DOWN: '跌停卖不掉且已超顺延上限',
  GAP: '缺口段不成交 —— 那一段的价格连续性本身不可信',
  NO_CASH: '模拟现金池不足',
  NO_LOT: '单笔名义金额买不起一手',
  NO_POSITION: '没有可卖的持仓',
  NO_BAR: `连续 ${MAX_DEFER_BARS} 天拿不到 K 线（长期停牌 / 退市）`,
}

function voidNote(at: number, order: ShadowOrder, reason: VoidReason): JournalDraft {
  return {
    at,
    kind: 'VOIDED',
    code: order.code,
    action: order.action,
    shares: null,
    price: null,
    rule: order.rule,
    regime: order.regime,
    score: order.score,
    reason: VOID_TEXT[reason],
  }
}

/** 推进被跳过的理由。**都要能报给 UI** —— 「影子曲线为什么不动」必须答得出来 */
export type ShadowSkip =
  | { kind: 'ALREADY_DONE'; date: TradeDate }
  | { kind: 'ENGINE_VERSION_CHANGED'; recorded: string; current: string }

export interface ShadowRunner {
  /** 推进一个交易日。返回 null = 本轮什么都没做，理由见 `lastSkip()` */
  advance(input: { date: TradeDate; at: number; outcomes: readonly SignalOutcome[] }): ShadowAdvanceResult | null
  lastSkip(): ShadowSkip | null
  /**
   * 记一行「这一天整轮没推进」。
   *
   * 调用方是 data-layer 的补跑适配器：只有它同时知道 `feedShadow` 的判据与理由，
   * 而那道闸门（成交机会已过 ⇒ 不喂）意味着**那个交易日的前向记录永久缺失** ——
   * 此前这件事只在主进程日志里出现一行，界面上完全不可见，
   * 而它恰恰是「影子为什么不动」最常见的答案。
   *
   * **已经有那天的流水就不覆盖**：真推进过的记录比一句「没推进」值钱得多。
   */
  noteNotAdvanced(input: { date: TradeDate; at: number; reason: string }): void
  /** 清空。下一个交易日的 advance() 会重新初始化起点（引擎参数变更后用） */
  reset(): void
}

export function createShadowRunner(deps: ShadowRunnerDeps): ShadowRunner {
  const {
    repo,
    meta,
    klines,
    engineVersion,
    trackedCodes,
    profileOf,
    params,
    costs = DEFAULT_COSTS,
    startCapital = DEFAULT_SHADOW_CAPITAL,
    notionalPerTrade = DEFAULT_SHADOW_NOTIONAL,
    benchmarkCode = BENCHMARK_CODE,
    newId,
    log = { info: () => {}, warn: () => {} },
  } = deps

  let skip: ShadowSkip | null = null

  /** 末根恰好是 `date` 时才认。不是就说明这只今天没有 K 线（停牌 / 尚未回补） */
  function lastIf(candles: readonly Candle[], date: TradeDate): Candle | null {
    const last = candles[candles.length - 1]
    return last && last.date === date ? last : null
  }

  /**
   * 今天这一根 + 昨收。昨收拿不到时给 0 —— priceLimits 会返回 null，而不是编一个边界出来。
   *
   * 用 `recentThrough(code, date, 2)` 而不是 `recent(code, 2)`：后者取的是「库里最后两根」，
   * 只要库里存在比 `date` 更新的行（跨日唤醒后一次补多天、或测试预置），
   * 拿到的就是错的那两根，而症状是「委托莫名不成交」，极难归因。
   */
  function barsOf(code: SecCode, date: TradeDate): { today: Candle; prevClose: number } | null {
    const window = klines.recentThrough(code, date, 2)
    const today = lastIf(window, date)
    if (!today) return null
    return { today, prevClose: window.length >= 2 ? (window[0]?.close ?? 0) : 0 }
  }

  function ensureStarted(date: TradeDate, at: number): number {
    if (meta.getNumber(SHADOW_KEYS.startedAt) === null) {
      meta.setNumber(SHADOW_KEYS.startedAt, at)
      meta.set(SHADOW_KEYS.startedDate, date)
      meta.setNumber(SHADOW_KEYS.startCapital, startCapital)
      meta.setNumber(SHADOW_KEYS.cash, startCapital)
      meta.set(SHADOW_KEYS.engineVersion, engineVersion())
      log.info(`[shadow] 影子运行从 ${date} 开始，起始资金 ${startCapital} 元`)
    }
    return meta.getNumber(SHADOW_KEYS.cash) ?? startCapital
  }

  function bump(key: string, delta: number): void {
    meta.setNumber(key, (meta.getNumber(key) ?? 0) + delta)
  }

  /** 基准指数在 `date` 那天的收盘。那天的那根还没入库时为 null（**不是 0**） */
  function benchmarkOn(date: TradeDate): number | null {
    return lastIf(klines.recentThrough(benchmarkCode, date, 1), date)?.closeAdj ?? null
  }

  return {
    lastSkip: () => skip,

    advance({ date, at, outcomes }) {
      skip = null
      // ① 幂等：盘后会跑好几轮 tick，同一天只推进一次
      if (repo.hasDate(date)) {
        skip = { kind: 'ALREADY_DONE', date }
        return null
      }

      // ② 引擎版本闸门。已经有记录且版本变了 → 停下来，等用户决定
      const current = engineVersion()
      const recorded = meta.get(SHADOW_KEYS.engineVersion)
      if (recorded !== null && recorded !== current && repo.barCount() > 0) {
        skip = { kind: 'ENGINE_VERSION_CHANGED', recorded, current }
        return null
      }

      let cash = ensureStarted(date, at)
      if (recorded !== current) meta.set(SHADOW_KEYS.engineVersion, current)

      const result: ShadowAdvanceResult = {
        date,
        opened: 0,
        closed: 0,
        placed: 0,
        voided: [],
        equity: 0,
        cash,
      }

      const tracked = trackedCodes()
      // 本轮的参数取一次就定住：⑤a 在持仓循环里用它，逐只重取虽然结果一样，
      // 但「同一轮里两只票用了不同阈值」这种可能性不该在结构上存在
      const engineParams = params()
      const journal: JournalDraft[] = []
      const note = (entry: JournalDraft): void => void journal.push(entry)
      /**
       * 本轮已经由 ⑤a 强制离场挂过单的代码。**⑥ 必须跳过它们** ——
       * 那是 `gateSignal` 的优先级（`forced ? forced.direction : signal.direction`）：
       * 止损压过策略信号。少了这一步，同一只票的一条策略买入会把止损委托覆盖掉。
       */
      const forcedCodes = new Set<SecCode>()

      /*
        ⓿ 口径分段标记（2026-08-28）。

        「离场按影子自己的持仓判定」这条修复**不清空既有记录**，判据是：修复之前
        `shadow_trade` 一行都没有 ⇒ 第一段里没有任何一笔往返成交带着旧口径
        ⇒ 「两套口径混进同一条曲线、事后拆不开」这件事在那份数据上不成立。

        但曲线的**含义**确实从某一天起变了，所以那一天必须落库 ——
        「参数一变就停止累积」那条纪律真正在防的是**拆不开**，
        而记下分界点恰好把它拆得开。不记的话就是一条静默换了含义的曲线，那才是坏的。

        `barCount() === 0`（全新账本）不写：没有第一段，就没有分段。
      */
      if (meta.get(SHADOW_KEYS.exitRulesFrom) === null && repo.barCount() > 0) {
        meta.set(SHADOW_KEYS.exitRulesFrom, date)
        note({
          at,
          kind: 'RULES_CHANGED',
          code: null,
          action: null,
          shares: null,
          price: null,
          rule: null,
          regime: null,
          score: null,
          reason:
            '离场规则改为按影子自己的持仓判定（此前读的是用户手工录入的持仓 ' +
            '⇒ 影子持有、用户没录入的票一次都不会离场）。此前那一段没有任何离场，' +
            '记录未清空 —— 引用绩效时按这一天切成两段读。',
        })
      }

      // ③ 执行昨天挂下的委托 —— 今天的开盘价
      for (const order of repo.orders()) {
        const bars = barsOf(order.code, date)
        if (!bars) {
          // 停牌 / K 线未回补：委托留着并计一次顺延，超上限作废
          if (order.deferred >= MAX_DEFER_BARS) {
            repo.clearOrder(order.code)
            result.voided.push({ reason: 'NO_BAR', code: order.code })
            note(voidNote(at, order, 'NO_BAR'))
          } else {
            repo.putOrder({ ...order, deferred: order.deferred + 1 })
            note({
              at,
              kind: 'DEFERRED',
              code: order.code,
              action: order.action,
              shares: null,
              price: null,
              rule: order.rule,
              regime: order.regime,
              score: order.score,
              reason: `当日无 K 线（停牌或尚未回补），已顺延 ${order.deferred + 1}/${MAX_DEFER_BARS} 天`,
            })
          }
          continue
        }
        const profile = profileOf(order.code)
        const outcome = executeOrder(order, repo.position(order.code), {
          bar: bars.today,
          prevClose: bars.prevClose,
          board: profile?.board ?? 'MAIN',
          isST: profile?.isST ?? false,
          costs,
          notionalPerTrade,
          cash,
          engineVersion: current,
          newId,
        })

        switch (outcome.kind) {
          case 'FILLED_BUY':
            cash = outcome.cash
            repo.putPosition(outcome.position)
            repo.clearOrder(order.code)
            result.opened++
            note({
              at,
              kind: 'FILLED_BUY',
              code: order.code,
              action: 'BUY',
              shares: outcome.position.shares,
              price: outcome.position.entryPriceRaw,
              rule: order.rule,
              regime: order.regime,
              score: order.score,
              reason: null,
            })
            break
          case 'FILLED_SELL':
            cash = outcome.cash
            repo.insertTrade(outcome.trade)
            if (outcome.position) repo.putPosition(outcome.position)
            else repo.clearPosition(order.code)
            repo.clearOrder(order.code)
            result.closed++
            note({
              at,
              kind: 'FILLED_SELL',
              code: order.code,
              action: outcome.trade.partial ? 'REDUCE' : 'SELL',
              shares: outcome.trade.shares,
              price: outcome.trade.exitPriceRaw,
              rule: outcome.trade.exitRule,
              regime: order.regime,
              score: order.score,
              reason: null,
            })
            break
          case 'DEFERRED':
            repo.putOrder(outcome.order)
            bump(SHADOW_KEYS.limitBlocked, 1)
            note({
              at,
              kind: 'DEFERRED',
              code: order.code,
              action: order.action,
              shares: null,
              price: null,
              rule: order.rule,
              regime: order.regime,
              score: order.score,
              reason: `开盘跌停卖不掉，已顺延 ${outcome.order.deferred}/${MAX_DEFER_BARS} 天`,
            })
            break
          case 'VOID':
            repo.clearOrder(order.code)
            result.voided.push({ reason: outcome.reason, code: order.code })
            if (outcome.reason === 'NO_CASH') bump(SHADOW_KEYS.skippedNoCash, 1)
            if (outcome.reason === 'LIMIT_UP' || outcome.reason === 'LIMIT_DOWN') {
              bump(SHADOW_KEYS.limitBlocked, 1)
            }
            note(voidNote(at, order, outcome.reason))
            break
        }
      }

      /*
        ③ 之后仍挂着的委托 = 顺延下来的那些（跌停卖不掉 / 停牌拿不到 K 线）。
        ⑤a 与 ⑥ 都不许覆盖它们：顺延计数 `deferred` 在委托对象上，
        覆盖一次等于把「已经等了 3 天」重置成 0，`MAX_DEFER_BARS` 那道上限就永远咬不住。
      */
      const pendingCodes = new Set(repo.orders().map((order) => order.code))

      // ④⑤ 盯市；已移出自选的持仓就地了结
      let positionValue = 0
      for (const position of repo.positions()) {
        const bars = barsOf(position.code, date)
        if (!tracked.has(position.code)) {
          const exitAdj = sellFill(position.lastCloseAdj, costs)
          const amount = exitAdj * position.shares
          // 板块决定费率：场内基金免印花税与过户费（costs.ts 的 isFundBoard）
          const fees = sellFees(amount, costsOn(costs, date), profileOf(position.code)?.board)
          cash += amount - fees
          repo.insertTrade({
            id: newId(),
            code: position.code,
            entryDate: position.entryDate,
            exitDate: date,
            entryPrice: position.entryPriceAdj,
            exitPrice: exitAdj,
            entryPriceRaw: position.entryPriceRaw,
            exitPriceRaw: sellFill(position.lastCloseAdj, costs),
            shares: position.shares,
            pnl: (exitAdj - position.entryPriceAdj) * position.shares - fees - position.entryCosts,
            pnlPct:
              position.entryPriceAdj > 0 ? (exitAdj - position.entryPriceAdj) / position.entryPriceAdj : 0,
            holdingBars: position.barsHeld,
            costs: fees + position.entryCosts,
            regimeAtEntry: position.entryRegime,
            entryScore: position.entryScore,
            // 归因时要能把这类「不是信号让我卖的」筛掉
            exitRule: 'WATCHLIST_REMOVED',
            partial: false,
            engineVersion: position.engineVersion,
          })
          repo.clearPosition(position.code)
          repo.clearOrder(position.code)
          result.closed++
          note({
            at,
            kind: 'CLOSED_OUT',
            code: position.code,
            action: 'SELL',
            shares: position.shares,
            price: sellFill(position.lastCloseAdj, costs),
            rule: 'WATCHLIST_REMOVED',
            regime: position.entryRegime,
            score: position.entryScore,
            reason: '已移出自选，按最后收盘价了结（不再跟踪 = 影子也不再持有）',
          })
          continue
        }

        const next: ShadowPosition = bars
          ? {
              ...position,
              peakRaw: Math.max(position.peakRaw, bars.today.high),
              lastCloseAdj: bars.today.closeAdj,
              barsHeld: position.barsHeld + 1,
            }
          : // 停牌：净值沿用最后一次收盘价，**不补 0**，持有根数也不加
            position
        repo.putPosition(next)
        positionValue += next.shares * next.lastCloseAdj

        /*
          ⑤a 强制离场：按**影子自己的**成本与峰值判一次（2026-08-28，`shadowExitOrder`）。

          位置与回测逐位对齐：`simulate.ts` 每根的顺序是
          ① 开盘执行委托 → ② `peakRaw = max(peakRaw, bar.high)` → ③ 净值 → ④ 判定挂单，
          所以这里必须用 `next`（**已含今日 high**）而不是 `position`。

          **必须在这个循环里，不能挪进 ⑥。** ⑥ 遍历的是 `outcomes`（信号），
          而强制离场的前提恰恰是「哪怕当日一条子信号都没成立」（risk/index.ts 头注释）
          —— 一只票今天没有评估就没有 outcome，而它的成本线可能已经被击穿。
        */
        if (bars && !pendingCodes.has(position.code)) {
          const exit = shadowExitOrder({
            position: next,
            closeRaw: bars.today.close,
            volume: bars.today.volume,
            date,
            params: engineParams,
          })
          if (exit) {
            repo.putOrder(exit)
            pendingCodes.add(exit.code)
            // 强制离场压过策略信号（见 ⑥ 里的 skip）—— 与 `gateSignal` 的
            // `direction = forced ? forced.direction : signal.direction` 同一优先级
            forcedCodes.add(exit.code)
            result.placed++
            note({
              at,
              kind: 'PLACED',
              code: exit.code,
              action: exit.action,
              shares: null,
              price: null,
              rule: exit.rule,
              regime: exit.regime,
              score: exit.score,
              reason: '持仓风控强制离场（按影子自己的成本与峰值），按次日开盘价成交',
            })
          }
        }
      }

      // ⑥ 用今天的收盘确认信号挂明天的委托
      for (const outcome of outcomes) {
        const evaluation = outcome.evaluation
        if (evaluation.signal.stage !== 'CONFIRMED' || evaluation.date !== date) continue
        const code = evaluation.code
        if (!tracked.has(code)) continue
        /*
          强制离场（⑤a）压过策略信号 —— 与 `gateSignal` 的
          `direction = forced ? forced.direction : signal.direction` 同一优先级。

          ⚠ 这里**只**挡 `forcedCodes`，**不挡 `pendingCodes`** —— 后者会改变
          2026-08-28 之前就有的行为（顺延中的委托本来就会被今天的新信号覆盖，
          于是 `deferred` 重置成 0、`MAX_DEFER_BARS` 那道上限咬不住）。
          那是一处独立的既有缺陷，不在这次改动的范围里，别顺手一起改。
        */
        if (forcedCodes.has(code)) continue
        const holding = repo.position(code) !== null
        const direction = evaluation.gated.direction === 'SELL' || evaluation.gated.direction === 'REDUCE' ? 'SELL' : 'BUY'
        const order = orderFrom({
          code,
          gated: evaluation.gated,
          regime: evaluation.regime.regime,
          score: evaluation.signal.score,
          rule: exitRuleOf(evaluation.gated.verdicts, evaluation.signal.subSignals, direction),
          signalId: outcome.signalId,
          date,
          holding,
        })
        if (!order) continue
        repo.putOrder(order)
        result.placed++
        note({
          at,
          kind: 'PLACED',
          code: order.code,
          action: order.action,
          shares: null,
          price: null,
          rule: order.rule,
          regime: order.regime,
          score: order.score,
          reason: '按次日开盘价成交',
        })
      }

      // ⑦ 写一行净值
      const benchmark = benchmarkOn(date)
      const equity = cash + positionValue
      repo.putEquity({ date, cash, positionValue, equity, benchmark })
      meta.setNumber(SHADOW_KEYS.cash, cash)

      // ⑧ 把历史上没取到基准的那些天补齐（见 `ShadowRepo.setBenchmark` 的边界说明）
      for (const missing of repo.equityMissingBenchmark()) {
        const value = benchmarkOn(missing)
        if (value !== null) {
          repo.setBenchmark(missing, value)
          log.info(`[shadow] ${missing} 的基准收盘价已补齐（当时取数失败）`)
        }
      }

      // ⑨ 流水整批落盘。空的那天也要写 —— 面板上「那天什么都没发生」与
      // 「那天压根没推进」是两件事，而它们在净值曲线上长得一模一样
      repo.putJournal(date, journal)

      result.cash = cash
      result.equity = equity
      log.info(
        `[shadow] ${date} 建仓 ${result.opened} · 平仓 ${result.closed} · 挂单 ${result.placed} · 净值 ${equity.toFixed(0)}`
      )
      return result
    },

    noteNotAdvanced({ date, at, reason }) {
      if (repo.hasDate(date)) return
      repo.putJournal(date, [
        {
          at,
          kind: 'NOT_ADVANCED',
          code: null,
          action: null,
          shares: null,
          price: null,
          rule: null,
          regime: null,
          score: null,
          reason,
        },
      ])
    },

    reset() {
      // 只清，不预设起点：起点由下一次 advance() 的 ensureStarted 写，
      // 免得「已清空但还没有交易日」被显示成「已运行 0 天、起始资金 100 万」
      repo.reset()
      log.info('[shadow] 影子运行已清空，将在下一个交易日重新开始累积')
    },
  }
}
