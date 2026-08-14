/**
 * 东方财富行情适配（主源：日线含复权、批量快照、基础信息、交易日历）。
 * 接口地址、字段含义与怪癖见 ./NOTES.md。
 *
 * ⚠ 与另外两个源不同：本文件的 fixture 是**手写**的，不是录制的真实响应。
 * 开发机访问 push2 / push2his 时连接被对端直接断开（curl 56 / fetch "other side closed"），
 * 无法录制。字段映射按公开已知的契约实现，**未在真机核对**。
 * 首次能联网的机器上必须先跑 `pnpm fixtures:record -- --provider eastmoney`
 * 并人工比对 fixture 差异 —— 见 NOTES.md「待核对」。
 */

import type { AdjustMode, SecCode, SecProfile, Snapshot, TradeDate } from '@core/types'
import { isSTName, splitCode } from '@core/code'
import type { HttpClient } from '../../net/http'
import type { MinutePoint, MinuteSeries, ProviderCapabilities, QuoteProvider } from '../types'
import {
  ProviderDataError,
  type RawBar,
  SNAPSHOT_CHUNK,
  calendarFromIndexBars,
  chunk,
  classify,
  compactDate,
  dashDate,
  handsToShares,
  inRange,
  inferSuspended,
  mergeAdjusted,
  num,
  parseDateTime,
  positive,
  resolveLimits,
  withoutAdjustment,
} from '../shared'

const ID = 'eastmoney'

const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const SNAPSHOT_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const PROFILE_URL = 'https://push2.eastmoney.com/api/qt/stock/get'
const TRENDS_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'

/**
 * 接口必需的查询参数，不是伪造身份 —— 缺了它多数端点直接 400。
 * 这是个公开常量，全网的示例都是同一个值。
 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b'

/** klt=101 日线；fqt: 0 不复权 / 1 前复权 / 2 后复权 */
const KLT_DAY = 101
const FQT: Record<AdjustMode, number> = { none: 0, qfq: 1, hfq: 2 }

/** klines 里 CSV 的列序，由 fields2 参数决定 —— 两者必须一起改 */
const KLINE_FIELDS = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
const K = {
  date: 0,
  open: 1,
  close: 2,
  high: 3,
  low: 4,
  /** 手 */
  volumeHands: 5,
  /** 元 */
  amount: 6,
  turnoverRate: 10,
} as const

/** 快照字段。f13 是市场号（1=沪、0=深/京），拼回内部代码要用它。 */
const SNAPSHOT_FIELDS = 'f2,f5,f6,f12,f13,f14,f15,f16,f17,f18,f51,f52,f124'
const S = {
  last: 'f2',
  volumeHands: 'f5',
  amount: 'f6',
  digits: 'f12',
  market: 'f13',
  name: 'f14',
  high: 'f15',
  low: 'f16',
  open: 'f17',
  preClose: 'f18',
  limitUp: 'f51',
  limitDown: 'f52',
  /** unix 秒 */
  stamp: 'f124',
} as const

const PROFILE_FIELDS = 'f57,f58,f127,f189'
const P = { digits: 'f57', name: 'f58', industry: 'f127', listedAt: 'f189' } as const

/** 由基准指数日线反推交易日历时用它。上证指数历史最长，任何年份都有数据。 */
const CALENDAR_BENCHMARK: SecCode = 'SH000001'

/** trends2 里 CSV 的列序，由 fields2 决定 —— 两者必须一起改 */
const TRENDS_FIELDS = 'f51,f53,f56,f58'
const T = {
  /** 'YYYY-MM-DD HH:mm' */
  time: 0,
  last: 1,
  /** 手 —— 分时图不画量，留着是为了列序对得上 */
  volumeHands: 2,
  avg: 3,
} as const

const CAPABILITIES: ProviderCapabilities = {
  daily: true,
  snapshot: true,
  minute: true,
  profile: true,
  calendar: true,
}

