/**
 * 气泡内容（docs/05 §5 的四段结构 + 措辞纪律）。
 *
 * ```
 * [方向徽章] 名称 代码            置信 78%
 * 金叉突破 · 趋势市
 * MA5上穿MA20 / MACD零轴上金叉 / 放量1.4倍
 * 14:32  现价 12.34 (+2.1%)
 * ```
 *
 * ## 四条纪律
 *
 * 1. **不可点击**（docs/06 §2.3）：主进程侧 `setIgnoreMouseEvents(true)` 常开，
 *    这里连一个按钮都不放 —— 放了也点不到，只会让人以为坏了。
 * 2. **6s 后自己淡出**（C6）：淡出由这里做，`hide()` 由主进程在动画结束后补一刀。
 *    两边都做是有意的：窗口 hide 得比动画早会看到硬切，晚了则透明窗口白挂着。
 * 3. **卖出/减仓用暖橙不用红**：A 股红涨绿跌，红色作警示会与涨跌色打架（docs/05 §5）。
 * 4. **底部固定「仅供参考，非投资建议」**，且不出现「胜率」「必涨」一类措辞（CLAUDE.md）。
 */

import { useEffect, useRef, useState } from 'react'
import type { AlertPayload } from '@shared/ipc-types'
import { shanghaiHhmm } from '@shared/time'
import type { GatedDirection } from '@core/types'

/** 与主进程 BubbleWindow.AUTO_HIDE_MS 一致；改一处要改两处，所以两边都写了注释 */
const AUTO_HIDE_MS = 6_000

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

const DIRECTION_CLASS: Record<GatedDirection, string> = {
  BUY: 'badge--buy',
  SELL: 'badge--sell',
  REDUCE: 'badge--sell',
  NEXT_DAY_WATCH: 'badge--watch',
  NONE: 'badge--watch',
}

/**
 * 北京时间（`shared/time.ts`）。同一条提醒在气泡、提醒日志、日报三处必须是同一个时刻 ——
 * `getHours()` 会按宿主时区偏（本机 UTC+7 上少一小时）。
 */
const timeOf = shanghaiHhmm

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function changeClass(value: number): string {
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}

export function App(): React.JSX.Element | null {
  const [alert, setAlert] = useState<AlertPayload | null>(null)
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    const off = window.gp.on('push:alert', (payload) => {
      setAlert(payload)
      setVisible(true)
      // 新气泡替换旧的并重置计时，不排队（排队 = 让用户看一串过时的提醒轮播）
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setVisible(false)
      }, AUTO_HIDE_MS)
    })
    return () => {
      off()
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  if (!alert) return null

  return (
    <div className={`bubble${visible ? ' bubble--in' : ''}`}>
      <div className="row row--head">
        <span className={`badge ${DIRECTION_CLASS[alert.direction]}`}>
          {DIRECTION_LABEL[alert.direction]}
        </span>
        <span className="name">{alert.name}</span>
        <span className="code">{alert.code}</span>
        {/* 「置信」二字是有意的：不得写成胜率或概率（docs/04 §4.3） */}
        <span className="score">置信 {Math.round(alert.score * 100)}%</span>
      </div>

      <div className="row headline">{alert.headline}</div>

      <div className="row reasons">{alert.reasons.join(' / ')}</div>

      <div className="row row--foot">
        <span>{timeOf(alert.at)}</span>
        <span>
          现价 {alert.price.toFixed(2)}{' '}
          <span className={changeClass(alert.changePct)}>({signed(alert.changePct)})</span>
        </span>
        <span className="disclaimer">仅供参考，非投资建议</span>
      </div>
    </div>
  )
}
