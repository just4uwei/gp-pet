/**
 * 悬浮条 —— 出厂默认形态（docs/06 §2.1），也是 C2 点击穿透的判定端（§2.2）。
 *
 * 与桌宠形态的关系：**共用主进程那一侧的全部机制**（OverlayWindow、`pet:*` 通道、
 * 拖拽吸附、多屏校验），这里只是把「画一只猫」换成「画一行字」。
 * 命中判定仍然必须在渲染层做 —— Electron 只有窗口级的 setIgnoreMouseEvents，
 * 没有像素级命中测试。区别是悬浮条**窗口即本体**，所以命中区不是描一个轮廓，
 * 而是「整块减掉四个圆角」，三个矩形就够。
 *
 * ## 四条纪律
 *
 * 1. **状态点只跟着 `push:petState` 走，不自己从信号里推断强度。**
 *    WATCHING / EXCITED / ALERT 由主进程的 `PetStateMachine` 给出，而它只接受
 *    **过了四道闸门**（防抖、冷却、频率上限、免打扰）的提醒。这里若自己去读
 *    signal:history 点亮状态点，等于开一条绕过闸门的旁路 —— 那正是 M3 之前
 *    这段注释在防的事。跑马灯上的方向标签**不受这条约束**：它复述的是
 *    「引擎今天判了什么」（面板的今日信号列表同源），不是「有没有提醒你」。
 * 2. **价格取缓存时必须灰显**（`stale`），不假装实时。
 * 3. **今天没有信号就写「无信号」**，不许填一个像建议的中性词 —— 引擎没说话，
 *    条子不替它说（判据在 `@shared/ticker`）。
 * 4. **休市 / 离线 / 免打扰时滚动必须停**（C7 休市零开销，docs/06 §1）。
 * 5. **单击不做任何事，双击才开面板**（2026-08-13 改）。理由是这条子会被拖着走，
 *    而拖拽以一次 click 收尾 —— 单击绑面板时，每挪一次位置都会顺手开一次面板。
 *    连带后果是**双击不再是免打扰**（C8 因此退到右键菜单，见 docs/06 §4 的注），
 *    桌宠形态仍是「单击面板 / 双击免打扰」，两种形态的手势自此不同。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { hitTest } from '@shared/hit-test'
import { applyOrder, buildTicker, orderFingerprint, type TickerEntry } from '@shared/ticker'
import type { GatedDirection, SecCode } from '@core/types'
import type { EngineStatus, PetState, QuoteTick, Rect, SignalRecord, WatchItem } from '@shared/ipc-types'

/** 与 styles.css 的 `.bar { border-radius }` 必须一致，否则命中区会盖到圆角外 */
const CORNER_RADIUS = 8
/** 位移超过这个距离就算拖拽，不再当作单击 */
const DRAG_SLOP_PX = 4
/** 跑马灯速度。慢到能读完一只票，快到不必等太久 */
const SCROLL_PX_PER_SEC = 28

const DOT_CLASS: Record<PetState, string> = {
  OFFLINE: 'dot--offline',
  SLEEPY: 'dot--sleepy',
  IDLE: 'dot--idle',
  WATCHING: 'dot--watching',
  EXCITED: 'dot--excited',
  ALERT: 'dot--alert',
}

const DOT_TITLE: Record<PetState, string> = {
  OFFLINE: '行情离线',
  SLEEPY: '休市 / 免打扰',
  IDLE: '盯盘中',
  WATCHING: '关注中',
  EXCITED: '有较强信号',
  ALERT: '有需要处理的提醒',
}

/** 与面板的今日信号列表同一份措辞（SignalList.tsx），别在两处各写一套 */
const ACTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

/** 卖出/减仓用暖橙不用红：A 股红涨绿跌，红色作警示会与涨跌色打架（docs/05 §5） */
const ACTION_CLASS: Record<GatedDirection, string> = {
  BUY: 'act--buy',
  SELL: 'act--sell',
  REDUCE: 'act--sell',
  NEXT_DAY_WATCH: 'act--neutral',
  NONE: 'act--neutral',
}

interface DragState {
  lastScreenX: number
  lastScreenY: number
  travelled: number
}

/** 当天 00:00。信号按 created_at 存的是墙上时刻，按「今天」筛（与面板列表同一口径） */
function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * 圆角矩形的命中区：整块减掉四个角。
 *
 * 「宁可少覆盖也不要多覆盖」（docs/06 §2.2）—— 少覆盖只是圆角处点不动，
 * 多覆盖会吞掉本该穿透的点击，而 C2 是底线。
 */
