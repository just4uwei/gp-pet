/**
 * 「我接受这一段亏损」表单（009_position_stop.sql）。
 *
 * ## 它在关掉一个安全提醒，所以措辞不许含糊
 *
 * 固定止损是 L3 强制类、不可降级（docs/05 §2.3）。这个表单让用户把那条线往下挪，
 * 于是**在跌到新线之前，亏损不会再提醒他**。CLAUDE.md 里「少发的错误用户发现不了」
 * 说的正是这一类：漏一条止损提醒，用户当时什么都察觉不到，事后也归不了因。
 *
 * 所以界面上有三件事必须做到：
 *
 * 1. **把代价原话写出来** —— 「跌到 8.46 之前，不会再因为亏损提醒你」。
 *    不许写成「调整止损线」这种听起来像优化的说法。
 * 2. **说清哪些还会响** —— 移动止损 / 回撤减仓 / 盈利保护照旧。
 *    用户接受的是「这一段下跌」，不是「所有风控都别响了」。
 * 3. **随时能撤销**，而且撤销入口与确认入口一样显眼（在持仓页上）。
 *
 * ## 建议值
 *
 * 预填「现价 × (1 − 出厂止损幅)」—— 也就是「再跌一个止损幅还是要提醒你」。
 * 给建议值而不是空着，是因为用户在那一刻通常不知道该填多少，
 * 空着会让他随手填一个很低的数，那等于静默到底。可改。
 */

import { useState } from 'react'
import type { SecCode } from '@core/types'
import type { PositionView } from '@shared/ipc-types'

/**
 * 出厂止损幅。**与 `src/core/params.ts` 的 `risk.stopLossPct` 成对**，
 * 但这里只用来算一个**建议值** —— 真正的判定在主进程，所以两边偶尔不一致
 * 的后果只是建议值偏一点，不会影响提醒。
 * （渲染层拿不到 params：那是 `src/core`，而 `renderer → main/core` 是禁止的。）
 */
const SUGGEST_DROP = 0.08

export function StopFloorForm({
  code,
  position,
  price,
  onDone,
  onCancel,
  onError,
}: {
  code: SecCode
  position: PositionView
  /** 现价。拿不到时不给建议值，也不校验 —— 主进程那边还会校验一次 */
  price: number | undefined
  onDone: (next: PositionView | null) => void
  onCancel: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const suggested = price === undefined ? null : Number((price * (1 - SUGGEST_DROP)).toFixed(2))
  const [value, setValue] = useState(suggested === null ? '' : String(suggested))
  const [busy, setBusy] = useState(false)

  const floor = Number(value)
  const valid = Number.isFinite(floor) && floor > 0 && (price === undefined || floor < price)
  const lossPct =
    position.cost > 0 && price !== undefined ? ((price - position.cost) / position.cost) * 100 : null
  /** 从现价到新线还有多少空间 —— 这是用户真正要判断的那个数 */
  const roomPct = price !== undefined && price > 0 ? ((floor - price) / price) * 100 : null

  const submit = (): void => {
    if (!valid || busy) return
    setBusy(true)
    void window.gp
      .invoke('position:acceptLoss', code, floor)
      .then(onDone)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mt-2 rounded border border-amber-400/30 bg-amber-500/[0.06] p-2 text-xs">
      <p className="leading-relaxed text-amber-100/80">
        接受当前这一段亏损
        {lossPct === null ? '' : `（${lossPct.toFixed(1)}%）`}，把止损线挪到：
      </p>

      <div className="mt-2 flex items-center gap-2">
        <input
          className="w-24 rounded border border-white/15 bg-black/25 px-2 py-1 font-mono text-xs outline-none focus:border-white/35"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {suggested !== null ? (
          <span className="text-[10px] text-white/35">
            建议 {suggested}（现价再跌 {Math.round(SUGGEST_DROP * 100)}%）
          </span>
        ) : null}
      </div>

      {/*
        代价原话。这一段是整个表单存在的理由 —— 用户点「确认」之前必须看到
        「不会再提醒」这五个字，否则他日后会觉得是软件漏报了
      */}
      <p className="mt-2 leading-relaxed text-white/50">
        {/*
          还没输入时不报错。拿不到现价（休市、取数失败）就给不出建议值，输入框是空的，
          这时先弹一句红色的「要填一个正数」会让刚打开表单的人以为自己已经做错了什么
          —— 而他一个字都还没打。空态说明这一栏是干什么的就够了。
        */}
        {value.trim() === '' ? (
          <span className="text-white/40">
            填一个价：跌破它才会再因为亏损提醒你。
            {price === undefined ? '（当前拿不到现价，所以没有建议值）' : ''}
          </span>
        ) : valid ? (
          <>
            跌到 <span className="font-mono text-amber-100/80">{floor}</span> 之前，
            <span className="text-amber-100/80">不会再因为亏损提醒你</span>
            {roomPct === null ? '' : `（还有 ${Math.abs(roomPct).toFixed(1)}% 空间）`}。
            跌破它会重新提醒，届时可以再接受一段。
          </>
        ) : price !== undefined ? (
          <span className="text-rose-200/80">要填一个低于现价 {price} 的正数。</span>
        ) : (
          <span className="text-rose-200/80">要填一个正数。</span>
        )}
      </p>
      <p className="mt-1 text-[10px] leading-snug text-white/30">
        只影响「亏损过大」这一条。移动止损、回撤减仓、盈利保护照旧提醒 ——
        你接受的是这一段下跌，不是关掉全部风控。
      </p>

      <div className="mt-2 flex gap-2">
        <button className="gp-btn text-[11px]" disabled={!valid || busy} onClick={submit}>
          {busy ? '保存中…' : '确认接受'}
        </button>
        <button className="gp-btn text-[11px]" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

/** 已确认时的那一行 + 撤销。**撤销要与确认一样显眼**，见文件头第 3 条 */
export function StopFloorNotice({
  code,
  ack,
  onDone,
  onError,
}: {
  code: SecCode
  ack: NonNullable<PositionView['stopAck']>
  onDone: (next: PositionView | null) => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const when = new Date(ack.ackAt).toLocaleString('zh-CN')

  return (
    <div className="mt-2 rounded border border-amber-400/25 bg-amber-500/[0.05] p-2 text-[11px] leading-relaxed">
      <p className="text-amber-100/75">
        你已接受 {ack.ackLossPct.toFixed(1)}% 的亏损，止损线现在是{' '}
        <span className="font-mono">{ack.stopFloor}</span>。
      </p>
      <p className="mt-0.5 text-white/35">
        {when} 确认 · 跌破它才会再提醒；其余风控规则不受影响。
      </p>
      <button
        className="gp-btn mt-1.5 px-1.5 py-0.5 text-[10px]"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void window.gp
            .invoke('position:clearStop', code)
            .then(onDone)
            .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false))
        }}
      >
        撤销，回到按 8% 判定
      </button>
    </div>
  )
}
