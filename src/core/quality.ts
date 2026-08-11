/**
 * 入库前的数据质量校验（docs/07 §4）。
 *
 * 回测结论的可信度上限由数据质量决定，而免费源的静默错误（陈旧、错位、缺口）
 * 比请求失败危险得多 —— 失败会被重试，静默错误会被当成事实算进指标。
 *
 * 处理原则：
 *   - 结构性错误（高低价颠倒、收盘越界）→ 丢弃该根并报告
 *   - 语义可疑（跳变、零成交）→ 保留但标记，由人或上层决定
 *   - 缺口 → 打 hasGap，回测跳过该段（docs/07 §2.2）
 */

import { countDaysBetween, isWeekday, toEpochDay } from './date'
import type { Candle, TradeDate } from './types'

export type QualityIssueKind =
  | 'PRICE_LOGIC'
  | 'NON_POSITIVE_PRICE'
  | 'OUT_OF_ORDER'
  | 'DUPLICATE_DATE'
  | 'BAD_DATE'
  | 'DATE_GAP'
  | 'ZERO_VOLUME'
  | 'PRICE_JUMP'

export interface QualityIssue {
  kind: QualityIssueKind
  date: TradeDate
  detail: string
  /** true 表示该根已被丢弃 */
  dropped: boolean
}

export interface ScreenOptions {
  /** 交易日判据。默认周一至周五 —— 节假日表由 src/main 注入（docs/03 §3） */
  isTradingDay?: (date: TradeDate) => boolean
  /** 相邻收盘跳变阈值，超过即标记可疑。默认 0.2（docs/07 §4） */
  jumpThreshold?: number
}

export interface ScreenResult {
  candles: Candle[]
  issues: QualityIssue[]
}

function priceLogicError(c: Candle): string | null {
  const values = [c.open, c.high, c.low, c.close, c.openAdj, c.highAdj, c.lowAdj, c.closeAdj]
  if (values.some((v) => !Number.isFinite(v))) return '存在非数值价格'
  if (values.some((v) => v <= 0)) return '存在非正价格'
  if (c.high < c.low) return `high(${c.high}) < low(${c.low})`
  if (c.highAdj < c.lowAdj) return `highAdj(${c.highAdj}) < lowAdj(${c.lowAdj})`
  if (c.open > c.high || c.open < c.low) return `open(${c.open}) 越出 [${c.low}, ${c.high}]`
  if (c.close > c.high || c.close < c.low) return `close(${c.close}) 越出 [${c.low}, ${c.high}]`
  if (!Number.isFinite(c.volume) || c.volume < 0) return `volume 非法：${c.volume}`
  return null
}

/**
 * 校验并清洗一段日线。输入按日期升序；乱序与重复会被丢弃并报告
 * —— 排序修复看似更友好，但会掩盖数据源错位这类真问题。
 */
export function screenCandles(input: readonly Candle[], options: ScreenOptions = {}): ScreenResult {
  const isTradingDay = options.isTradingDay ?? isWeekday
  const jumpThreshold = options.jumpThreshold ?? 0.2

  const issues: QualityIssue[] = []
  const candles: Candle[] = []
  const seen = new Set<TradeDate>()

  for (const raw of input) {
    if (toEpochDay(raw.date) === null) {
      issues.push({ kind: 'BAD_DATE', date: raw.date, detail: '日期格式非法', dropped: true })
      continue
    }
    if (seen.has(raw.date)) {
      issues.push({ kind: 'DUPLICATE_DATE', date: raw.date, detail: '同一日期重复出现', dropped: true })
      continue
    }

    const prev = candles[candles.length - 1]
    if (prev && raw.date <= prev.date) {
      issues.push({
        kind: 'OUT_OF_ORDER',
        date: raw.date,
        detail: `晚于其后的 ${prev.date}，数据源可能错位`,
        dropped: true,
      })
      continue
    }

    const logic = priceLogicError(raw)
    if (logic) {
      const kind: QualityIssueKind = logic.includes('非正') ? 'NON_POSITIVE_PRICE' : 'PRICE_LOGIC'
      issues.push({ kind, date: raw.date, detail: logic, dropped: true })
      continue
    }

    // 缺口：与上一根之间还夹着交易日。用 hasGap 标记而非补空 K —— 补出来的 K 是假数据
    const skipped = prev ? countDaysBetween(prev.date, raw.date, isTradingDay) : 0
    const candle: Candle = { ...raw }
    if (skipped > 0) {
      candle.hasGap = true
      issues.push({
        kind: 'DATE_GAP',
        date: raw.date,
        detail: `与 ${prev?.date ?? '?'} 之间缺失 ${skipped} 个交易日`,
        dropped: false,
      })
    } else {
      delete candle.hasGap
    }

    if (candle.volume === 0) {
      issues.push({ kind: 'ZERO_VOLUME', date: candle.date, detail: '零成交量（停牌或数据缺失）', dropped: false })
    }

    // 跳变用前复权收盘比 —— 除权导致的跳空在 *Adj 序列里已经被抹平，
    // 所以这里报出来的都是真异常，不会被除权日刷屏（docs/03 §2.3）
    if (prev && !candle.hasGap) {
      const change = Math.abs(candle.closeAdj - prev.closeAdj) / prev.closeAdj
      if (change > jumpThreshold) {
        issues.push({
          kind: 'PRICE_JUMP',
          date: candle.date,
          detail: `前复权收盘跳变 ${(change * 100).toFixed(1)}%，需人工确认`,
          dropped: false,
        })
      }
    }

    seen.add(candle.date)
    candles.push(candle)
  }

  return { candles, issues }
}

/**
 * 复权因子突变检测（docs/07 §4：触发该标的日线全量重拉）。
 *
 * 数据源不一定给 adj_factor，但 closeAdj / close 就是它。历史日期上这个比值一旦变了，
 * 说明发生了新的除权且历史前复权序列已被整体重算 —— 此时增量补齐会把两套口径拼在一起，
 * 指标必然失真，只能全量重拉。
 */
export function detectAdjustmentDrift(
  stored: readonly Pick<Candle, 'date' | 'close' | 'closeAdj'>[],
  incoming: readonly Pick<Candle, 'date' | 'close' | 'closeAdj'>[],
  tolerance = 0.005
): { date: TradeDate; storedFactor: number; incomingFactor: number } | null {
  const byDate = new Map(incoming.map((c) => [c.date, c]))
  for (const old of stored) {
    const fresh = byDate.get(old.date)
    if (!fresh || old.close <= 0 || fresh.close <= 0) continue
    const storedFactor = old.closeAdj / old.close
    const incomingFactor = fresh.closeAdj / fresh.close
    if (storedFactor <= 0 || incomingFactor <= 0) continue
    if (Math.abs(incomingFactor - storedFactor) / storedFactor > tolerance) {
      return { date: old.date, storedFactor, incomingFactor }
    }
  }
  return null
}

/**
 * 多源一致性：抽样比对最新价，偏差 > 1% 记一条告警（docs/03 §2.2）。
 * 免费源偶发返回陈旧或错位数据，这类静默错误比请求失败更危险。
 */
export function priceDeviation(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null
  return Math.abs(a - b) / ((a + b) / 2)
}
