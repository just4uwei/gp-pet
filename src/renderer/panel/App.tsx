/**
 * 面板窗口 —— 自选股列表 + 数据层状态 + 今日信号 + 持仓录入 + 提醒日志。
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
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  EngineStatus,
  PetSkinView,
  PositionView,
  ProviderHealth,
  QuoteTick,
  WatchItem,
} from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import { AlertLog } from './AlertLog'
import { PositionEditor } from './PositionEditor'
import { SignalList } from './SignalList'

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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/50">
      <span>
        时段 <span className="text-white/80">{session}</span>
      </span>
      <span>
        自选 <span className="text-white/80">{status?.watchCount ?? 0}</span> 只
      </span>
      {status?.doNotDisturb ? (
        // 免打扰的成因要摆出来：用户问的是「为什么刚才没弹」，不是「有没有静默」
        <span className="text-white/80">
          免打扰生效中{status.doNotDisturbReason ? `（${status.doNotDisturbReason}）` : ''}
        </span>
      ) : null}
      <span className="flex gap-2">
        {health.length === 0 ? (
          <span>数据源 …</span>
        ) : (
          health.map((h) => (
            <span key={h.provider} title={h.lastError ?? ''}>
              {h.provider}{' '}
              <span className={HEALTH_TONE[h.status]}>
                {HEALTH_LABEL[h.status]}
                {h.successRate > 0 ? ` ${Math.round(h.successRate * 100)}%` : ''}
              </span>
            </span>
          ))
        )}
      </span>
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
    <form className="mt-4" onSubmit={(e) => void submit(e)}>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-white/15 bg-white/5 px-3 py-1.5 text-sm outline-none placeholder:text-white/25 focus:border-white/35"
          placeholder="添加自选：600000 / sh600000 / 000001.SZ"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="rounded border border-white/15 px-3 py-1.5 text-sm text-white/80 hover:border-white/35 disabled:opacity-40"
          type="submit"
          disabled={busy || value.trim() === ''}
        >
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
    <li className="border-b border-white/10 py-2 text-sm">
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

        <div className={`w-20 text-right font-mono ${stale ? 'text-white/35' : ''}`}>
          {quote ? quote.last.toFixed(2) : '—'}
        </div>
        <div className={`w-20 text-right font-mono ${stale ? 'text-white/35' : changeTone(quote?.changePct ?? 0)}`}>
          {quote ? signed(quote.changePct) : '—'}
        </div>

        <div className="flex w-24 shrink-0 justify-end gap-1 text-xs text-white/40">
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
  const [items, setItems] = useState<WatchItem[]>([])
  const [quotes, setQuotes] = useState<QuoteTick[]>([])
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [skin, setSkin] = useState<PetSkinView | null>(null)
  const [positions, setPositions] = useState<PositionView[]>([])
  const [editing, setEditing] = useState<SecCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 引擎每轮跑完会推一次 engineStatus；用它当信号与提醒日志的重取信号
  const [signalKey, setSignalKey] = useState(0)

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
    void window.gp.invoke('app:engineStatus').then(setStatus)
    void window.gp.invoke('pet:getSkin').then(setSkin)
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

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col p-6">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">GP Pet · 自选股</h1>
          <button
            className="text-xs text-white/40 hover:text-white/80"
            onClick={() => void reload()}
            title="重新读取自选与数据源健康度"
          >
            刷新
          </button>
        </div>
        <div className="mt-2">
          <StatusBar status={status} health={health} />
        </div>
      </header>

      <div className="mt-3 flex flex-col gap-2">
        {error ? <Banner tone="warn">{error}</Banner> : null}
        {status?.offline ? (
          <Banner tone="warn">行情离线：数据源全部不可用，下面显示的是最后一次成功取到的价格。</Banner>
        ) : status?.stale ? (
          <Banner tone="warn">最近一轮取数失败，价格取自缓存，未必是最新的。</Banner>
        ) : null}
        {status?.calendarUncertain ? (
          <Banner tone="info">交易日历尚未核对，休市判断可能不准（节假日会照常轮询）。</Banner>
        ) : null}
        {skin?.fallback ? <Banner tone="info">皮肤已回退到占位形象：{skin.fallbackReason}</Banner> : null}
      </div>

      <AddForm onAdd={add} />

      <section className="mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto">
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-white/35">还没有自选股，先在上面添加一只。</p>
        ) : (
          <ul>
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

        {items.length > 0 ? <SignalList refreshKey={signalKey} onError={setError} /> : null}

        <AlertLog
          refreshKey={signalKey}
          unread={status?.unreadAlerts ?? 0}
          onRead={refreshStatus}
          onError={setError}
        />
      </section>

      {/*
        这里以前有一行「信号只在这个列表里显示，还不会弹气泡或发系统通知」——
        提醒分发接上之后它就变成了一句过时的假话，所以删掉了。
        能力边界仍然对用户有意义，但现在的边界写在提醒日志里（每条为什么发/没发），
        比页脚上一句静态的话诚实得多。
      */}
      <footer className="mt-4 shrink-0 text-xs text-white/40">
        <p>仅供参考，非投资建议</p>
      </footer>
    </main>
  )
}
