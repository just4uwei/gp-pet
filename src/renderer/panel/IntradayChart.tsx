/**
 * 当日分时走势图 —— 抽屉「行情」页那张带坐标轴的图。
 *
 * ## 两种来源，图上必须分得出来
 *
 * `IntradaySeries.source` 决定这张图能不能被当成分时看：
 *
 * - **`REMOTE`** —— 数据源的逐分钟分时，09:30 起覆盖全天。用户打开抽屉时拉一次
 *   （主进程侧带 30s 缓存，不进 tick 轮询）。这是默认路径。
 * - **`LOCAL`** —— 拉不到时退回本机留痕 `quote_tick`：覆盖范围 = 应用开着且取数成功的
 *   时段，粒度 30s。**它不是分时**，只是「本机观测到的那些点」。
 *
 * 底部文案因此必须分叉。**降级路径的那三句诚实话一个字都不能省** ——
 * 有坐标轴的图看起来很「正式」，一条半截曲线被当成全天的概率比想象中高。
 *
 * ## 三条诚实纪律（这张图能不能信，全在这三条上）
 *
 * 1. **相邻两点间隔超过 `GAP_MS` 就断线，绝不直连。** 一条规则同时暴露两种洞：
 *    午休（11:30–13:00，两种来源都没有点）和「应用当时没开着」（只有 LOCAL 会有）。
 *    直连出来的那条斜线看着像分时线，但那段时间里什么都没被观测到 ——
 *    而用户没有任何办法看出那是假的。
 * 2. **覆盖起点如实标注**（仅 LOCAL）。首个点明显晚于 09:30 时，图下方写一行
 *    「分时自 13:02 起在本机记录」。不写就等于宣称覆盖了全天。
 * 3. **一个点都没有时不画空坐标系**，直接说「今天还没有分时数据」。
 *    但**信号点照画** —— `priceAt` 是信号产生那一刻真实观测到的价，不是插值。
 *
 * ## 坐标轴上的四条
 *
 * - **x 轴由 `series.tradeDate` 推，不是由「今天」推。** 休市日打开抽屉时数据源给的是
 *   **上一个交易日**那条曲线，按今天画就是一条日期错位、图上却毫无破绽的假曲线。
 *   不是今天时底部文案要点名那一天。
 * - **右轴（涨跌幅 %）在 `preClose` 为 null 时整个不画。** 没有昨收就算不出百分比，
 *   **不许拿当日首个价顶替** —— 那会让涨跌幅永远从 0% 开始，看起来像今天没波动。
 * - **价格线不按涨跌上色**（中性白）。分时线画的是走势不是涨跌幅，
 *   着色会与 A 股「红涨绿跌」的口径打架 —— 一条从低点涨上来但仍低于昨收的线该是什么颜色？
 * - `preserveAspectRatio` 用默认值，**不要用 `none`**：非等比缩放会把信号点压成椭圆。
 */

import { useEffect, useState } from 'react'
import type { GatedDirection, SecCode } from '@core/types'
import type { IntradaySeries } from '@shared/ipc-types'

/** 相邻两点超过这个间隔就认为中间没有观测，断开折线 */
const GAP_MS = 5 * 60_000

/** 连续竞价的四个时刻，单位是「当天第几毫秒」。x 轴按墙上时间线性铺开，午休不压缩 */
const OPEN_MS = (9 * 60 + 30) * 60_000
const AM_CLOSE_MS = (11 * 60 + 30) * 60_000
const PM_OPEN_MS = 13 * 60 * 60_000
const CLOSE_MS = 15 * 60 * 60_000

/** viewBox。抽屉宽约 460px，这个比例下 1 单位 ≈ 1px */
const W = 430
const H = 190
/** 左边留给价格刻度，右边留给涨跌幅刻度，底部留给时间刻度 */
const PAD = { left: 40, right: 40, top: 10, bottom: 18 }
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }

/** 纵轴刻度条数（含首尾） */
const Y_TICKS = 5

/** 均价线。与日 K 图的 MA20 同色 —— 两张图上「那条黄线是均线」是同一个意思 */
const AVG_COLOR = '#fcd34d'

const MARK_COLOR: Record<GatedDirection, string> = {
  BUY: '#fda4af',
  SELL: '#fcd34d',
  REDUCE: '#fcd34d',
  NEXT_DAY_WATCH: 'rgba(255,255,255,0.55)',
  NONE: 'rgba(255,255,255,0.4)',
}

const MARK_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

export interface IntradayMark {
  id: string
  ts: number
  price: number
  direction: GatedDirection
}

