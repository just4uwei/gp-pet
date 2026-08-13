/**
 * 悬浮条 —— 出厂默认形态（docs/06 §2.1），也是 C2 点击穿透的判定端（§2.2）。
 *
 * 与桌宠形态的关系：**共用主进程那一侧的全部机制**（OverlayWindow、`pet:*` 通道、
 * 拖拽吸附、多屏校验），这里只是把「画一只猫」换成「画一行字」。
 * 命中判定仍然必须在渲染层做 —— Electron 只有窗口级的 setIgnoreMouseEvents，
 * 没有像素级命中测试。区别是悬浮条**窗口即本体**，所以命中区不是描一个轮廓，
 * 而是「整块减掉四个圆角」，三个矩形就够。
 *
 * ## 两条纪律
 *
 * 1. **状态点只跟着 `push:petState` 走，不自己从信号里推断强度。**
 *    WATCHING / EXCITED / ALERT 由主进程的 `PetStateMachine` 给出，而它只接受
 *    **过了四道闸门**（防抖、冷却、频率上限、免打扰）的提醒。这里若自己去读
 *    signal:history 点亮状态点，等于开一条绕过闸门的旁路 —— 那正是 M3 之前
 *    这段注释在防的事。
 * 2. **价格取缓存时必须灰显**（`stale`），不假装实时。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hitTest } from '@shared/hit-test'
import { pickFeatured } from '@shared/featured'
import type { EngineStatus, PetState, QuoteTick, Rect, SignalRecord, WatchItem } from '@shared/ipc-types'

/** 与 styles.css 的 `.bar { border-radius }` 必须一致，否则命中区会盖到圆角外 */
const CORNER_RADIUS = 8
/** 位移超过这个距离就算拖拽，不再当作单击 */
const DRAG_SLOP_PX = 4
/** 区分单击与双击的等待窗口 */
const DOUBLE_CLICK_MS = 250

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
  const clickTimerRef = useRef<number | null>(null)

  const rects = useMemo(() => barHitRects(window.innerWidth, window.innerHeight), [])

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

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    }
  }, [])

  // ── 手势（docs/06 §4，与桌宠一致）─────────────────────────────────
  const onMouseDown = (event: React.MouseEvent): void => {
    if (event.button !== 0) return
    dragRef.current = { lastScreenX: event.screenX, lastScreenY: event.screenY, travelled: 0 }
  }

  const onClick = (): void => {
    // 单击要等一个双击窗口期，否则双击会先触发一次面板开关
    if (clickTimerRef.current !== null) return
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      void window.gp.invoke('panel:toggle')
    }, DOUBLE_CLICK_MS)
  }

  const onDoubleClick = (): void => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    void window.gp.invoke('pet:toggleDoNotDisturb')
  }

  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    void window.gp.invoke('pet:contextMenu')
  }

  // ── 绘制 ─────────────────────────────────────────────────────────
  const actionable = useMemo(() => signals.filter((s) => s.suppressedReason === undefined), [signals])
  const featured = useMemo(() => pickFeatured(quotes, actionable), [quotes, actionable])
  const stale = featured?.stale === true
  const nameOf = useMemo(() => {
    const map = new Map(items.map((item) => [item.code, item.name]))
    // 自选还没读到（或刚加进来还没补基础信息）时退到信号里的名称，再退到代码本身
    for (const signal of signals) if (!map.has(signal.code)) map.set(signal.code, signal.name)
    return map
  }, [items, signals])

  return (
    <div
      className={`bar${status?.doNotDisturb === true ? ' bar--quiet' : ''}`}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={`${DOT_TITLE[petState]} · 单击打开面板 · 双击免打扰 · 右键菜单`}
    >
      <span className={`dot ${DOT_CLASS[petState]}`} />

      {featured ? (
        <>
          <span className="name">{nameOf.get(featured.code) || featured.code}</span>
          <span className={`price${stale ? ' stale' : ''}`}>{featured.last.toFixed(2)}</span>
          <span className={`change ${changeClass(featured.changePct)}${stale ? ' stale' : ''}`}>
            {signed(featured.changePct)}
          </span>
        </>
      ) : (
        // 还没有报价时不显示任何数字（docs/03：没有报价 ≠ 报价为 0）
        <span className="empty">{status?.watchCount === 0 ? '未添加自选' : '等待行情…'}</span>
      )}

      {actionable.length > 0 ? (
        <span className="badge" title={`今日 ${actionable.length} 条信号，单击查看`}>
          {actionable.length > 99 ? '99+' : actionable.length}
        </span>
      ) : null}
    </div>
  )
}
