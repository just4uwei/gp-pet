/**
 * 抽屉「持仓」页：持仓与盈亏卡 + 成交录入 + 流水列表。
 *
 * ## 录成交，不是改数字
 *
 * 这里取代了原先那个覆盖式的持仓表单（填多少股就写多少股）。
 * 覆盖式改数与流水记账并存会让两者静默分叉，而**一个对不上的盈亏数字比没有这个数字更坏**
 * —— 用户没法判断哪个是对的，只能两个都不信。所以界面上不再有直接改持仓的入口，
 * 持仓只能由成交流水推出来。录错了就删那一笔（会按剩余流水重放重建持仓）。
 *
 * ## 三条
 *
 * 1. **提交前的试算走 `trade:preview` 这趟 IPC，与落库是同一个 `applyTrade`。**
 *    在渲染层照抄一份口径才是坏选择：症状会是「表单说成本变成 12.34，存完变成 12.31」，
 *    而用户没法判断哪个才对。记账规则住在 `src/main`，而 `renderer → main`
 *    是禁止的反向依赖（tsconfig.web 的 include 会直接把这种 import 拦下来）。
 * 2. **价格填不复权真实成交价**（券商 App 上那个数）。这条在表单上要写出来 ——
 *    填成前复权价会让止损线在除权后凭空触发（docs/03 §2.3）。
 * 3. **手续费不让用户填**，按回测那套默认费率算（佣金万 2.5 / 最低 5 元、印花税千 1、
 *    过户费万 0.1）。与影子运行、回测同一口径，三边的盈亏数字才能横向比。
 *    **但不套滑点** —— 用户填的就是真实成交价（见 ledger.ts 头注释）。
 *
 * ## T+1 与建仓体检（2026-08-19）
 *
 * - 选「买入」时表单**上方**是 `EntryCheckCard`（建仓体检）。摆在上方是刻意的：
 *   「先帮我判断危险性」要求它在决定之前被看到，摆在按钮下面等于事后诸葛。
 * - 选「卖出」时若股数超过当日可卖（A 股 T+1），`preview.warning` 给一条**琥珀色**提示
 *   而按钮**仍然可用** —— 与玫红色的 `error`（真的录不进去）严格区分。
 *   不硬拒的理由在 `TradePreview.warning` 上：跨境/债券 ETF 与可转债是 T+0。
 * - 持仓卡上显示「其中 N 股今日买入」。不说的话用户会按全仓去挂单，然后被券商拒掉。
 */

import { useEffect, useState } from 'react'
import type { SecCode } from '@core/types'
import type { PositionView, QuoteTick, TradeLedger, TradePreview, TradeView } from '@shared/ipc-types'
import { EntryCheckCard } from './EntryCheckCard'
import { StopFloorForm, StopFloorNotice } from './StopFloorForm'

const FIELD =
  'rounded border border-white/15 bg-black/25 px-2 py-1 text-[11px] outline-none focus:border-white/35'

const SIDE_LABEL: Record<TradeView['side'], string> = {
  BUY: '买入',
  SELL: '卖出',
  OPENING: '期初',
}

const SIDE_TONE: Record<TradeView['side'], string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  OPENING: 'border-white/15 bg-white/5 text-white/50',
}

/** A 股红涨绿跌 */
function moneyTone(value: number): string {
  return value > 0 ? 'text-rose-300' : value < 0 ? 'text-emerald-300' : 'text-white/60'
}

