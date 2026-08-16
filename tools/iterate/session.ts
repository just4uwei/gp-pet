/**
 * 「真机数据有没有跨过一个新的交易日」—— 看板给两项真机诊断分桶时缺的那个判据。
 *
 * ## 它修的是什么
 *
 * 看板原先只看**存量**：`CONFIRMED === 0 && signals > 0` 就报「现在就能做」，
 * `alerts > 0 && alertsWithGate === 0` 同理。可这两项的修复都是**要下一个交易日才生效**的：
 *
 *   * `engine/settle.ts`（收盘确认补跑）设计上只在**次日盘前**那一跳执行；
 *   * `011_alert_gate.sql` 加的 `would_block` 只有迁移之后**新写入**的行才有。
 *
 * 于是 2026-08-16（周日）那次会话里，两项都被报成「现在就能做」，
 * 而真实情况是**最后一个交易日 08-14 之后再没开过盘** —— 什么都做不了，
 * 花掉的是人去查库、翻 git log、读 settle.ts 的时间。**看板的价值就在于免掉这些**，
 * 报错桶等于把它自己要省的成本又加回去了。
 *
 * ## 判据：拿「最新一行数据的日子」和「最后一个已收盘的交易日」比
 *
 * 相等（或更新）⇒ 修复落地之后一个交易日都没经历过 ⇒ 这是**时间问题**，不是工程问题。
 * 严格更早 ⇒ 中间确实开过盘而数据没变 ⇒ 那才是复发，值得立刻查。
 *
 * ## 一条纪律：不知道就说不知道，绝不猜成「已经跨过了」
 *
 * 交易日历有三级判据（`scheduler/calendar.ts`：db > builtin > weekday），
 * 后两级会在调休与临时休市上出错。判错的代价**不对称**：
 *
 *   * 猜成「跨过了」⇒ 报成复发 ⇒ 人白查一遍（还会开始怀疑 settle.ts）；
 *   * 猜成「没跨过」⇒ 真的复发被压进「只能靠时间」⇒ **静默地不查**，最坏。
 *
 * 所以 `uncertain` 的结论**不进「只能靠时间」桶**，而是留在原桶并把不确定性写进文案 ——
 * 与 CalendarRepo 的三态、`resolve()` 的「不知道绝不当成休市」同一条。
 */

import type { TradeDate } from '@core/types'
import { addDays, fromEpochDay, toEpochDay } from '@core/date'
import type { CalendarSource, TradingCalendar } from '@main/scheduler/calendar'
import { SHANGHAI_OFFSET_MS } from '@shared/time'

/** A 股收盘时刻（北京时间 15:00）—— 与 `engine/settle.ts` 的 `CLOSE_MINUTE` 同一个数 */
const CLOSE_HOUR = 15

/** 往回找几天就放弃。长假最多 8 天，16 天足够且不会在日历坏掉时变成死循环 */
const MAX_LOOKBACK_DAYS = 16

export interface ClosedSession {
  date: TradeDate
  /** 判据来源。`db` 是事实，`builtin` / `weekday` 是转述与兜底 */
  source: CalendarSource
  /** 依据不够硬，结论不可用来把任务降级（见文件头纪律） */
  uncertain: boolean
}

/** `epochMs` 那一刻，北京时间的日期 */
export function shanghaiDateOf(epochMs: number): TradeDate {
  return fromEpochDay(Math.floor((epochMs + SHANGHAI_OFFSET_MS) / 86_400_000))
}

/** 北京时间当天已过去的小时数（用来判断「今天收盘了没」） */
function shanghaiHourOf(epochMs: number): number {
  const ms = (epochMs + SHANGHAI_OFFSET_MS) % 86_400_000
  return Math.floor(((ms + 86_400_000) % 86_400_000) / 3_600_000)
}

/**
 * `now` 那一刻，**最后一个已经收盘的交易日**。
 *
 * 「已收盘」而不是「已开盘」：盘中那半天的数据本来就还在写，
 * 拿它当「数据应该已经更新了」的基准会在每个交易日的上午误报一次复发。
 *
 * 找不到（日历连着 16 天都判休市、或日期非法）返回 null —— 同样是「不知道」，
 * 调用方不许把它当成「没跨过」。
 */
export function lastClosedSession(now: number, calendar: TradingCalendar): ClosedSession | null {
  const today = shanghaiDateOf(now)
  // 今天 15:00 之前，今天这一场还没收盘，从昨天起找
  let cursor: TradeDate = shanghaiHourOf(now) >= CLOSE_HOUR ? today : addDays(today, -1)

  for (let i = 0; i < MAX_LOOKBACK_DAYS; i += 1) {
    const verdict = calendar.resolve(cursor)
    if (verdict.isOpen) {
      return { date: cursor, source: verdict.source, uncertain: verdict.uncertain }
    }
    cursor = addDays(cursor, -1)
  }
  return null
}

