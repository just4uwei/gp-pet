/**
 * 一只标的的详情抽屉（右侧滑出），三个页签：行情 / 信号 / 持仓。
 *
 * 由 `SignalDrawer` 扩成的：那个只有信号，而「点自选股看行情」与「看信号」
 * 想看的是同一只票的同一件事。做成两个抽屉的话，同一只股票会有两个长得差不多、
 * 内容却不一样的详情页，用户得记住自己是从哪个入口进来的。
 *
 * ## 四条
 *
 * 1. **`top` 从 `TITLE_BAR_HEIGHT`（40px）开始，不要 `inset-y-0`。**
 *    面板是 `titleBarStyle: 'hidden'` + `titleBarOverlay`，右上角那一块归**系统**
 *    窗口控件（PanelWindow.ts）。盖上去 = 用户关不掉窗口，而且多半会以为是软件卡死了。
 * 2. **走 portal 挂到 `document.body`**：触发它的组件住在 `overflow-hidden` 的窄栏里，
 *    `absolute` 会被裁掉。
 * 3. **Esc 与点遮罩都能关。** 只能靠右上角小叉关掉的浮层，在键盘用户那里是个陷阱。
 * 4. **页签切换不卸载已加载的数据**（各页自己管自己的请求）—— 但也不预加载：
 *    没打开过的页签一个请求都不发。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SecCode } from '@core/types'
import type { QuoteTick, SignalRecord, TradeLedger } from '@shared/ipc-types'
import type { SignalGroup } from '@shared/signal-group'
import { DailyChart } from './DailyChart'
import { IntradayChart, type IntradayMark } from './IntradayChart'
import { TradePanel } from './TradePanel'

/** 与 PanelWindow.ts 的 TITLE_BAR_HEIGHT 成对，改一处要改两处 */
const TITLE_BAR_HEIGHT = 40

export type StockTab = 'QUOTE' | 'SIGNAL' | 'POSITION'

/** 北京时间那一天的 00:00（epoch ms）。交易时段是交易所的，不看本机时区 */
function beijingDayStart(at: number): number {
  const offset = 8 * 60 * 60_000
  return Math.floor((at + offset) / 86_400_000) * 86_400_000 - offset
}

const TABS: { key: StockTab; label: string }[] = [
  { key: 'QUOTE', label: '行情' },
  { key: 'SIGNAL', label: '信号' },
  { key: 'POSITION', label: '持仓' },
]

export function StockDrawer({
  code,
  name,
  initialTab,
  quote,
  group,
  ledger,
  renderSignalRow,
  countChips,
  onSubmitTrade,
  onRemoveTrade,
  tradeBusy,
  onError,
  onClose,
}: {
  code: SecCode
  name: string
  initialTab: StockTab
  quote: QuoteTick | undefined
  /** 该股今日的信号分组；今天没有信号时为 undefined（页签仍在，给空态） */
  group: SignalGroup<SignalRecord> | undefined
  ledger: TradeLedger | null
  /** 信号行交回上层渲染 —— 展开依据 / AI 的状态在那边，抽屉不该复制一份 */
  renderSignalRow: (record: SignalRecord) => React.JSX.Element
  countChips: React.JSX.Element | null
  onSubmitTrade: (draft: {
    side: 'BUY' | 'SELL'
    price: number
    shares: number
    tradedAt: number
    note?: string
  }) => void
  onRemoveTrade: (id: string) => void
  tradeBusy: boolean
  onError: (message: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [tab, setTab] = useState<StockTab>(initialTab)

  // 换了一只票（从别的行再点开）时回到该入口对应的页签
  useEffect(() => setTab(initialTab), [code, initialTab])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const signals = group ? [group.latest, ...group.rest] : []
  const marks: IntradayMark[] = signals.map((record) => ({
    id: record.id,
    ts: record.createdAt,
    price: record.priceAt,
    direction: record.direction,
  }))

  // 当天 00:00 —— 按**北京时间**，不是本机时区。它同时是分时的查询窗口下界，
  // 而 quote_tick.ts 与数据源的分时时刻都是交易所时间：机器设成别的时区时，
  // 用本机零点会把窗口整体挪走，图上会缺掉一头
  const dayStart = beijingDayStart(Date.now())

  return createPortal(
    <>
      {/* 遮罩也从标题栏下方开始：盖住系统窗口控件的话，点它会变成「点了没反应」 */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 bg-black/45"
        style={{ top: TITLE_BAR_HEIGHT }}
        onClick={onClose}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${name} 详情`}
        className="fixed bottom-0 right-0 z-50 flex w-[460px] max-w-full flex-col border-l border-white/10 bg-[var(--gp-surface)] shadow-2xl"
        style={{ top: TITLE_BAR_HEIGHT }}
      >
        <header className="shrink-0 border-b border-white/10 px-4 pt-3">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="font-mono text-xs text-white/35">{code}</span>
            <span
              className={`ml-auto shrink-0 font-mono text-sm ${quote?.stale === true ? 'text-white/35' : ''}`}
            >
              {quote ? quote.last.toFixed(2) : '—'}
            </span>
            <button className="shrink-0 text-xs text-white/35 hover:text-white/70" onClick={onClose}>
              ✕
            </button>
          </div>

          <nav className="mt-2 flex gap-1">
            {TABS.map((item) => (
              <button
                key={item.key}
                className={`rounded-t border-b-2 px-3 py-1.5 text-xs ${
                  tab === item.key
                    ? 'border-sky-400/70 text-white/85'
                    : 'border-transparent text-white/40 hover:text-white/70'
                }`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
                {item.key === 'SIGNAL' && group ? (
                  <span className="ml-1 text-[10px] text-white/30">{group.total}</span>
                ) : null}
              </button>
            ))}
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === 'QUOTE' ? (
            <div className="space-y-4">
              <section>
                <h3 className="mb-1 text-[11px] text-white/40">当日分时</h3>
                <IntradayChart code={code} from={dayStart} marks={marks} onError={onError} />
              </section>
              <section className="border-t border-white/10 pt-3">
                <h3 className="mb-1 text-[11px] text-white/40">日 K</h3>
                <DailyChart code={code} onError={onError} />
              </section>
            </div>
          ) : null}

          {tab === 'SIGNAL' ? (
            group ? (
              <>
                {countChips ? <div className="flex flex-wrap items-center gap-1">{countChips}</div> : null}
                <h3 className="mt-3 text-[11px] text-white/40">
                  今日全部信号（{group.total} 条，新的在上）
                </h3>
                <ul className="mt-1">
                  {signals.map((record) => (
                    <li key={record.id} className="border-b border-white/[0.06] py-2 last:border-b-0">
                      {renderSignalRow(record)}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="py-10 text-center text-xs leading-relaxed text-white/35">
                这只票今天还没有信号。
                <br />
                收盘后引擎会做一次确认轮，届时再看。
              </p>
            )
          ) : null}

          {tab === 'POSITION' ? (
            <TradePanel
              code={code}
              quote={quote}
              ledger={ledger}
              onSubmit={onSubmitTrade}
              onRemove={onRemoveTrade}
              busy={tradeBusy}
            />
          ) : null}
        </div>
      </aside>
    </>,
    document.body
  )
}
