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
import { isSTName, parseCode, splitCode } from '@core/code'
import { shanghaiDate } from '@shared/time'
import type { HttpClient } from '../../net/http'
import type { Announcement, MinutePoint, MinuteSeries, ProviderCapabilities, QuoteProvider } from '../types'
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
  shanghaiToEpochMs,
  withoutAdjustment,
} from '../shared'

const ID = 'eastmoney'

const KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const SNAPSHOT_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const PROFILE_URL = 'https://push2.eastmoney.com/api/qt/stock/get'
const TRENDS_URL = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
/** 公告（docs/11 N2）。与行情不同域，UT 也用不上 —— 它不是 push2 那一族 */
const ANNOUNCE_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
/** 原文详情页。`art_code` + 六位代码就能拼出来，接口本身不给完整 URL */
const ANNOUNCE_DETAIL = 'https://data.eastmoney.com/notices/detail'
/** 接口单页上限实测就是 100（要 200 也只给 100） */
const ANNOUNCE_PAGE_SIZE = 100
/**
 * 翻页上限。返回是**全局按发布时刻倒序的扁平流**，活跃日里少数公司会占满整页 ——
 * 实测请求 40 只、单页 100 条时只覆盖到 32 只。所以必须翻页，但要有上限：
 * 没有上限的话，`sinceMs` 给早了会把整个历史拖下来。
 */
const ANNOUNCE_MAX_PAGES = 10

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
  // 公告：np-anotice-stock 那条路，见 fetchAnnouncements
  announcement: true,
}

export interface EastmoneyOptions {
  http: HttpClient
  now?: () => number
}

// ─────────────────────────── 公告 ───────────────────────────

/**
 * `2026-08-14 17:30:24:703` → epoch ms。**毫秒是用冒号分隔的**，不是小数点。
 *
 * ⚠ **不要用 `Date.parse` / `new Date(...)`，它不会报错，只会给一个偏掉的时刻。**
 * V8 对这个格式是宽容的（**不**返回 NaN），但它按**本机时区**解析：
 * 实测本机 UTC+7 时 `Date.parse('2026-08-14 17:30:24:703')` 给
 * `2026-08-14T10:30:24Z`，而北京时间 17:30 是 `T09:30:24Z` —— **整整差一小时**。
 *
 * 这是本项目最讨厌的那类失真：不抛异常、不报警，只是把「昨晚 17:30 发的公告」
 * 记成别的时刻，于是盘前简报的时间窗口会漏掉或多算一批。所以走 `shanghaiToEpochMs`。
 */
export function parseAnnounceStamp(raw: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) return null
  return shanghaiToEpochMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

/**
 * 六位数字 + `ann_type` → 内部代码。
 *
 * ⚠ **这里踩过一个真 bug，别改回去**（2026-08-15 实测发现）：
 * 原先写的是 `splitCode('SH'+digits) ?? splitCode('SZ'+digits) ?? splitCode('BJ'+digits)`，
 * 而 SH 的代码段表里有 `['000', 'INDEX']` —— 于是 `000157`（中联重科，深市主板）
 * 被判成 `SH000157`（上证指数段）。后果是**整个深市 000 段**（000001 平安银行、
 * 000002 万科…）的公告都会带着一个错代码出来，被编排层当成「未点名的票」丢掉，
 * 用户永远看不到这些票的公告，**而界面上完全看不出来**。实测一次请求丢了 8 条。
 *
 * 两道判据，顺序不能换：
 *   1. **`ann_type` 优先**。实测它是可靠的市场位：`A,SHA` / `A,SZA` / `A,CYB`（创业板）。
 *      早先注释说它「只是分类标签」是错的，那个判断把我引向了上面那条错路。
 *   2. 没有 `ann_type` 时退到 `parseCode`，**不要自己拼 SH/SZ/BJ 试** ——
 *      它已经做对了这件事（`src/core/code.ts`：「指数段排除在推断之外」），
 *      而公告永远不属于指数。
 */
export function resolveAnnounceCode(digits: string, annType: string): SecCode | null {
  const market = /SHA|SHB|SH\b/.test(annType)
    ? 'SH'
    : /SZA|SZB|CYB/.test(annType)
      ? 'SZ'
      : /BJA|BSE|BJ\b/.test(annType)
        ? 'BJ'
        : null
  if (market) {
    const explicit = splitCode(`${market}${digits}` as SecCode)
    // 显式市场下 000157 仍可能落到 SH 的 INDEX 段上，所以这里也要把指数挡掉
    if (explicit && explicit.board !== 'INDEX') return explicit.code
  }
  const inferred = parseCode(digits)
  return inferred.ok ? inferred.value.code : null
}

