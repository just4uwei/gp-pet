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

import { useMemo, useState } from 'react'
import type { SecCode } from '@core/types'
import type { FeeCalibration, TradeLedger, TradeView } from '@shared/ipc-types'
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
  trades,
  onDone,
  onCancel,
  onError,
}: {
  code: SecCode
  /**
   * 这只票的全部流水。**只用来按截止日切一下、把两边的费用合计加出来**
   * —— 那是把 `TradeView.fee` 这一列求和，不是在渲染层重算费率
   * （费率口径只有 `main/trades/fees.ts` 一处，见 `trade:preview` 那条纪律）。
   */
  trades: readonly TradeView[]
  /** 应用成功后把新账本交回上层 */
  onDone: (ledger: TradeLedger) => void
  onCancel: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [target, setTarget] = useState('')
  const [through, setThrough] = useState(defaultThrough)
  const [waive, setWaive] = useState(false)
  const [result, setResult] = useState<FeeCalibration | null>(null)
  /**
   * 「应用」点过一次，正在等第二次确认。
   *
   * ⚠ **刻意不用 `window.confirm`**（2026-09-03 换掉）：它是一个**原生模态框**，
   * 而这一屏在它关掉之后还要继续输入 —— 用户实测「第二次校正时输入框点不进去、
   * 敲了没字」，而自动化**永远复现不出来**（Playwright 把 `window.confirm` 拦掉，
   * 从头到尾没有真的弹过原生框）。既然测不到，就不该留在关键路径上。
   *
   * 换成页内两步之后还顺手去掉了一处重复：后果清单（改写几笔、清掉几条止损线、
   * 逐只列出受影响的持仓）**本来就画在表单里**，原生框只是把同样的话再说一遍。
   */
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const targetFeeTotal = Number(target)
  // 截止日按北京日**收盘之后**算，否则当天那些流水会被自己的截止日挡掉
  const throughMs = (shanghaiMsFrom(through, '23:59') ?? Date.now()) + 59_000

  /*
    ⚠ 把「截止日之内」与「之后」两边的费用**当场摊开**（2026-09-03 加）。

    这个功能最容易出的错不是解错，而是**两边不是同一个窗口**：
    截止日排掉了今天那两笔，而用户抄的券商数字**已经把今天算进去了**
    ⇒ 差额被整个记到佣金率头上，解出一个看起来精确的错数。
    出错时账面上没有任何异样 —— 所以要在他动手之前就把两个数摆出来。
  */
  const split = useMemo(() => {
    let inWindow = 0
    let inFee = 0
    let after = 0
    let afterFee = 0
    for (const t of trades) {
      if (t.tradedAt <= throughMs) {
        inWindow += 1
        inFee += t.fee
      } else {
        after += 1
        afterFee += t.fee
      }
    }
    return { inWindow, inFee, after, afterFee }
  }, [trades, throughMs])
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
    setBusy(true)
    void window.gp
      .invoke('trade:calibrateApply', query)
      .then((res) => {
        if (res.status !== 'DONE') {
          onError(res.message)
          setConfirming(false)
          return undefined
        }
        // ⚠ 这一趟也要 catch：漏了的话账本已经改完、界面却停在原地不动，
        // 而用户会以为「没生效」再点一次
        return window.gp
          .invoke('trade:list', { code })
          .then(onDone)
          .catch((err: unknown) =>
            onError(
              `账本已按新费率重算，但刷新这一屏失败了：${err instanceof Error ? err.message : String(err)}`
            )
          )
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  /** 改了任何一个入参 ⇒ 上一次的结果与那次待确认都作废 */
  const dirty = (): void => {
    setResult(null)
    setConfirming(false)
  }

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

      {/*
        两边的窗口必须一致 —— 这是这个功能最容易出的错，而且出错时账面上看不出来。
        所以把「截止日之内我们算多少」直接摆在输入框下面，让他拿券商那个数当场比。
      */}
      <p className="mt-1 text-[10px] leading-snug text-white/30">
        截止日之内 <span className="font-mono text-white/50">{split.inWindow}</span> 笔，
        我们现在算 <span className="font-mono text-white/50">{split.inFee.toFixed(2)}</span> 元
        —— <span className="text-white/45">你填的那个数要是同一个窗口的</span>。
      </p>
      {split.after > 0 ? (
        <p className="mt-1 rounded border border-amber-400/25 bg-amber-400/[0.07] px-2 py-1.5 text-[10px] leading-snug text-amber-200/85">
          ⚠ 截止日之后还有 <span className="font-mono">{split.after}</span> 笔
          （我们算 <span className="font-mono">{split.afterFee.toFixed(2)}</span> 元）
          <span className="font-medium">没算进去</span>。
          如果券商那个数**已经把它们算了**，就把截止日往后挪 —— 否则这点差额会被
          整个记到佣金率头上，解出一个看起来精确的错数。
        </p>
      ) : null}

      {result !== null ? (
        <div className={`mt-2 rounded border px-2 py-1.5 text-[10px] leading-relaxed ${TONE[result.status]}`}>
          {result.message}
          {result.status === 'OK' ? (
            <>
              <div className="mt-1 font-mono text-white/60">
                这 {result.feeBearing} 笔：{result.feeTotalNow.toFixed(2)} →{' '}
                {(result.feeTotalAfter ?? 0).toFixed(2)}（目标 {result.targetFeeTotal.toFixed(2)}）
              </div>
              {/*
                ⚠ **逐笔对照才是判据。** 合计是反解出来的，它按构造总能对上 ——
                真机踩过：同一个 85.11，「免最低」勾与不勾都能对上合计，
                而逐笔一个是 4.81/4.95/4.48（8/8 全错）、另一个是 5.00/5.00/5.00
                （8/8 零残差）。用户手上正好有那张逐笔账单，摆出来他一眼就看得出。
              */}
              {result.rows.length > 0 ? (
                <>
                  <div className="mt-1.5 text-white/45">
                    逐笔会变成这样 —— <span className="text-white/70">拿它对一下券商的逐笔账单</span>
                    ，对不上就说明下面那个勾或者截止日选错了：
                  </div>
                  <ul className="mt-1 max-h-28 overflow-y-auto font-mono text-[10px] text-white/45">
                    {result.rows.map((r) => (
                      <li key={`${r.tradedAt}-${r.side}-${r.amount}`} className="flex gap-2">
                        <span className="w-20 shrink-0">{shanghaiDate(r.tradedAt)}</span>
                        <span className="w-8 shrink-0">{r.side === 'SELL' ? '卖' : '买'}</span>
                        <span className="w-20 shrink-0 text-right">{r.amount.toFixed(0)}</span>
                        <span className="w-14 shrink-0 text-right text-white/30">
                          {r.feeNow.toFixed(2)}
                        </span>
                        <span className="w-4 shrink-0 text-center text-white/25">→</span>
                        <span className="w-14 shrink-0 text-right text-white/75">
                          {r.feeAfter.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {/*
                这一条专门抓「免最低勾错了」：勾了之后小额那几笔会算出**不足原最低**
                的费用，而券商账单上那些笔多半恰好是整数 5.00 —— 那就是勾反了。
                合计仍然对得上，所以只能靠这个特征来提。
              */}
              {result.minCommissionAfter === 0 &&
              result.minCommissionNow > 0 &&
              result.rows.some((r) => r.feeAfter < result.minCommissionNow) ? (
                <div className="mt-1.5 rounded border border-amber-400/30 bg-amber-400/[0.08] px-2 py-1.5 text-amber-200/90">
                  ⚠ 上面有
                  <span className="font-mono">
                    {' '}
                    {result.rows.filter((r) => r.feeAfter < result.minCommissionNow).length}{' '}
                  </span>
                  笔算出来<span className="font-medium">不足 {result.minCommissionNow} 元</span>。
                  如果券商账单上那几笔恰好是
                  <span className="font-mono"> {result.minCommissionNow.toFixed(2)} </span>
                  整，说明你的券商<span className="font-medium">有</span>这条最低 ——
                  把下面「免 5 元最低佣金」那个勾<span className="font-medium">取消</span>再解一次。
                  （合计两种都对得上，只有逐笔分得开。）
                </div>
              ) : null}

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
              {/*
                两步确认（页内，不用原生模态框 —— 见 `confirming` 的注释）。
                第二步那段话讲的是**上面那张清单之外**的三件事：
                费率是账户级的 · 可逆 · 事前会备份。清单本身不重复。
              */}
              {confirming ? (
                <div className="mt-2 rounded border border-amber-400/40 bg-amber-400/[0.08] px-2 py-1.5">
                  <div className="text-[10px] leading-snug text-amber-100/90">
                    费率是<span className="font-medium">账户级</span>的 —— 它作用于全部标的。
                    如果只有这一只对不上，更可能是这只票的流水本身漏了什么。
                    <br />
                    这一步<span className="font-medium">可逆</span>：重新校正一次就还原，事前会自动备份一份数据库。
                  </div>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      className="gp-btn flex-1 justify-center border-amber-400/50 text-amber-100"
                      disabled={busy}
                      onClick={apply}
                    >
                      {busy ? '重算中…' : '确认，重算整个账本'}
                    </button>
                    <button className="gp-btn" disabled={busy} onClick={() => setConfirming(false)}>
                      再想想
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="gp-btn mt-2 w-full justify-center"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                >
                  应用到全部标的
                </button>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
