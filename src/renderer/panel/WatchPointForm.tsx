/**
 * 「设为观察点」的确认表单（P2 续）。
 *
 * ## 这个表单存在的意义就是「人是闸门」
 *
 * 模型的建议只走到**预填**这一步。每一项都可改，改过就记成 `USER_EDITED`。
 * 抽取失败时表单空着照样能用 —— 模型不照格式输出是常态，不能因此让这条路走不通。
 *
 * 措辞上刻意不说「AI 推荐」而说「建议值，请自行核对」：这几个数没有任何回测依据，
 * 与 `params.ts` 里那些标定过的东西不是一回事（后者也只标定过一项）。
 *
 * ## 组合条件（2026-08-25）
 *
 * 一个观察点可以挂 1–3 个条件，**同一轮全部成立**才提醒。界面上那句话必须写出来 ——
 * 「且」与「或」在这里差一个提醒该不该来，而用户没有别的地方能看出软件用的是哪个。
 * 「或」不在这个表单里：那种情况建两个观察点，各自命中各自提醒。
 */

import { useState } from 'react'
import type { SecCode } from '@core/types'
import type {
  WatchCondition,
  WatchPointDraft,
  WatchSuggestion,
  WatchVerdict,
} from '@shared/ipc-types'
import {
  MAX_WATCH_CONDITIONS,
  conditionsText,
  impossibleConditions,
} from '@shared/watch-metrics'

/** 与 src/main/watch/metrics.ts 的白名单一致。那边是判定用的，这边是给人选的 */
const METRICS: { value: string; label: string }[] = [
  { value: 'PRICE', label: '价格' },
  { value: 'ma5', label: 'MA5' },
  { value: 'ma10', label: 'MA10' },
  { value: 'ma20', label: 'MA20' },
  { value: 'ma60', label: 'MA60' },
  { value: 'ma120', label: 'MA120' },
  { value: 'rsi', label: 'RSI' },
  { value: 'adx', label: 'ADX' },
  { value: 'dif', label: 'MACD DIF' },
  { value: 'dea', label: 'MACD DEA' },
  { value: 'hist', label: 'MACD 柱' },
  { value: 'bollUpper', label: '布林上轨' },
  { value: 'bollMid', label: '布林中轨' },
  { value: 'bollLower', label: '布林下轨' },
  { value: 'bbwPct', label: '带宽分位' },
  { value: 'plusDI', label: '+DI' },
  { value: 'minusDI', label: '−DI' },
  { value: 'atr', label: 'ATR' },
  { value: 'volRatio', label: '量比' },
]

const FIELD =
  'rounded border border-white/15 bg-black/25 px-2 py-1 text-[11px] outline-none focus:border-white/35'

/**
 * 表单里的一行条件。阈值存**字符串**：输入过程中的 `""` / `"8."` 都是合法中间态，
 * 提前 `Number()` 会让光标跳、让减号打不出来。提交时才转数。
 */
interface ConditionRow {
  metric: string
  op: 'LTE' | 'GTE'
  threshold: string
}

/**
 * 方向结论的可选值。空串 = 不填。
 *
 * **「不填」必须是一个正当选项**：模型说不清方向时（或它压根没给）不该被逼着选一个 ——
 * 一个猜出来的方向会以「用户确认过」的身份留在观察点列表上（005_watch_verdict.sql）。
 */
const VERDICTS: { value: '' | WatchVerdict; label: string }[] = [
  { value: '', label: '判断：不填' },
  { value: 'UP', label: '判断：上涨' },
  { value: 'DOWN', label: '判断：下跌' },
  { value: 'RANGE', label: '判断：震荡' },
]