function barHitRects(width: number, height: number, radius = CORNER_RADIUS): Rect[] {
  const r = Math.min(radius, Math.floor(height / 2))
  return [
    { x: r, y: 0, w: Math.max(0, width - 2 * r), h: r },
    { x: 0, y: r, w: width, h: Math.max(0, height - 2 * r) },
    { x: r, y: height - r, w: Math.max(0, width - 2 * r), h: r },
  ]
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function changeClass(value: number): string {
  if (value > 0) return 'change--up'
  if (value < 0) return 'change--down'
  return 'change--flat'
}

/**
 * 跑马灯里的一只票。
 *
 * 「无信号」是一个**事实**，不是一条中性建议 —— 引擎今天没对它说话，
 * 这里就不许写「观望」「持有」之类看起来像结论的词（措辞纪律，CLAUDE.md）。
 */
function Item({ entry }: { entry: TickerEntry }): React.JSX.Element {
  const grey = entry.stale ? ' stale' : ''
  return (
    <span className="item">
      <span className="name">{entry.name}</span>
      <span className={`price${grey}`}>{entry.last === null ? '—' : entry.last.toFixed(2)}</span>
      <span
        className={`change ${entry.changePct === null ? 'change--flat' : changeClass(entry.changePct)}${grey}`}
      >
        {entry.changePct === null ? '—' : signed(entry.changePct)}
      </span>
      {entry.action === null ? (
        <span className="act act--none">无信号</span>
      ) : (
        <span className={`act ${ACTION_CLASS[entry.action]}`}>{ACTION_LABEL[entry.action]}</span>
      )}
    </span>
  )
}

/**
 * 滚动一圈的全部内容。
 *
 * 末尾那句免责小字跟着「条子上确实出现了方向标签」走：跑马灯把买卖建议摆到了
 * 桌面上，而气泡与通知的那句固定小字（docs/05 §5）在这里没有落点，
 * 于是让它跟着轮播过一遍 —— 只在真有建议时出现，没有建议时不占位置。
 */
function Lap({ entries, disclaimer }: { entries: TickerEntry[]; disclaimer: boolean }): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => (
        <Item key={entry.code} entry={entry} />
      ))}
      {disclaimer ? <span className="item disclaimer">仅供参考，非投资建议</span> : null}
    </>
  )
}

