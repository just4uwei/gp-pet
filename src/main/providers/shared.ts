/**
 * provider 适配层的公共零件（docs/03 §2）。
 *
 * 放在这里的只有「三个源都要做同一件事、且做错了会静默失真」的部分：
 *   - 数值解析：免费源用 `-` / `` / `0.00` 表示「没有这个值」，一律解析成 null 而不是 0
 *   - 单位换算：腾讯给手与万元、新浪给股与元。全仓库统一到 **股 / 元**
 *   - 时间戳：源里给的是北京时间的墙上时钟，本机时区不一定是 Asia/Shanghai，
 *     用 Date.UTC(..., H - 8, ...) 换算，不依赖运行环境
 *   - 涨跌停：本地按板块算，源给的值只作兜底（fixture 里北交所直接返回 -1）
 *   - 复权双轨：不复权与复权是两次请求，按日期对齐后才构成一根 Candle
 */

import type { AdjustMode, Board, Candle, SecCode, TradeDate } from '@core/types'
import { addDays, countDaysBetween, isWeekday, toEpochDay } from '@core/date'
import { isSTName, priceLimits, splitCode } from '@core/code'

/** 一次快照请求携带的最大代码数（docs/03 §2.4） */
export const SNAPSHOT_CHUNK = 50

/** 1 手 = 100 股 */
export const SHARES_PER_HAND = 100

/** 源返回的内容不符合预期结构 —— 与网络错误区分开，便于健康度归因 */
export class ProviderDataError extends Error {
  constructor(
    readonly provider: string,
    message: string
  ) {
    super(`[${provider}] ${message}`)
    this.name = 'ProviderDataError'
  }
}

