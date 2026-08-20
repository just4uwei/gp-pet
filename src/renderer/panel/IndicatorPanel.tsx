/**
 * 「当前指标」—— 抽屉「行情」页两张图下面那一块。
 *
 * ## 它与行情软件的指标栏差在哪（这是它存在的理由）
 *
 * 行情软件给你一排数字。这里每个数字都带三样东西：
 * **定义**（这个数怎么算的）· **口径差异**（与通达信/东财对不上的地方）·
 * **标定状态**（相关阈值有没有本地依据）。
 *
 * ## 三条文案纪律（与 `shared/indicator-catalog.ts` 同一条，这里是执行侧）
 *
 * 1. **不写投资含义。** 没有「金叉看涨」「超卖反弹」这类话 ——
 *    2026-08-20 实测买入得分与前瞻收益的横截面秩相关是**负的**（M2 §5.46），
 *    在界面上写那种常识等于把一个已被本地数据否掉的说法印出来。
 * 2. **得分不叫「概率」也不叫「胜率」**（措辞纪律）。它就是组合层的买入得分 0..1。
 * 3. **盘中要显示「未定稿」**：临时线上的指标会抖，收盘确认轮才定论。
 *    这与日报 `stage` 是同一条纪律。
 *
 * ## 取数
 *
 * `indicators:current` 只在**用户点开这一页时**调一次（换票会重取），
 * 且它**不发网络请求** —— 主进程就地评估一次本地日线。
 * 所以它不占 docs/03 §2.4 的轮询预算，与 `quote:intraday` 那条不同。
 */

import { useCallback, useEffect, useState } from 'react'
import type { Regime } from '@core/types'
import type { IndicatorSnapshotView, ParamRow } from '@shared/ipc-types'
import {
  INDICATOR_CATALOG,
  INDICATOR_GROUP_LABEL,
  type IndicatorGroup,
  type IndicatorMeta,
} from '@shared/indicator-catalog'

/** 与 SignalList 的那份同一套 ID —— 两处都要改的话，说明该挪进 shared 了 */
const SUB_SIGNAL_LABEL: Record<string, string> = {
  T1_MA_CROSS: '均线交叉',
  T2_MACD_ZERO_CROSS: 'MACD 零轴交叉',
  T3_BREAKOUT: '轨道突破',
  T4_ALIGNMENT: '均线排列',
  T5_PULLBACK_HOLD: '回踩中轨',
  R1_RSI_BAND: 'RSI 极值触轨',
  R2_REVERT_TO_MID: '回归中轨',
  R3_SQUEEZE: '带宽压缩触轨',
  R4_MID_REVERSION: '中轨超调',
  M1_WEEK_MACD_DAY_RSI: '周线拐头共振',
  M2_WEEK_ADX_CONFIRM: '周线趋势确认',
  M3_FALSE_BREAKOUT: '周线无趋势，突破存疑',
}

const REGIME_LABEL: Record<Regime, string> = {
  TREND_UP: '上升趋势',
  TREND_DOWN: '下降趋势',
  RANGE: '震荡',
  TRANSITION: '过渡',
}

/** 与设置页那份保持一致；两处不一致会让同一个状态看起来是两回事 */
const STATUS_LABEL: Record<ParamRow['status'], { text: string; cls: string }> = {
  CALIBRATED: { text: '已标定', cls: 'bg-emerald-500/15 text-emerald-300' },
  KEPT: { text: '已测·保持', cls: 'bg-sky-500/15 text-sky-300' },
  INERT: { text: '惰性', cls: 'bg-white/10 text-white/40' },
  UNTESTABLE: { text: '回测测不到', cls: 'bg-violet-500/15 text-violet-300' },
  BLOCKED: { text: '已测·无结论', cls: 'bg-orange-500/15 text-orange-300' },
  GUESS: { text: '未测', cls: 'bg-amber-500/15 text-amber-300' },
}

const GROUP_ORDER: IndicatorGroup[] = ['TREND', 'MOMENTUM', 'VOLATILITY', 'VOLUME', 'THRESHOLD']

