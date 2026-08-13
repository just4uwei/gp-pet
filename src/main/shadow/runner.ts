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
 * ⑥ 用今天的收盘确认信号挂明天的委托
 * ⑦ 写一行净值（含沪深300 收盘）
 * ```
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
 */

import { BENCHMARK_CODE } from '../engine'
import type { SignalOutcome } from '../engine'
import type { Board, Candle, SecCode, TradeDate } from '@core/types'
import type { KlineRepo } from '../storage/repositories/kline'
import type { MetaRepo } from '../storage/repositories/meta'
import type { ShadowRepo } from '../storage/repositories/shadow'
import { SHADOW_KEYS } from '../storage/repositories/shadow'
import { DEFAULT_COSTS, sellFees, sellFill, type CostModel } from '../../backtest/costs'
import {
  MAX_DEFER_BARS,
  exitRuleOf,
  executeOrder,
  orderFrom,
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

/** 推进被跳过的理由。**都要能报给 UI** —— 「影子曲线为什么不动」必须答得出来 */
export type ShadowSkip =
  | { kind: 'ALREADY_DONE'; date: TradeDate }
  | { kind: 'ENGINE_VERSION_CHANGED'; recorded: string; current: string }

export interface ShadowRunner {
  /** 推进一个交易日。返回 null = 本轮什么都没做，理由见 `lastSkip()` */
  advance(input: { date: TradeDate; at: number; outcomes: readonly SignalOutcome[] }): ShadowAdvanceResult | null
  lastSkip(): ShadowSkip | null
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

      // ③ 执行昨天挂下的委托 —— 今天的开盘价
      for (const order of repo.orders()) {
        const bars = barsOf(order.code, date)
        if (!bars) {
          // 停牌 / K 线未回补：委托留着并计一次顺延，超上限作废
          if (order.deferred >= MAX_DEFER_BARS) {
            repo.clearOrder(order.code)
            result.voided.push({ reason: 'NO_BAR', code: order.code })
          } else {
            repo.putOrder({ ...order, deferred: order.deferred + 1 })
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
            break
          case 'FILLED_SELL':
            cash = outcome.cash
            repo.insertTrade(outcome.trade)
            if (outcome.position) repo.putPosition(outcome.position)
            else repo.clearPosition(order.code)
            repo.clearOrder(order.code)
            result.closed++
            break
          case 'DEFERRED':
            repo.putOrder(outcome.order)
            bump(SHADOW_KEYS.limitBlocked, 1)
            break
          case 'VOID':
            repo.clearOrder(order.code)
            result.voided.push({ reason: outcome.reason, code: order.code })
            if (outcome.reason === 'NO_CASH') bump(SHADOW_KEYS.skippedNoCash, 1)
            if (outcome.reason === 'LIMIT_UP' || outcome.reason === 'LIMIT_DOWN') {
              bump(SHADOW_KEYS.limitBlocked, 1)
            }
            break
        }
      }

      // ④⑤ 盯市；已移出自选的持仓就地了结
      let positionValue = 0
      for (const position of repo.positions()) {
        const bars = barsOf(position.code, date)
        if (!tracked.has(position.code)) {
          const exitAdj = sellFill(position.lastCloseAdj, costs)
          const amount = exitAdj * position.shares
          const fees = sellFees(amount, costs)
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
      }

      // ⑥ 用今天的收盘确认信号挂明天的委托
      for (const outcome of outcomes) {
        const evaluation = outcome.evaluation
        if (evaluation.signal.stage !== 'CONFIRMED' || evaluation.date !== date) continue
        const code = evaluation.code
        if (!tracked.has(code)) continue
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
      }

      // ⑦ 写一行净值
      const benchmark = lastIf(klines.recentThrough(benchmarkCode, date, 1), date)?.closeAdj ?? null
      const equity = cash + positionValue
      repo.putEquity({ date, cash, positionValue, equity, benchmark })
      meta.setNumber(SHADOW_KEYS.cash, cash)

      result.cash = cash
      result.equity = equity
      if (result.opened + result.closed + result.placed > 0) {
        log.info(
          `[shadow] ${date} 建仓 ${result.opened} · 平仓 ${result.closed} · 挂单 ${result.placed} · 净值 ${equity.toFixed(0)}`
        )
      }
      return result
    },

    reset() {
      // 只清，不预设起点：起点由下一次 advance() 的 ensureStarted 写，
      // 免得「已清空但还没有交易日」被显示成「已运行 0 天、起始资金 100 万」
      repo.reset()
      log.info('[shadow] 影子运行已清空，将在下一个交易日重新开始累积')
    },
  }
}
