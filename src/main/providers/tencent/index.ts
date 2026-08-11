/**
 * 腾讯行情适配（备源：快照 + 日线）。接口地址、字段含义与怪癖见 ./NOTES.md。
 *
 * 字段全靠下标定位，没有任何名字可以自解释 —— 所以每个下标都必须有常量名，
 * 且 tests/fixtures/providers/tencent/ 里的真实响应是唯一的验收依据。
 * 腾讯改了字段顺序时，回放测试会失败并指出是哪一个。
 */

import type { AdjustMode, SecCode, SecProfile, Snapshot, TradeDate } from '@core/types'
import { splitCode } from '@core/code'
import type { HttpClient } from '../../net/http'
import type { ProviderCapabilities, QuoteProvider } from '../types'
import {
  ProviderDataError,
  type RawBar,
  SNAPSHOT_CHUNK,
  calendarFromIndexBars,
  chunk,
  classify,
  estimateBarCount,
  fromLowerPrefixed,
  handsToShares,
  inRange,
  inferSuspended,
  mergeAdjusted,
  num,
  parseCompactStamp,
  positive,
  resolveLimits,
  toLowerPrefixed,
  wanToYuan,
  withoutAdjustment,
} from '../shared'

const ID = 'tencent'

const SNAPSHOT_URL = 'https://qt.gtimg.cn/q='
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'

/** `v_sh600000="…"` 里 `~` 分隔的字段下标。完整清单见 NOTES.md。 */
const F = {
  name: 1,
  digits: 2,
  last: 3,
  preClose: 4,
  open: 5,
  /** 手 */
  volumeHands: 6,
  stamp: 30,
  high: 33,
  low: 34,
  /** -1 表示该源不给（fixture 里北交所就是 -1） */
  limitUp: 47,
  limitDown: 48,
  /** 万元，4 位小数，比下标 37 的整数万元精确 */
  amountWan: 57,
} as const

/** 字段数少于这个值说明返回被截断了，宁可报错也不要解析出半截数据 */
const MIN_SNAPSHOT_FIELDS = 58

const CAPABILITIES: ProviderCapabilities = {
  daily: true,
  snapshot: true,
  minute: false,
  // 只有名称与板块，没有行业与上市日 —— 见 NOTES.md
  profile: true,
  // 由基准指数日线反推，见 shared.ts calendarFromIndexBars
  calendar: true,
}

/** 反推交易日历用的基准指数。上证指数历史最长，任何年份都有数据。 */
const CALENDAR_BENCHMARK: SecCode = 'SH000001'

export interface TencentOptions {
  http: HttpClient
  now?: () => number
}

// ─────────────────────────── 快照 ───────────────────────────

interface TencentQuote {
  external: string
  fields: string[]
}

/** 拆出 `v_sh600000="a~b~c";` 这样的一条条记录。分号后可能带换行。 */
export function splitQuoteRecords(body: string): TencentQuote[] {
  const out: TencentQuote[] = []
  const re = /v_([a-z]{2}\d{6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    out.push({ external: m[1] ?? '', fields: (m[2] ?? '').split('~') })
  }
  return out
}

function toSnapshot(quote: TencentQuote, fallbackAt: number): Snapshot | null {
  const code = fromLowerPrefixed(quote.external)
  if (!code) return null
  if (quote.fields.length < MIN_SNAPSHOT_FIELDS) {
    throw new ProviderDataError(ID, `${quote.external} 只返回 ${quote.fields.length} 个字段，疑似接口变更`)
  }

  const name = (quote.fields[F.name] ?? '').trim()
  const meta = classify(code, name)
  if (!meta) return null

  const last = positive(quote.fields[F.last])
  const preClose = positive(quote.fields[F.preClose])
  // 昨收都没有的记录无法用于任何判定（涨跌幅、涨跌停都以它为基准），整条丢弃
  if (preClose === null) return null

  const open = num(quote.fields[F.open])
  const volume = handsToShares(num(quote.fields[F.volumeHands]))
  const limits = resolveLimits(
    preClose,
    meta.board,
    meta.isST,
    num(quote.fields[F.limitUp]),
    num(quote.fields[F.limitDown])
  )

  return {
    code,
    at: parseCompactStamp(quote.fields[F.stamp] ?? '') ?? fallbackAt,
    // 停牌股的 last 就是昨收，用昨收兜底比用 0 合理
    last: last ?? preClose,
    open: open ?? 0,
    high: num(quote.fields[F.high]) ?? 0,
    low: num(quote.fields[F.low]) ?? 0,
    preClose,
    volume: volume ?? 0,
    amount: wanToYuan(num(quote.fields[F.amountWan])) ?? 0,
    limitUp: limits.limitUp,
    limitDown: limits.limitDown,
    suspended: inferSuspended(preClose, open, volume),
  }
}

// ─────────────────────────── 日线 ───────────────────────────

/** `[date, open, close, high, low, volume]` —— 注意是**开收高低**，不是开高低收 */
const K = { date: 0, open: 1, close: 2, high: 3, low: 4, volumeHands: 5 } as const

interface KlineResponse {
  code?: number
  msg?: string
  data?: Record<string, Record<string, unknown> | undefined>
}

/** 复权模式 → 响应里承载数据的键名 */
const SERIES_KEY: Record<AdjustMode, string> = { none: 'day', qfq: 'qfqday', hfq: 'hfqday' }

export function parseKline(
  body: string,
  external: string,
  adjust: AdjustMode,
  from: TradeDate,
  to: TradeDate
): RawBar[] {
  let parsed: KlineResponse
  try {
    parsed = JSON.parse(body) as KlineResponse
  } catch {
    throw new ProviderDataError(ID, `日线返回不是 JSON：${body.slice(0, 80)}`)
  }
  if (parsed.code !== undefined && parsed.code !== 0) {
    throw new ProviderDataError(ID, `日线返回 code=${parsed.code} ${parsed.msg ?? ''}`.trim())
  }

  const entry = parsed.data?.[external]
  if (!entry) throw new ProviderDataError(ID, `日线返回里没有 ${external}`)

  const key = SERIES_KEY[adjust]
  const rows = entry[key]
  if (!Array.isArray(rows)) {
    throw new ProviderDataError(ID, `日线返回里没有 ${key} 数组（${external}）`)
  }

  const bars: RawBar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const cells = row as unknown[]
    const date = String(cells[K.date] ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inRange(date, from, to)) continue

    const open = positive(cells[K.open])
    const high = positive(cells[K.high])
    const low = positive(cells[K.low])
    const close = positive(cells[K.close])
    const volume = handsToShares(num(cells[K.volumeHands]))
    // 四个价里缺任何一个都无法构成一根 K 线，跳过而不是填 0
    if (open === null || high === null || low === null || close === null) continue

    bars.push({
      date,
      open,
      high,
      low,
      close,
      volume: volume ?? 0,
      // 腾讯日线不给成交额。null 而不是 0，见 Candle.amount 的注释
      amount: null,
    })
  }
  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars
}

