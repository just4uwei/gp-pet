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

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  EngineStatus,
  PositionView,
  ProviderHealth,
  QuoteTick,
  WatchItem,
} from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import { AlertLog } from './AlertLog'
import { ConfigTransferButtons, ConfigTransferNotice, type TransferOutcome } from './ConfigTransfer'
import { FOOTER_NOTE } from './disclaimer'
import { Onboarding } from './Onboarding'
import { PositionEditor } from './PositionEditor'
import { Settings } from './Settings'
import { ShadowPanel } from './ShadowPanel'
import { SignalList } from './SignalList'
import { WatchPoints } from './WatchPoints'

/**
 * 四个标签页。**不做路由** —— 面板只有四屏，`useState` 比引一个 router 便宜得多。
 *
 * 「概览」是默认页且是唯一有推送的一屏（行情每轮都在变）；其余三个标签页都是
 * 「打开看一眼」的性质，所以它们**不订阅推送**，只在切进来时拉一次。
 *
 * 「观察点」的标题带 ACTIVE 计数 —— 那是「软件现在在盯什么」最直接的回答，
 * 而这个功能的全部意义就在于让用户看得见它在盯。
 */
type Tab = 'OVERVIEW' | 'WATCH' | 'SHADOW' | 'SETTINGS'

const TABS: { id: Tab; label: string }[] = [
  { id: 'OVERVIEW', label: '概览' },
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
    <form className="shrink-0 border-b border-white/10 px-3 py-2.5" onSubmit={(e) => void submit(e)}>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-white/15 bg-black/25 px-2.5 py-1.5 text-sm outline-none placeholder:text-white/25 focus:border-white/35"
          placeholder="添加自选：600000 / sh600000 / 000001.SZ"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="gp-btn shrink-0" type="submit" disabled={busy || value.trim() === ''}>
          {busy ? '添加中…' : '添加'}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
    </form>
  )
}