export interface EastmoneyOptions {
  http: HttpClient
  now?: () => number
}

/** `SH600000` → `1.600000`；深市与北交所同属市场号 0 */
export function toSecId(code: SecCode): string | null {
  const parsed = splitCode(code)
  if (!parsed) return null
  return `${parsed.market === 'SH' ? 1 : 0}.${parsed.digits}`
}

/** 市场号 + 六位数字 → 内部代码。市场号 0 既可能是深市也可能是北交所，靠代码段区分。 */
export function fromSecId(market: number, digits: string): SecCode | null {
  if (market === 1) return splitCode(`SH${digits}`)?.code ?? null
  return splitCode(`SZ${digits}`)?.code ?? splitCode(`BJ${digits}`)?.code ?? null
}

// ─────────────────────────── 日线 ───────────────────────────

interface KlineResponse {
  rc?: number
  data?: { klines?: unknown; decimal?: number } | null
}

export function parseKline(body: string, from: TradeDate, to: TradeDate): RawBar[] {
  let parsed: KlineResponse
  try {
    parsed = JSON.parse(body) as KlineResponse
  } catch {
    throw new ProviderDataError(ID, `日线返回不是 JSON：${body.slice(0, 80)}`)
  }
  if (parsed.rc !== undefined && parsed.rc !== 0) {
    throw new ProviderDataError(ID, `日线返回 rc=${parsed.rc}`)
  }
  // data 为 null 是「代码不存在」而非「区间内无数据」，两者都返回空数组由上层判断
  const rows = parsed.data?.klines
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) throw new ProviderDataError(ID, 'klines 不是数组，疑似接口变更')

  const bars: RawBar[] = []
  for (const row of rows) {
    if (typeof row !== 'string') continue
    const cells = row.split(',')
    const date = (cells[K.date] ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inRange(date, from, to)) continue

    const open = positive(cells[K.open])
    const high = positive(cells[K.high])
    const low = positive(cells[K.low])
    const close = positive(cells[K.close])
    if (open === null || high === null || low === null || close === null) continue

    bars.push({
      date,
      open,
      high,
      low,
      close,
      volume: handsToShares(num(cells[K.volumeHands])) ?? 0,
      amount: num(cells[K.amount]),
    })
  }
  bars.sort((a, b) => a.date.localeCompare(b.date))
  return bars
}

// ─────────────────────────── 分时 ───────────────────────────

interface TrendsResponse {
  rc?: number
  data?: { trends?: unknown; preClose?: unknown } | null
}

/**
 * `data.trends` 的每行是 `'2026-08-14 09:31,10.11,1234,10.10'`。
 *
 * **`tradeDate` 取自数据本身的第一行，不取本机日期** —— 休市日请求这个端点，
 * 返回的是上一个交易日那条曲线，用本机日期去标就等于把周五的走势说成今天的。
 */
export function parseTrends(body: string): MinuteSeries {
  let parsed: TrendsResponse
  try {
    parsed = JSON.parse(body) as TrendsResponse
  } catch {
    throw new ProviderDataError(ID, `分时返回不是 JSON：${body.slice(0, 80)}`)
  }
  if (parsed.rc !== undefined && parsed.rc !== 0) {
    throw new ProviderDataError(ID, `分时返回 rc=${parsed.rc}`)
  }

  const rows = parsed.data?.trends
  if (rows !== undefined && rows !== null && !Array.isArray(rows)) {
    throw new ProviderDataError(ID, 'trends 不是数组，疑似接口变更')
  }

  const points: MinutePoint[] = []
  let tradeDate = ''
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row !== 'string') continue
    const cells = row.split(',')
    const stamp = (cells[T.time] ?? '').trim()
    const [date = '', time = ''] = stamp.split(' ')
    const ts = parseDateTime(date, time)
    const last = positive(cells[T.last])
    if (ts === null || last === null) continue
    if (tradeDate === '') tradeDate = date
    // 跨日的返回（ndays > 1，或接口自己拼了两天）只保留第一天那段：
    // 这张图画的是「一个交易日」，两天连起来会在午夜处画出一条不存在的长线
    if (date !== tradeDate) continue
    points.push({ ts, last, avg: positive(cells[T.avg]) })
  }
  points.sort((a, b) => a.ts - b.ts)

  return { tradeDate, preClose: positive(parsed.data?.preClose), points }
}

