/**
 * 「校正成本」（017）：抄下券商那边的摊薄成本 → 软件反解佣金率 → 确认后重算全库。
 *
 * ## 为什么是这个形态，而不是四个费率输入框
 *
 * 出厂费率（万 2.5 / 最低 5 元）是「A 股散户常见档」的猜测，真实档位在万 0.85 ~ 万 3
 * —— 于是成本价与已实现盈亏系统性偏高，而这张账存在的唯一理由就是「实盘盈亏可比」。
 *
 * 但让用户对着四个框填费率是个坏入口：那四个数他**没有依据**，而
 * **摊薄成本是他每天都在看的一个可核对的事实**。所以入口摆在这里
 * （持仓卡上，成本价旁边），要他填的就是那个数。判据与
 * 「设置页不给参数编辑框」（docs/01 §5.5）是同一条。
 *
 * ## 界面上必须说出来的三件事（少一件就会被读错）
 *
 * 1. **费率是账户级的 ⇒ 校正一只票会改动全部标的的成本。** 确认前把
 *    `audit` 里那些持仓逐只列出来 —— 「N 只受影响」这种汇总数看不出严重性。
 * 2. **会清掉「已接受的那段亏损」。** 成本变了那条线就不是同一个判断，
 *    而少一条止损线用户发现不了。
 * 3. **解不出来时不给数。** `UNIDENTIFIABLE` / `OUT_OF_RANGE` 一律显示主进程给的
 *    那句「更可能的原因是什么」，**不提供「强行按边界值应用」的按钮** ——
 *    差额若来自漏录的一笔流水，按边界值应用只会把错误固化成一个荒唐的费率。
 */

import { useState } from 'react'
import type { SecCode } from '@core/types'
import type { CostCalibration, TradeLedger } from '@shared/ipc-types'

const TONE: Record<CostCalibration['status'], string> = {
  OK: 'border-sky-400/30 bg-sky-500/[0.07] text-sky-100/80',
  UNIDENTIFIABLE: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200/85',
  OUT_OF_RANGE: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200/85',
  NO_BASIS: 'border-white/15 bg-white/5 text-white/55',
  NO_POSITION: 'border-white/15 bg-white/5 text-white/55',
}

export function CostCalibrateForm({
  code,
  currentCost,
  onDone,
  onCancel,
  onError,
}: {
  code: SecCode
  /** 现在算出来的摊薄成本，用来当输入框的占位（让用户看着它抄旁边那个数） */
  currentCost: number
  /** 应用成功后把新账本交回上层 */
  onDone: (ledger: TradeLedger) => void
  onCancel: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [target, setTarget] = useState('')
  const [result, setResult] = useState<CostCalibration | null>(null)
  const [busy, setBusy] = useState(false)

  const targetCost = Number(target)
  const valid = Number.isFinite(targetCost) && targetCost > 0

  const preview = (): void => {
    if (!valid) return
    setBusy(true)
    setResult(null)
    void window.gp
      .invoke('trade:costPreview', { code, targetCost })
      .then(setResult)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const apply = (): void => {
    if (result === null || result.status !== 'OK') return
    const audit = result.audit
    const ok = window.confirm(
      `按 ${code} 的成本反解出的佣金率，重算整个账本？\n\n` +
        `· 会改写 ${audit?.trades ?? 0} 笔流水（${audit?.codes ?? 0} 只标的）\n` +
        `· 成本价会变的持仓：${audit?.positions.length ?? 0} 只\n` +
        `· 会清掉 ${audit?.stopAcksCleared ?? 0} 条「已接受的那段亏损」` +
        `（成本变了，那条线不再是同一个判断）\n\n` +
        '费率是账户级的，所以它作用于全部标的 —— 如果只有这一只对不上，' +
        '更可能是这只票的流水本身漏了什么。\n\n' +
        '这一步可逆：改回原来那个成本再校正一次就还原。事前会自动备份一份数据库。'
    )
    if (!ok) return
    setBusy(true)
    void window.gp
      .invoke('trade:costApply', { code, targetCost })
      .then((res) => {
        if (res.status === 'DONE') {
          void window.gp.invoke('trade:list', { code }).then(onDone)
        } else {
          onError(res.message)
        }
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mt-2 rounded border border-white/10 bg-black/20 p-2.5">
      <div className="text-[11px] text-white/70">校正成本</div>
      <p className="mt-0.5 text-[10px] leading-snug text-white/35">
        填券商 App 上这只票的<span className="text-white/55">摊薄成本</span>，
        软件会从流水反解出你的佣金率（现在这里算的是 {currentCost.toFixed(3)}）。
        改的是费率，不是这个数字本身。
      </p>

      <div className="mt-2 flex items-center gap-1.5">
        <input
          className="w-24 rounded border border-white/15 bg-black/25 px-2 py-1 text-right font-mono text-[11px] outline-none focus:border-white/35"
          value={target}
          placeholder={currentCost.toFixed(3)}
          inputMode="decimal"
          onChange={(e) => {
            setTarget(e.target.value)
            setResult(null)
          }}
        />
        <button className="gp-btn" disabled={!valid || busy} onClick={preview}>
          {busy ? '算…' : '反解'}
        </button>
        <button className="gp-btn ml-auto" onClick={onCancel}>
          取消
        </button>
      </div>

      {result !== null ? (
        <div className={`mt-2 rounded border px-2 py-1.5 text-[10px] leading-relaxed ${TONE[result.status]}`}>
          {result.message}
          {result.status === 'OK' ? (
            <>
              <div className="mt-1 font-mono text-white/60">
                成本 {result.costNow.toFixed(3)} → {(result.costAfter ?? 0).toFixed(3)}
                （目标 {result.targetCost.toFixed(3)}）
              </div>
              {result.audit !== undefined ? (
                <div className="mt-1 text-white/45">
                  会改写 {result.audit.trades} 笔流水 · {result.audit.positions.length} 只持仓的成本会变
                  {result.audit.stopAcksCleared > 0
                    ? ` · 清掉 ${result.audit.stopAcksCleared} 条已接受的止损线`
                    : ''}
                  {result.audit.feeIncludedSkipped > 0
                    ? ` · 跳过 ${result.audit.feeIncludedSkipped} 笔「价已含费」的建仓`
                    : ''}
                </div>
              ) : null}
              {/* 逐只列出来：汇总数看不出严重性（见头注释第 1 条） */}
              {result.audit !== undefined && result.audit.positions.length > 0 ? (
                <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-white/40">
                  {result.audit.positions.map((row) => (
                    <li key={row.code}>
                      {row.code} {row.costBefore.toFixed(3)} → {row.costAfter.toFixed(3)}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button className="gp-btn mt-2 w-full justify-center" disabled={busy} onClick={apply}>
                {busy ? '重算中…' : '应用到全部标的'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
