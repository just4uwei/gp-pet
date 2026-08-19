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
import type { MinutePoint, MinuteSeries, ProviderCapabilities, QuoteProvider } from '../types'
import {
  ProviderDataError,
  type RawBar,
  SNAPSHOT_CHUNK,
  calendarFromIndexBars,
  chunk,
  classify,
  dashDate,
  estimateBarCount,
  fromLowerPrefixed,
  handsToShares,
  inRange,
  inferSuspended,
  mergeAdjusted,
  num,
  parseCompactStamp,
  parseDateTime,
  positive,
  resolveLimits,
  toLowerPrefixed,
  wanToYuan,
  withoutAdjustment,
} from '../shared'

const ID = 'tencent'

const SNAPSHOT_URL = 'https://qt.gtimg.cn/q='
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const MINUTE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query'

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
  minute: true,
  // 只有名称与板块，没有行业与上市日 —— 见 NOTES.md
  profile: true,
  // 由基准指数日线反推，见 shared.ts calendarFromIndexBars
  calendar: true,
  // 腾讯的公告在另一套页面里，形状与东财差得远，暂不做第二套解析器
  announcement: false,
}

/** 反推交易日历用的基准指数。上证指数历史最长，任何年份都有数据。 */
const CALENDAR_BENCHMARK: SecCode = 'SH000001'

export interface TencentOptions {
  http: HttpClient
  now?: () => number
}

// ─────────────────────────── 分时 ───────────────────────────

/**
 * 分时一行：`'0931 9.11 18364 16769279.00'`，空格分隔。
 *
 * ⚠ **后两列是「当日累计」量与额，不是这一分钟的，更不是均价**（2026-08-14 实测核对）。
 * 把第 4 列直接当均价用会得到一个七位数，而它会被算进纵轴范围 ——
 * 症状是整条分时线被压成贴着框底的一条直线，图上看不出是哪一列读错了。
 * 均价只能自己除：`额 / (量 × 100)`。已与主源同一分钟的 f58 对过（两边都是 9.132）。
 */
const M = { time: 0, last: 1, cumVolumeHands: 2, cumAmountYuan: 3 } as const

interface MinuteResponse {
  code?: number
  data?: Record<string, unknown> | null
}

function pick(node: unknown, key: string): unknown {
  return typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined
}

/**
 * `data.sh600000.data` = `{ date: '20260814', data: ['0931 9.11 18364 16769279.00', …] }`。
 *
 * **昨收实测来自 `qt` 那条快照的下标 4**（2026-08-14 核对：响应里的键只有
 * `data` / `qt` / `mx_price`，**没有 `prec`**）。仍然先看 `prec` 是因为网上的示例里有它，
 * 留一条兼容路径不花什么代价；但真正在跑的是 `qt` 那条 —— 别把 `qt` 当可有可无的东西删掉，
 * 删了就没有昨收，基准线与右轴涨跌幅一起消失。
 *
 * ⚠ 这个端点是 **UTF-8 JSON**，不像 `qt.gtimg.cn` 的快照那样按 GBK 读。
 * 而且这里必须是 UTF-8：把 UTF-8 字节按 GBK 解会让某个汉字吞掉紧随其后的 ASCII 字节
 * （GBK 的尾字节范围含 `}` `\`），JSON 结构直接被啃坏 —— 反过来则只会出几个替换字符。
 */