// ─────────────────────────── 快照 ───────────────────────────

interface SnapshotResponse {
  rc?: number
  data?: { diff?: unknown } | null
}

type Row = Record<string, unknown>

/** diff 有两种形态：数组，或以 "0"/"1"… 为键的对象。两种都见过，都要吃下。 */
function rowsOf(diff: unknown): Row[] {
  if (Array.isArray(diff)) return diff.filter((row): row is Row => typeof row === 'object' && row !== null)
  if (typeof diff === 'object' && diff !== null) {
    return Object.values(diff as Record<string, unknown>).filter(
      (row): row is Row => typeof row === 'object' && row !== null
    )
  }
  return []
}

function toSnapshot(row: Row, fallbackAt: number): Snapshot | null {
  const digits = typeof row[S.digits] === 'string' ? (row[S.digits] as string) : null
  const market = num(row[S.market])
  if (!digits || market === null) return null
  const code = fromSecId(market, digits)
  if (!code) return null

  const name = typeof row[S.name] === 'string' ? (row[S.name] as string).trim() : ''
  const meta = classify(code, name)
  if (!meta) return null

  const preClose = positive(row[S.preClose])
  if (preClose === null) return null

  const last = positive(row[S.last])
  const open = num(row[S.open])
  const volume = handsToShares(num(row[S.volumeHands]))
  const stamp = num(row[S.stamp])
  const limits = resolveLimits(preClose, meta.board, meta.isST, num(row[S.limitUp]), num(row[S.limitDown]))

  return {
    code,
    at: stamp === null ? fallbackAt : stamp * 1000,
    last: last ?? preClose,
    open: open ?? 0,
    high: num(row[S.high]) ?? 0,
    low: num(row[S.low]) ?? 0,
    preClose,
    volume: volume ?? 0,
    amount: num(row[S.amount]) ?? 0,
    limitUp: limits.limitUp,
    limitDown: limits.limitDown,
    suspended: inferSuspended(preClose, open, volume),
  }
}

// ─────────────────────────── Provider ───────────────────────────

