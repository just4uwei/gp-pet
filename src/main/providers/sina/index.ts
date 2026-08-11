/**
 * 新浪行情适配（备源：批量快照）。接口地址、字段含义与怪癖见 ./NOTES.md。
 *
 * 只承担快照。日线走主源或腾讯 —— 新浪的历史数据接口是另一套（带 JS 包装、
 * 复权口径不明），为一个备源引入第二套解析器不值得，capabilities.daily 因此为 false。
 */

import type { AdjustMode, Candle, SecCode, SecProfile, Snapshot, TradeDate } from '@core/types'
import { splitCode } from '@core/code'
import type { HttpClient } from '../../net/http'
import type { ProviderCapabilities, QuoteProvider } from '../types'
import {
  ProviderDataError,
  SNAPSHOT_CHUNK,
  UnsupportedCapabilityError,
  chunk,
  classify,
  fromLowerPrefixed,
  inferSuspended,
  num,
  parseDateTime,
  positive,
  resolveLimits,
  toLowerPrefixed,
} from '../shared'

const ID = 'sina'

const SNAPSHOT_URL = 'https://hq.sinajs.cn/list='

/**
 * 没有 Referer 会返回 403。这是接口方明确的调用要求，不属于「伪造身份」
 * （docs/03 §2.4 允许的唯一例外）。
 */
const HEADERS = { Referer: 'https://finance.sina.com.cn' } as const

/** 逗号分隔字段的下标。完整清单见 NOTES.md。 */
const F = {
  name: 0,
  open: 1,
  preClose: 2,
  last: 3,
  high: 4,
  low: 5,
  /** 股 */
  volume: 8,
  /** 元 */
  amount: 9,
  date: 30,
  time: 31,
} as const

/** 停牌股的返回会短一截（fixture 里北交所只有 33 个字段），价格段仍在前面，够用 */
const MIN_FIELDS = 10

const CAPABILITIES: ProviderCapabilities = {
  daily: false,
  snapshot: true,
  minute: false,
  // 只有名称与板块，没有行业与上市日
  profile: true,
  calendar: false,
}

export interface SinaOptions {
  http: HttpClient
  now?: () => number
}

interface SinaRecord {
  external: string
  fields: string[]
}

/** 拆出 `var hq_str_sh600000="a,b,c";` 这样的一条条记录 */
export function splitQuoteRecords(body: string): SinaRecord[] {
  const out: SinaRecord[] = []
  const re = /hq_str_([a-z]{2}\d{6})="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    out.push({ external: m[1] ?? '', fields: (m[2] ?? '').split(',') })
  }
  return out
}

function toSnapshot(record: SinaRecord, fallbackAt: number): Snapshot | null {
  const code = fromLowerPrefixed(record.external)
  if (!code) return null

  const name = (record.fields[F.name] ?? '').trim()
  // 新浪对未上市/退市/长期停牌的代码返回一整行 0（fixture 里的 bj430047 就是），
  // 名称也可能为空。这种记录整条丢弃 —— 落库会污染昨收，进而污染涨跌停与止损。
  if (name === '' || record.fields.length < MIN_FIELDS) return null

  const preClose = positive(record.fields[F.preClose])
  if (preClose === null) return null

  const meta = classify(code, name)
  if (!meta) return null

  const last = positive(record.fields[F.last])
  const open = num(record.fields[F.open])
  const volume = num(record.fields[F.volume])
  // 新浪不给涨跌停价，全部本地算
  const limits = resolveLimits(preClose, meta.board, meta.isST)

  return {
    code,
    at: parseDateTime(record.fields[F.date] ?? '', record.fields[F.time] ?? '') ?? fallbackAt,
    last: last ?? preClose,
    open: open ?? 0,
    high: num(record.fields[F.high]) ?? 0,
    low: num(record.fields[F.low]) ?? 0,
    preClose,
    volume: volume ?? 0,
    amount: num(record.fields[F.amount]) ?? 0,
    limitUp: limits.limitUp,
    limitDown: limits.limitDown,
    suspended: inferSuspended(preClose, open, volume),
  }
}

export function createSinaProvider(options: SinaOptions): QuoteProvider {
  const { http, now = () => Date.now() } = options

  return {
    id: ID,
    capabilities: CAPABILITIES,

    fetchDaily(_code: SecCode, _from: TradeDate, _to: TradeDate, _adjust: AdjustMode): Promise<Candle[]> {
      return Promise.reject(new UnsupportedCapabilityError(ID, '日线'))
    },

    async fetchSnapshots(codes: SecCode[]): Promise<Snapshot[]> {
      const usable = codes
        .map((code) => toLowerPrefixed(code))
        .filter((external): external is string => external !== null)
      if (usable.length === 0) return []

      const batches = await Promise.all(
        chunk(usable, SNAPSHOT_CHUNK).map(async (group) => {
          const { body } = await http.get(`${SNAPSHOT_URL}${group.join(',')}`, {
            encoding: 'gbk',
            headers: HEADERS,
          })
          const at = now()
          return splitQuoteRecords(body)
            .map((record) => toSnapshot(record, at))
            .filter((snapshot): snapshot is Snapshot => snapshot !== null)
        })
      )
      return batches.flat()
    },

    async fetchProfile(code: SecCode): Promise<SecProfile> {
      const external = toLowerPrefixed(code)
      const parsed = splitCode(code)
      if (!external || !parsed) throw new ProviderDataError(ID, `无法识别的代码：${code}`)

      const { body } = await http.get(`${SNAPSHOT_URL}${external}`, {
        encoding: 'gbk',
        headers: HEADERS,
      })
      const name = splitQuoteRecords(body)[0]?.fields[F.name]?.trim()
      if (!name) throw new ProviderDataError(ID, `${code} 没有取到名称`)

      const meta = classify(code, name)
      return { code, name, market: parsed.market, board: parsed.board, isST: meta?.isST ?? false }
    },
  }
}
