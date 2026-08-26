/**
 * 面板窗口 —— 自选股列表 + 数据层状态 + 今日信号 + 持仓录入 + 提醒日志 + 配置导入导出。
 *
 * 三条克制：
 *
 * 1. **只显示已经有的东西。** 不留占位行 —— 空着的占位比没有更容易让人误判完成度。
 * 2. **拿不到数据就明说。** 行情离线、日历可能过期、数据源降级都摆在顶部，
 *    绝不用上一轮的价格假装实时（stale 一律灰显并标注）。
 * 3. **不出现「胜率」「必涨」一类措辞**（CLAUDE.md 措辞纪律），底部固定免责声明。
 *
 * 「今日信号」与「提醒日志」是两件事，刻意分成两块：
 * 前者回答「引擎判了什么」，后者回答「它有没有真的提醒我，没提醒是被哪道闸门挡的」。
 *
 * ## 布局：两栏，页面本身不滚
 *
 * 左栏是**我关心哪些票**（自选 + 持仓录入），右栏是**今天发生了什么**（信号 + 提醒判定）。
 * 这不是为了填满宽度而拆的：这两件事的刷新节奏不同 —— 自选是我偶尔改一次的清单，
 * 信号是每轮 tick 都在变的流水。挤在一列里滚动时，改自选要先滚过一屏信号。
 *
 * 三处可滚区域各自独立（自选列表、信号列表、提醒日志），**最外层 `overflow: hidden`**
 * （styles.css）。窄到 md 以下（面板最小宽 720，用户可以拖到这么窄）退回单列，
 * 这时改由中间那层容器整体滚动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  EngineStatus,
  IntradayTHint,
  PositionView,
  ProviderHealth,
  QuoteTick,
  SignalRecord,
  TradeLedger,
  WatchItem,
  WatchPointView,
} from '@shared/ipc-types'
import { groupSignals } from '@shared/signal-group'
import { watchMarkOf } from '@shared/watch-mark'
import { T_HINT_LABEL, T_HINT_TITLE } from '@shared/intraday-t'
import { SHANGHAI_OFFSET_MS, shanghaiDayStartMs, shanghaiMdHhmm } from '@shared/time'
import { INDUSTRY_ETF_GROUP, INDUSTRY_ETFS } from '@shared/industry-etf'
import {
  canReorderWatch,
  reorderWatchItems,
  splitWatchItems,
  watchTabOf,
  type WatchTab,
} from '@shared/watch-split'
import type { SecCode } from '@core/types'
import { AlertLog } from './AlertLog'
import { BrandMark } from './BrandMark'
import { ConfigTransferButtons, ConfigTransferNotice, type TransferOutcome } from './ConfigTransfer'
import { DailyReportPanel } from './DailyReport'
import { BriefPanel } from './BriefPanel'
import { FOOTER_NOTE } from './disclaimer'
import { Onboarding } from './Onboarding'
import { Settings } from './Settings'
import { ShadowPanel } from './ShadowPanel'
import { CountChips, SignalList, SignalRow } from './SignalList'
import { StockDrawer, type StockTab } from './StockDrawer'
import { useSignalEvidence } from './useSignalEvidence'
import { WatchPoints } from './WatchPoints'

/**
 * 五个标签页。**不做路由** —— 面板只有五屏，`useState` 比引一个 router 便宜得多。
 *
 * 「概览」是默认页且是唯一有推送的一屏（行情每轮都在变）；其余四个标签页都是
 * 「打开看一眼」的性质，所以它们**不订阅推送**，只在切进来时拉一次。
 *
 * 「观察点」的标题带 ACTIVE 计数 —— 那是「软件现在在盯什么」最直接的回答，
 * 而这个功能的全部意义就在于让用户看得见它在盯。
 */
type Tab = 'OVERVIEW' | 'REPORT' | 'BRIEF' | 'WATCH' | 'SHADOW' | 'SETTINGS'

const TABS: { id: Tab; label: string }[] = [
  { id: 'OVERVIEW', label: '概览' },
  // 日报排在概览之后：它是「一天结束后看一眼」的东西，比观察点更常用
  { id: 'REPORT', label: '日报' },
  // 公告排在日报之后：日报答「今天怎么样」，公告答「引擎看不见的那部分」。
  // 它**不是提醒渠道** —— 不进闸门、不占配额，出口只有这一页签（docs/11 §2.3）
  { id: 'BRIEF', label: '公告' },
  { id: 'WATCH', label: '观察点' },
  { id: 'SHADOW', label: '影子运行' },
  { id: 'SETTINGS', label: '设置' },
]

const SESSION_LABEL: Record<string, string> = {
  CLOSED: '休市',
  PRE_OPEN: '盘前',
  AUCTION: '集合竞价',
  PRE_TRADE: '待开盘',
  CONTINUOUS_AM: '上午盘',
  LUNCH_BREAK: '午休',
  CONTINUOUS_PM: '下午盘',
  CLOSING_AUCTION: '收盘竞价',
  SETTLE: '盘后',
}

const HEALTH_LABEL: Record<ProviderHealth['status'], string> = {
  OK: '正常',
  DEGRADED: '降级',
  DOWN: '不可用',
}

const HEALTH_TONE: Record<ProviderHealth['status'], string> = {
  OK: 'text-emerald-300',
  DEGRADED: 'text-amber-300',
  DOWN: 'text-rose-300',
}

/**
 * 时钟偏差提示的门槛。取 60s：应用对时间的敏感度是分钟级（时段边界、尾盘窗口），
 * 秒级偏差已经被校正掉且不影响任何判定，为它常亮一条横幅只会训练用户无视横幅。
 */
const CLOCK_WARN_MS = 60_000

/**
 * 自选卡片里的两个 tab。
 *
 * **2026-08-18 起分的是 `board`（代码段推的），不再是 `WatchItem.group`。**
 * 按分组分的时候，用户自己加的黄金ETF 留在个股屏、内置的 15 只行业 ETF 在另一屏 ——
 * 同一类品种分居两处。改按「它是什么」之后两屏的语义才是干净的：
 * 左边是股票，右边是场内基金，内置与手动加的混在一起（用是否可移除区分）。
 *
 * 判据在 `@shared/watch-split`（纯函数，有用例）—— 渲染层没有测试，
 * 这种「谁进哪一屏」的判据不该埋在 JSX 里靠肉眼验收。
 */
const WATCH_TABS = [
  { id: 'STOCK', label: '个股' },
  { id: 'ETF', label: 'ETF' },
] as const

/**
 * Electron 会把主进程抛出的 Error 包成 "Error invoking remote method 'x': Error: 真正的原因"。
 * 直接显示这串会把「代码不认识」这种用户能自己修的问题埋在噪音里。
 */
function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker >= 0 ? raw.slice(marker + 'Error: '.length) : raw
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function changeTone(value: number): string {
  // A 股习惯：红涨绿跌
  if (value > 0) return 'text-rose-400'
  if (value < 0) return 'text-emerald-400'
  return 'text-white/60'
}

function Banner({ tone, children }: { tone: 'warn' | 'info'; children: React.ReactNode }): React.JSX.Element {
  const cls =
    tone === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
      : 'border-white/15 bg-white/5 text-white/60'
  return <p className={`rounded border px-3 py-2 text-xs ${cls}`}>{children}</p>
}