// ─────────────────────────── Provider ───────────────────────────

export function createTencentProvider(options: TencentOptions): QuoteProvider {
  const { http, now = () => Date.now() } = options

  async function fetchSeries(
    external: string,
    adjust: AdjustMode,
    from: TradeDate,
    to: TradeDate,
    count: number
  ): Promise<RawBar[]> {
    // param = 代码,周期,起,止,根数,复权；不复权时复权段留空
    const suffix = adjust === 'none' ? '' : adjust
    const param = `${external},day,${from},${to},${count},${suffix}`
    const { body } = await http.get(`${KLINE_URL}?param=${encodeURIComponent(param)}`)
    return parseKline(body, external, adjust, from, to)
  }

  const provider: QuoteProvider = {
    id: ID,
    capabilities: CAPABILITIES,

    async fetchDaily(code: SecCode, from: TradeDate, to: TradeDate, adjust: AdjustMode) {
      const external = toLowerPrefixed(code)
      if (!external) throw new ProviderDataError(ID, `无法识别的代码：${code}`)
      const count = estimateBarCount(from, to)

      const raw = await fetchSeries(external, 'none', from, to, count)
      if (adjust === 'none') return withoutAdjustment(raw)
      // 复权与不复权是两次请求：腾讯的响应二选一，不会同时给两条序列。
      // 日线是每日一次的增量补齐，两次请求的代价可以接受（docs/03 §2.4）。
      const adjusted = await fetchSeries(external, adjust, from, to, count)
      return mergeAdjusted(raw, adjusted)
    },

    async fetchSnapshots(codes: SecCode[]): Promise<Snapshot[]> {
      const externals = codes.map((code) => ({ code, external: toLowerPrefixed(code) }))
      const usable = externals.filter((x): x is { code: SecCode; external: string } => x.external !== null)
      if (usable.length === 0) return []

      const batches = await Promise.all(
        chunk(usable, SNAPSHOT_CHUNK).map(async (group) => {
          const url = `${SNAPSHOT_URL}${group.map((x) => x.external).join(',')}`
          const { body } = await http.get(url, { encoding: 'gbk' })
          const at = now()
          return splitQuoteRecords(body)
            .map((quote) => toSnapshot(quote, at))
            .filter((snapshot): snapshot is Snapshot => snapshot !== null)
        })
      )
      return batches.flat()
    },

    async fetchProfile(code: SecCode): Promise<SecProfile> {
      const external = toLowerPrefixed(code)
      const parsed = splitCode(code)
      if (!external || !parsed) throw new ProviderDataError(ID, `无法识别的代码：${code}`)

      const { body } = await http.get(`${SNAPSHOT_URL}${external}`, { encoding: 'gbk' })
      const record = splitQuoteRecords(body)[0]
      const name = record?.fields[F.name]?.trim()
      if (!name) throw new ProviderDataError(ID, `${code} 没有取到名称`)

      const meta = classify(code, name)
      // industry / listedAt：腾讯快照接口不提供，留空由主源补
      return { code, name, market: parsed.market, board: parsed.board, isST: meta?.isST ?? false }
    },

    /** 与主源同法：由基准指数日线反推开市日（docs/03 §3、shared.ts calendarFromIndexBars） */
    async fetchCalendar(year: number) {
      const bars = await provider.fetchDaily(
        CALENDAR_BENCHMARK,
        `${year}-01-01`,
        `${year}-12-31`,
        'none'
      )
      return calendarFromIndexBars(bars, year)
    },
  }

  return provider
}
