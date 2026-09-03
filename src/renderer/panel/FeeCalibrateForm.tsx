/**
 * 「校正费率」（017）：抄下券商那边的累计交易税费 → 软件反解佣金率 → 确认后重算全库。
 *
 * ## 为什么是这个形态，而不是四个费率输入框
 *
 * 出厂费率（万 2.5 / 最低 5 元）是「A 股散户常见档」的猜测，真实档位在万 0.85 ~ 万 3
 * —— 于是成本价与已实现盈亏系统性偏高，而这张账存在的唯一理由就是「实盘盈亏可比」。
 *
 * 但让用户对着四个框填费率是个坏入口：那四个数他**没有依据**。而
 * **累计交易税费是券商真的扣走的一笔钱**，可核对。判据与
 * 「设置页不给参数编辑框」（docs/01 §5.5）是同一条。
 *
 * ## ⚠ 为什么目标是「税费」而不是「成本」（2026-09-03 换的，真机逼出来的）
 *
 * 第一版让用户抄**摊薄成本**，而券商持仓页上那个「成本价」多半是**净成本**
 * （把已实现盈亏折回成本里）—— 同一只票实测 12.067 vs 12.903，**两边根本不是
 * 一个数**。用户照着抄下来的那个值我们永远解不出，而错误的形状是
 * 「软件说这个成本不可能」。「累计交易税费」没有这个歧义：它就是一笔钱。
 *
 * ## 界面上必须说出来的四件事（少一件就会被读错）
 *
 * 1. **「免 5 元最低佣金」得让用户勾。** 它反解不出来（一个方程两个未知数），
 *    而它**决定成败**：真机上那个账户免最低，保留 5 元时即使佣金率归零，
 *    总费用也够不到券商给的数 —— 无论怎么解都解不出来。
 * 2. **截止日。** 当日的税费券商往往当天不出，把今天那两笔算进我们这一侧
 *    而券商那侧没算，差额会被整个记到费率头上。默认排除今天。
 * 3. **费率是账户级的 ⇒ 校正一只票会改动全部标的的成本。** `audit` 就是为此存在的：
 *    确认之前逐只列出受影响的持仓（汇总数看不出严重性），并说明会清掉几条
 *    「已接受的那段亏损」（成本变了那条线不再是同一个判断）。
 * 4. **解不出来时不给数。** `UNIDENTIFIABLE` / `OUT_OF_RANGE` 一律显示主进程给的
 *    那句「更可能的原因是什么」，**不提供「强行按边界值应用」的按钮** ——
 *    差额若来自漏录的一笔流水，按边界值应用只会把错误固化成一个荒唐的费率。
 */

import { useState } from 'react'
import type { SecCode } from '@core/types'
import type { FeeCalibration, TradeLedger } from '@shared/ipc-types'
import { shanghaiDate, shanghaiMsFrom } from '@shared/time'

const TONE: Record<FeeCalibration['status'], string> = {
  OK: 'border-sky-400/30 bg-sky-500/[0.07] text-sky-100/80',
  UNIDENTIFIABLE: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200/85',
  OUT_OF_RANGE: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-200/85',
  NO_BASIS: 'border-white/15 bg-white/5 text-white/55',
}

const FIELD =
  'rounded border border-white/15 bg-black/25 px-2 py-1 text-[11px] outline-none focus:border-white/35'

/** 昨天的北京日期 —— 截止日的默认值（当日税费券商往往当天不出） */
function defaultThrough(): string {
  return shanghaiDate(Date.now() - 24 * 3600_000)
}