/**
 * 底部时钟（2026-08-15）。
 *
 * 显示的是**引擎正在用的那个时间**：校准后的北京时间，不是系统托盘上那个。
 * 这两者在两种情况下会不一样，而它们恰恰是最需要看见的时候 ——
 * 机器不在 +08 时区（托盘显示本地时间），或者本机时钟真的偏了（已被校正）。
 * 时段判定、尾盘窗口、信号的 created_at 用的都是这里显示的这个时刻。
 *
 * **自带 state 与 interval，不挂在 App 上**：面板是常驻挂载的，
 * 每秒钟让整棵树重渲染一次太贵，而这里只需要一个 `<span>` 重画。
 *
 * 拿不到校准量时显式说「未校准」。这一档看着多余，但它是「读不到就说读不到」的落点：
 * 校时探测失败（离线、被挡）时这个时刻退化成本机钟，而那正是它可能不准的时候。
 */
function FooterClock({ offsetMs }: { offsetMs?: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // 先加偏移再用 getUTC* 读 —— 用 getHours() 会按宿主时区二次偏移（与 IntradayChart 同一口径）
  const at = new Date(now + (offsetMs ?? 0) + SHANGHAI_OFFSET_MS)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const clock = `${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`

  return (
    <span
      className="shrink-0 tabular-nums"
      title={
        offsetMs === undefined
          ? '尚未取到校时样本，暂用本机时钟'
          : `已按行情服务器校正 ${Math.round(offsetMs)} ms`
      }
    >
      北京时间 {clock}
      {offsetMs === undefined ? '（未校准）' : ''}
    </span>
  )
}

function StatusBar({
  status,
  health,
}: {
  status: EngineStatus | null
  health: ProviderHealth[]
}): React.JSX.Element {
  const session = status ? (SESSION_LABEL[status.session] ?? status.session) : '…'
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="gp-chip">
        时段 <span className="text-white/80">{session}</span>
      </span>
      <span className="gp-chip">
        自选 <span className="text-white/80">{status?.watchCount ?? 0}</span> 只
      </span>
      {status?.doNotDisturb ? (
        // 免打扰的成因要摆出来：用户问的是「为什么刚才没弹」，不是「有没有静默」
        <span className="gp-chip text-amber-200/80">
          免打扰生效中{status.doNotDisturbReason ? `（${status.doNotDisturbReason}）` : ''}
        </span>
      ) : null}
      {health.length === 0 ? (
        <span className="gp-chip">数据源 …</span>
      ) : (
        health.map((h) => (
          <span className="gp-chip" key={h.provider} title={h.lastError ?? ''}>
            {h.provider}{' '}
            <span className={HEALTH_TONE[h.status]}>
              {HEALTH_LABEL[h.status]}
              {h.successRate > 0 ? ` ${Math.round(h.successRate * 100)}%` : ''}
            </span>
          </span>
        ))
      )}
    </div>
  )
}

/**
 * 添加自选。**两屏共用一个**（2026-08-18）：它坐在 tab 那一行的右半边，
 * 而不是像以前那样只挂在个股屏。
 *
 * 分屏判据已经是「代码是什么」而不是「你在哪一屏加的」，所以让用户先切对屏再输入
 * 是一个纯粹多余的步骤 —— 输 `159915` 就该进 ETF 屏，与他当时看着哪一屏无关。
 * 加完由上层切屏并滚过去（`pendingFocus`），用户不用自己去找它落在哪。
 *
 * 错误绝对定位在输入框下方：它挂在 `gp-card-head` 里，占高度会把整张卡的表头撑开一跳。
 */