function money(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

function dateText(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `<input type="date">` 要的 yyyy-MM-dd，本地时区 */
function dateValue(ms: number): string {
  return dateText(ms)
}

function parseDate(text: string, fallback: number): number {
  const parsed = new Date(`${text}T12:00:00`).getTime()
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 输入框里的字符串 → 正数或 `undefined`。
 *
 * **不退成 0**：建仓体检靠「有没有这个值」决定要不要算止损参考与行业占比，
 * 0 会让「还没填」看起来像「打算 0 元买 0 股」（约束 4 的展示层版本）。
 */
function positiveOrUndefined(text: string): number | undefined {
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function TradePanel({
  code,
  quote,
  ledger,
  onSubmit,
  onRemove,
  onStopChanged,
  onError,
  busy,
  stopIntent = false,
}: {
  code: SecCode
  quote: QuoteTick | undefined
  ledger: TradeLedger | null
  /**
   * 用户是从「止损线」那个入口点进来的（自选行上那个），不是来记账的。
   *
   * 两件事都要做，缺一个都会变成「点了止损线，跳到一个让我录成交的表单」：
   *   ① **强制渲染止损那一段** —— 下面那个 `floatingPct < 0` 的条件需要报价，
   *      而休市或取数失败时没有报价，整块会消失；
   *   ② **直接把表单展开**，不要求再点一次「我接受这段亏损」。
   *
   * 反过来，**没有这个意图时那条规则一个字不改**：赚着的时候不主动提这件事，
   * 免得看起来像软件在劝他别卖（见下面那段注释）。
   */
  stopIntent?: boolean
  onSubmit: (draft: { side: 'BUY' | 'SELL'; price: number; shares: number; tradedAt: number; note?: string }) => void
  onRemove: (id: string) => void
  /** 止损确认/撤销之后把新的持仓视图交回上层（账本里那份要跟着换） */
  onStopChanged: (next: PositionView | null) => void
  onError: (message: string) => void
  busy: boolean
}): React.JSX.Element {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [price, setPrice] = useState('')
  const [shares, setShares] = useState('')
  const [tradedAt, setTradedAt] = useState(() => dateValue(Date.now()))
  const [note, setNote] = useState('')
  // 带着「要改止损线」的意图进来时直接展开表单（见 stopIntent 的注释）
  const [stopFormOpen, setStopFormOpen] = useState(stopIntent)

  const position = ledger?.position ?? null

  /**
   * 表单里那两个输入框的「意向值」。填不出正数时是 `undefined` ——
   * **不要退成 0**：体检那边靠「有没有这个值」决定要不要算止损参考与行业占比，
   * 而 0 会让「还没填」看起来像「打算 0 元买 0 股」。
   */
  const intentPrice = positiveOrUndefined(price)
  const intentShares = positiveOrUndefined(shares)

  /**
   * 试算。数值填全之前不发请求（`null` = 还没得算，不是「算不出来」）。
   * `position` 进依赖数组是必须的：刚录完一笔之后账本变了，试算要跟着重算。
   *
   * **`tradedAt` 要一起送过去**（2026-08-19）：T+1 的那条提示按**这笔成交自己的日期**
   * 判「当天买了多少」，不是按今天。漏传的症状是补录上周那笔卖出时凭空报一次 T+1
   * —— 而用户会以为软件不让他补录。
   */
  const [preview, setPreview] = useState<TradePreview | null>(null)
  useEffect(() => {
    const p = Number(price)
    const n = Math.trunc(Number(shares))
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(n) || n <= 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    void window.gp
      .invoke('trade:preview', { code, side, price: p, shares: n, tradedAt: parseDate(tradedAt, Date.now()) })
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, price, shares, side, tradedAt, position])

  const valid = preview !== null && preview.error === undefined

  const submit = (): void => {
    if (!valid) return
    onSubmit({
      side,
      price: Number(price),
      shares: Math.trunc(Number(shares)),
      tradedAt: parseDate(tradedAt, Date.now()),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    })
    setPrice('')
    setShares('')
    setNote('')
  }

  const last = quote?.last
  const floating =
    position && last !== undefined ? (last - position.cost) * position.shares : null
  const floatingPct =
    position && last !== undefined && position.cost > 0
      ? ((last - position.cost) / position.cost) * 100
      : null

  return (
    <div className="space-y-4">
      {/* ── 持仓与盈亏 ─────────────────────────────────────────── */}
      <section className="rounded border border-white/10 bg-black/20 p-3">
        {position ? (
          <div className="grid grid-cols-2 gap-y-1.5 text-xs">
            <span className="text-white/40">持有</span>
            <span className="text-right font-mono">
              {position.shares} 股
              {/*
                A 股 T+1：今天买的今天卖不掉。**必须显示** —— 用户看到的是持有数，
                不说的话他会按全仓挂单，然后被券商拒掉。
                `lockedShares` 由主进程按成交流水算（判据与风控层同一个数）
              */}
              {position.lockedShares !== undefined && position.lockedShares > 0 ? (
                <span className="ml-1 text-[10px] text-amber-200/70">
                  （可卖 {Math.max(0, position.shares - position.lockedShares)}，
                  {position.lockedShares} 股今日买入）
                </span>
              ) : null}
            </span>
            <span className="text-white/40">摊薄成本（含费）</span>
            <span className="text-right font-mono">{position.cost.toFixed(3)}</span>
            <span className="text-white/40">现价</span>
            <span className={`text-right font-mono ${quote?.stale === true ? 'text-white/35' : ''}`}>
              {last === undefined ? '—' : last.toFixed(2)}
            </span>
            <span className="text-white/40">浮动盈亏</span>
            <span className={`text-right font-mono ${floating === null ? '' : moneyTone(floating)}`}>
              {floating === null ? '—' : `${money(floating)}（${money(floatingPct ?? 0)}%）`}
            </span>
          </div>
        ) : (
          <p className="text-xs text-white/40">当前没有持仓。</p>
        )}

        {/*
          止损确认（009_position_stop.sql）。**入口摆在持仓卡里**，因为这里同时能看到
          成本、现价与浮亏 —— 那三个数是做这个决定的全部依据。

          已确认时显示当前那条线 + 撤销；没确认时**只在已经触及止损线时**才给入口
          （2026-08-15 收紧，原先是「正在亏就给」）—— 还没跌破就提这件事只是噪音，
          赚着的时候更会让人误以为软件在劝他别卖。

          **判据用 `position.stopBreached`（主进程算的），不在这里拿浮亏比 8%。**
          `risk.stopLossPct` 在 `src/core/params.ts`，而 `renderer → core` 是禁止的；
          在这里抄一个 0.08 出来，两个口径分叉之后症状是
          「界面说该改止损线了，引擎却还没打算提醒」。
        */}
        {position?.stopAck ? (
          <StopFloorNotice
            code={code}
            ack={position.stopAck}
            onDone={onStopChanged}
            onError={onError}
          />
        ) : position && (stopIntent || position.stopBreached === true) ? (
          stopFormOpen ? (
            <StopFloorForm
              code={code}
              position={position}
              price={last}
              onDone={(next) => {
                setStopFormOpen(false)
                onStopChanged(next)
              }}
              onCancel={() => setStopFormOpen(false)}
              onError={onError}
            />
          ) : (
            <button
              className="gp-btn mt-2 w-full justify-center text-[11px]"
              onClick={() => setStopFormOpen(true)}
            >
              我接受这段亏损，把止损线往下挪
            </button>
          )
        ) : null}

        {/* 已实现盈亏与持仓分开显示：清仓之后前者还在，那正是这张表存在的理由 */}
        <div className="mt-2 flex items-baseline justify-between border-t border-white/10 pt-2 text-xs">
          <span className="text-white/40">已实现盈亏（含费）</span>
          <span className={`font-mono ${moneyTone(ledger?.realizedTotal ?? 0)}`}>
            {ledger === null ? '—' : money(ledger.realizedTotal)}
          </span>
        </div>
        <div className="mt-1 flex items-baseline justify-between text-[10px]">
          <span className="text-white/25">累计手续费</span>
          <span className="font-mono text-white/35">{(ledger?.feeTotal ?? 0).toFixed(2)}</span>
        </div>
      </section>

      {/*
        ── 建仓体检 ────────────────────────────────────────────
        只在「买入」时出现，且**在录入表单之上** —— 「先帮我判断危险性」
        要求它在决定之前被看到。价与股数没填也照样出（结构性风险与买多少无关）。
      */}
      {side === 'BUY' ? (
        <EntryCheckCard
          code={code}
          price={intentPrice}
          shares={intentShares}
          revision={position}
          onError={onError}
        />
      ) : null}

      {/* ── 录一笔成交 ─────────────────────────────────────────── */}
      <section className="rounded border border-sky-400/25 bg-sky-500/[0.06] p-3">
        <div className="mb-2 text-[11px] text-sky-200/80">录一笔成交</div>

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            className={FIELD}
            value={side}
            onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}
          >
            <option value="BUY">买入</option>
            <option value="SELL">卖出</option>
          </select>
          <input
            className={`${FIELD} w-20 text-right font-mono`}
            value={price}
            placeholder="成交价"
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value)}
          />
          <input
            className={`${FIELD} w-20 text-right font-mono`}
            value={shares}
            placeholder="股数"
            inputMode="numeric"
            onChange={(e) => setShares(e.target.value)}
          />
          <input
            className={`${FIELD} w-32`}
            type="date"
            value={tradedAt}
            onChange={(e) => setTradedAt(e.target.value)}
          />
        </div>

        <input
          className={`${FIELD} mt-1.5 w-full`}
          value={note}
          placeholder="备注（可空）"
          onChange={(e) => setNote(e.target.value)}
        />

        <p className="mt-1.5 text-[10px] leading-snug text-white/30">
          填<span className="text-white/45">不复权真实成交价</span>（券商 App 上那个数）。
          手续费按常见档位自动算（佣金万 2.5 / 最低 5 元、印花税千 1、过户费万 0.1），不用你填。
        </p>

        {/* 试算：让用户在按下确认之前就看到账会变成什么样 */}
        {preview !== null ? (
          preview.error !== undefined ? (
            <p className="mt-1.5 text-[11px] text-rose-200/80">{preview.error}</p>
          ) : (
            <div className="mt-1.5 rounded bg-black/25 px-2 py-1.5 text-[10px] leading-relaxed text-white/50">
              手续费 <span className="font-mono text-white/70">{preview.fee.toFixed(2)}</span>
               成交额 <span className="font-mono text-white/70">{preview.amount.toFixed(2)}</span>
              <br />
              录入后：
              {preview.position === null ? (
                <span className="text-white/70">清仓</span>
              ) : (
                <>
                  <span className="font-mono text-white/70">{preview.position.shares}</span> 股 · 成本{' '}
                  <span className="font-mono text-white/70">{preview.position.cost.toFixed(3)}</span>
                </>
              )}
              {preview.realized !== null ? (
                <>
                  {' 本笔已实现 '}
                  <span className={`font-mono ${moneyTone(preview.realized)}`}>
                    {money(preview.realized)}
                  </span>
                </>
              ) : null}
            </div>
          )
        ) : null}

        {/*
          T+1 提示（琥珀色）。**与上面那条玫红色的 error 严格分开**：
          error 是「录不进去」，这条是「能录，但你可能把日期填错了」——
          按钮照样可用（跨境/债券 ETF 与可转债是 T+0，见 TradePreview.warning）。
        */}
        {preview?.warning !== undefined ? (
          <p className="mt-1.5 rounded border border-amber-400/25 bg-amber-400/[0.07] px-2 py-1.5 text-[10px] leading-snug text-amber-200/85">
            {preview.warning}
          </p>
        ) : null}

        <button className="gp-btn mt-2 w-full justify-center" disabled={!valid || busy} onClick={submit}>
          {busy ? '保存中…' : '确认录入'}
        </button>
      </section>

      {/* ── 流水 ──────────────────────────────────────────────── */}
      <section>
        <h3 className="text-[11px] text-white/40">成交流水</h3>
        {ledger === null || ledger.trades.length === 0 ? (
          <p className="py-4 text-center text-xs text-white/35">还没有成交记录。</p>
        ) : (
          <ul className="mt-1">
            {ledger.trades.map((trade) => (
              <li
                key={trade.id}
                className="flex items-baseline gap-2 border-b border-white/[0.06] py-1.5 text-[11px] last:border-b-0"
              >
                <span className="shrink-0 font-mono text-white/35">{dateText(trade.tradedAt)}</span>
                <span className={`shrink-0 rounded border px-1 py-px text-[10px] ${SIDE_TONE[trade.side]}`}>
                  {SIDE_LABEL[trade.side]}
                </span>
                <span className="shrink-0 font-mono text-white/70">
                  {trade.shares} @ {trade.price.toFixed(3)}
                </span>
                {trade.realized !== undefined ? (
                  <span className={`shrink-0 font-mono ${moneyTone(trade.realized)}`}>
                    {money(trade.realized)}
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-white/25">
                  费 {trade.fee.toFixed(2)}
                </span>
                <button
                  className="shrink-0 text-[10px] text-white/25 hover:text-rose-300"
                  title="删掉这一笔（会按剩余流水重建持仓）"
                  onClick={() => onRemove(trade.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[10px] leading-snug text-white/25">
          持仓由这些成交推出来，没有单独改持仓的入口 —— 录错了就删那一笔，
          软件会按剩下的流水重新算一遍。标着「期初」的那笔是升级或导入配置时按当时持仓补的，
          它的手续费记 0 是因为<span className="text-white/45">不知道</span>，不是没有。
        </p>
      </section>
    </div>
  )
}
