/**
 * 当日分时走势图 —— 信号抽屉里那张带坐标轴的图。
 *
 * ## 这张图能画到什么程度，取决于数据是怎么来的
 *
 * 数据源是 `quote_tick`（004_quote_tick.sql）：盘中每轮 tick 顺手把**已经拿到的**
 * 快照落一行。所以它**不是完整分时** —— 覆盖范围 = 应用开着且取数成功的时段。
 * 用户下午一点才开机，上午就是空的。
 *
 * ## 三条诚实纪律（这张图能不能信，全在这三条上）
 *
 * 1. **相邻两点间隔超过 `GAP_MS` 就断线，绝不直连。** 一条规则同时暴露两种洞：
 *    午休（11:30–13:00）和「应用当时没开着」。直连出来的那条斜线看着像分时线，
 *    但那段时间里什么都没被观测到 —— 而用户没有任何办法看出那是假的。
 *    **加了坐标轴之后这一条尤其要守住**：有轴的图看起来更「正式」，
 *    一条假的连线骗到人的概率更高。
 * 2. **覆盖起点如实标注。** 首个点明显晚于 09:30 时，图下方写一行
 *    「分时自 13:02 起在本机记录」。不写就等于宣称覆盖了全天。
 * 3. **一个点都没有时不画空坐标系**，直接说「今天还没记到分时数据」。
 *    但**信号点照画** —— `priceAt` 是信号产生那一刻真实观测到的价，不是插值。
 *
 * ## 坐标轴上的三条
 *
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

function hhmm(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** 价格刻度的小数位：低价股要两位，高价股一位就够，避免轴上挤成一团 */
function priceDigits(span: number): number {
  return span >= 20 ? 1 : 2
}

/** 把一串点按 GAP_MS 切成若干段。每段至少 2 个点才画得成线 */
function splitSegments(points: readonly { x: number; y: number; ts: number }[]) {
  const segments: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  let prevTs: number | null = null
  for (const point of points) {
    if (prevTs !== null && point.ts - prevTs > GAP_MS) {
      if (current.length > 1) segments.push(current)
      current = []
    }
    current.push({ x: point.x, y: point.y })
    prevTs = point.ts
  }
  if (current.length > 1) segments.push(current)
  return segments
}

export function IntradayChart({
  code,
  from,
  marks,
  onError,
}: {
  code: SecCode
  /** 当天 00:00。x 轴由它推出 09:30–15:00 两端 */
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

  if (points.length === 0 && marks.length === 0) {
    return <p className="py-6 text-center text-xs text-white/35">今天还没记到分时数据。</p>
  }

  // 纵轴：分时 ∪ 信号价 ∪ 昨收。信号价必须算进来 —— 应用没开时产生的信号
  // 会落在分时序列的取值范围之外，只按序列缩放会把它画到框外
  const values = [...points.map((p) => p.last), ...marks.map((m) => m.price)]
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
    const ratio = (ts - (from + OPEN_MS)) / (CLOSE_MS - OPEN_MS)
    return PAD.left + Math.min(1, Math.max(0, ratio)) * PLOT.w
  }
  const yOf = (value: number): number => PAD.top + (1 - (value - lo) / (hi - lo)) * PLOT.h

  const segments = splitSegments(points.map((p) => ({ x: xOf(p.ts), y: yOf(p.last), ts: p.ts })))
  const first = points[0]
  const coverageFrom = first && first.ts > from + OPEN_MS + 60_000 ? first.ts : null

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
              x1={xOf(from + tick.at)}
              x2={xOf(from + tick.at)}
              y1={PAD.top}
              y2={PAD.top + PLOT.h}
              stroke="rgba(255,255,255,0.07)"
              strokeWidth={1}
              {...(tick.at === AM_CLOSE_MS || tick.at === PM_OPEN_MS ? { strokeDasharray: '2 3' } : {})}
            />
            <text
              x={xOf(from + tick.at)}
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

        {/* 价格线。中性白，不按涨跌上色（见文件头） */}
        {segments.map((segment, i) => (
          <polyline
            key={i}
            points={segment.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
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

      <p className="mt-1 text-[10px] leading-snug text-white/30">
        {coverageFrom !== null ? (
          <span className="text-amber-200/60">
            分时自 {hhmm(coverageFrom)} 起在本机记录，之前那段没有数据。
          </span>
        ) : points.length === 0 ? (
          <span className="text-amber-200/60">今天没记到分时，图上只有信号点。</span>
        ) : (
          <span>线在缺口处断开（午休，或应用当时没开着）。</span>
        )}
        {preClose === null ? ' 拿不到昨收，未画涨跌幅刻度。' : null}
      </p>
    </div>
  )
}