function AddForm({ onAdd }: { onAdd: (code: string) => Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    const code = value.trim()
    if (!code || busy) return
    setBusy(true)
    setError(null)
    try {
      await onAdd(code)
      setValue('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="relative ml-auto flex min-w-0 flex-1 gap-1.5" onSubmit={(e) => void submit(e)}>
      <input
        className="min-w-0 flex-1 rounded border border-white/15 bg-black/25 px-2 py-1 text-xs outline-none placeholder:text-white/25 focus:border-white/35"
        placeholder="添加：600000 / 159915"
        title="股票与场内基金都从这里加，加完会自动切到它所属的那一屏"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button className="gp-btn shrink-0" type="submit" disabled={busy || value.trim() === ''}>
        {busy ? '添加中…' : '添加'}
      </button>
      {error ? (
        <p className="absolute right-0 top-full z-10 mt-1 max-w-full rounded border border-rose-400/30 bg-[var(--gp-surface)] px-2 py-1 text-xs text-rose-300 shadow-lg">
          {error}
        </p>
      ) : null}
    </form>
  )
}

function WatchRow({
  item,
  quote,
  position,
  tHint,
  first,
  last,
  removable = true,
  highlight = false,
  dragging = false,
  dimmed = false,
  dropEdge = null,
  innerRef,
  onRemove,
  onMove,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  onOpen,
  onEditStop,
}: {
  item: WatchItem
  quote: QuoteTick | undefined
  position: PositionView | undefined
  /**
   * 本轮的日内做T建议（`core/risk/intraday-t.ts`）。挂在自选行而不是信号列表里：
   * 它**只对持仓给**，而且与「引擎今天判了什么」是并列的两件事 ——
   * 放进信号流水会让人以为引擎又出了一条结论。
   */
  tHint: IntradayTHint | undefined
  first: boolean
  last: boolean
  /** 显示移除按钮。内置的「行业ETF」组传 false —— 删了下次启动会被补回来 */
  removable?: boolean
  /** 刚添加进来的那一行：上层要滚到它，并短暂高亮让人看见它落在哪 */
  highlight?: boolean
  /** 正被拖着的就是这一行 */
  dragging?: boolean
  /**
   * 拖动进行中，而这一行**不是合法落点**（不同段）。灰下去而不是插一条提示 ——
   * 提示条会在拖动开始那一刻把整列表推下去一行，拖着的目标跟着跑。
   */
  dimmed?: boolean
  /** 落点指示线画在这一行的哪一边（拖动方向决定），不是落点就传 null */
  dropEdge?: 'TOP' | 'BOTTOM' | null
  /** 上层用来 `scrollIntoView` 的把手。只给 `highlight` 那一行装 */
  innerRef?: (el: HTMLLIElement | null) => void
  onRemove: (code: SecCode) => void
  onMove: (code: SecCode, delta: number) => void
  onDragStart: (code: SecCode) => void
  /** 拖到这一行上。返回 false 表示不接受（上层按段判），此时不许 preventDefault */
  onDragOver: (code: SecCode) => boolean
  onDragEnd: () => void
  onDrop: (code: SecCode) => void
  /** 打开详情抽屉。`tab` 决定落在哪一页 */
  onOpen: (code: SecCode, tab: StockTab) => void
  /**
   * 打开「重画止损线」。**与 `onOpen(code, 'POSITION')` 不是一回事** ——
   * 后者落在成交录入那一屏，而止损那一段在没有报价时根本不渲染。
   */
  onEditStop: (code: SecCode) => void
}): React.JSX.Element {
  // 没有报价 ≠ 报价为 0。这一栏在拿到第一轮快照前显示 '—'，不显示数字
  const stale = quote?.stale === true
  const floatingPct =
    position && quote && position.cost > 0 ? ((quote.last - position.cost) / position.cost) * 100 : null

  return (
    /*
      持仓行左侧一条竖线（2026-08-16）。**用左边框而不是整行底色**：
      这一行里已经有涨跌的红/绿、做T的紫、行业的青，再加一层底色会把它们压掉。
      非持仓行给一条**透明**的同宽边框，否则两种行会差 2px、看起来像没对齐。

      色系选 sky：与「公告」页的持仓标记同一个色，且避开 rose/emerald（涨跌）、
      teal（行业ETF 观察名单）、violet（做T建议）—— 那三个都已经有确定含义。

      ⚠ 底色**三选一，写成互斥的三元**而不是叠两个 `bg-sky-400/*` 类：
      同为工具类时谁生效取决于**样式表里的先后**，不是 className 里的先后 ——
      叠着写的话「刚添加的高亮」会不会盖住持仓底色，取决于 Tailwind 这次怎么排，
      而那是一个每次构建都可能翻转、且只在持仓行上出现的差异。
    */
    <li
      ref={innerRef}
      /*
        整行可拖（不只把手）—— 把手只是让人看得见这件事能做。
        `select-none` 是必需的：不加的话按住往下拖会先选中一片文字，
        浏览器把它当成「拖选文本」，行本身反而不动。

        落点指示线是一条**绝对定位的 2px 条**（所以这里要 `relative`），
        不是 border、不是底色：这一行的 `border-b` / `border-l` 与三选一的底色
        都已经有确定含义（见下面那段注释），再往里挤会把「持仓」「刚添加」两个标记压掉。
      */
      draggable
      onDragStart={(event) => {
        // Chromium 下不设 data 也能拖，但设了才有标准的 move 光标
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', item.code)
        onDragStart(item.code)
      }}
      onDragOver={(event) => {
        // 不接受就**不 preventDefault**：drop 事件因此根本不会来，
        // 光标也变成禁止符 —— 拒绝这件事不需要额外写一行代码去挡
        if (!onDragOver(item.code)) {
          event.dataTransfer.dropEffect = 'none'
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop(item.code)
      }}
      onDragEnd={onDragEnd}
      className={`relative border-b border-l-2 border-b-white/[0.06] transition-colors select-none last:border-b-0 hover:bg-white/[0.02] ${
        item.hasPosition ? 'border-l-sky-400/60' : 'border-l-transparent'
      } ${highlight ? 'bg-sky-400/15' : item.hasPosition ? 'bg-sky-400/[0.03]' : ''} ${
        dragging ? 'opacity-40' : dimmed ? 'opacity-25' : ''
      }`}
    >
      {/* `pointer-events-none` 是必需的：它盖在行上，会吃掉 dragover ⇒ 落点一闪就没 */}
      {dropEdge ? (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-x-0 h-0.5 bg-sky-400 ${
            dropEdge === 'TOP' ? 'top-0' : 'bottom-0'
          }`}
        />
      ) : null}

      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        {/*
          整行是打开详情的按钮。上移/下移/移除三个小按钮在它外面 ——
          嵌在按钮里的按钮点起来会连带触发外层，那是「点了移除结果弹出详情」的来源
        */}
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen(item.code, 'QUOTE')}>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate">{item.name}</span>
              {item.hasPosition ? (
                <span className="shrink-0 rounded bg-sky-400/15 px-1 text-[10px] text-sky-200/85">持仓</span>
              ) : null}
              {/*
                日内做T建议。**不是提醒**：它不进 alert_log、不点状态点、不发气泡，
                只在这里和悬浮条上出现（core/risk/intraday-t.ts 的第 2 条边界）。
                紫色与买卖两色都拉开 —— 它是并排的另一件事，不是引擎改口。
              */}
              {tHint ? (
                <span
                  className="shrink-0 rounded bg-violet-400/15 px-1 text-[10px] text-violet-200/85"
                  title={`${T_HINT_TITLE[tHint.side]}（${tHint.reason}）`}
                >
                  {T_HINT_LABEL[tHint.side]}
                </span>
              ) : null}
            </span>
            <span className="block font-mono text-xs text-white/40">
              {item.code}
              {item.industry ? ` · ${item.industry}` : ''}
            </span>
          </span>

          {/*
            `title` 上标出数据时刻（2026-08-19）。灰显只说「别当实时用」，
            答不了「有多旧」—— 而重启之后差别很大：3 分钟前的和上周五收盘的都是灰的，
            但只有一个还值得看。走 shanghaiMdHhmm，**不许用 toLocaleTimeString**
            （宿主时区上会把北京 09:03 写成 08:03，而同一屏还有一个北京时钟）
          */}
          <span
            className={`w-16 text-right font-mono ${stale ? 'text-white/35' : ''}`}
            title={quote && stale ? `${shanghaiMdHhmm(quote.at)} 的价，非实时` : undefined}
          >
            {quote ? quote.last.toFixed(2) : '—'}
          </span>
          <span
            className={`w-18 text-right font-mono ${stale ? 'text-white/35' : changeTone(quote?.changePct ?? 0)}`}
          >
            {quote ? signed(quote.changePct) : '—'}
          </span>
        </button>

        <div className="flex shrink-0 justify-end gap-0.5 text-xs text-white/40">
          {/*
            「仓」以前对「行业ETF」组不显示（2026-08-15 的取舍：那 15 只是观察名单）。
            2026-08-18 用户要在行业 ETF 上真的建仓，那条限制去掉了 ——
            连带的是提醒轨：有持仓即翻回 PRIMARY（`main/alerts/track.ts`），
            否则止损会留在只有 2 条日配额、且抢不到气泡的 OBSERVE 轨上。
          */}
          <button
            className="px-1 hover:text-white/80"
            title="持仓与成交录入"
            onClick={() => onOpen(item.code, 'POSITION')}
          >
            仓
          </button>
          {/*
            拖动把手。**它自己不带 `draggable`** —— 整行才是被拖的东西，
            把手只负责说「这行能拖」并给 grab 光标。给它单独加 draggable 的话，
            从把手起手拖的是这个 span，拖影只有一个小图标，看着像拖丢了。
          */}
          <span
            className="cursor-grab px-1 leading-none active:cursor-grabbing"
            title="按住拖动排序。持仓与非持仓各自成段，不能拖到另一段里去"
          >
            ⠿
          </span>
          <button
            className="px-1 hover:text-white/80 disabled:opacity-25"
            disabled={first}
            title="上移"
            onClick={() => onMove(item.code, -1)}
          >
            ↑
          </button>
          <button
            className="px-1 hover:text-white/80 disabled:opacity-25"
            disabled={last}
            title="下移"
            onClick={() => onMove(item.code, 1)}
          >
            ↓
          </button>
          {removable ? (
            <button className="px-1 hover:text-rose-300" title="移除" onClick={() => onRemove(item.code)}>
              ×
            </button>
          ) : null}
        </div>
      </div>

      {/* 有持仓时把浮盈亏摆在行里：那是用户最常想看的一个数，不该要点进抽屉才知道 */}
      {position ? (
        <div className="flex items-baseline gap-2 px-3 pb-1.5 text-[10px] text-white/35">
          <span>{position.shares} 股</span>
          <span>成本 {position.cost.toFixed(3)}</span>
          {floatingPct === null ? null : (
            <span className={changeTone(floatingPct)}>{signed(floatingPct)}</span>
          )}
          {/*
            止损线的入口与状态（2026-08-15）。**摆在浮亏这个数旁边**，
            因为用户想起「这条线该挪一挪」的那一刻，看的正是这个数。

            以前它只在抽屉 → 持仓页里，于是「跌破 8% 之后每天都提醒同一件事」
            这个已经解决了的问题，在用户那里仍然是个没解决的问题 —— 他找不到开关。

            **两个态都点进同一个表单，这里不做任何修改动作。** 一键重置会把
            009 那个刻意的确认流程（填一个价 + 把代价原话写出来）退化成
            「让它别响」，而这个按钮关掉的是一条 L3 强制提醒。
          */}
          {position.stopAck ? (
            // 已确认过的**一直显示**：这是用户主动关掉了一个安全提醒的凭据，
            // 藏起来的话他日后只会觉得「跌了这么多怎么没提醒我」（PositionView.stopAck）
            <button
              className="text-amber-200/70 underline decoration-dotted underline-offset-2 hover:text-amber-100"
              title={`你已接受 ${position.stopAck.ackLossPct.toFixed(1)}% 的亏损，跌破 ${position.stopAck.stopFloor} 才会再提醒。点开可改或撤销`}
              onClick={() => onEditStop(item.code)}
            >
              止损 {position.stopAck.stopFloor}
            </button>
          ) : position.stopBreached ? (
            // 还没跌破的票不给这个入口：那时提「要不要改止损线」只是噪音。
            // 判据由主进程算（`stopBreached`），渲染层不许自己拿 0.08 去比
            <button
              className="text-amber-200/70 underline decoration-dotted underline-offset-2 hover:text-amber-100"
              title="已触及止损线。可以确认接受这一段亏损并把线往下挪：挪之后跌到新线之前不再因为亏损提醒你（移动止损、回撤减仓、盈利保护照旧）"
              onClick={() => onEditStop(item.code)}
            >
              重画止损线
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export function App(): React.JSX.Element {
  /**
   * 免责声明闸门（docs/01 §8）。三态：
   *   null  还没读到设置 —— 什么都别画，避免引导闪一下又消失
   *   false 没确认过 → 只画引导
   *   true  可以进主界面
   */
  const [accepted, setAccepted] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('OVERVIEW')
  const [items, setItems] = useState<WatchItem[]>([])
  const [watchTab, setWatchTab] = useState<WatchTab>('STOCK')
  /**
   * 刚添加进来的那一只：切到它所属的那一屏、滚过去、短暂高亮，然后清空。
   *
   * 加完不定位的话，一只 ETF 会落在另一屏的某个位置上，用户看到的是「点了添加，
   * 什么都没发生」—— 而列表可能有二十来行，他并不知道该去哪一屏找。
   * **重复添加（幂等）也照样定位**：那正是他想确认的事（「我是不是已经加过了」）。
   */
  const [pendingFocus, setPendingFocus] = useState<SecCode | null>(null)
  const [quotes, setQuotes] = useState<QuoteTick[]>([])
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [positions, setPositions] = useState<PositionView[]>([])
  /*
    本轮的日内做T建议。**每轮全量替换**：它的时效只有几十分钟，
    留着上一轮的会让早上那条建议一直挂到收盘（push:intradayT 的头注释记着同一条）。
  */
  const [tHints, setTHints] = useState<IntradayTHint[]>([])
  const [error, setError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<TransferOutcome | null>(null)
  // 引擎每轮跑完会推一次 engineStatus；用它当信号与提醒日志的重取信号
  const [signalKey, setSignalKey] = useState(0)
  /**
   * AI 解读是否可用（已启用 + 有 key + 有模型名）。
   *
   * **状态提到 App 这一层是必须的。** 它原来放在 SignalList 里、只在挂载时读一次 ——
   * 而概览页是**常驻挂载**的（只切 display），面板窗口又是懒建之后一直留着的，
   * 于是「读一次」= 整个应用生命周期读一次：用户在设置页打开 AI 再切回概览，
   * 入口永远不出现，看起来就是「开了但没有功能入口」。
   * 现在切回概览时重读，设置页改完也会主动回调重读。
   */
  const [aiReady, setAiReady] = useState(false)
  /*
    信号的拉取与分组提到这一层（原先在 SignalList 里）：抽屉现在有三个入口，
    其中两个在自选列表那边，而抽屉的信号页要拿到同一份分组数据。
    「展开了哪一条依据」也在这里（useSignalEvidence），列表与抽屉共用一份。
  */
  const [signalRecords, setSignalRecords] = useState<SignalRecord[]>([])
  /*
    今天命中的观察点。与信号合流成一条**按股票**的时间线（groupSignals 的第二个入参）
    —— 用户看一只票时想看的是变化：早上出了买入信号 → 下午他自己设的失效条件命中了
    → 引擎又给了卖出。这三件事挨着看才有意义。

    **它不是信号**，所以不写进 signal 表、也不计入方向徽标的计数（见 groupSignals 头注释）。
  */
  const [watchHits, setWatchHits] = useState<WatchPointView[]>([])
  const [showSuppressed, setShowSuppressed] = useState(true)
  const signalEvidence = useSignalEvidence(setError)
  /*
    抽屉：看哪只、落在哪个页签、AI 页签解读哪一条。null = 关着。

    **AI 的状态挂在这一层是刻意的**：它原先内嵌在信号行里，而那个列表每轮 tick 都在重排
    （同一只票来条新信号就换组头），正在流式生成的解读跟着被卸载、请求被取消，
    而那次调用已经计过费。挂在这里之后，列表怎么分组、排序、条件渲染都碰不到它。
  */
  const [drawer, setDrawer] = useState<{
    code: SecCode
    tab: StockTab
    aiSignalId?: string
    /** 从自选行的「止损线」入口进来的：持仓页要直接把那个表单展开（见 TradePanel.stopIntent） */
    stopIntent?: boolean
  } | null>(null)
  const [ledger, setLedger] = useState<TradeLedger | null>(null)
  const [tradeBusy, setTradeBusy] = useState(false)
  /*
    「今天」只在挂载时算一次并存住：每次渲染现算的话，跨午夜那一刻起点会变，
    而面板是常驻挂载的（下面只切 display），真的会跨午夜。
    refreshKey 每轮引擎跑完都递增，届时自然重新对齐。
  */
  const [dayStart] = useState(() => shanghaiDayStartMs(Date.now()))

  /** ACTIVE 观察点数，显示在标签上 —— 「软件在盯什么」要一眼看见 */
  const [watchActive, setWatchActive] = useState(0)
  const [watchKey, setWatchKey] = useState(0)

  const refreshWatch = useCallback((): void => {
    setWatchKey((key) => key + 1)
    void window.gp
      .invoke('watch:list', { status: 'ACTIVE', limit: 200 })
      .then((rows) => setWatchActive(rows.length))
      .catch(() => setWatchActive(0))
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [list, providers, held] = await Promise.all([
        window.gp.invoke('watchlist:list'),
        window.gp.invoke('app:providerHealth'),
        window.gp.invoke('position:list'),
      ])
      setItems(list)
      setHealth(providers)
      setPositions(held)
      setError(null)
    } catch (err) {
      // 数据层装配失败时 watchlist:list 会抛「数据层尚未就绪」—— 如实显示，不吞
      setError(errorText(err))
    }
  }, [])

  // ── 信号：拉取 → 过滤 → 分组 ──────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void window.gp
      /*
        `perCode` 是防饥饿的闸门：全局 limit 会被单只刷屏的票吃光，
        而症状是「早上那批信号凭空不见了」，界面上完全看不出来
        （2026-08-14 实测过一次真的，判据见 SignalQuery.perCode）。
        20 条足够画一只票的当日时间线 —— 它本来就是折叠成一组显示的。
      */
      .invoke('signal:history', { from: dayStart, limit: 200, perCode: 20 })
      .then((rows) => {
        if (!cancelled) setSignalRecords(rows)
      })
      .catch((err: unknown) => setError(errorText(err)))

    // 命中的观察点只取**今天**的：这条时间线画的是「今天这只票怎么了」，
    // 上周命中的那条挂在今天的信号旁边会让人以为它刚发生
    void window.gp
      .invoke('watch:list', { status: 'HIT', limit: 200 })
      .then((rows) => {
        if (!cancelled) setWatchHits(rows.filter((row) => (row.hitAt ?? 0) >= dayStart))
      })
      .catch((err: unknown) => setError(errorText(err)))

    return () => {
      cancelled = true
    }
  }, [signalKey, dayStart])

  /*
    先按「含被静默的」过滤，**再**分组 —— 顺序不能倒过来。
    倒过来的话徽标会数上几条用户当前看不到的信号，而「写着 4 条、展开只有 1 条」
    这种对不上比少显示更难排查（groupSignals 的头注释记着同一条）。
  */
  const { groups, suppressedCount } = useMemo(() => {
    const suppressed = signalRecords.filter((r) => r.suppressedReason !== undefined)
    const visible = showSuppressed
      ? signalRecords
      : signalRecords.filter((r) => r.suppressedReason === undefined)
    return { groups: groupSignals(visible, watchHits), suppressedCount: suppressed.length }
  }, [signalRecords, showSuppressed, watchHits])

  // ── 详情抽屉与成交流水 ───────────────────────────────────────
  const loadLedger = useCallback((code: SecCode): void => {
    void window.gp
      .invoke('trade:list', { code })
      .then(setLedger)
      .catch((err: unknown) => setError(errorText(err)))
  }, [])

  /*
    打开详情抽屉。`aiSignalId` 只在从信号行点「AI 解读」时给 —— 它决定 AI 页签
    默认解读哪一条；不给时那一页取该股最新那条。

    **必须定义在 renderSignalRow 之前**：那个回调里要用它，而 `const` 有 TDZ。
    顺序反过来时首屏不会报错（回调体是延迟执行的），但一旦有人把它加进 deps 数组
    就会变成启动即崩，而那个崩溃点看起来与本文件无关。
  */
  const openDrawer = useCallback(
    (code: SecCode, drawerTab: StockTab, aiSignalId?: string): void => {
      setDrawer({ code, tab: drawerTab, ...(aiSignalId === undefined ? {} : { aiSignalId }) })
      // 账本每次打开都重拉：它可能在别处被改过（导入配置、另一只票的重放）
      setLedger(null)
      loadLedger(code)
    },
    [loadLedger]
  )

  /**
   * 从自选行的「止损线」入口打开抽屉。
   *
   * 与 `openDrawer(code, 'POSITION')` 的差别是那个 `stopIntent` ——
   * 少了它，用户点「止损线」落地看到的是**成交录入表单**，
   * 而止损那一段可能根本没渲染（它要求「有报价且正在亏损」，休市时没有报价）。
   * 那正是用户报的「让我录入成交，我很疑惑」。
   */
  const openStopEditor = useCallback(
    (code: SecCode): void => {
      setDrawer({ code, tab: 'POSITION', stopIntent: true })
      setLedger(null)
      loadLedger(code)
    },
    [loadLedger]
  )

  /**
   * 走 `OBSERVE` 轨的标的。信号列表拿它决定要不要把那条结论画成中性色。
   *
   * **判据必须与主进程的 `alertTrackOf` 一致**（2026-08-18）：
   * 中性色表达的是「这条不会像个股那样提醒你」，而有持仓的行业 ETF 已经翻回 PRIMARY，
   * 它的结论是可执行的 —— 继续画成观察色就是在说一句与实际行为相反的话。
   *
   * 与 `openDrawer` 同一条理由，**必须定义在 renderSignalRow 之前**（`const` 有 TDZ，
   * 而它进了那个回调的 deps 数组 —— 顺序反过来是启动即崩）。
   */
  const observeCodes = useMemo(
    () =>
      new Set(
        items
          .filter((item) => item.group === INDUSTRY_ETF_GROUP && !item.hasPosition)
          .map((item) => item.code)
      ),
    [items]
  )

  /** 信号行由这一层渲染：列表与抽屉共用同一份展开状态（见 useSignalEvidence） */
  const renderSignalRow = useCallback(
    (record: SignalRecord): React.JSX.Element => (
      <SignalRow
        record={record}
        // 用户自己设的条件把这条结论否掉了 / 确认了。与悬浮条共用同一份判据
        mark={watchMarkOf(record.id, watchHits)}
        // 走观察轨的结论（无持仓的行业 ETF）颜色必须与可执行的买卖分开
        observational={observeCodes.has(record.code)}
        expanded={signalEvidence.expandedId === record.id}
        evidence={signalEvidence.evidence[record.id] ?? null}
        aiReady={aiReady}
        onOpenAi={(row) => openDrawer(row.code, 'AI', row.id)}
        onToggle={signalEvidence.toggle}
      />
    ),
    [signalEvidence, aiReady, openDrawer, watchHits, observeCodes]
  )

  /**
   * 录一笔成交。成功后同时刷三处：账本（抽屉里）、自选行的持仓角标、以及引擎状态
   * —— 持仓变了会打开/关闭止损类强制提醒那条通道（docs/05 §2.3），
   * 不刷的话用户看到的是「录完了但列表上还是没持仓」。
   */
  const submitTrade = useCallback(
    (draft: { side: 'BUY' | 'SELL'; price: number; shares: number; tradedAt: number; note?: string }): void => {
      const code = drawer?.code
      if (code === undefined) return
      setTradeBusy(true)
      void window.gp
        .invoke('trade:add', { code, ...draft })
        .then((next) => {
          setLedger(next)
          void reload()
        })
        .catch((err: unknown) => setError(errorText(err)))
        .finally(() => setTradeBusy(false))
    },
    [drawer, reload]
  )

  const removeTrade = useCallback(
    (id: string): void => {
      setTradeBusy(true)
      void window.gp
        .invoke('trade:remove', id)
        .then((next) => {
          setLedger(next)
          void reload()
        })
        .catch((err: unknown) => setError(errorText(err)))
        .finally(() => setTradeBusy(false))
    },
    [reload]
  )

  const refreshAiReady = useCallback((): void => {
    void window.gp
      .invoke('ai:config')
      .then((config) => setAiReady(config.enabled && config.hasKey && config.model !== ''))
      .catch(() => setAiReady(false))
  }, [])


  useEffect(() => {
    // 设置读失败也要能进主界面：把用户锁在引导页外面（或里面）比少弹一次声明糟得多。
    // 声明本身在「设置 → 关于」里随时可查，所以这条兜底不会让它彻底看不到
    void window.gp
      .invoke('settings:get')
      .then((next: AppSettings) => setAccepted(next.disclaimerAcceptedAt !== undefined))
      .catch(() => setAccepted(true))
  }, [])

  const acceptDisclaimer = useCallback(async (): Promise<void> => {
    const next = await window.gp.invoke('settings:patch', { disclaimerAcceptedAt: Date.now() })
    // 以主进程回写的结果为准，不是「点了就算」：写盘失败时 Onboarding 会显示错误并留在原地
    if (next.disclaimerAcceptedAt === undefined) throw new Error('设置没能保存下来，请检查数据目录是否可写')
    setAccepted(true)
  }, [])

  useEffect(() => {
    void window.gp.invoke('app:engineStatus').then(setStatus)
    void reload()

    const offStatus = window.gp.on('push:engineStatus', (next) => {
      setStatus(next)
      setSignalKey((key) => key + 1)
    })
    const offQuotes = window.gp.on('push:quoteTick', (ticks) => {
      setQuotes(ticks)
      // 每轮取数后基础信息可能补上了名称/行业，健康度也变了，顺带重取一次
      void reload()
    })
    // 全量替换：主进程每轮都推，没有建议时推空数组（见 push:intradayT 的说明）
    const offTHints = window.gp.on('push:intradayT', setTHints)
    return () => {
      offStatus()
      offQuotes()
      offTHints()
    }
  }, [reload])

  // 切回概览时重读一次 AI 可用性 —— 概览是常驻挂载的，指望它自己重挂是指望不到的
  useEffect(() => {
    if (tab === 'OVERVIEW') refreshAiReady()
  }, [tab, refreshAiReady])

  // 观察点计数跟着引擎每轮走：命中会让 ACTIVE 少一个，标签上的数要跟上
  useEffect(refreshWatch, [refreshWatch, signalKey])

  const quoteOf = useMemo(() => new Map(quotes.map((q) => [q.code, q])), [quotes])
  const positionOf = useMemo(() => new Map(positions.map((p) => [p.code, p])), [positions])
  const tHintOf = useMemo(() => new Map(tHints.map((h) => [h.code, h])), [tHints])

  const refreshStatus = useCallback((): void => {
    void window.gp.invoke('app:engineStatus').then(setStatus)
  }, [])

  /**
   * 添加一只。**以主进程回写的那一行为准**来决定切到哪一屏 ——
   * 用户输的是 `159915` / `sz159915` / `159915.SZ` 里的任意一种，
   * 规范化只在主进程做一次（`engine/watchlist.ts` 的头注释），
   * 在这里照着输入串猜代码等于把那件事抄第二遍。
   */
  const add = useCallback(
    async (code: string, group?: string): Promise<void> => {
      const item = await window.gp.invoke('watchlist:add', code, group)
      await reload()
      setWatchTab(watchTabOf(item.code))
      setPendingFocus(item.code)
    },
    [reload]
  )


  const remove = useCallback(
    (code: SecCode): void => {
      void window.gp
        .invoke('watchlist:remove', code)
        .then(() => reload())
        .catch((err: unknown) => setError(errorText(err)))
    },
    [reload]
  )

  /**
   * 落库新顺序。**先动 UI 再落库**（落库失败由 reload 纠正回来）——
   * 上移/下移与拖动共用这一处，两处各写一份的症状是「一种方式排得住、另一种排不住」。
   */
  const persistOrder = useCallback(
    (next: WatchItem[]): void => {
      setItems(next)
      void window.gp
        .invoke(
          'watchlist:reorder',
          next.map((item) => item.code)
        )
        .then(() => reload())
        .catch((err: unknown) => setError(errorText(err)))
    },
    [reload]
  )

  /**
   * 上移/下移。
   *
   * ⚠ `delta` 是**在当前 tab 这一屏里**的位移，不是全局列表里的。
   * `sort_order` 只有一份（全局），而界面按分组切成了两屏 ——
   * 直接在全局数组里 ±1 会让「在行业ETF 里点上移」跟一只**股票**换位置，
   * 表现是那一行原地不动（它换到了另一个 tab 里去）。
   * 所以先在可见子集里找到邻居，再把这两只在全局数组里**对调**。
   */
  const move = useCallback(
    (code: SecCode, delta: number, visible: readonly WatchItem[]): void => {
      const at = visible.findIndex((item) => item.code === code)
      const neighbour = at < 0 ? undefined : visible[at + delta]
      if (!neighbour) return
      const next = [...items]
      const a = next.findIndex((item) => item.code === code)
      const b = next.findIndex((item) => item.code === neighbour.code)
      if (a < 0 || b < 0) return
      const [itemA, itemB] = [next[a], next[b]]
      if (!itemA || !itemB) return
      next[a] = itemB
      next[b] = itemA
      persistOrder(next)
    },
    [items, persistOrder]
  )

  /**
   * 拖动排序（2026-08-24）。
   *
   * 判据全在 `@shared/watch-split`（纯函数、有用例）：同段才认，落点是「占掉目标那一格」。
   * 这里只管三件事 —— 记住正在拖谁、把落点算成一条线、放手时落库。
   *
   * ⚠ **`dragOver` 里绝不能无条件 setState**：dragover 每几十毫秒就来一次，
   * 每次都 setState 会让这一列表在拖动全程持续重渲染（同一屏上还挂着每 30 秒
   * 一跳的行情推送）。所以同一个落点直接返回原对象。
   */
  const [drag, setDrag] = useState<{ code: SecCode; over: SecCode | null } | null>(null)

  const dragOver = useCallback(
    (code: SecCode): boolean => {
      if (!drag) return false
      const ok = canReorderWatch(
        items.find((item) => item.code === drag.code),
        items.find((item) => item.code === code)
      )
      if (!ok) return false
      setDrag((prev) => (!prev || prev.over === code ? prev : { ...prev, over: code }))
      return true
    },
    [drag, items]
  )

  const drop = useCallback(
    (code: SecCode): void => {
      const from = drag?.code
      setDrag(null)
      if (!from) return
      const next = reorderWatchItems(items, from, code)
      if (next) persistOrder(next)
    },
    [drag, items, persistOrder]
  )

  const onTransfer = useCallback(
    (outcome: TransferOutcome): void => {
      // 静默取消（用户在文件框里按了取消、且解析阶段没产生 warning）什么都不说 ——
      // 存下来会让横幅区留一条空白，那比没有更奇怪
      const silent = outcome.result.status === 'CANCELED' && outcome.result.warnings.length === 0
      setTransfer(silent ? null : outcome)
      // 导入成功后整份自选与持仓都换了，界面必须立刻跟上，不能等下一轮 tick
      if (outcome.kind === 'import' && outcome.result.status === 'DONE') {
        // 抽屉里那只票的持仓与账本已经被整份换掉了，关掉比留一屏旧数字诚实
        setDrawer(null)
        void reload()
        refreshStatus()
        setSignalKey((key) => key + 1)
      }
    },
    [reload, refreshStatus]
  )

  /*
    本机时钟偏差。只在**分钟级**才提 —— 秒级偏差对时段判定没有影响，
    而一条常亮的提示条会让用户学会无视所有横幅。
    注意 `clockOffsetMs` 可能是 0（已校准且刚好对齐），所以判 undefined 而不是判真值。
  */
  /*
    两屏的内容与顺序。判据全在 `@shared/watch-split`（纯函数，有用例）——
    分屏按代码段推出的板块，段内**持仓优先且保持用户自己排的顺序**。

    **ETF 那一屏 2026-08-18 起也排**：它不再是「不设持仓的观察名单」，
    有持仓的同样该一眼看到。两屏因此逐字同规则，`first`/`last` 的段边界算法也共用。
  */
  const split = useMemo(() => splitWatchItems(items), [items])
  const visibleWatch = watchTab === 'ETF' ? split.etf : split.stock

  /*
    拖动中的两个派生量。`dragAt` 是被拖那一行在**当前屏**里的下标 ——
    往下拖把线画在目标下沿、往上拖画在上沿，与 `reorderWatchItems` 的落点语义
    （占掉目标那一格）对得上。被拖的那只可能不在这一屏（拖着切了 tab），
    那时 `dragAt < 0`，一条线都不画。
  */
  const dragItem = drag ? items.find((item) => item.code === drag.code) : undefined
  const dragAt = drag ? visibleWatch.findIndex((item) => item.code === drag.code) : -1

  /*
    刚添加的那一行：滚到它并短暂高亮。

    **超时一定要挂**（而不是只在 `el` 存在时挂）：拿不到那一行的可能性是真的
    （列表还没 reload 回来、或者主进程回写的代码不在任何一屏），
    只在成功路径上清 `pendingFocus` 会让一行永久高亮着，而那是个假的「刚加进来」。

    `block: 'nearest'` 而不是 `'center'`：目标已经在视野里时它一个像素都不动，
    否则每加一只都会把列表整个甩一下。
  */
  const focusRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (pendingFocus === null) return
    focusRef.current?.scrollIntoView({ block: 'nearest' })
    const timer = window.setTimeout(() => setPendingFocus(null), 1800)
    return () => window.clearTimeout(timer)
  }, [pendingFocus, visibleWatch])

  const clockOffMs = status?.clockOffsetMs
  const clockSkewed = clockOffMs !== undefined && Math.abs(clockOffMs) >= CLOCK_WARN_MS

  // 逐条显式比较而不是 `a ?? b ?? c`：这些字段是 `boolean | undefined`，
  // `false ?? x` 会停在 false 上，把后面几条横幅一起吞掉
  const hasBanner =
    error !== null ||
    status?.offline === true ||
    status?.stale === true ||
    status?.calendarUncertain === true ||
    clockSkewed ||
    transfer !== null

  // 还没读到设置：画一屏空白而不是先画引导。引导闪一下又消失比多等 20ms 难看得多
  if (accepted === null) return <main className="h-full bg-[var(--gp-bg)]" />
  if (!accepted) return <Onboarding onAccept={acceptDisclaimer} />

  return (
    <main className="flex h-full flex-col overflow-hidden">
      {/*
        这个头部**同时是窗口的标题栏**：主进程用 titleBarStyle: 'hidden' 把系统标题栏收掉了
        （浅色 Windows 主题下它是白的，压在一整屏暗色面板上格外突兀），只留三颗系统窗口控件
        画在右上角。代价是两条：
        1. 拖窗口靠 `-webkit-app-region: drag`，所以头部里**每一个可点的东西都要 no-drag**，
           否则点它等于拖窗口（按钮会「点不动」）。
        2. 右上角那块归系统，`pr-[144px]` 是给三颗控件让的位置（与 PanelWindow.ts 的
           TITLE_BAR_HEIGHT 成对，改一处要改两处）。
      */}
      <header
        className="shrink-0 border-b border-white/10 bg-[var(--gp-surface)] px-5 py-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5 pr-[144px]">
          {/* 纯装饰的品牌标记。这里**不放状态点** —— 状态点的唯一判定者是主进程的
              PetStateMachine（CLAUDE.md），面板上再放一个语义相近的点只会让两处对不上 */}
          <BrandMark />
          <h1 className="text-sm font-semibold tracking-wide">蹲点</h1>
          <span className="hidden text-xs text-white/30 sm:inline">自选 · 信号 · 提醒</span>

          <div
            className="ml-auto flex items-center gap-2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <ConfigTransferButtons onOutcome={onTransfer} />
            <button className="gp-btn" onClick={() => void reload()} title="重新读取自选与数据源健康度">
              刷新
            </button>
          </div>
        </div>

        {/* 状态条里有可点的东西（数据源健康度），不能落在拖拽区里 */}
        <div className="mt-2.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <StatusBar status={status} health={health} />
        </div>

        {/* 标签页。按钮当然不能落在拖拽区里（否则点它等于拖窗口） */}
        <div
          className="-mb-3 mt-2.5 flex gap-4"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`border-b-2 pb-1.5 text-xs transition-colors ${
                tab === item.id
                  ? 'border-sky-400/70 text-white'
                  : 'border-transparent text-white/40 hover:text-white/70'
              }`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {/* 「软件在盯 N 个条件」要一眼看见 —— 这是这个功能的全部意义 */}
              {item.id === 'WATCH' && watchActive > 0 ? (
                <span className="ml-1 rounded bg-sky-400/20 px-1 text-[10px] text-sky-200">
                  {watchActive}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </header>

      {/* 横幅区：只在真有话说时占高度，空着时一个像素都不留 */}
      {hasBanner ? (
        <div className="flex shrink-0 flex-col gap-2 px-5 pt-3">
          {error ? <Banner tone="warn">{error}</Banner> : null}
          {status?.offline ? (
            <Banner tone="warn">行情离线：数据源全部不可用，下面显示的是最后一次成功取到的价格。</Banner>
          ) : status?.stale ? (
            <Banner tone="warn">最近一轮取数失败，价格取自缓存，未必是最新的。</Banner>
          ) : null}
          {status?.calendarUncertain ? (
            <Banner tone="info">交易日历尚未核对，休市判断可能不准（节假日会照常轮询）。</Banner>
          ) : null}
          {clockSkewed ? (
            <Banner tone="info">
              本机时钟比行情服务器{(clockOffMs as number) > 0 ? '慢' : '快'}
              {Math.round(Math.abs(clockOffMs as number) / 1000)} 秒，已按服务器校正；建议检查系统时间同步。
            </Banner>
          ) : null}
          {transfer ? (
            <ConfigTransferNotice outcome={transfer} onDismiss={() => setTransfer(null)} />
          ) : null}
        </div>
      ) : null}

      {/* 影子运行与设置是单栏长内容，交给这一层滚动 */}
      {/*
        日报与观察点、影子运行同一形态：**不订阅推送**，切进来时拉一次。
        `signalKey` 每轮引擎跑完递增，切回来时自然是最新的 ——
        让一份「收盘总结」每 30 秒跳一次数字既没必要也让人分心。
      */}
      {tab === 'REPORT' ? (
        // 滚动交给**这一层**（与观察点 / 影子运行 / 设置逐字相同）。
        // 别把它改成 `flex flex-col overflow-hidden` 再让子组件 `flex-1 overflow-y-auto`：
        // 那样内层列容器被限死在视口高度，而 `.gp-card` 是 `display:flex; min-height:0`
        // 的 flex 子项、默认会**收缩** —— 内容压不下就溢出到下一张卡上面，
        // 表现是「一打开就重叠错乱」（2026-08-14 真机撞到）
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <DailyReportPanel refreshKey={signalKey} />
        </div>
      ) : null}
      {tab === 'BRIEF' ? (
        // 滚动同样交给这一层，理由与 REPORT 那一段逐字相同
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <BriefPanel onError={setError} />
        </div>
      ) : null}
      {tab === 'WATCH' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <WatchPoints refreshKey={watchKey} onChanged={refreshWatch} onError={setError} />
        </div>
      ) : null}
      {tab === 'SHADOW' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* 行情传下去只为「模拟持仓」那一节的现价与当日参考盈亏；绩效数字一律来自模拟账本 */}
          <ShadowPanel refreshKey={signalKey} quoteOf={quoteOf} onError={setError} />
        </div>
      ) : null}
      {tab === 'SETTINGS' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* onAiChanged：改完立刻重算入口可见性，不用等切回概览 */}
          <Settings onError={setError} onAiChanged={refreshAiReady} />
        </div>
      ) : null}

      {/*
        两栏。md 以下退回单列并交给这一层滚动；md 及以上两栏各自内部滚动。
        左栏权重稍大（1.4 : 1）—— 自选那一行要放名称、代码、行业、价格、涨跌与四个按钮，
        右栏的信号行短得多。
      */}
      {/*
        概览**保持挂载**（只用 display 切换）而不是条件渲染：它订阅了 push:quoteTick /
        push:engineStatus，卸载再装回来会丢掉滚动位置与正在编辑的持仓行。
        不能用 `hidden` 属性 —— Tailwind 的 `grid` 类会盖掉它带来的 `display: none`，
        这是 Tailwind 下很常见的一个坑，所以这里显式切 `grid` / `hidden` 两个类。
      */}
      <div
        className={`min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-[minmax(0,1.4fr)_minmax(300px,1fr)] md:overflow-hidden ${
          tab === 'OVERVIEW' ? 'grid' : 'hidden'
        }`}
      >
        {/*
          两个 tab 分的是**板块**（代码段推的），不是分组：左边股票，右边场内基金。
          内置的 15 只行业 ETF 与用户自己加的 ETF 因此混在同一屏 ——
          区别只在「能不能移除」（内置的删了下次启动会被补回来）。
        */}
        <section className="gp-card max-h-full">
          {/* 添加框与 tab 同一行（2026-08-18）：两屏共用一个，加完自动切屏 */}
          <div className="gp-card-head">
            <div className="flex shrink-0 items-center gap-1">
              {WATCH_TABS.map((t) => (
                <button
                  key={t.id}
                  className={`rounded px-2 py-0.5 text-sm transition-colors ${
                    watchTab === t.id ? 'bg-white/10 text-white/90' : 'text-white/40 hover:text-white/70'
                  }`}
                  onClick={() => setWatchTab(t.id)}
                >
                  {t.label}
                  {/* 只数挪进标签里，把表头右侧腾给添加框 */}
                  <span className="ml-1 text-xs text-white/30">
                    {(t.id === 'ETF' ? split.etf : split.stock).length}
                  </span>
                </button>
              ))}
            </div>
            <AddForm onAdd={(code) => add(code)} />
          </div>

          {/*
            ETF 屏的一行短注。**必须说清两档待遇**：无持仓的走观察轨
            （独立配额、抢不到气泡），有持仓的按个股待遇提醒 —— 这是同一屏里
            两种不同的行为，不写出来的话用户会按其中一种去理解另一种。
          */}
          {watchTab === 'ETF' ? (
            <p className="shrink-0 border-b border-white/10 px-3 py-2 text-xs leading-relaxed text-white/35">
              含内置 {INDUSTRY_ETFS.length} 只行业 ETF（每个行业一只，不可移除）。
              <span className="text-white/55">无持仓时走观察轨</span>：结论照常算、照常进今日信号，
              但提醒配额独立且不抢气泡；<span className="text-white/55">有持仓后按个股待遇提醒</span>。
            </p>
          ) : null}

          {visibleWatch.length === 0 ? (
            watchTab === 'ETF' ? (
              // 内置组理应非空。真空了说明播种没跑成（库打不开、代码清单坏了），
              // 那时说「暂时为空」比画一片空白诚实
              <p className="px-3 py-10 text-center text-sm text-white/35">
                内置行业 ETF 暂时为空，重启应用会自动补齐。
              </p>
            ) : (
              <p className="px-3 py-10 text-center text-sm text-white/35">还没有个股，先在上面添加一只。</p>
            )
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {visibleWatch.map((item, i) => (
                <WatchRow
                  key={item.code}
                  item={item}
                  quote={quoteOf.get(item.code)}
                  position={positionOf.get(item.code)}
                  tHint={tHintOf.get(item.code)}
                  // 段边界即禁用边界 —— 理由见 splitWatchItems 头注释的第 2 条
                  first={i === 0 || visibleWatch[i - 1]?.hasPosition !== item.hasPosition}
                  last={
                    i === visibleWatch.length - 1 ||
                    visibleWatch[i + 1]?.hasPosition !== item.hasPosition
                  }
                  // 内置组不给删除：删了下次启动又回来，那是一个点了会复活的按钮。
                  // **按项判断而不是按屏** —— 同一屏里用户自己加的 ETF 照常可删
                  removable={item.group !== INDUSTRY_ETF_GROUP}
                  highlight={pendingFocus === item.code}
                  dragging={drag?.code === item.code}
                  // 不是合法落点就灰下去。判据与 onDragOver 那道拒绝**同一个函数**，
                  // 各写一份的症状是「看着能放，放下去没反应」
                  dimmed={!!drag && drag.code !== item.code && !canReorderWatch(dragItem, item)}
                  dropEdge={
                    drag?.over === item.code && dragAt >= 0 ? (dragAt < i ? 'BOTTOM' : 'TOP') : null
                  }
                  {...(pendingFocus === item.code ? { innerRef: (el) => (focusRef.current = el) } : {})}
                  onRemove={remove}
                  onMove={(code, delta) => move(code, delta, visibleWatch)}
                  onDragStart={(code) => setDrag({ code, over: null })}
                  onDragOver={dragOver}
                  onDragEnd={() => setDrag(null)}
                  onDrop={drop}
                  onOpen={openDrawer}
                  onEditStop={openStopEditor}
                />
              ))}
            </ul>
          )}
        </section>

        <div className="flex min-h-0 flex-col gap-4">
          {/* 信号是流水，占掉右栏剩下的全部高度；提醒日志是按需展开的，按内容给高 */}
          <SignalList
            groups={groups}
            expandedId={signalEvidence.expandedId}
            suppressedCount={suppressedCount}
            showSuppressed={showSuppressed}
            onShowSuppressed={setShowSuppressed}
            renderRow={renderSignalRow}
            onOpen={(code) => openDrawer(code, 'SIGNAL')}
          />
          <AlertLog
            refreshKey={signalKey}
            unread={status?.unreadAlerts ?? 0}
            onRead={refreshStatus}
            onError={setError}
          />
        </div>
      </div>

      {/*
        这里以前有一行「信号只在这个列表里显示，还不会弹气泡或发系统通知」——
        提醒分发接上之后它就变成了一句过时的假话，所以删掉了。
        能力边界仍然对用户有意义，但现在的边界写在提醒日志里（每条为什么发/没发），
        比页脚上一句静态的话诚实得多。
      */}
      {/*
        详情抽屉。三个入口（自选行 / 「仓」按钮 / 信号徽标行）共用它 ——
        一只股票只有一个详情页，不该因为从哪进来而看到不一样的东西。
        它挂在 App 这一层而不是列表里：`fixed` 定位要躲开右栏的 overflow-hidden，
        而信号页要用的分组数据与「展开了哪一条依据」也都在这一层。
      */}
      {drawer ? (
        <StockDrawer
          code={drawer.code}
          name={items.find((item) => item.code === drawer.code)?.name ?? drawer.code}
          initialTab={drawer.tab}
          quote={quoteOf.get(drawer.code)}
          group={groups.find((g) => g.code === drawer.code)}
          ledger={ledger}
          renderSignalRow={renderSignalRow}
          countChips={(() => {
            const group = groups.find((g) => g.code === drawer.code)
            return group ? <CountChips group={group} /> : null
          })()}
          onSubmitTrade={submitTrade}
          onRemoveTrade={removeTrade}
          tradeBusy={tradeBusy}
          {...(drawer.aiSignalId === undefined ? {} : { aiSignalId: drawer.aiSignalId })}
          {...(drawer.stopIntent === true ? { stopIntent: true } : {})}
          onWatchCreated={refreshWatch}
          onStopChanged={(next) => {
            // 账本里那份持仓视图要跟着换，否则确认完界面上还是旧的那行。
            // 同时刷一次自选列表的持仓角标与引擎状态（止损通道的判据变了）
            setLedger((prev) => (prev === null ? prev : { ...prev, position: next }))
            void reload()
            refreshStatus()
          }}
          onError={setError}
          onClose={() => setDrawer(null)}
        />
      ) : null}

      {/* 免责小字靠左固定（措辞纪律：每一屏底部都要有），时钟靠右 */}
      <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-white/10 px-5 py-2 text-xs text-white/35">
        <span>{FOOTER_NOTE}</span>
        <FooterClock {...(clockOffMs === undefined ? {} : { offsetMs: clockOffMs })} />
      </footer>
    </main>
  )
}
