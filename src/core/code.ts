/**
 * 证券代码规范化与价格档位规则（docs/03 §5）。
 *
 * 内部形态只有一种：`SH600000` / `SZ000001` / `BJ430047`。
 * 各 provider 在自己的适配层转成外部形态（`sh600000`、`1.600000`…），上层永远只见内部形态。
 *
 * 涨跌停价放在这里而不是交给数据源：免费源对涨跌停的支持参差不齐
 * （录制的 fixture 里北交所直接返回 -1），而板块比例是公开的规则，本地算比取数更可靠。
 */

import type { Board, Market, SecCode } from './types'

export interface ParsedCode {
  code: SecCode
  market: Market
  board: Board
  /** 六位数字本体 */
  digits: string
}

export type CodeParseResult = { ok: true; value: ParsedCode } | { ok: false; reason: string }

/**
 * 各市场的代码段 → 板块。按前缀长度从长到短匹配。
 *
 * 920 段（北交所自 2023 年起启用）不在 docs/03 §5 的表里，是按真实市场规则补的；
 * 表已同步更新，见该节的脚注。
 */
const SEGMENTS: Record<Market, readonly (readonly [string, Board])[]> = {
  SH: [
    ['600', 'MAIN'],
    ['601', 'MAIN'],
    ['603', 'MAIN'],
    ['605', 'MAIN'],
    ['688', 'STAR'],
    ['51', 'ETF'],
    ['56', 'ETF'],
    ['58', 'ETF'],
    ['000', 'INDEX'],
  ],
  SZ: [
    ['000', 'MAIN'],
    ['001', 'MAIN'],
    ['002', 'MAIN'],
    ['003', 'MAIN'],
    ['300', 'GEM'],
    ['301', 'GEM'],
    ['399', 'INDEX'],
    ['15', 'ETF'],
    ['16', 'ETF'],
  ],
  BJ: [
    ['430', 'BSE'],
    ['920', 'BSE'],
    ['83', 'BSE'],
    ['87', 'BSE'],
    ['88', 'BSE'],
  ],
}

const MARKETS: readonly Market[] = ['SH', 'SZ', 'BJ']

function boardIn(market: Market, digits: string): Board | null {
  for (const [prefix, board] of SEGMENTS[market]) {
    if (digits.startsWith(prefix)) return board
  }
  return null
}

/**
 * 接受 `600000` / `sh600000` / `SH600000` / `600000.SH` / `600000.sh`（含首尾空白）。
 *
 * 拒绝而不猜的两种情况（docs/03 §5「歧义直接拒绝并提示」）：
 *   - 显式市场与代码段不符（`SZ600000`）
 *   - 无前缀且落在多个市场都成立的段上
 * 指数代码（SH000300 / SZ399300）必须带显式市场：裸 `000300` 按表推断是深市主板，
 * 强行猜指数会让「上证指数」和「深市个股」互相污染。
 */
export function parseCode(input: string): CodeParseResult {
  const raw = input.trim().toUpperCase().replace(/\s+/g, '')
  if (raw.length === 0) return { ok: false, reason: '代码为空' }

  // 数字位数放宽到 1..10 是为了把「位数不对」和「格式不认识」区分成两条不同的提示
  const m = /^(?:(SH|SZ|BJ)\.?)?(\d{1,10})(?:\.(SH|SZ|BJ))?$/.exec(raw)
  if (!m) return { ok: false, reason: `无法识别的代码格式：${input.trim()}` }

  const prefix = m[1]
  const digits = m[2] ?? ''
  const suffix = m[3]
  if (prefix && suffix && prefix !== suffix) {
    return { ok: false, reason: `代码两侧的市场标识冲突：${input.trim()}` }
  }
  if (digits.length !== 6) {
    return { ok: false, reason: `代码必须是 6 位数字，收到 ${digits.length} 位：${input.trim()}` }
  }

  const explicit = (prefix ?? suffix) as Market | undefined
  if (explicit) {
    const board = boardIn(explicit, digits)
    if (!board) return { ok: false, reason: `${explicit} 市场没有 ${digits} 这个代码段` }
    return { ok: true, value: { code: `${explicit}${digits}`, market: explicit, board, digits } }
  }

  // 指数段排除在推断之外 —— 它们只能靠显式市场消歧
  const hits = MARKETS.map((market) => ({ market, board: boardIn(market, digits) })).filter(
    (h): h is { market: Market; board: Board } => h.board !== null && h.board !== 'INDEX'
  )
  const first = hits[0]
  if (!first) return { ok: false, reason: `无法判断 ${digits} 属于哪个市场，请带上 SH/SZ/BJ 前缀` }
  if (hits.length > 1) {
    return { ok: false, reason: `${digits} 在 ${hits.map((h) => h.market).join('/')} 均成立，请带上市场前缀` }
  }
  return {
    ok: true,
    value: { code: `${first.market}${digits}`, market: first.market, board: first.board, digits },
  }
}

/** 校验失败即抛错，错误消息可直接展示给用户。宽容路径用 parseCode。 */
export function normalizeCode(input: string): SecCode {
  const result = parseCode(input)
  if (!result.ok) throw new Error(result.reason)
  return result.value.code
}

/** 已是内部形态时的快速拆解；非法返回 null。 */
export function splitCode(code: SecCode): ParsedCode | null {
  const result = parseCode(code)
  return result.ok ? result.value : null
}

// ─────────────────────────── 价格档位与涨跌停 ───────────────────────────

/** 报价最小变动的小数位数：基金 3 位，股票 2 位。 */
export function priceDigits(board: Board): number {
  return board === 'ETF' ? 3 : 2
}

/** 四舍五入到板块对应的价格档位。+EPSILON 是为了让 9.29×1.1 = 10.219000000000001 落回 10.22。 */
export function roundToTick(price: number, board: Board): number {
  const factor = 10 ** priceDigits(board)
  return Math.round((price + Number.EPSILON) * factor) / factor
}

/**
 * 涨跌幅比例。主板 ST 为 ±5%；创业板/科创板即便是 ST 仍为 ±20%，故只对 MAIN 特殊处理。
 * INDEX 无涨跌停。
 */
export function priceLimitRatio(board: Board, isST: boolean): number | null {
  switch (board) {
    case 'MAIN':
      return isST ? 0.05 : 0.1
    case 'ETF':
      return 0.1
    case 'GEM':
    case 'STAR':
      return 0.2
    case 'BSE':
      return 0.3
    case 'INDEX':
      return null
  }
}

/**
 * 由昨收算涨跌停价。
 *
 * 不适用的两种情形返回 null，由调用方决定如何展示 —— 不要用 0 兜底：
 * 0 会让「跌停价」判定永真，这类静默错误比缺值危险得多。
 *   - 指数
 *   - 上市首日 / 无昨收（新股首日不设涨跌幅限制）
 */
export function priceLimits(
  preClose: number,
  board: Board,
  isST: boolean
): { limitUp: number; limitDown: number } | null {
  const ratio = priceLimitRatio(board, isST)
  if (ratio === null || !Number.isFinite(preClose) || preClose <= 0) return null
  return {
    limitUp: roundToTick(preClose * (1 + ratio), board),
    limitDown: roundToTick(preClose * (1 - ratio), board),
  }
}

/** 名称里带 ST / *ST 即视为风险警示股。数据源不单独给这个标志，只能从名称判。 */
export function isSTName(name: string): boolean {
  return /ST/i.test(name)
}