/**
 * 分时的时刻一律按**北京时间**读写：交易时段是交易所的，不是本机时区的。
 * 机器设成别的时区时，用 `getHours()` 会让 09:30 那根竖线跑到曲线中间去。
 */
const CST_OFFSET_MS = 8 * 60 * 60_000

function hhmm(ms: number): string {
  const at = new Date(ms + CST_OFFSET_MS)
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD'（北京时间的那一天）→ 该日 00:00 的 epoch ms */
function dayStartOf(tradeDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - CST_OFFSET_MS
}

function mdText(tradeDate: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(tradeDate)
  return m ? `${Number(m[1])} 月 ${Number(m[2])} 日` : tradeDate
}

/** 价格刻度的小数位：低价股要两位，高价股一位就够，避免轴上挤成一团 */
function priceDigits(span: number): number {
  return span >= 20 ? 1 : 2
}

/**
 * 把一串点按 GAP_MS 切成若干段。每段至少 2 个点才画得成线。
 * `y` 为 null 的点（均价线预热不足）当成断点，**不连过去** —— 与日 K 图的 MA 同一条。
 */
function splitSegments(points: readonly { x: number; y: number | null; ts: number }[]) {
  const segments: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  let prevTs: number | null = null
  for (const point of points) {
    const broken = point.y === null || (prevTs !== null && point.ts - prevTs > GAP_MS)
    if (broken) {
      if (current.length > 1) segments.push(current)
      current = []
    }
    if (point.y !== null) current.push({ x: point.x, y: point.y })
    prevTs = point.ts
  }
  if (current.length > 1) segments.push(current)
  return segments
}

function polyline(segment: readonly { x: number; y: number }[]): string {
  return segment.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

export function IntradayChart({
  code,
  from,
  marks,
  onError,
}: {
  code: SecCode
  /** 当天 00:00。序列拿不到 `tradeDate` 时（一个点都没有）由它兜底推 x 轴 */
  from: number
  /** 该标的今日的信号点，直接来自 SignalRecord 的 createdAt / priceAt */
  marks: readonly IntradayMark[]
  onError: (message: string) => void
}): React.JSX.Element {
  const [series, setSeries] = useState<IntradaySeries | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.gp
      .invoke('quote:intraday', { code, from, to: from + CLOSE_MS })
      .then((result) => {
        if (!cancelled) setSeries(result)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [code, from, onError])

  if (loading) return <p className="py-6 text-center text-xs text-white/35">分时加载中…</p>

  const points = series?.points ?? []
  const preClose = series?.preClose ?? null
  const remote = series?.source === 'REMOTE'

  if (points.length === 0 && marks.length === 0) {
    return <p className="py-6 text-center text-xs text-white/35">今天还没有分时数据。</p>
  }

  // x 轴的那一天以序列为准。休市日数据源返回的是上一个交易日，按「今天」画会日期错位
  const dayStart = (series?.tradeDate === undefined || series.tradeDate === null
    ? null
    : dayStartOf(series.tradeDate)) ?? from
  const otherDay = series?.tradeDate != null && dayStart !== from ? series.tradeDate : null

  // 纵轴：分时 ∪ 均价 ∪ 信号价 ∪ 昨收。信号价必须算进来 —— 应用没开时产生的信号
  // 会落在分时序列的取值范围之外，只按序列缩放会把它画到框外
  const values = [...points.map((p) => p.last), ...marks.map((m) => m.price)]
  for (const point of points) {
    if (point.avg !== null) values.push(point.avg)
  }
  if (preClose !== null) values.push(preClose)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (!(hi > lo)) {
    // 全天一个价（停牌、一字板，或只有一个点）—— 给一条 ±0.5% 的假想带把线摆到中间。
    // 这不是伪造数据：线仍然是平的，只是不让它贴在框的边上
    const pad = Math.max(Math.abs(hi) * 0.005, 0.01)
    lo = hi - pad
    hi = hi + pad
  }
  const digits = priceDigits(hi - lo)

  const xOf = (ts: number): number => {
    const ratio = (ts - (dayStart + OPEN_MS)) / (CLOSE_MS - OPEN_MS)
    return PAD.left + Math.min(1, Math.max(0, ratio)) * PLOT.w
  }
  const yOf = (value: number): number => PAD.top + (1 - (value - lo) / (hi - lo)) * PLOT.h

  const priceSegments = splitSegments(
    points.map((p) => ({ x: xOf(p.ts), y: yOf(p.last), ts: p.ts }))
  )
  const avgSegments = splitSegments(
    points.map((p) => ({ x: xOf(p.ts), y: p.avg === null ? null : yOf(p.avg), ts: p.ts }))
  )
  const first = points[0]
  const coverageFrom = first && first.ts > dayStart + OPEN_MS + 60_000 ? first.ts : null

  const yTicks = Array.from({ length: Y_TICKS }, (_, i) => lo + ((hi - lo) * i) / (Y_TICKS - 1))
  const xTicks = [
    { at: OPEN_MS, label: '09:30' },
    { at: AM_CLOSE_MS, label: '11:30' },
    { at: PM_OPEN_MS, label: '13:00' },
    { at: CLOSE_MS, label: '15:00' },
  ]

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${code} 当日分时与信号点`}>
        {/* 横向网格 + 左轴价格 + 右轴涨跌幅 */}
        {yTicks.map((value) => {
          const y = yOf(value)
          return (
            <g key={value}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,0.07)"
                strokeWidth={1}
              />
              <text x={PAD.left - 4} y={y + 3} textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.35)">
                {value.toFixed(digits)}
              </text>
              {/* 右轴只在有昨收时才画 —— 没有基准就算不出百分比，不许拿首个价顶替 */}
              {preClose !== null && preClose > 0 ? (
                <text
                  x={W - PAD.right + 4}
                  y={y + 3}
                  fontSize={8}
                  fill={
                    value > preClose
                      ? 'rgba(253,164,175,0.55)'
                      : value < preClose
                        ? 'rgba(110,231,183,0.55)'
                        : 'rgba(255,255,255,0.3)'
                  }
                >
                  {(((value - preClose) / preClose) * 100).toFixed(2)}%
                </text>
              ) : null}
            </g>
          )
        })}

        {/* 时间刻度。午休两端各一条竖线，中间那段与「断线」一起说明那里没有交易 */}
        {xTicks.map((tick) => (
          <g key={tick.label}>
            <line
              x1={xOf(dayStart + tick.at)}
              x2={xOf(dayStart + tick.at)}
              y1={PAD.top}
              y2={PAD.top + PLOT.h}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
              {...(tick.at === AM_CLOSE_MS || tick.at === PM_OPEN_MS ? { strokeDasharray: '2 3' } : {})}
            />
            <text
              x={xOf(dayStart + tick.at)}
              y={H - 6}
              textAnchor={tick.at === OPEN_MS ? 'start' : tick.at === CLOSE_MS ? 'end' : 'middle'}
              fontSize={8}
              fill="rgba(255,255,255,0.35)"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* 昨收基准线 */}
        {preClose !== null ? (
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={yOf(preClose)}
            y2={yOf(preClose)}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
        ) : null}

        {/* 均价线画在价格线下面：两条重叠时该看清的是价格 */}
        {avgSegments.map((segment, i) => (
          <polyline
            key={`avg-${i}`}
            points={polyline(segment)}
            fill="none"
            stroke={AVG_COLOR}
            strokeWidth={1}
            opacity={0.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* 价格线。中性白，不按涨跌上色（见文件头） */}
        {priceSegments.map((segment, i) => (
          <polyline
            key={i}
            points={polyline(segment)}
            fill="none"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth={1.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {marks.map((mark) => (
          <circle
            key={mark.id}
            cx={xOf(mark.ts)}
            cy={yOf(mark.price)}
            r={3.5}
            fill={MARK_COLOR[mark.direction]}
            /* 描一圈卡片底色：两个信号挨得近时才分得开 */
            stroke="var(--gp-surface)"
            strokeWidth={1}
          >
            <title>{`${hhmm(mark.ts)} ${MARK_LABEL[mark.direction]} ${mark.price.toFixed(digits)}`}</title>
          </circle>
        ))}
      </svg>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] leading-snug text-white/30">
        {otherDay !== null ? (
          <span className="text-amber-200/60">今天休市，画的是 {mdText(otherDay)} 那一天。</span>
        ) : null}

        {remote ? (
          <>
            <span>逐分钟分时，覆盖全天</span>
            {avgSegments.length > 0 ? <span style={{ color: AVG_COLOR }}>— 均价</span> : null}
          </>
        ) : coverageFrom !== null ? (
          <span className="text-amber-200/60">
            拉不到分时，图上是本机自 {hhmm(coverageFrom)} 起记下的观测点，之前那段没有数据。
          </span>
        ) : points.length === 0 ? (
          <span className="text-amber-200/60">今天没记到分时，图上只有信号点。</span>
        ) : (
          <span className="text-amber-200/60">
            拉不到分时，图上是本机记下的观测点（30s 一个），线在缺口处断开。
          </span>
        )}

        {preClose === null ? <span>拿不到昨收，未画涨跌幅刻度。</span> : null}
      </p>
    </div>
  )
}
