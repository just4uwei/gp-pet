/**
 * 日 K 图（抽屉「行情」页）。60 根蜡烛 + MA20 / MA60 + 成交量。
 *
 * ## 价格是不复权的，这有代价，别在图上抹平
 *
 * 价格轴要与用户的成交价、持仓成本、券商 App 上的数字对得上（docs/03 §2.3），
 * 所以画的是**不复权**价。代价是**除权日会跳空**，两条 MA 也跟着跳 ——
 * 那是真的，如实呈现，不做接续。图下方那行小字就是为了说这件事。
 *
 * 由此：**这两条 MA 不是引擎用的那两条**（引擎一律用前复权）。
 * 看到图上 MA20 与信号里的 ma20 对不上时，先想起这一条，别去查指标实现。
 *
 * ## 画法约定（与 IntradayChart 同一套）
 *
 * - 等比 viewBox，`preserveAspectRatio` 用默认值 —— 用 `none` 会把蜡烛压变形。
 * - 预热不足的 MA 是 null，**不画**，不是画成 0（约束 4）。
 * - 红涨绿跌（A 股口径）：收 ≥ 开为红，收 < 开为绿。
 */

import { useEffect, useState } from 'react'
import type { SecCode } from '@core/types'
import type { DailyBar } from '@shared/ipc-types'

const BARS = 60

/** 抽屉宽约 460px，图区约 430；主图与量图 3:1 */
const W = 430
const H = 210
const PAD = { left: 38, right: 8, top: 8, bottom: 16 }
/** 量图高度（含它与主图之间的间隙） */
const VOL_H = 42
const MAIN_H = H - PAD.top - PAD.bottom - VOL_H

const UP = '#fb7185'
const DOWN = '#34d399'
const MA20 = '#fcd34d'
const MA60 = '#60a5fa'

function priceDigits(span: number): number {
  return span >= 20 ? 1 : 2
}

/** 成交量的人话。A 股一手 100 股，随手换算成「万手」比 12,345,600 好读 */
function volumeText(shares: number): string {
  const lots = shares / 100
  if (lots >= 10_000) return `${(lots / 10_000).toFixed(1)}万手`
  return `${Math.round(lots)}手`
}

function mdText(date: string): string {
  return date.slice(5)
}