export function App(): React.JSX.Element {
  const [petState, setPetState] = useState<PetState>('IDLE')
  const [quotes, setQuotes] = useState<QuoteTick[]>([])
  const [signals, setSignals] = useState<SignalRecord[]>([])
  const [status, setStatus] = useState<EngineStatus | null>(null)
  // QuoteTick 只有代码与价格，名称在自选列表里（首轮基础信息补齐后才有，所以要跟着重取）
  const [items, setItems] = useState<WatchItem[]>([])

  const dragRef = useRef<DragState | null>(null)
  /** 本地缓存的穿透状态，避免每次 mousemove 都发 IPC */
  const interactiveRef = useRef(false)

  /**
   * 命中区跟着窗口尺寸走，不是挂载时算一次。
   *
   * 只在挂载时算过一次的版本有一个很难归因的坏结局：窗口尺寸一旦与它不符
   * （历史上是拖拽把窗口撑大，见 OverlayWindow.moveTo），鼠标压在条子上却被判成
   * 「不在命中区」→ 穿透 → 点什么都没反应。主进程那边已经堵住了成因，
   * 这里再跟一手，让「尺寸变了」最多是一帧的事而不是永久失灵。
   */
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const rects = useMemo(() => barHitRects(viewport.w, viewport.h), [viewport])

  useEffect(() => {
    const onResize = (): void => {
      setViewport((prev) =>
        prev.w === window.innerWidth && prev.h === window.innerHeight
          ? prev
          : { w: window.innerWidth, h: window.innerHeight }
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    void window.gp.invoke('pet:setHitRegion', rects)
  }, [rects])

  // ── 订阅 ──────────────────────────────────────────────────────────
  useEffect(() => {
    void window.gp.invoke('app:engineStatus').then(setStatus)

    // 悬浮条上没有地方显示错误，且它不该因为一次取数失败就空白 —— 静默保留上一次
    const loadSignals = (): void => {
      void window.gp
        .invoke('signal:history', { from: startOfToday(), limit: 200 })
        .then(setSignals)
        .catch(() => undefined)
    }
    const loadItems = (): void => {
      void window.gp
        .invoke('watchlist:list')
        .then(setItems)
        .catch(() => undefined)
    }
    loadSignals()
    loadItems()

    const offState = window.gp.on('push:petState', setPetState)
    const offQuotes = window.gp.on('push:quoteTick', setQuotes)
    const offStatus = window.gp.on('push:engineStatus', (next) => {
      setStatus(next)
      // 引擎每轮跑完会推一次，借它当信号列表的重取信号（与面板同一做法）
      loadSignals()
      loadItems()
    })
    return () => {
      offState()
      offQuotes()
      offStatus()
    }
  }, [])

  const setInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return
    interactiveRef.current = next
    void window.gp.invoke('pet:setInteractive', next)
  }, [])

  // ── 命中判定 + 拖拽（与桌宠形态同一套逻辑）────────────────────────
  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (drag) {
        const dx = event.screenX - drag.lastScreenX
        const dy = event.screenY - drag.lastScreenY
        if (dx !== 0 || dy !== 0) {
          drag.lastScreenX = event.screenX
          drag.lastScreenY = event.screenY
          drag.travelled += Math.abs(dx) + Math.abs(dy)
          void window.gp.invoke('pet:dragBy', dx, dy)
        }
        return // 拖拽期间不做命中判定，否则拖出本体范围会立刻穿透并丢掉拖拽
      }
      setInteractive(hitTest(rects, event.clientX, event.clientY))
    }

    const onMouseUp = (): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      if (drag.travelled > DRAG_SLOP_PX) void window.gp.invoke('pet:dragEnd')
    }

    // 鼠标快速掠出窗口时可能收不到最后一个 mousemove，
    // 不补这一手会让窗口停在「可交互」状态，把下层应用的点击吃掉 —— C2 的典型破法
    const onMouseLeave = (): void => {
      if (!dragRef.current) setInteractive(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [rects, setInteractive])

  // ── 手势（docs/06 §4；悬浮条形态与桌宠不同，见文件头纪律 5）───────────
  const onMouseDown = (event: React.MouseEvent): void => {
    if (event.button !== 0) return
    dragRef.current = { lastScreenX: event.screenX, lastScreenY: event.screenY, travelled: 0 }
  }

  const onDoubleClick = (): void => {
    void window.gp.invoke('panel:toggle')
  }

  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    void window.gp.invoke('pet:contextMenu')
  }

  // ── 绘制 ─────────────────────────────────────────────────────────
  const actionable = useMemo(() => signals.filter((s) => s.suppressedReason === undefined), [signals])
  const fresh = useMemo(() => buildTicker(items, quotes, signals), [items, quotes, signals])

  /**
   * 位置只在「集合或方向变了」时才重排 —— 排序规则里有 |涨跌幅|，而它每一轮取数都在变，
   * 照单重排会让跑马灯在滚动过程中把条目换位，看起来像卡带（判据在 @shared/ticker）。
   * 渲染期改 ref 是刻意的：这是纯粹从 props 派生的顺序，走 state + effect 只会多渲染一遍。
   */
  const fingerprint = useMemo(() => orderFingerprint(fresh), [fresh])
  const orderRef = useRef<SecCode[]>([])
  const fingerprintRef = useRef<string | null>(null)
  if (fingerprintRef.current !== fingerprint) {
    fingerprintRef.current = fingerprint
    orderRef.current = fresh.map((entry) => entry.code)
  }
  const entries = useMemo(() => applyOrder(fresh, orderRef.current), [fresh, fingerprint])
  const hasAdvice = useMemo(() => entries.some((entry) => entry.action !== null), [entries])

  /**
   * 内容比可视区宽才滚；装得下就静止 —— 一条常驻置顶的条子，
   * 没必要为了「有动效」而一直动（C7 的精神）。
   */
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const lapRef = useRef<HTMLDivElement | null>(null)
  const [scrollSec, setScrollSec] = useState(0)
  useLayoutEffect(() => {
    const lap = lapRef.current
    const view = viewportRef.current
    if (lap === null || view === null) return
    // 一份内容的宽度就是滚一圈的距离。量的是第一份，所以「加不加第二份」不会反过来影响测量
    const width = lap.scrollWidth
    const next = width > view.clientWidth ? width / SCROLL_PX_PER_SEC : 0
    setScrollSec((prev) => (Math.abs(prev - next) < 0.05 ? prev : next))
  }, [entries, hasAdvice, viewport])

  // 休市 / 离线 / 免打扰时停下（C7 休市零开销）
  const paused = petState === 'SLEEPY' || petState === 'OFFLINE' || status?.doNotDisturb === true

  return (
    <div
      className={`bar${status?.doNotDisturb === true ? ' bar--quiet' : ''}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {/*
        整块的 title 以前是「盯盘中 · 单击打开面板 · 双击免打扰 · 右键菜单」——
        一条常驻置顶的悬浮条，鼠标每次路过都弹一次操作说明，那本身就是干扰
        （零干扰契约的精神，docs/06 §1）。手势说明属于首次引导与右键菜单，
        不属于每一次 hover。状态语义留在状态点上：它是**变化**的信息，
        用户看到点变色时确实需要一句话解释。
      */}
      <span className={`dot ${DOT_CLASS[petState]}`} title={DOT_TITLE[petState]} />

      {entries.length > 0 ? (
        <div className="viewport" ref={viewportRef}>
          <div
            className={`track${scrollSec > 0 ? ' track--scroll' : ''}${paused ? ' track--paused' : ''}`}
            style={scrollSec > 0 ? { animationDuration: `${scrollSec.toFixed(1)}s` } : undefined}
          >
            <div className="lap" ref={lapRef}>
              <Lap entries={entries} disclaimer={hasAdvice} />
            </div>
            {/* 第二份是为了首尾相接地循环；装得下时不渲染，否则会露在空白处 */}
            {scrollSec > 0 ? (
              <div className="lap" aria-hidden>
                <Lap entries={entries} disclaimer={hasAdvice} />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        // 还没有报价时不显示任何数字（docs/03：没有报价 ≠ 报价为 0）
        <span className="empty">{status?.watchCount === 0 ? '未添加自选' : '等待行情…'}</span>
      )}

      {actionable.length > 0 ? (
        <span className="badge" title={`今日 ${actionable.length} 条信号`}>
          {actionable.length > 99 ? '99+' : actionable.length}
        </span>
      ) : null}
    </div>
  )
}