export function FeeCalibrateForm({
  code,
  feeTotal,
  onDone,
  onCancel,
  onError,
}: {
  code: SecCode
  /** 我们现在算出来的累计手续费，用来当输入框的占位（让用户看着它抄旁边那个数） */
  feeTotal: number
  /** 应用成功后把新账本交回上层 */
  onDone: (ledger: TradeLedger) => void
  onCancel: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [target, setTarget] = useState('')
  const [through, setThrough] = useState(defaultThrough)
  const [waive, setWaive] = useState(false)
  const [result, setResult] = useState<FeeCalibration | null>(null)
  const [busy, setBusy] = useState(false)

  const targetFeeTotal = Number(target)
  // 截止日按北京日**收盘之后**算，否则当天那些流水会被自己的截止日挡掉
  const throughMs = (shanghaiMsFrom(through, '23:59') ?? Date.now()) + 59_000
  const valid = target.trim() !== '' && Number.isFinite(targetFeeTotal) && targetFeeTotal >= 0
  const query = { code, targetFeeTotal, throughMs, waiveMinCommission: waive }

  const preview = (): void => {
    if (!valid) return
    setBusy(true)
    setResult(null)
    void window.gp
      .invoke('trade:calibratePreview', query)
      .then(setResult)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const apply = (): void => {
    if (result === null || result.status !== 'OK') return
    const audit = result.audit
    const ok = window.confirm(
      `按 ${code} 的税费反解出的佣金率，重算整个账本？\n\n` +
        `· 会改写 ${audit?.trades ?? 0} 笔流水（${audit?.codes ?? 0} 只标的）\n` +
        `· 成本价会变的持仓：${audit?.positions.length ?? 0} 只\n` +
        `· 会清掉 ${audit?.stopAcksCleared ?? 0} 条「已接受的那段亏损」` +
        `（成本变了，那条线不再是同一个判断）\n\n` +
        '费率是账户级的，所以它作用于全部标的 —— 如果只有这一只对不上，' +
        '更可能是这只票的流水本身漏了什么。\n\n' +
        '这一步可逆：重新校正一次就还原。事前会自动备份一份数据库。'
    )
    if (!ok) return
    setBusy(true)
    void window.gp
      .invoke('trade:calibrateApply', query)
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

  const dirty = (): void => setResult(null)

  return (
    <div className="mt-2 rounded border border-white/10 bg-black/20 p-2.5">
      <div className="text-[11px] text-white/70">校正费率</div>
      <p className="mt-0.5 text-[10px] leading-snug text-white/35">
        填券商 App 上这只票的<span className="text-white/55">累计交易税费</span>
        （佣金 + 印花税 + 过户费），软件会反解出你的佣金率。
        <span className="text-white/45">不要填成本价</span> —— 券商那个「成本价」多半是
        含已实现盈亏的净成本，与这里算的不是一个口径。
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <input
          className={`${FIELD} w-24 text-right font-mono`}
          value={target}
          placeholder="累计税费"
          inputMode="decimal"
          onChange={(e) => {
            setTarget(e.target.value)
            dirty()
          }}
        />
        <span className="text-[10px] text-white/30">截至</span>
        <input
          className={`${FIELD} w-32`}
          type="date"
          value={through}
          title="当日的税费券商往往当天不出 —— 默认排除今天，把这一天之后的流水一并排除"
          onChange={(e) => {
            setThrough(e.target.value)
            dirty()
          }}
        />
        <button className="gp-btn" disabled={!valid || busy} onClick={preview}>
          {busy ? '算…' : '反解'}
        </button>
        <button className="gp-btn ml-auto" onClick={onCancel}>
          取消
        </button>
      </div>

      {/*
        这个勾**反解不出来**（一个方程两个未知数），而它决定成败：
        真机上那个账户免最低，保留 5 元时即使佣金率归零总费用也够不到目标。
      */}
      <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-white/45">
        <input
          type="checkbox"
          checked={waive}
          onChange={(e) => {
            setWaive(e.target.checked)
            dirty()
          }}
        />
        我的券商<span className="text-white/65">免 5 元最低佣金</span>
        （这一项软件猜不出来，但它常常就是对不上的原因）
      </label>

      <p className="mt-1 text-[10px] text-white/25">
        我们现在算出来的是 <span className="font-mono text-white/45">{feeTotal.toFixed(2)}</span>
        （全部流水，含截止日之后的）
      </p>

      {result !== null ? (
        <div className={`mt-2 rounded border px-2 py-1.5 text-[10px] leading-relaxed ${TONE[result.status]}`}>
          {result.message}
          {result.status === 'OK' ? (
            <>
              <div className="mt-1 font-mono text-white/60">
                这 {result.feeBearing} 笔：{result.feeTotalNow.toFixed(2)} →{' '}
                {(result.feeTotalAfter ?? 0).toFixed(2)}（目标 {result.targetFeeTotal.toFixed(2)}）
              </div>
              {result.audit !== undefined ? (
                <div className="mt-1 text-white/45">
                  会改写 {result.audit.trades} 笔流水 · {result.audit.positions.length} 只持仓的成本会变
                  {result.audit.stopAcksCleared > 0
                    ? ` · 清掉 ${result.audit.stopAcksCleared} 条已接受的止损线`
                    : ''}
                </div>
              ) : null}
              {/* 逐只列出来：汇总数看不出严重性（见头注释第 3 条） */}
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