export function DailyChart({
  code,
  onError,
}: {
  code: SecCode
  onError: (message: string) => void
}): React.JSX.Element {
  const [bars, setBars] = useState<DailyBar[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setBars(null)
    void window.gp
      .invoke('kline:daily', { code, limit: BARS })
      .then((rows) => {
        if (!cancelled) setBars(rows)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error))
        if (!cancelled) setBars([])
      })
    return () => {
      cancelled = true
    }
  }, [code, onError])

  if (bars === null) return <p className="py-8 text-center text-xs text-white/35">日线加载中…</p>
  if (bars.length === 0) {
    return (
      <p className="py-8 text-center text-xs leading-relaxed text-white/35">
        还没有这只票的日线。
        <br />
        引擎会在下一轮取数时补齐，稍后再看。
      </p>
    )
  }

  // 纵轴把两条 MA 一起算进去：只按 K 线取范围的话，MA60 在趋势段会跑到框外
  const values: number[] = []
  for (const bar of bars) {
    values.push(bar.high, bar.low)
    if (bar.ma20 !== null) values.push(bar.ma20)
    if (bar.ma60 !== null) values.push(bar.ma60)
  }
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (!(hi > lo)) {
    const pad = Math.max(Math.abs(hi) * 0.005, 0.01)
    lo = hi - pad
    hi = hi + pad
  }
  const digits = priceDigits(hi - lo)
  const maxVolume = Math.max(...bars.map((b) => b.volume), 1)

  const slot = (W - PAD.left - PAD.right) / bars.length
  /** 蜡烛实体宽：留一点缝，太挤时至少保证 1px */
  const body = Math.max(1, slot * 0.62)
  const xOf = (i: number): number => PAD.left + slot * (i + 0.5)
  const yOf = (value: number): number => PAD.top + (1 - (value - lo) / (hi - lo)) * MAIN_H
  const volTop = PAD.top + MAIN_H + 12
  const volY = (v: number): number => volTop + (1 - v / maxVolume) * (VOL_H - 12)

  const line = (pick: (bar: DailyBar) => number | null): string[] => {
    const segments: string[] = []
    let current: string[] = []
    bars.forEach((bar, i) => {
      const value = pick(bar)
      // 预热不足的那几根断开，**不要连过去** —— 连线等于凭空补出一段不存在的均线
      if (value === null) {
        if (current.length > 1) segments.push(current.join(' '))
        current = []
        return
      }
      current.push(`${xOf(i).toFixed(1)},${yOf(value).toFixed(1)}`)
    })
    if (current.length > 1) segments.push(current.join(' '))
    return segments
  }

  const yTicks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3)
  const last = bars[bars.length - 1]

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${code} 日 K`}>
        {yTicks.map((value) => (
          <g key={value}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yOf(value)}
              y2={yOf(value)}
              stroke="rgba(255,255,255,0.07)"
            />
            <text
              x={PAD.left - 4}
              y={yOf(value) + 3}
              textAnchor="end"
              fontSize={8}
              fill="rgba(255,255,255,0.35)"
            >
              {value.toFixed(digits)}
            </text>
          </g>
        ))}

        {bars.map((bar, i) => {
          const up = bar.close >= bar.open
          const color = up ? UP : DOWN
          const top = yOf(Math.max(bar.open, bar.close))
          const bottom = yOf(Math.min(bar.open, bar.close))
          return (
            <g key={bar.date}>
              <line
                x1={xOf(i)}
                x2={xOf(i)}
                y1={yOf(bar.high)}
                y2={yOf(bar.low)}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={xOf(i) - body / 2}
                y={top}
                width={body}
                /* 一字板（开 = 收）也要有 1px，否则那根 K 线整个消失 */
                height={Math.max(1, bottom - top)}
                fill={color}
              />
              <rect
                x={xOf(i) - body / 2}
                y={volY(bar.volume)}
                width={body}
                height={Math.max(1, volTop + (VOL_H - 12) - volY(bar.volume))}
                fill={color}
                opacity={0.5}
              />
              <title>
                {`${bar.date} 开${bar.open.toFixed(digits)} 高${bar.high.toFixed(digits)} ` +
                  `低${bar.low.toFixed(digits)} 收${bar.close.toFixed(digits)} 量${volumeText(bar.volume)}`}
              </title>
            </g>
          )
        })}

        {line((bar) => bar.ma20).map((points, i) => (
          <polyline key={`ma20-${i}`} points={points} fill="none" stroke={MA20} strokeWidth={1} opacity={0.75} />
        ))}
        {line((bar) => bar.ma60).map((points, i) => (
          <polyline key={`ma60-${i}`} points={points} fill="none" stroke={MA60} strokeWidth={1} opacity={0.75} />
        ))}

        <text x={PAD.left} y={H - 4} fontSize={8} fill="rgba(255,255,255,0.35)">
          {mdText(bars[0]?.date ?? '')}
        </text>
        <text x={W - PAD.right} y={H - 4} textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.35)">
          {mdText(last?.date ?? '')}
        </text>
      </svg>

      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] leading-snug text-white/30">
        <span>近 {bars.length} 个交易日</span>
        <span style={{ color: MA20 }}>— MA20</span>
        <span style={{ color: MA60 }}>— MA60</span>
        <span className="text-white/25">
          价格与均线都是<span className="text-white/45">不复权</span>的（与你的成本价同一口径），
          除权日会跳空 —— 这两条均线不是引擎用的那两条。
        </span>
      </p>
    </div>
  )
}
