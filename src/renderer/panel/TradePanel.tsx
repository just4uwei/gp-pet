/**
 * 抽屉「持仓」页：持仓与盈亏卡 + 流水录入 + 流水列表。
 *
 * ## 录流水，不是改数字
 *
 * 这里取代了原先那个覆盖式的持仓表单（填多少股就写多少股）。
 * 覆盖式改数与流水记账并存会让两者静默分叉，而**一个对不上的盈亏数字比没有这个数字更坏**
 * —— 用户没法判断哪个是对的，只能两个都不信。所以界面上不再有直接改持仓的入口，
 * 持仓只能由流水推出来。录错了就改那一笔或删那一笔（都会按流水重放重建）。
 *
 * ## 五种流水（017）
 *
 * 买入 · 卖出 · **建仓**（我早就持有，价可选含不含费）· **现金分红**（扣减摊薄成本）·
 * **送股/转增**（股数增、成本按比例摊薄）。字段与措辞在 `TradeFields.tsx` 一处定义
 * —— 录入与行内编辑共用，各写一份会让「改一笔分红」时的提示语说成「成交价」。
 *
 * ## 三条
 *
 * 1. **提交前的试算走 `trade:preview` 这趟 IPC，与落库是同一个 `applyTrade`。**
 *    在渲染层照抄一份口径才是坏选择：症状会是「表单说成本变成 12.34，存完变成 12.31」，
 *    而用户没法判断哪个才对。记账规则住在 `src/main`，而 `renderer → main`
 *    是禁止的反向依赖（tsconfig.web 的 include 会直接把这种 import 拦下来）。
 * 2. **价格填不复权真实成交价**（券商 App 上那个数）。这条在表单上要写出来 ——
 *    填成前复权价会让止损线在除权后凭空触发（docs/03 §2.3）。
 * 3. **手续费不给输入框，费率也不给。** 手续费按费率算；对不上时走持仓卡上那个
 *    **「校正成本」** —— 抄一个摊薄成本，软件反解佣金率（`CostCalibrateForm`）。
 *    判据是可核对性：那个成本价用户每天都在看，费率不是。
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

import { useEffect, useMemo, useState } from 'react'
import type { SecCode } from '@core/types'
import type {
  PositionView,
  QuoteTick,
  TradeDecisionOption,
  TradeLedger,
  TradePreview,
  TradeSide,
  TradeView,
} from '@shared/ipc-types'
import { shanghaiDate, shanghaiHhmm, shanghaiMdHhmm, shanghaiMsFrom } from '@shared/time'
import { EntryCheckCard } from './EntryCheckCard'
import { StopFloorForm, StopFloorNotice } from './StopFloorForm'
import { CostCalibrateForm } from './CostCalibrateForm'
import {
  ENTRY_SIDES,
  FIELD,
  SIDE_LABEL,
  TradeFields,
  hasPrice,
  sideHint,
} from './TradeFields'

const SIDE_TONE: Record<TradeSide, string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  OPENING: 'border-white/15 bg-white/5 text-white/50',
  // 分红与送转不是成交，用中性青色与买卖的红/黄分开 —— 一眼能看出「这一行不是我下的单」
  DIVIDEND: 'border-cyan-400/35 bg-cyan-400/10 text-cyan-200',
  SPLIT: 'border-cyan-400/35 bg-cyan-400/10 text-cyan-200',
}

/** A 股红涨绿跌 */
function moneyTone(value: number): string {
  return value > 0 ? 'text-rose-300' : value < 0 ? 'text-emerald-300' : 'text-white/60'
}

