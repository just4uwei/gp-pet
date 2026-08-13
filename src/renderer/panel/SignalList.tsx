/**
 * 「今日信号」列表 + 依据展开（docs/08 M2 最后一项、docs/05 §5/§6）。
 *
 * 四条克制，评审时按这四条看：
 *
 * 1. **置信度不叫「胜率」也不叫「概率」**（docs/04 §4.3）。它是规则一致性的度量。
 * 2. **被静默的信号也列出来，并写明原因**（docs/05 §4）—— 不制造信息黑洞。
 *    用户要能回答「它是不是漏提醒了」。
 * 3. **卖出用暖橙不用红**：A 股红涨绿跌，红色作警示会与涨跌色打架（docs/05 §5）。
 * 4. **没有数字就显示「—」**，不用 0 占位。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AlertLevel, GatedDirection, Regime, SecCode } from '@core/types'
import type { SignalEvidence, SignalRecord } from '@shared/ipc-types'

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

/** 卖出/减仓一律暖橙；买入用红（A 股红涨）；观察类中性 */
const DIRECTION_TONE: Record<GatedDirection, string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  REDUCE: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  NEXT_DAY_WATCH: 'border-white/20 bg-white/5 text-white/70',
  NONE: 'border-white/15 bg-white/5 text-white/50',
}

const REGIME_LABEL: Record<Regime, string> = {
  TREND_UP: '上升趋势',
  TREND_DOWN: '下跌趋势',
  RANGE: '震荡市',
  TRANSITION: '转换期',
}

const LEVEL_LABEL: Record<AlertLevel, string> = {
  L1: '静默',
  L2: '气泡',
  L3: '通知',
}

const STAGE_LABEL: Record<SignalRecord['stage'], string> = {
  PROVISIONAL: '盘中临时',
  CONFIRMED: '收盘确认',
  INVALIDATED: '收盘失效',
}

/** 子信号 ID → 中文标签。与 core/risk/text.ts 同一份措辞，只是这里要展开全部而非前 3 条 */
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