interface AnnounceRow {
  art_code?: unknown
  title?: unknown
  display_time?: unknown
  notice_date?: unknown
  codes?: { stock_code?: unknown; short_name?: unknown; ann_type?: unknown }[]
  columns?: { column_name?: unknown }[]
}

/**
 * 解析公告列表。**跳过而不是抛错**的三种行：缺 `art_code`、缺原文可拼出的代码、
 * 时刻解析不出来。理由是这三种都只影响那一条，而抛错会让整页作废 ——
 * 一条脏数据不该让用户今天一条公告都看不到。
 *
 * 但 **`url` 拿不到就整条丢弃**（docs/11 N2-d）：能点回原文是防幻觉的结构性保证，
 * 一条点不开的公告比没有这条更糟。这里的 url 由 `art_code` + 六位代码拼出来，
 * 所以「拿不到 url」等价于「拿不到这两个之一」。
 */
export function parseAnnouncements(body: string): Announcement[] {
  let payload: { data?: { list?: unknown } | null }
  try {
    payload = JSON.parse(body) as { data?: { list?: unknown } | null }
  } catch {
    throw new ProviderDataError(ID, `公告返回不是 JSON：${body.slice(0, 80)}`)
  }
  const list = payload.data?.list
  if (!Array.isArray(list)) return []

  const out: Announcement[] = []
  for (const raw of list as AnnounceRow[]) {
    const artCode = typeof raw.art_code === 'string' ? raw.art_code : null
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const first = raw.codes?.[0]
    const digits = typeof first?.stock_code === 'string' ? first.stock_code : null
    if (artCode === null || title === '' || digits === null) continue

    const code = resolveAnnounceCode(digits, typeof first?.ann_type === 'string' ? first.ann_type : '')
    if (!code) continue

    const publishedAt = typeof raw.display_time === 'string' ? parseAnnounceStamp(raw.display_time) : null
    if (publishedAt === null) continue

    const noticeRaw = typeof raw.notice_date === 'string' ? raw.notice_date : ''
    const noticeDate = /^(\d{4}-\d{2}-\d{2})/.exec(noticeRaw)?.[1]
    if (noticeDate === undefined) continue

    const columnName = raw.columns?.[0]?.column_name
    out.push({
      id: artCode,
      code,
      name: typeof first?.short_name === 'string' ? first.short_name : '',
      title,
      // 拿不到分类给 null，**不填「其他」** —— 猜一个出来，下游的白名单就会命中不存在的类型
      category: typeof columnName === 'string' && columnName !== '' ? columnName : null,
      publishedAt,
      noticeDate: noticeDate as TradeDate,
      url: `${ANNOUNCE_DETAIL}/${digits}/${artCode}.html`,
    })
  }
  return out
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
  // `at` 要先算出来：涨跌停比例按**这条快照自己的交易日**分档（主板 ST 有生效日，见 core/code.ts）
  const at = stamp === null ? fallbackAt : stamp * 1000
  const limits = resolveLimits(
    preClose,
    meta.board,
    meta.isST,
    shanghaiDate(at),
    num(row[S.limitUp]),
    num(row[S.limitDown])
  )

  return {
    code,
    at,
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

    /**
     * 个股公告（docs/11 N2）。**批量、翻页、只取到 `sinceMs` 为止。**
     *
     * 三条实测（2026-08-15，`scripts/probe-announcements.mjs`）决定了这个写法：
     *   - `stock_list` 塞到 200 只仍**无混入**（返回里没有未点名的票）⇒ 不分批；
     *   - 单页上限 100，分页无重叠；
     *   - 返回按发布时刻**倒序**，且是**跨标的的扁平流** ⇒ 只取第一页会漏票。
     */
    async fetchAnnouncements(codes: SecCode[], sinceMs: number): Promise<Announcement[]> {
      const digits = codes.map((code) => splitCode(code)?.digits).filter((d): d is string => d !== undefined)
      if (digits.length === 0) return []

      const out: Announcement[] = []
      for (let page = 1; page <= ANNOUNCE_MAX_PAGES; page++) {
        const query = new URLSearchParams({
          page_size: String(ANNOUNCE_PAGE_SIZE),
          page_index: String(page),
          ann_type: 'A',
          client_source: 'web',
          stock_list: digits.join(','),
        })
        const { body } = await http.get(`${ANNOUNCE_URL}?${query.toString()}`)
        const rows = parseAnnouncements(body)
        // 空页 = 到底了。**这不是失败** —— registry 那一层刻意不设 emptyIsFailure
        if (rows.length === 0) break

        out.push(...rows.filter((row) => row.publishedAt >= sinceMs))
        // 这一页最旧的一条已经早于下界 ⇒ 后面只会更旧，不必再翻
        const oldest = rows[rows.length - 1]
        if (oldest && oldest.publishedAt < sinceMs) break
        if (rows.length < ANNOUNCE_PAGE_SIZE) break
      }
      return out
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