export function createEastmoneyProvider(options: EastmoneyOptions): QuoteProvider {
  const { http, now = () => Date.now() } = options

  async function fetchSeries(
    secid: string,
    adjust: AdjustMode,
    from: TradeDate,
    to: TradeDate
  ): Promise<RawBar[]> {
    const query = new URLSearchParams({
      secid,
      ut: UT,
      fields1: 'f1,f2,f3,f4,f5,f6',
      fields2: KLINE_FIELDS,
      klt: String(KLT_DAY),
      fqt: String(FQT[adjust]),
      beg: compactDate(from),
      end: compactDate(to),
      lmt: '2000',
    })
    const { body } = await http.get(`${KLINE_URL}?${query.toString()}`)
    return parseKline(body, from, to)
  }

  const provider: QuoteProvider = {
    id: ID,
    capabilities: CAPABILITIES,

    async fetchDaily(code: SecCode, from: TradeDate, to: TradeDate, adjust: AdjustMode) {
      const secid = toSecId(code)
      if (!secid) throw new ProviderDataError(ID, `无法识别的代码：${code}`)

      const raw = await fetchSeries(secid, 'none', from, to)
      if (adjust === 'none') return withoutAdjustment(raw)
      // fqt 一次只能给一种口径，复权双轨必然是两次请求（docs/03 §2.3）
      const adjusted = await fetchSeries(secid, adjust, from, to)
      return mergeAdjusted(raw, adjusted)
    },

    async fetchSnapshots(codes: SecCode[]): Promise<Snapshot[]> {
      const secids = codes.map((code) => toSecId(code)).filter((id): id is string => id !== null)
      if (secids.length === 0) return []

      const batches = await Promise.all(
        chunk(secids, SNAPSHOT_CHUNK).map(async (group) => {
          const query = new URLSearchParams({
            ut: UT,
            // fltt=2：价格已按 decimal 除好，直接是可用的小数。缺它会拿到放大 100 倍的整数
            fltt: '2',
            invt: '2',
            secids: group.join(','),
            fields: SNAPSHOT_FIELDS,
          })
          const { body } = await http.get(`${SNAPSHOT_URL}?${query.toString()}`)
          let parsed: SnapshotResponse
          try {
            parsed = JSON.parse(body) as SnapshotResponse
          } catch {
            throw new ProviderDataError(ID, `快照返回不是 JSON：${body.slice(0, 80)}`)
          }
          if (parsed.rc !== undefined && parsed.rc !== 0) {
            throw new ProviderDataError(ID, `快照返回 rc=${parsed.rc}`)
          }
          const at = now()
          return rowsOf(parsed.data?.diff)
            .map((row) => toSnapshot(row, at))
            .filter((snapshot): snapshot is Snapshot => snapshot !== null)
        })
      )
      return batches.flat()
    },

    /**
     * 当日分时。`ndays=1` 只要最近一个交易日 —— 休市时它给的是**上一个交易日**，
     * 这不是错误，由 `tradeDate` 如实带出去，上层照它画 x 轴。
     */
    async fetchMinutes(code: SecCode): Promise<MinuteSeries> {
      const secid = toSecId(code)
      if (!secid) throw new ProviderDataError(ID, `无法识别的代码：${code}`)

      const query = new URLSearchParams({
        secid,
        ut: UT,
        fields1: 'f1,f2,f3,f4,f5,f6,f7,f8',
        fields2: TRENDS_FIELDS,
        // iscr=0 不含盘前集合竞价那一段（09:15–09:25 是虚价，docs/03 §3 的 AUCTION 一行）
        iscr: '0',
        ndays: '1',
      })
      const { body } = await http.get(`${TRENDS_URL}?${query.toString()}`)
      return parseTrends(body)
    },

    async fetchProfile(code: SecCode): Promise<SecProfile> {
      const secid = toSecId(code)
      const parsed = splitCode(code)
      if (!secid || !parsed) throw new ProviderDataError(ID, `无法识别的代码：${code}`)

      const query = new URLSearchParams({
        ut: UT,
        invt: '2',
        fltt: '2',
        secid,
        fields: PROFILE_FIELDS,
      })
      const { body } = await http.get(`${PROFILE_URL}?${query.toString()}`)
      let payload: { rc?: number; data?: Row | null }
      try {
        payload = JSON.parse(body) as { rc?: number; data?: Row | null }
      } catch {
        throw new ProviderDataError(ID, `基础信息返回不是 JSON：${body.slice(0, 80)}`)
      }
      const row = payload.data
      const name = row && typeof row[P.name] === 'string' ? (row[P.name] as string).trim() : ''
      if (!name) throw new ProviderDataError(ID, `${code} 没有取到名称`)

      const industry = row && typeof row[P.industry] === 'string' ? (row[P.industry] as string).trim() : ''
      const listedAt = num(row?.[P.listedAt])

      return {
        code,
        name,
        market: parsed.market,
        board: parsed.board,
        isST: isSTName(name),
        // exactOptionalPropertyTypes 开着，可选字段只能「有值才给键」
        ...(industry === '' || industry === '-' ? {} : { industry }),
        ...(listedAt === null || listedAt <= 0 ? {} : { listedAt: dashDate(String(listedAt)) }),
      }
    },

    /**
     * 交易日历由基准指数日线反推（docs/03 §3）。
     * 没有用某个未公开的日历端点：指数有数据的那天必然开市，这个推断不会因接口下线而失效。
     */
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