function timeOf(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function numberText(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function Evidence({ evidence }: { evidence: SignalEvidence }): React.JSX.Element {
  const indicators = Object.entries(evidence.indicatorsAt).filter(([, v]) => v !== null)
  return (
    <div className="mt-2 space-y-2 rounded border border-white/10 bg-black/20 p-2 text-xs">
      <div>
        <div className="text-white/40">子信号</div>
        {evidence.subSignals.length === 0 ? (
          <div className="text-white/35">无 —— 该条记录由风控规则产生，不来自策略得分</div>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {evidence.subSignals.map((sub, i) => (
              <li key={`${sub.id}-${i}`} className="flex items-baseline gap-2">
                <span className={sub.direction === 'SELL' ? 'text-amber-200/80' : 'text-rose-200/80'}>
                  {sub.direction === 'SELL' ? '卖' : '买'}
                </span>
                <span className="flex-1">{SUB_SIGNAL_LABEL[sub.id] ?? sub.id}</span>
                <span className="font-mono text-white/45">
                  强度 {numberText(sub.score)} × 权重 {numberText(sub.weight)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {evidence.adjustments.length > 0 ? (
        <div>
          <div className="text-white/40">多周期调整</div>
          <ul className="mt-1 space-y-0.5">
            {evidence.adjustments.map((adjustment, i) => (
              <li key={`${adjustment.id}-${i}`} className="flex items-baseline gap-2">
                <span className="flex-1">{SUB_SIGNAL_LABEL[adjustment.id] ?? adjustment.id}</span>
                <span className={`font-mono ${adjustment.delta < 0 ? 'text-amber-200/80' : 'text-white/60'}`}>
                  {adjustment.delta > 0 ? '+' : ''}
                  {numberText(adjustment.delta)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-white/40">触发时的指标值</div>
        {/* 固定两列：右栏只有 ~330px 宽，三列会让指标名与数值挤成一团 */}
        <div className="mt-1 grid grid-cols-2 gap-x-4 font-mono text-white/55">
          {indicators.map(([key, value]) => (
            <span key={key}>
              {key} {numberText(value)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function SignalRow({
  record,
  expanded,
  evidence,
  onToggle,
}: {
  record: SignalRecord
  expanded: boolean
  evidence: SignalEvidence | null
  onToggle: (id: string) => void
}): React.JSX.Element {
  const suppressed = record.suppressedReason !== undefined
  return (
    <li className="border-b border-white/[0.06] py-2 last:border-b-0">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => onToggle(record.id)}>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${DIRECTION_TONE[record.direction]}`}
        >
          {DIRECTION_LABEL[record.direction]}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm">{record.name}</span>
            <span className="font-mono text-xs text-white/35">{record.code}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-white/45">
            <span>{REGIME_LABEL[record.regime]}</span>
            <span>·</span>
            <span>{STAGE_LABEL[record.stage]}</span>
            <span>·</span>
            <span>{LEVEL_LABEL[record.level]}</span>
            {suppressed ? <span className="text-amber-200/70">· 已静默：{record.suppressedReason}</span> : null}
          </span>
        </span>

        <span className="shrink-0 text-right">
          {/* 「置信」二字是有意的：不得写成胜率或概率（docs/04 §4.3） */}
          <span className="block font-mono text-sm">置信 {Math.round(record.score * 100)}%</span>
          <span className="block text-xs text-white/40">
            {record.votes} 票 · {timeOf(record.createdAt)} · {numberText(record.priceAt)}
          </span>
        </span>
      </button>

      {expanded ? (
        evidence ? (
          <Evidence evidence={evidence} />
        ) : (
          <p className="mt-2 text-xs text-white/40">依据加载中…</p>
        )
      ) : null}
    </li>
  )
}

/** 当天 00:00 的时间戳。信号按 created_at 存的是墙上时刻，列表按「今天」筛 */
function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function SignalList({
  refreshKey,
  onError,
}: {
  /** 每轮引擎跑完后由父组件递增，触发重新拉取 */
  refreshKey: number
  onError: (message: string) => void
}): React.JSX.Element {
  const [records, setRecords] = useState<SignalRecord[]>([])
  const [showSuppressed, setShowSuppressed] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<Record<string, SignalEvidence>>({})

  useEffect(() => {
    let cancelled = false
    void window.gp
      .invoke('signal:history', { from: startOfToday(), limit: 200 })
      .then((rows) => {
        if (!cancelled) setRecords(rows)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, onError])

  const toggle = useCallback(
    (id: string): void => {
      setExpandedId((current) => (current === id ? null : id))
      if (evidence[id]) return
      void window.gp
        .invoke('signal:explain', id)
        .then((detail) => setEvidence((current) => ({ ...current, [id]: detail })))
        .catch((error: unknown) => {
          onError(error instanceof Error ? error.message : String(error))
        })
    },
    [evidence, onError]
  )

  const { visible, suppressedCount } = useMemo(() => {
    const suppressed = records.filter((r) => r.suppressedReason !== undefined)
    return {
      visible: showSuppressed ? records : records.filter((r) => r.suppressedReason === undefined),
      suppressedCount: suppressed.length,
    }
  }, [records, showSuppressed])

  // 卡片自己吃掉右栏剩下的高度，列表在卡片内部滚动 —— 信号是每轮都在长的流水，
  // 让它把整页顶长会把下面的提醒日志推出视野
  return (
    <section className="gp-card min-h-0 flex-1">
      <div className="gp-card-head">
        <h2 className="gp-card-title">今日信号</h2>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-white/40">
          <input
            type="checkbox"
            checked={showSuppressed}
            onChange={(e) => setShowSuppressed(e.target.checked)}
          />
          含被静默的 {suppressedCount} 条
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 py-8 text-center text-xs text-white/35">
          今日暂无信号。收盘后引擎会做一次确认轮，届时再看。
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-3">
          {visible.map((record) => (
            <SignalRow
              key={record.id}
              record={record}
              expanded={expandedId === record.id}
              evidence={evidence[record.id] ?? null}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export type { SecCode }