export function WatchPointForm({
  signalId,
  code,
  name,
  suggestions,
  onDone,
  onCancel,
  onError,
}: {
  signalId: string
  code: SecCode
  name: string
  /** 模型给的建议，用于预填。空数组 = 抽不到，表单留空 */
  suggestions: readonly WatchSuggestion[]
  onDone: () => void
  onCancel: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const first = suggestions[0]
  // 阈值是**字符串**状态：输入中的 "8." / "" 不该被 Number() 提前吃掉
  const [rows, setRows] = useState<ConditionRow[]>(() =>
    first === undefined
      ? [{ metric: 'PRICE', op: 'LTE', threshold: '' }]
      : first.conditions.map((c) => ({ metric: c.metric, op: c.op, threshold: String(c.threshold) }))
  )
  const [meaning, setMeaning] = useState<'INVALIDATE' | 'CONFIRM'>(first?.meaning ?? 'INVALIDATE')
  const [note, setNote] = useState(first?.note ?? '')
  const [verdict, setVerdict] = useState<'' | WatchVerdict>(first?.verdict ?? '')
  const [verdictText, setVerdictText] = useState(first?.verdictText ?? '')
  const [days, setDays] = useState('28')
  const [busy, setBusy] = useState(false)

  // 记住预填值，用来判断用户有没有改过 —— 改过要记成 USER_EDITED
  const [prefill] = useState(() => ({
    rows: JSON.stringify(
      first === undefined
        ? [{ metric: 'PRICE', op: 'LTE', threshold: '' }]
        : first.conditions.map((c) => ({ metric: c.metric, op: c.op, threshold: String(c.threshold) }))
    ),
    verdict: (first?.verdict ?? '') as '' | WatchVerdict,
  }))

  const conditions: WatchCondition[] = rows.map((row) => ({
    metric: row.metric,
    op: row.op,
    threshold: Number(row.threshold),
  }))
  const filled = rows.every(
    (row) => row.threshold.trim() !== '' && Number.isFinite(Number(row.threshold))
  )
  // 可证明永不同时成立的那几条（同一指标上 ≤ a 且 ≥ b 且 b > a）。
  // **挡在确认之前**：那样的观察点看起来完全正常，用户会一直等一个不会来的提醒
  const impossible = filled ? impossibleConditions(conditions) : []
  const valid = filled && impossible.length === 0
  const edited = JSON.stringify(rows) !== prefill.rows || verdict !== prefill.verdict

  const setRow = (index: number, patch: Partial<ConditionRow>): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const submit = (): void => {
    if (!valid) return
    setBusy(true)
    const draft: WatchPointDraft = {
      signalId,
      conditions,
      meaning,
      days: Number(days) || 28,
      // 抽取失败时（没有预填）一律算用户填的
      edited: first === undefined || edited,
    }
    if (note.trim() !== '') draft.note = note.trim()
    if (verdict !== '') draft.verdict = verdict
    if (verdictText.trim() !== '') draft.verdictText = verdictText.trim().slice(0, 40)

    void window.gp
      .invoke('watch:create', draft)
      .then(() => onDone())
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mt-2 rounded border border-sky-400/30 bg-sky-500/[0.06] p-2.5 text-xs">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] text-sky-200/80">
          设为观察点 · {name} <span className="font-mono text-white/35">{code}</span>
        </span>
        {suggestions.length > 1 ? (
          <span className="text-[10px] text-white/30">模型给了 {suggestions.length} 条，这里用第一条</span>
        ) : null}
      </div>

      <p className="mb-2 text-[10px] leading-snug text-white/35">
        {first === undefined
          ? '模型这次没给出具体数值，请自己填。'
          : '下面是模型的建议值，请自行核对后再确认 —— 它没有任何回测依据。'}
        {rows.length > 1 ? '这些条件' : '条件'}
        {rows.length > 1 ? <span className="text-white/55">同时成立</span> : '成立'}
        时会提醒你一次，然后这个观察点就结束了。
      </p>

      {rows.map((row, index) => (
        <div key={index} className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {index > 0 ? <span className="text-[11px] text-white/45">且</span> : null}

          <select
            className={FIELD}
            value={row.metric}
            onChange={(e) => setRow(index, { metric: e.target.value })}
          >
            {METRICS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>

          <select
            className={FIELD}
            value={row.op}
            onChange={(e) => setRow(index, { op: e.target.value as 'LTE' | 'GTE' })}
          >
            <option value="LTE">跌破 / 低于</option>
            <option value="GTE">升破 / 高于</option>
          </select>

          <input
            className={`${FIELD} w-20 text-right font-mono ${
              impossible.includes(index) ? 'border-rose-400/50' : ''
            }`}
            value={row.threshold}
            placeholder="阈值"
            onChange={(e) => setRow(index, { threshold: e.target.value })}
          />

          {rows.length > 1 ? (
            <button
              className="text-[10px] text-white/30 hover:text-rose-300"
              onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
            >
              删除
            </button>
          ) : null}
        </div>
      ))}

      <div className="mb-1.5 flex items-center gap-2">
        <button
          className="text-[10px] text-sky-200/70 hover:text-sky-200 disabled:text-white/20"
          disabled={rows.length >= MAX_WATCH_CONDITIONS}
          onClick={() => setRows((prev) => [...prev, { metric: 'PRICE', op: 'LTE', threshold: '' }])}
        >
          + 再加一个条件（且）
        </button>
        <span className="text-[10px] text-white/25">
          最多 {MAX_WATCH_CONDITIONS} 条；「任一成立就提醒」请分开建两个观察点
        </span>
      </div>

      {/*
        永不同时成立的组合挡在这里。措辞点名那几条，别只说「条件有误」——
        用户要知道是哪两行打架
      */}
      {impossible.length > 0 ? (
        <p className="mb-1.5 rounded border border-rose-400/30 bg-rose-500/[0.07] px-2 py-1 text-[10px] leading-snug text-rose-100/80">
          这些条件不可能同时成立：
          {conditionsText(impossible.map((i) => conditions[i]).filter((c) => c !== undefined))}
          。改一下阈值，或者把它们拆成两个观察点。
        </p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <select
          className={FIELD}
          value={meaning}
          onChange={(e) => setMeaning(e.target.value as 'INVALIDATE' | 'CONFIRM')}
        >
          <option value="INVALIDATE">命中 = 原判断失效</option>
          <option value="CONFIRM">命中 = 判断得到确认</option>
        </select>
        <input
          className={`${FIELD} w-14 text-right font-mono`}
          type="number"
          min={1}
          max={365}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
        <span className="text-[10px] text-white/35">天内有效</span>
      </div>

      {/*
        方向结论。这一行记的是**当时那条解读判的是什么方向**，不是引擎的判断，
        也不参与任何判定 —— 它的用处是让一条到期未命中的观察点变成一个能读的结论：
        「当时判上涨、失效条件没出现」与「当时判下跌、失效条件没出现」是两件事。
      */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <select
          className={FIELD}
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as '' | WatchVerdict)}
        >
          {VERDICTS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          className={`${FIELD} min-w-0 flex-1`}
          value={verdictText}
          placeholder="判断原文（模型原话，最多 40 字）"
          maxLength={40}
          onChange={(e) => setVerdictText(e.target.value)}
        />
      </div>

      <input
        className={`${FIELD} mt-1.5 w-full`}
        value={note}
        placeholder="备注（为什么设这个，三个月后你会需要它）"
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="mt-2 flex items-center gap-1.5">
        <button className="gp-btn" disabled={!valid || busy} onClick={submit}>
          {busy ? '保存中…' : '确认跟踪'}
        </button>
        <button className="gp-btn" onClick={onCancel}>
          取消
        </button>
        {valid ? (
          <span className="ml-auto text-right text-[10px] text-white/30">
            {conditionsText(conditions)}
          </span>
        ) : null}
      </div>
    </div>
  )
}