function valueText(value: number | null | undefined, meta: IndicatorMeta): string {
  // null 是「未预热 / 算不出」，显示成 — 而不是 0（约束 4 的展示层版本）
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(meta.digits)}${meta.unit ?? ''}`
}

function Row({
  meta,
  value,
  params,
  open,
  onToggle,
}: {
  meta: IndicatorMeta
  value: number | null | undefined
  params: IndicatorSnapshotView['params']
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const related = (meta.paramPaths ?? [])
    .map((path) => params.find((p) => p.path === path))
    .filter((p): p is IndicatorSnapshotView['params'][number] => p !== undefined)

  return (
    <li className="border-b border-white/5 last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 py-1 text-left hover:bg-white/5"
        aria-expanded={open}
      >
        <span className="w-4 shrink-0 text-white/25">{open ? '−' : '+'}</span>
        <span className="flex-1 text-white/70">{meta.label}</span>
        <span className="font-mono text-white/85">{valueText(value, meta)}</span>
      </button>

      {open ? (
        <div className="space-y-1.5 pb-2 pl-6 pr-1 text-[11px] leading-relaxed text-white/55">
          <p>{meta.definition}</p>
          {meta.caveat === undefined ? null : <p className="text-amber-200/70">{meta.caveat}</p>}
          {meta.usedBy === undefined ? null : (
            <p className="text-white/45">
              用在：{meta.usedBy.map((id) => SUB_SIGNAL_LABEL[id] ?? id).join(' · ')}
            </p>
          )}
          {related.length > 0 ? (
            <div className="space-y-0.5">
              {related.map((p) => (
                <div key={p.path} className="flex items-baseline gap-2">
                  <span className="font-mono text-white/45">{p.path}</span>
                  <span className="font-mono text-white/70">{p.value}</span>
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${STATUS_LABEL[p.status].cls}`}>
                    {STATUS_LABEL[p.status].text}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export function IndicatorPanel({ code }: { code: string }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<IndicatorSnapshotView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.gp
      .invoke('indicators:current', code)
      .then((data) => setSnapshot(data as IndicatorSnapshotView))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [code])

  useEffect(() => {
    setSnapshot(null)
    setOpenKey(null)
    load()
  }, [load])

  if (error !== null) {
    // 「算不出」要说清是算不出，不显示一屏 0
    return <p className="text-[11px] text-amber-200/70">指标取不到：{error}</p>
  }
  if (snapshot === null) return <p className="text-[11px] text-white/35">读取中…</p>

  const provisional = snapshot.stage === 'PROVISIONAL'

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-2 text-[11px]">
        <span className="text-white/45">{snapshot.date}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            provisional ? 'bg-amber-500/15 text-amber-300' : 'bg-white/10 text-white/50'
          }`}
        >
          {provisional ? '盘中未定稿' : '收盘定稿'}
        </span>
        <span className="text-white/45">
          市场状态 <span className="text-white/70">{REGIME_LABEL[snapshot.regime]}</span>
        </span>
        <span className="text-white/45">
          买入得分{' '}
          <span className="font-mono text-white/70">
            {snapshot.buyScore === null ? '—' : snapshot.buyScore.toFixed(2)}
          </span>
        </span>
      </div>

      {provisional ? (
        <p className="text-[11px] text-amber-200/60">
          盘中用的是当日临时 K 线，指标会随价格变动 —— 收盘确认轮才定论。
        </p>
      ) : null}

      {GROUP_ORDER.map((group) => {
        const metas = INDICATOR_CATALOG.filter((m) => m.group === group)
        if (metas.length === 0) return null
        return (
          <section key={group}>
            <h4 className="mb-0.5 text-[11px] text-white/40">{INDICATOR_GROUP_LABEL[group]}</h4>
            <ul className="rounded border border-white/10 bg-black/20 px-2">
              {metas.map((meta) => (
                <Row
                  key={meta.key}
                  meta={meta}
                  value={snapshot.values[meta.key]}
                  params={snapshot.params}
                  open={openKey === meta.key}
                  onToggle={() => setOpenKey(openKey === meta.key ? null : meta.key)}
                />
              ))}
            </ul>
          </section>
        )
      })}

      {/*
        这两句是固定 DOM 而不是提示词/文案变量：
        ① 指标只描述行情，不构成建议 —— 与「AI 解读」那两行免责同一处置；
        ② 阈值的标定状态是这一屏的重点，别让人以为这些数经过验证（ADR-0003）。
      */}
      <p className="pt-1 text-[10px] leading-relaxed text-white/30">
        指标只描述已发生的行情，不预测涨跌、不构成投资建议。展开每项可看它的定义、
        与常见行情软件的口径差异，以及相关阈值的标定状态 ——
        标「未测 / 已测·无结论」的阈值**没有**本项目回测支持的依据。
      </p>
    </div>
  )
}