function WatchRow({
  item,
  quote,
  position,
  editing,
  first,
  last,
  onRemove,
  onMove,
  onToggleEdit,
  onSaved,
  onError,
}: {
  item: WatchItem
  quote: QuoteTick | undefined
  position: PositionView | undefined
  editing: boolean
  first: boolean
  last: boolean
  onRemove: (code: SecCode) => void
  onMove: (code: SecCode, delta: number) => void
  onToggleEdit: (code: SecCode) => void
  onSaved: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  // 没有报价 ≠ 报价为 0。这一栏在拿到第一轮快照前显示 '—'，不显示数字
  const stale = quote?.stale === true
  return (
    <li className="border-b border-white/[0.06] px-3 py-2 text-sm last:border-b-0 hover:bg-white/[0.02]">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate">{item.name}</span>
            {item.hasPosition ? (
              <span className="shrink-0 rounded bg-white/10 px-1 text-[10px] text-white/60">持仓</span>
            ) : null}
          </div>
          <div className="font-mono text-xs text-white/40">
            {item.code}
            {item.industry ? ` · ${item.industry}` : ''}
          </div>
        </div>

        <div className={`w-16 text-right font-mono ${stale ? 'text-white/35' : ''}`}>
          {quote ? quote.last.toFixed(2) : '—'}
        </div>
        <div className={`w-18 text-right font-mono ${stale ? 'text-white/35' : changeTone(quote?.changePct ?? 0)}`}>
          {quote ? signed(quote.changePct) : '—'}
        </div>

        <div className="flex shrink-0 justify-end gap-0.5 text-xs text-white/40">
          <button
            className={`px-1 hover:text-white/80 ${editing ? 'text-white/80' : ''}`}
            title="录入持仓（启用止损类强制提醒）"
            onClick={() => onToggleEdit(item.code)}
          >
            仓
          </button>
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
          <button className="px-1 hover:text-rose-300" title="移除" onClick={() => onRemove(item.code)}>
            ×
          </button>
        </div>
      </div>

      {editing ? (
        <PositionEditor
          code={item.code}
          position={position}
          quote={quote}
          onSaved={onSaved}
          onError={onError}
        />
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
  const [quotes, setQuotes] = useState<QuoteTick[]>([])
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [positions, setPositions] = useState<PositionView[]>([])
  const [editing, setEditing] = useState<SecCode | null>(null)
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

  const refreshAiReady = useCallback((): void => {
    void window.gp
      .invoke('ai:config')
      .then((config) => setAiReady(config.enabled && config.hasKey && config.model !== ''))
      .catch(() => setAiReady(false))
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
    return () => {
      offStatus()
      offQuotes()
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

  const refreshStatus = useCallback((): void => {
    void window.gp.invoke('app:engineStatus').then(setStatus)
  }, [])

  const add = useCallback(
    async (code: string): Promise<void> => {
      await window.gp.invoke('watchlist:add', code)
      await reload()
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

  const move = useCallback(
    (code: SecCode, delta: number): void => {
      const index = items.findIndex((item) => item.code === code)
      const target = index + delta
      if (index < 0 || target < 0 || target >= items.length) return
      const next = [...items]
      const [moved] = next.splice(index, 1)
      if (!moved) return
      next.splice(target, 0, moved)
      setItems(next) // 先动 UI，落库失败再由 reload 纠正回来
      void window.gp
        .invoke(
          'watchlist:reorder',
          next.map((item) => item.code)
        )
        .then(() => reload())
        .catch((err: unknown) => setError(errorText(err)))
    },
    [items, reload]
  )

  const onTransfer = useCallback(
    (outcome: TransferOutcome): void => {
      // 静默取消（用户在文件框里按了取消、且解析阶段没产生 warning）什么都不说 ——
      // 存下来会让横幅区留一条空白，那比没有更奇怪
      const silent = outcome.result.status === 'CANCELED' && outcome.result.warnings.length === 0
      setTransfer(silent ? null : outcome)
      // 导入成功后整份自选与持仓都换了，界面必须立刻跟上，不能等下一轮 tick
      if (outcome.kind === 'import' && outcome.result.status === 'DONE') {
        setEditing(null)
        void reload()
        refreshStatus()
        setSignalKey((key) => key + 1)
      }
    },
    [reload, refreshStatus]
  )

  // 逐条显式比较而不是 `a ?? b ?? c`：这些字段是 `boolean | undefined`，
  // `false ?? x` 会停在 false 上，把后面几条横幅一起吞掉
  const hasBanner =
    error !== null ||
    status?.offline === true ||
    status?.stale === true ||
    status?.calendarUncertain === true ||
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
          <span className="h-5 w-5 shrink-0 rounded bg-gradient-to-br from-sky-400/70 to-indigo-500/70" />
          <h1 className="text-sm font-semibold tracking-wide">GP Pet</h1>
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
          {transfer ? (
            <ConfigTransferNotice outcome={transfer} onDismiss={() => setTransfer(null)} />
          ) : null}
        </div>
      ) : null}

      {/* 影子运行与设置是单栏长内容，交给这一层滚动 */}
      {tab === 'WATCH' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <WatchPoints refreshKey={watchKey} onChanged={refreshWatch} onError={setError} />
        </div>
      ) : null}
      {tab === 'SHADOW' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <ShadowPanel refreshKey={signalKey} onError={setError} />
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
        <section className="gp-card max-h-full">
          <div className="gp-card-head">
            <h2 className="gp-card-title">自选股</h2>
            <span className="text-xs text-white/30">{items.length} 只</span>
          </div>

          <AddForm onAdd={add} />

          {items.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-white/35">还没有自选股，先在上面添加一只。</p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {items.map((item, i) => (
                <WatchRow
                  key={item.code}
                  item={item}
                  quote={quoteOf.get(item.code)}
                  position={positionOf.get(item.code)}
                  editing={editing === item.code}
                  first={i === 0}
                  last={i === items.length - 1}
                  onRemove={remove}
                  onMove={move}
                  onToggleEdit={(code) => setEditing((current) => (current === code ? null : code))}
                  onSaved={() => void reload()}
                  onError={setError}
                />
              ))}
            </ul>
          )}
        </section>

        <div className="flex min-h-0 flex-col gap-4">
          {/* 信号是流水，占掉右栏剩下的全部高度；提醒日志是按需展开的，按内容给高 */}
          <SignalList
            refreshKey={signalKey}
            aiReady={aiReady}
            onWatchCreated={refreshWatch}
            onError={setError}
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
      <footer className="shrink-0 border-t border-white/10 px-5 py-2 text-xs text-white/35">
        {FOOTER_NOTE}
      </footer>
    </main>
  )
}