export function parseMinutes(body: string, external: string): MinuteSeries {
  let parsed: MinuteResponse
  try {
    parsed = JSON.parse(body) as MinuteResponse
  } catch {
    throw new ProviderDataError(ID, `分时返回不是 JSON：${body.slice(0, 80)}`)
  }
  if (parsed.code !== undefined && parsed.code !== 0) {
    throw new ProviderDataError(ID, `分时返回 code=${parsed.code}`)
  }

  const node = pick(parsed.data, external)
  const inner = pick(node, 'data')
  const rows = pick(inner, 'data')
  if (rows !== undefined && rows !== null && !Array.isArray(rows)) {
    throw new ProviderDataError(ID, '分时 data.data 不是数组，疑似接口变更')
  }

  const compact = typeof pick(inner, 'date') === 'string' ? (pick(inner, 'date') as string).trim() : ''
  // 日期只有 8 位紧凑串这一种来源。拿不到就整段作废 —— 用本机日期顶替会把
  // 休市日返回的「上一个交易日」标成今天（见 types.ts MinuteSeries 的告警）
  if (!/^\d{8}$/.test(compact)) {
    throw new ProviderDataError(ID, `分时没有给交易日：${body.slice(0, 80)}`)
  }
  const tradeDate = dashDate(compact)

  const points: MinutePoint[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row !== 'string') continue
    const cells = row.trim().split(/\s+/)
    const hhmm = (cells[M.time] ?? '').trim()
    if (!/^\d{4}$/.test(hhmm)) continue
    const ts = parseDateTime(tradeDate, `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`)
    const last = positive(cells[M.last])
    if (ts === null || last === null) continue
    // 均价自己除（见 M 的注释）。任一项为 0 / 缺失时是 null，**不要退化成 last** ——
    // 那会画出一条与价格线完全重合的假均价线，而重合本身看起来很正常
    const cumVolume = handsToShares(positive(cells[M.cumVolumeHands]))
    const cumAmount = positive(cells[M.cumAmountYuan])
    const avg = cumVolume !== null && cumVolume > 0 && cumAmount !== null ? cumAmount / cumVolume : null
    points.push({ ts, last, avg })
  }
  points.sort((a, b) => a.ts - b.ts)

  const prec = positive(pick(node, 'prec'))
  const qtFields = pick(pick(node, 'qt'), external)
  const fromQt = Array.isArray(qtFields) ? positive(qtFields[F.preClose]) : null

  return { tradeDate, preClose: prec ?? fromQt, points }
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

/**
 * 这个 external 是**指数**吗（2026-08-19）。
 *
 * 指数没有复权这个概念，腾讯的 `fqkline` 因此只给 `day` 一轨 —— 实测 `sh000300`
 * 无论请不请 qfq，返回里都只有 `day`。于是基准指数的日线在腾讯这条路上**永远失败**，
 * 只剩 eastmoney 单源（成功率约 78%），而它失败的那一天影子净值的基准列就永久留 null。
 *
 * ⚠ **只对指数放行 `day` 回退。** ETF 与个股真的有复权，拿不复权顶替是错的失败方式
 * （CLAUDE.md 那条「`assertKey` 拒绝拿不复权顶替 —— 那是对的失败方式」说的就是它们）。
 */
function isIndex(external: string): boolean {
  const code = fromLowerPrefixed(external)
  return code !== null && splitCode(code)?.board === 'INDEX'
}

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
  let rows = entry[key]
  // 指数：请的是复权轨、返回只有 day —— 对它而言 day 就是复权轨（见 isIndex）
  if (!Array.isArray(rows) && adjust !== 'none' && isIndex(external) && Array.isArray(entry['day'])) {
    rows = entry['day']
  }
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

    /**
     * 当日分时。这个端点只给「最近一个交易日」，休市时给的是上一个 ——
     * 由 `tradeDate` 如实带出去，上层照它画 x 轴（见 types.ts MinuteSeries）。
     */
    async fetchMinutes(code: SecCode): Promise<MinuteSeries> {
      const external = toLowerPrefixed(code)
      if (!external) throw new ProviderDataError(ID, `无法识别的代码：${code}`)
      // 刻意不传 encoding：这是 UTF-8 JSON，按 GBK 读会啃坏结构（见 parseMinutes）
      const { body } = await http.get(`${MINUTE_URL}?code=${external}`)
      return parseMinutes(body, external)
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