/** provider 不承担该能力。registry 应先看 capabilities，走到这里说明调用方越过了它。 */
export class UnsupportedCapabilityError extends Error {
  constructor(provider: string, capability: string) {
    super(`[${provider}] 不提供 ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

/**
 * 宽松数值解析。空串、`-`、`--`、NaN 一律 null。
 *
 * 注意 `0` 是合法返回值（真的零成交量），所以不能用 `Number(x) || null` 这种写法。
 */
export function num(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '' || /^-+$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** 源用 0.00 表示「无此值」的字段（如停牌股的开盘价）。0 与缺失不可区分时按缺失处理。 */
export function positive(raw: unknown): number | null {
  const value = num(raw)
  return value !== null && value > 0 ? value : null
}

export function handsToShares(hands: number | null): number | null {
  return hands === null ? null : Math.round(hands * SHARES_PER_HAND)
}

/** 万元 → 元。腾讯的成交额字段是万元且带 4 位小数，直接乘会留浮点尾巴。 */
export function wanToYuan(wan: number | null): number | null {
  return wan === null ? null : Math.round(wan * 10_000)
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * 北京时间的年月日时分秒 → epoch ms。
 *
 * 不用 `new Date('2026-08-11 15:34:59')`：那会按**本机时区**解析。
 * 用户机器设成 UTC 时，盘中快照的时间戳会整体偏 8 小时，而这不会报任何错。
 */
export function shanghaiToEpochMs(
  y: number,
  m: number,
  d: number,
  hh = 0,
  mm = 0,
  ss = 0
): number {
  return Date.UTC(y, m - 1, d, hh - 8, mm, ss)
}

/** 'YYYYMMDDHHmmss'（腾讯）→ epoch ms；长度不对返回 null。 */
export function parseCompactStamp(raw: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw.trim())
  if (!m) return null
  return shanghaiToEpochMs(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  )
}

/** 'YYYY-MM-DD' + 'HH:mm:ss'（新浪）→ epoch ms；任一段不合法返回 null。 */
export function parseDateTime(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim())
  if (!d || !t) return null
  return shanghaiToEpochMs(
    Number(d[1]),
    Number(d[2]),
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
    Number(t[3] ?? 0)
  )
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'；长度不对原样返回（调用方会在校验层发现）。 */
export function dashDate(compact: string): TradeDate {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(compact.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : compact.trim()
}

export function compactDate(date: TradeDate): string {
  return date.replace(/-/g, '')
}

/**
 * 涨跌停价：本地算优先，源给的值只在本地算不出时兜底。
 *
 * 本地优先是刻意的 —— 板块比例是公开规则，而免费源的这两个字段可靠性最差
 * （录制的 fixture 里北交所返回 -1，指数返回 0）。两者都没有时返回 null，不用 0 兜底：
 * limitUp = 0 会让「已涨停」判定永真。
 */
export function resolveLimits(
  preClose: number | null,
  board: Board,
  isST: boolean,
  /**
   * 这条快照自己的交易日（北京时区），由调用方从它的时间戳算出来（`shanghaiDate(atMs)`）。
   * 主板 ST 的涨跌幅有生效日 —— 见 `core/code.ts` 的 `MAIN_ST_LIMIT_WIDENED_ON`。
   * **用快照的时刻而不是「现在」**：补历史快照时两者不是同一天。
   */
  asOf: TradeDate,
  sourceUp?: number | null,
  sourceDown?: number | null
): { limitUp: number | null; limitDown: number | null } {
  const local = preClose === null ? null : priceLimits(preClose, board, isST, asOf)
  if (local) return local
  return { limitUp: positive(sourceUp ?? null), limitDown: positive(sourceDown ?? null) }
}

/**
 * 停牌判定：有昨收（说明是个正常上市的品种）但今天没有任何成交。
 *
 * 用**昨收**而不是最新价作为「品种正常」的依据：停牌时腾讯把最新价填成昨收，
 * 而东财填成 `"-"`。以最新价为准会让后者判不出停牌。
 *
 * 开盘前的快照同样满足这个条件，这是可接受的 —— PRE_OPEN / AUCTION / PRE_TRADE
 * 时段本就不产出信号（src/core/session.ts `producesSignals`），此时的 suspended
 * 只影响面板上「停牌」两个字。真正需要它准确的时段（连续竞价、SETTLE）判定是准的。
 */
export function inferSuspended(
  preClose: number | null,
  open: number | null,
  volume: number | null
): boolean {
  return (
    preClose !== null && preClose > 0 && (open === null || open === 0) && (volume === null || volume === 0)
  )
}

// ─────────────────────────── 日线：复权双轨 ───────────────────────────

/** 各源日线解析后的中间形态。复权与不复权共用它，之后按日期对齐成 Candle。 */
export interface RawBar {
  date: TradeDate
  open: number
  high: number
  low: number
  close: number
  /** 股 */
  volume: number
  /** 元；源不提供时为 null（腾讯日线只给量不给额） */
  amount: number | null
}

/**
 * 把不复权与复权两条序列按日期对齐成 Candle[]。
 *
 * 以不复权序列为准（它才是「哪些天真的开过市」），复权序列缺该日期就丢掉这根 ——
 * 用不复权价冒充复权价会在除权日附近伪造出金叉死叉，正是 docs/03 §2.3 要防的事。
 * adjust 为 'none' 时两条序列同源，复权字段等于原价。
 */
export function mergeAdjusted(rawBars: readonly RawBar[], adjBars: readonly RawBar[]): Candle[] {
  const adjByDate = new Map(adjBars.map((bar) => [bar.date, bar]))
  const out: Candle[] = []
  for (const bar of rawBars) {
    const adj = adjByDate.get(bar.date)
    if (!adj) continue
    out.push({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      openAdj: adj.open,
      highAdj: adj.high,
      lowAdj: adj.low,
      closeAdj: adj.close,
      volume: bar.volume,
      amount: bar.amount,
    })
  }
  return out
}

/** 复权字段直接取原价。仅用于 adjust === 'none'。 */
export function withoutAdjustment(rawBars: readonly RawBar[]): Candle[] {
  return mergeAdjusted(rawBars, rawBars)
}

export function inRange(date: TradeDate, from: TradeDate, to: TradeDate): boolean {
  return date >= from && date <= to
}

/**
 * 估算区间内的 K 线根数，供腾讯那类必须显式给 count 的接口使用。
 * 宁可多要：count 给小了接口会返回**最近 count 根**而不是区间内的，静默截断。
 */
export function estimateBarCount(from: TradeDate, to: TradeDate, max = 1200): number {
  const weekdays = countDaysBetween(addDays(from, -1), addDays(to, 1), isWeekday)
  return Math.min(max, Math.max(20, weekdays + 20))
}

/**
 * 由基准指数的日线反推交易日历（docs/03 §3）。
 *
 * 三个免费源都没有可靠的日历接口。但指数日线本身就是一张交易日表：
 * 指数有数据的那天必然开市。比调用某个未公开的日历接口稳得多。
 *
 * 只覆盖到指数数据的最后一天为止 —— 再往后是「还不知道」，交由 CalendarRepo 的
 * 三态（true / false / null）表达，不能把「尚未开盘的今天」写成休市。
 */
export function calendarFromIndexBars(
  bars: readonly { date: TradeDate }[],
  year: number
): { date: TradeDate; isOpen: boolean }[] {
  const openDays = new Set(bars.map((bar) => bar.date).filter((date) => date.startsWith(`${year}-`)))
  const start = toEpochDay(`${year}-01-01`)
  const yearEnd = toEpochDay(`${year}-12-31`)
  if (start === null || yearEnd === null) return []

  const lastKnown = [...openDays].sort().at(-1)
  const end = lastKnown === null || lastKnown === undefined ? null : toEpochDay(lastKnown)
  if (end === null) return []

  const out: { date: TradeDate; isOpen: boolean }[] = []
  for (let epoch = start; epoch <= Math.min(end, yearEnd); epoch++) {
    const date = addDays(`${year}-01-01`, epoch - start)
    out.push({ date, isOpen: openDays.has(date) })
  }
  return out
}

// ─────────────────────────── 代码形态转换 ───────────────────────────

/** `SH600000` → `sh600000`（新浪 / 腾讯） */
export function toLowerPrefixed(code: SecCode): string | null {
  const parsed = splitCode(code)
  return parsed ? `${parsed.market.toLowerCase()}${parsed.digits}` : null
}

/** `sh600000` → `SH600000`；无法识别返回 null */
export function fromLowerPrefixed(external: string): SecCode | null {
  const parsed = splitCode(external.toUpperCase())
  return parsed?.code ?? null
}

/** 解析出板块与 ST 标志，快照与日线都要用 */
export function classify(code: SecCode, name: string): { board: Board; isST: boolean } | null {
  const parsed = splitCode(code)
  return parsed ? { board: parsed.board, isST: isSTName(name) } : null
}

export type { AdjustMode }