export type Freshness =
  /** 最后一个已收盘交易日的数据已经在库里 —— 这项是时间问题，不是工程问题 */
  | { kind: 'CAUGHT_UP'; session: ClosedSession; latest: TradeDate }
  /** 中间确实开过盘而数据停在更早的日子 —— 这才值得立刻查 */
  | { kind: 'STALE'; session: ClosedSession; latest: TradeDate; sessionsBehind: number }
  /** 判不了：没有数据、日历给不出结论、或结论不够硬 */
  | { kind: 'UNKNOWN'; why: string }

/**
 * 库里最新一行数据（`latest`）相对「最后一个已收盘交易日」是不是跟上了。
 *
 * `latest` 为 null 表示这张表一行都没有 —— 那不是「陈旧」，是另一个问题（还没跑过），
 * 由调用方的既有规则去报。
 */
export function dataFreshness(input: {
  now: number
  latest: TradeDate | null
  calendar: TradingCalendar
}): Freshness {
  const { now, latest, calendar } = input
  if (latest === null) return { kind: 'UNKNOWN', why: '这张表里一行数据都没有' }

  const session = lastClosedSession(now, calendar)
  if (session === null) {
    return { kind: 'UNKNOWN', why: `交易日历连着 ${MAX_LOOKBACK_DAYS} 天都判休市，给不出「最后一个交易日」` }
  }
  // 依据不够硬时不下结论 —— 猜成「没跨过」会让真的复发被静默压住（纪律见文件头）
  if (session.uncertain) {
    return {
      kind: 'UNKNOWN',
      why: `最后一个交易日只能判到 ${session.date}（来源 ${session.source}，依据不够硬），不据此降级`,
    }
  }

  const a = toEpochDay(latest)
  const b = toEpochDay(session.date)
  if (a === null || b === null) return { kind: 'UNKNOWN', why: `日期解析不了：${latest} / ${session.date}` }
  if (a >= b) return { kind: 'CAUGHT_UP', session, latest }

  return { kind: 'STALE', session, latest, sessionsBehind: countSessionsBetween(latest, session.date, calendar) }
}

/**
 * 「修复落地之后，有没有产生过新数据」—— 两项真机诊断真正的分桶判据。
 *
 * ## 为什么不能只看「有没有跨过新交易日」
 *
 * 那个判据答的是「现在有没有新东西可看」，**不是**「这个诊断该不该报警」。
 * 差别在第二天就会显出来：数据推进到最新一场之后 `dataFreshness` 恒为 `CAUGHT_UP`，
 * 于是「CONFIRMED 仍为 0」会被**永久**压进「只能靠时间」——
 * 真的复发从此再也不报。少报的错误没人发现得了，这是这个项目一直在防的方向。
 *
 * ## 判据：库里最新一行数据的日子，和**修复落地那天**比
 *
 * `landedOn` 是一个静态事实（某个 commit 的日期），DB 里查不到，所以由调用方写成常量
 * 并注明出处。落地日当天及以前的数据**本来就不该有**那个东西：
 *
 *   * `engine/settle.ts` 落地当天，那天盘前那一跳早就过去了；
 *   * `011_alert_gate.sql` 只让**此后新写入**的行带 `would_block`，存量行不回填。
 *
 * 严格晚于落地日的数据仍然是零 ⇒ 修复真的没生效 ⇒ 立刻查。
 * 这条判据不依赖交易日历，因此不受「日历依据不够硬」影响 ——
 * 日历只用来说明「下一个观察窗口在哪」，不参与分桶。
 */
export type SinceFix =
  /** 一行数据都没有 —— 另一个问题，由调用方的既有规则去报 */
  | 'NO_DATA'
  /** 全部数据都在落地日当天及以前 ⇒ 现在查不出任何东西 */
  | 'NOT_YET'
  /** 落地之后产生过数据而症状还在 ⇒ 复发 */
  | 'OBSERVED'

export function sinceFixLanded(input: { latest: TradeDate | null; landedOn: TradeDate }): SinceFix {
  const { latest, landedOn } = input
  if (latest === null) return 'NO_DATA'
  const a = toEpochDay(latest)
  const b = toEpochDay(landedOn)
  if (a === null || b === null) return 'NO_DATA'
  return a > b ? 'OBSERVED' : 'NOT_YET'
}

/**
 * `(from, to]` 之间开过几场。只用来把「落后多少」说成人话，
 * 数不准也不影响分桶（分桶只看 `a >= b`），所以走同一个 16 天上限、不精确追长假。
 */
function countSessionsBetween(from: TradeDate, to: TradeDate, calendar: TradingCalendar): number {
  let n = 0
  let cursor = addDays(from, 1)
  for (let i = 0; i < MAX_LOOKBACK_DAYS; i += 1) {
    const at = toEpochDay(cursor)
    const end = toEpochDay(to)
    if (at === null || end === null || at > end) break
    if (calendar.resolve(cursor).isOpen) n += 1
    cursor = addDays(cursor, 1)
  }
  return n
}