function money(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

/*
  时刻一律走 `shared/time.ts` 的北京口径（CLAUDE.md 的展示层纪律）。

  这里原先有一份 `dateText`（`getFullYear()`/`getMonth()`）与一个
  `parseDate`（`new Date('...T12:00:00')`）—— 两个都按**宿主本地时区**。
  在 UTC+8 上恰好对，在本机（UTC+7）上无害（同一个北京日），但在极西时区上
  会整整差一天，而 `TradeRepo.boughtSharesSince` 拿它去卡 T+1 卖出锁定
  ⇒ 昨天的买入被算成今天的，多锁一天。2026-08-26 一起改掉（016 头注释）。
*/

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

/** 这一笔流水在列表里显示的那个「价 × 量」。送转没有价，只报股数 */
function rowAmountText(trade: TradeView): string {
  if (trade.side === 'SPLIT') return `+${trade.shares} 股`
  if (trade.side === 'DIVIDEND') return `${trade.shares} 股 × ${trade.price.toFixed(3)}`
  return `${trade.shares} @ ${trade.price.toFixed(3)}`
}

/** 行内编辑一笔已有流水（`trade:update`） */
function TradeRowEditor({
  trade,
  onSaved,
  onCancel,
  onError,
}: {
  trade: TradeView
  onSaved: (ledger: TradeLedger) => void
  onCancel: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [side, setSide] = useState<TradeSide>(trade.side)
  const [price, setPrice] = useState(trade.side === 'SPLIT' ? '' : String(trade.price))
  const [shares, setShares] = useState(String(trade.shares))
  const [tradedAt, setTradedAt] = useState(shanghaiDate(trade.tradedAt))
  const [tradedTime, setTradedTime] = useState(
    trade.tradedAtExact === undefined ? '' : shanghaiHhmm(trade.tradedAtExact)
  )
  // 老行（017 之前）没有这一列，语义是「已含费」—— 与主进程的缺省保持一致
  const [feeIncluded, setFeeIncluded] = useState(trade.feeIncluded ?? true)
  const [note, setNote] = useState(trade.note ?? '')
  const [busy, setBusy] = useState(false)

  const tradedAtMs = shanghaiMsFrom(tradedAt)
  const exact = tradedTime === '' ? null : shanghaiMsFrom(tradedAt, tradedTime)
  const numericShares = Math.trunc(Number(shares))
  const numericPrice = Number(price)
  const valid =
    tradedAtMs !== null &&
    Number.isFinite(numericShares) &&
    numericShares > 0 &&
    (!hasPrice(side) || (Number.isFinite(numericPrice) && numericPrice > 0))

  const save = (): void => {
    if (!valid || tradedAtMs === null) return
    setBusy(true)
    void window.gp
      .invoke('trade:update', {
        id: trade.id,
        side,
        price: hasPrice(side) ? numericPrice : 0,
        shares: numericShares,
        tradedAt: tradedAtMs,
        // null = 清掉那个时刻（改成「不记得」）；这与「不带这个键」是两件事
        tradedAtExact: exact,
        note: note.trim() === '' ? null : note.trim(),
        ...(side === 'OPENING' ? { feeIncluded } : {}),
      })
      .then(onSaved)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="rounded border border-sky-400/25 bg-sky-500/[0.06] p-2">
      <div className="mb-1.5 text-[10px] text-sky-200/70">
        改这一笔。改完会按整条流水重放 —— 后面每一笔的成本与已实现盈亏都会跟着重算。
        {trade.signalId !== undefined ? '「照提醒」那个关联会保留。' : ''}
      </div>
      <TradeFields
        side={side}
        price={price}
        shares={shares}
        tradedAt={tradedAt}
        tradedTime={tradedTime}
        feeIncluded={feeIncluded}
        note={note}
        onSide={setSide}
        onPrice={setPrice}
        onShares={setShares}
        onTradedAt={setTradedAt}
        onTradedTime={setTradedTime}
        onFeeIncluded={setFeeIncluded}
        onNote={setNote}
      />
      <div className="mt-2 flex gap-1.5">
        <button className="gp-btn flex-1 justify-center" disabled={!valid || busy} onClick={save}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button className="gp-btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}

export function TradePanel({
  code,
  quote,
  ledger,
  onSubmit,
  onRemove,
  onLedgerChanged,
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
  onSubmit: (draft: {
    side: TradeSide
    price: number
    shares: number
    tradedAt: number
    /** 真实成交时刻。**用户没填时不带这个键** —— 主进程落 NULL，不拿 `tradedAt` 顶替 */
    tradedAtExact?: number
    /** 仅建仓：那个价含不含手续费 */
    feeIncluded?: boolean
    /** 照哪条提醒做的。没选时不带这个键 */
    signalId?: string
    note?: string
  }) => void
  onRemove: (id: string) => void
  /** 改一笔 / 校正成本之后把新账本交回上层（自选行上的持仓角标要跟着换） */
  onLedgerChanged: (next: TradeLedger) => void
  /** 止损确认/撤销之后把新的持仓视图交回上层（账本里那份要跟着换） */
  onStopChanged: (next: PositionView | null) => void
  onError: (message: string) => void
  busy: boolean
}): React.JSX.Element {
  const [side, setSide] = useState<TradeSide>('BUY')
  const [price, setPrice] = useState('')
  const [shares, setShares] = useState('')
  const [tradedAt, setTradedAt] = useState(() => shanghaiDate(Date.now()))
  /** 成交时刻（`HH:mm`）。**空串 = 不知道**，提交时整个键不带 —— 落 NULL 而不是 12:00 */
  const [tradedTime, setTradedTime] = useState('')
  /** 建仓：那个价含不含费。**默认不含**（用户手上多半是成交价，不是摊薄成本） */
  const [feeIncluded, setFeeIncluded] = useState(false)
  /** 照哪条提醒做的。空串 = 未关联（默认），**程序不猜**（2026-08-26 拍板） */
  const [signalId, setSignalId] = useState('')
  const [note, setNote] = useState('')
  // 带着「要改止损线」的意图进来时直接展开表单（见 stopIntent 的注释）
  const [stopFormOpen, setStopFormOpen] = useState(stopIntent)
  const [calibrateOpen, setCalibrateOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const position = ledger?.position ?? null

  /**
   * 表单里那两个输入框的「意向值」。填不出正数时是 `undefined` ——
   * **不要退成 0**：体检那边靠「有没有这个值」决定要不要算止损参考与行业占比，
   * 而 0 会让「还没填」看起来像「打算 0 元买 0 股」。
   */
  const intentPrice = positiveOrUndefined(price)
  const intentShares = positiveOrUndefined(shares)

  /**
   * 成交日与真实成交时刻。**日**永远算得出（非法日期退到今天）；
   * **时刻只在用户真填了的时候才有**，`shanghaiMsFrom` 判非法时给 null，
   * 而 null 一路传下去就是「不带这个键」⇒ 落 NULL。
   */
  const tradedAtMs = shanghaiMsFrom(tradedAt) ?? Date.now()
  const tradedAtExact = tradedTime === '' ? null : shanghaiMsFrom(tradedAt, tradedTime)

  /**
   * 「照哪条提醒做的」候选。切票或换成交日时重取一次 —— 换日不会改候选集合，
   * 但会改「当天唯一」那个标记，而标记算在渲染里，所以只依赖 `code`。
   */
  const [decisions, setDecisions] = useState<TradeDecisionOption[]>([])
  useEffect(() => {
    let cancelled = false
    void window.gp
      .invoke('trade:decisionOptions', { code })
      .then((rows) => {
        if (!cancelled) setDecisions(rows)
      })
      .catch(() => {
        if (!cancelled) setDecisions([])
      })
    return () => {
      cancelled = true
    }
  }, [code])

  // 换票时把关联清掉：上一只票的提醒挂到这一只上是纯粹的错误
  useEffect(() => setSignalId(''), [code])

  /**
   * 切到「现金分红」时把股数预填成当前持仓 —— 绝大多数分红就是按全仓派的，
   * 让用户再抄一遍自己刚在上面看到的那个数没有意义。
   * **只预填，不锁定**（部分卖出过的票用户可能要按公告的股数填）。
   */
  useEffect(() => {
    if (side === 'DIVIDEND' && shares === '' && position !== null) {
      setShares(String(position.shares))
    }
  }, [side, shares, position])

  /**
   * 成交当天**恰好只有一条**提醒时，把它标出来并给一键关联。
   *
   * ⚠ **标出来但不预选**（2026-08-26 拍板）：预选等于把「当天只有一条」这个巧合
   * 当成了因果 —— 用户完全可能是看了行情自己决定的，与那条提醒无关。
   */
  const soleOfDay = useMemo(() => {
    const sameDay = decisions.filter((d) => shanghaiDate(d.at) === tradedAt)
    return sameDay.length === 1 ? sameDay[0] : undefined
  }, [decisions, tradedAt])

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
    const p = hasPrice(side) ? Number(price) : 0
    const n = Math.trunc(Number(shares))
    if ((hasPrice(side) && (!Number.isFinite(p) || p <= 0)) || !Number.isFinite(n) || n <= 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    void window.gp
      .invoke('trade:preview', {
        code,
        side,
        price: p,
        shares: n,
        tradedAt: tradedAtMs,
        ...(side === 'OPENING' ? { feeIncluded } : {}),
      })
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, price, shares, side, tradedAt, feeIncluded, position])

  const valid = preview !== null && preview.error === undefined

  const submit = (): void => {
    if (!valid) return
    onSubmit({
      side,
      price: hasPrice(side) ? Number(price) : 0,
      shares: Math.trunc(Number(shares)),
      tradedAt: tradedAtMs,
      // 没填就整个键不带 —— 主进程据此落 NULL（「不知道分钟」不许被写成 12:00）
      ...(tradedAtExact === null ? {} : { tradedAtExact }),
      ...(side === 'OPENING' ? { feeIncluded } : {}),
      ...(signalId === '' ? {} : { signalId }),
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    })
    setPrice('')
    setShares('')
    setNote('')
    setTradedTime('')
    setSignalId('')
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
          校正成本（017）。**入口摆在成本价旁边**：用户正好在对着这个数与券商 App 比。
          没有持仓时不给 —— 反解的目标就是「当前成本」，没有它无从校正。
        */}
        {position !== null ? (
          calibrateOpen ? (
            <CostCalibrateForm
              code={code}
              currentCost={position.cost}
              onDone={(next) => {
                setCalibrateOpen(false)
                onLedgerChanged(next)
              }}
              onCancel={() => setCalibrateOpen(false)}
              onError={onError}
            />
          ) : (
            <button
              className="mt-1.5 text-[10px] text-white/30 underline decoration-dotted hover:text-sky-200/70"
              title="从券商那边的真实摊薄成本反解你的佣金率"
              onClick={() => setCalibrateOpen(true)}
            >
              成本与券商对不上？校正一下
            </button>
          )
        ) : null}

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
        {/*
          累计分红**单独一行，不并进已实现盈亏**（017）：分红走的是扣减摊薄成本，
          那笔钱要等卖出时才结转进已实现 —— 相加会把同一笔钱数两遍。
          一笔分红都没录过时不显示这一行（一个恒为 0 的数只是噪音）。
        */}
        {ledger !== null && ledger.dividendTotal > 0 ? (
          <div className="mt-1 flex items-baseline justify-between text-[10px]">
            <span className="text-white/25" title="已按每股金额扣减了摊薄成本，因此不计入上面那个数">
              累计分红（已抵成本）
            </span>
            <span className="font-mono text-white/35">{ledger.dividendTotal.toFixed(2)}</span>
          </div>
        ) : null}
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

      {/* ── 录一笔 ─────────────────────────────────────────────── */}
      <section className="rounded border border-sky-400/25 bg-sky-500/[0.06] p-3">
        <div className="mb-2 text-[11px] text-sky-200/80">录一笔</div>

        <TradeFields
          side={side}
          price={price}
          shares={shares}
          tradedAt={tradedAt}
          tradedTime={tradedTime}
          feeIncluded={feeIncluded}
          note={note}
          sides={ENTRY_SIDES}
          onSide={setSide}
          onPrice={setPrice}
          onShares={setShares}
          onTradedAt={setTradedAt}
          onTradedTime={setTradedTime}
          onFeeIncluded={setFeeIncluded}
          onNote={setNote}
          onNow={() => {
            setTradedAt(shanghaiDate(Date.now()))
            setTradedTime(shanghaiHhmm(Date.now()))
          }}
        />

        {/*
          「照哪条提醒做的」。默认未关联，**程序不猜**（见 controller.decisionOptions 的边界 1）。
          当天恰好只有一条时把它标出来并给一键关联 —— 标出来但不预选。
          只对真成交给：分红送转不是一次决策，挂上去会污染 IS 分解的样本（016）。
        */}
        {decisions.length > 0 && (side === 'BUY' || side === 'SELL') ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <select
              className={`${FIELD} min-w-0 flex-1`}
              value={signalId}
              onChange={(e) => setSignalId(e.target.value)}
            >
              <option value="">照哪条提醒做的？（可空）</option>
              {decisions.map((d) => (
                <option key={d.signalId} value={d.signalId}>
                  {`${shanghaiMdHhmm(d.at)} · ${d.direction} · ${d.level}${d.shown ? '' : '（未弹气泡）'} · ¥${d.priceAt.toFixed(3)}`}
                </option>
              ))}
            </select>
            {soleOfDay !== undefined && signalId !== soleOfDay.signalId ? (
              <button
                type="button"
                className="shrink-0 rounded border border-sky-400/40 px-1.5 py-1 text-[10px] text-sky-200/80 hover:border-sky-400/70"
                onClick={() => setSignalId(soleOfDay.signalId)}
              >
                当天只有这一条 · 就是它
              </button>
            ) : null}
          </div>
        ) : null}

        <p className="mt-1.5 text-[10px] leading-snug text-white/30">{sideHint(side)}</p>

        {/* 试算：让用户在按下确认之前就看到账会变成什么样 */}
        {preview !== null ? (
          preview.error !== undefined ? (
            <p className="mt-1.5 text-[11px] text-rose-200/80">{preview.error}</p>
          ) : (
            <div className="mt-1.5 rounded bg-black/25 px-2 py-1.5 text-[10px] leading-relaxed text-white/50">
              {side === 'DIVIDEND' ? (
                <>
                  到账 <span className="font-mono text-white/70">{preview.amount.toFixed(2)}</span>
                </>
              ) : side === 'SPLIT' ? (
                <>
                  送到账 <span className="font-mono text-white/70">{shares}</span> 股
                </>
              ) : (
                <>
                  手续费 <span className="font-mono text-white/70">{preview.fee.toFixed(2)}</span>
                  {' · '}成交额{' '}
                  <span className="font-mono text-white/70">{preview.amount.toFixed(2)}</span>
                </>
              )}
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
        <h3 className="text-[11px] text-white/40">账本流水</h3>
        {ledger === null || ledger.trades.length === 0 ? (
          <p className="py-4 text-center text-xs text-white/35">还没有任何记录。</p>
        ) : (
          <ul className="mt-1">
            {ledger.trades.map((trade) => (
              <li
                key={trade.id}
                className="border-b border-white/[0.06] py-1.5 text-[11px] last:border-b-0"
              >
                {editing === trade.id ? (
                  <TradeRowEditor
                    trade={trade}
                    onSaved={(next) => {
                      setEditing(null)
                      onLedgerChanged(next)
                    }}
                    onCancel={() => setEditing(null)}
                    onError={onError}
                  />
                ) : (
                  <div className="flex items-baseline gap-2">
                    {/* 有真实成交时刻就显示到分钟；没有就只给日期 —— 「不知道」不许被画成 00:00 */}
                    <span className="shrink-0 font-mono text-white/35">
                      {trade.tradedAtExact === undefined
                        ? shanghaiDate(trade.tradedAt)
                        : shanghaiMdHhmm(trade.tradedAtExact)}
                    </span>
                    {trade.signalId !== undefined ? (
                      <span
                        className="shrink-0 rounded border border-sky-400/30 px-1 py-px text-[10px] text-sky-200/70"
                        title={
                          trade.decisionAt === undefined || trade.decisionPrice === undefined
                            ? '照一条提醒做的'
                            : `照 ${shanghaiMdHhmm(trade.decisionAt)} 那条提醒做的（当时 ¥${trade.decisionPrice.toFixed(3)}）`
                        }
                      >
                        照提醒
                      </span>
                    ) : null}
                    <span
                      className={`shrink-0 rounded border px-1 py-px text-[10px] ${SIDE_TONE[trade.side]}`}
                    >
                      {SIDE_LABEL[trade.side]}
                    </span>
                    <span className="shrink-0 font-mono text-white/70">{rowAmountText(trade)}</span>
                    {/* 建仓那个价含不含费：不标出来的话两种行长得一模一样 */}
                    {trade.side === 'OPENING' && trade.feeIncluded === false ? (
                      <span className="shrink-0 text-[10px] text-white/25">价不含费</span>
                    ) : null}
                    {trade.realized !== undefined ? (
                      <span className={`shrink-0 font-mono ${moneyTone(trade.realized)}`}>
                        {money(trade.realized)}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-white/25">
                      费 {trade.fee.toFixed(2)}
                    </span>
                    <button
                      className="shrink-0 text-[10px] text-white/25 hover:text-sky-300"
                      title="改这一笔（会按整条流水重放）"
                      onClick={() => setEditing(trade.id)}
                    >
                      改
                    </button>
                    <button
                      className="shrink-0 text-[10px] text-white/25 hover:text-rose-300"
                      title="删掉这一笔（会按剩余流水重建持仓）"
                      onClick={() => onRemove(trade.id)}
                    >
                      ×
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[10px] leading-snug text-white/25">
          持仓由这些记录推出来，没有单独改持仓的入口 —— 录错了就改那一笔或删那一笔，
          软件会按整条流水重新算一遍（后面每一笔的成本与已实现盈亏都会跟着变）。
          标着「建仓」且没写「价不含费」的那笔，手续费记 0 是因为
          <span className="text-white/45">不知道</span>，不是没有。
        </p>
      </section>
    </div>
  )
}
