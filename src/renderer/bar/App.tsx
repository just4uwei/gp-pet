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
import { WATCH_MARK_LABEL } from '@shared/watch-mark'
import { T_HINT_LABEL, T_HINT_TITLE } from '@shared/intraday-t'
import { shanghaiDayStartMs } from '@shared/time'
import type { GatedDirection, SecCode } from '@core/types'
import type {
  EngineStatus,
  IntradayTHint,
  PetState,
  QuoteTick,
  Rect,
  SignalRecord,
  WatchItem,
  WatchPointView,
} from '@shared/ipc-types'

/** 与 styles.css 的 `.bar { border-radius }` 必须一致，否则命中区会盖到圆角外 */
const CORNER_RADIUS = 8
/** 位移超过这个距离就算拖拽，不再当作单击 */
const DRAG_SLOP_PX = 4
/** 跑马灯速度。慢到能读完一只票，快到不必等太久 */
const SCROLL_PX_PER_SEC = 28
/** 减少动态效果时改为「一次一只、定时换」，这是换一只的间隔 */
const STEP_MS = 4500

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

/**
 * 当天 00:00。信号按 created_at 存的是墙上时刻，按「今天」筛（与面板列表同一口径）。
 *
 * 日界走**北京时间**而不是宿主本地时区：在西半球本机 00:00 会落进午盘，
 * 列表会在交易时段中途清空一半（见 `shared/time.ts`）。
 */
function startOfToday(): number {
  return shanghaiDayStartMs(Date.now())
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
 * 系统是否要求「减少动态效果」。
 *
 * Windows 的「显示动画」关掉（设置 → 辅助功能 → 视觉效果，**远程桌面会话里默认就是关的**）
 * 会让 Chromium 报 `prefers-reduced-motion: reduce`。这在本项目里不是小事：
 * 跑马灯一旦不滚，用户**永远只看得到第一只**，而且它还被右边框裁掉一半 ——
 * 「滚动显示全部自选」这个功能在那台机器上等于不存在（2026-08-13 在打包版上实测到）。
 * 所以这里不是「关掉动画就完了」，而是换一种不连续运动的表达：**一次显示一只，定时换**。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
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
      {/*
        失效**替换**方向标签而不是并排放：用户自己设的失效条件已经命中了，
        旁边还留着「买入」两个字，等于在替一条已被否掉的结论继续背书。
        确认则是并排的小字 —— 那条结论仍然成立，只是多了一层用户自己的佐证。
      */}
      {entry.action === null ? (
        <span className="act act--none">无信号</span>
      ) : entry.mark === 'INVALIDATED' ? (
        <span className="act act--none">{WATCH_MARK_LABEL.INVALIDATED}</span>
      ) : (
        <>
          <span className={`act ${ACTION_CLASS[entry.action]}`}>{ACTION_LABEL[entry.action]}</span>
          {entry.mark === 'CONFIRMED' ? <span className="act act--mark">{WATCH_MARK_LABEL.CONFIRMED}</span> : null}
        </>
      )}
      {/*
        日内做T建议。**与方向标签并排而不是替换它**：引擎判什么方向，与「现价这一刻
        在日内哪个位置」是两件事，合成一个标签会让用户以为引擎改口了。
        措辞是「日内高抛 / 日内低吸」而不是「卖 / 买」—— 它说的是一次日内往返，
        不是对这只票的看法（措辞纪律）。
      */}
      {entry.tHint === null ? null : (
        <span className="act act--t" title={T_HINT_TITLE[entry.tHint]}>
          {T_HINT_LABEL[entry.tHint]}
        </span>
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
  /*
    今天命中的观察点。**只用来改写方向标签**（watch-mark.ts），不参与排序也不计数 ——
    它不是信号（003_watch.sql 的头注释），条子上「今日 N 条信号」那个徽标一个都不许加。
  */
  const [hits, setHits] = useState<WatchPointView[]>([])
  /*
    本轮的日内做T建议。**每轮全量替换**（主进程没有建议时推空数组）——
    留着上一轮的会让早上那条「可考虑高抛」一直挂到收盘，而它的时效只有几十分钟。
  */
  const [tHints, setTHints] = useState<IntradayTHint[]>([])

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
        /*
          条子只用到「每只票当日最后一条」（buildTicker 的口径），所以 perCode 给 3 就够 ——
          多要的那些在这里一行都用不上，而少了 perCode 会让一只刷屏的票
          把其余自选整个挤出窗口，表现为「那几只永远显示无信号」。
        */
        .invoke('signal:history', { from: startOfToday(), limit: 200, perCode: 3 })
        .then(setSignals)
        .catch(() => undefined)
    }
    const loadItems = (): void => {
      void window.gp
        .invoke('watchlist:list')
        .then(setItems)
        .catch(() => undefined)
    }
    // 只取**今天**命中的：上周那次命中改写今天这条结论是错的（面板那边同一条口径）
    const loadHits = (): void => {
      const from = startOfToday()
      void window.gp
        .invoke('watch:list', { status: 'HIT', limit: 200 })
        .then((rows) => setHits(rows.filter((row) => (row.hitAt ?? 0) >= from)))
        .catch(() => undefined)
    }
    loadSignals()
    loadItems()
    loadHits()

    const offState = window.gp.on('push:petState', setPetState)
    const offQuotes = window.gp.on('push:quoteTick', setQuotes)
    const offTHints = window.gp.on('push:intradayT', setTHints)
    const offStatus = window.gp.on('push:engineStatus', (next) => {
      setStatus(next)
      // 引擎每轮跑完会推一次，借它当信号列表的重取信号（与面板同一做法）
      loadSignals()
      loadItems()
      loadHits()
    })
    return () => {
      offState()
      offQuotes()
      offTHints()
      offStatus()
    }
  }, [])

  const setInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return
    interactiveRef.current = next
    void window.gp.invoke('pet:setInteractive', next)
  }, [])

  /*
    鼠标在不在条子上。**进入靠渲染层，离开靠主进程**，两边都不是 CSS `:hover`。

    `:hover` 在这个窗口上会卡住：鼠标一离开本体，主进程就
    `setIgnoreMouseEvents(true, { forward: true })`，窗口从此不参与 OS 命中测试，
    离开时那一下 mouseout 送不到渲染层。

    但**光把 `:hover` 换成命中判定还不够**（2026-08-14 第一次修没修好）：
    命中判定跑在 `mousemove` 上，而鼠标移出窗口之后就再也没有 `mousemove` 了 ——
    最后收到的那一次坐标仍然落在本体内，于是这里照样卡在 true。
    `document` 上的 `mouseleave` 本来是兜底，实测在这个窗口上不可靠。

    所以「离开」由主进程按**真实光标位置**裁决（`OverlayWindow.watchPointer`，
    只在压着条子时轮询），结论经 `push:overlayPointer` 回来。
    **别把这条订阅删掉去依赖 DOM 事件** —— 那正是这个 bug 修了两次的原因。

    第三次（2026-08-14）修的是这条推送的**副作用没做全**：主进程裁定离开时，
    它那边的 `interactive` 已经变成 false，而这里的 `interactiveRef` 还留着 true。
    于是下次进入时 `setInteractive(true)` 撞上「值没变」的短路、一条 IPC 都不发 ——
    主进程停在穿透态、轮询不再启动，再离开就没有任何人能把 `hovering` 解开，
    跑马灯从此不动。连带的第二个症状是那期间条子是穿透的（**双击打不开面板**），
    但用户不会把这两件事联系到一起。
    **主进程是唯一的裁决者，所以这里必须跟着它把本地缓存一起改掉。**
  */
  const [hovering, setHovering] = useState(false)
  useEffect(
    () =>
      window.gp.on('push:overlayPointer', ({ over }) => {
        setHovering(over)
        if (!over) interactiveRef.current = false
      }),
    []
  )

  // ── 命中判定 + 拖拽（与桌宠形态同一套逻辑）────────────────────────
  useEffect(() => {
    const endDrag = (drag: DragState): void => {
      dragRef.current = null
      if (drag.travelled > DRAG_SLOP_PX) void window.gp.invoke('pet:dragEnd')
    }

    const onMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (drag !== null && event.buttons !== 0) {
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
      if (drag !== null) {
        // 按键已经松了却还留着拖拽态 —— 松手那一下丢了（甩得快时窗口追不上光标，
        // mouseup 落到了别的窗口上）。不补这一手，`dragRef` 会永久留着，
        // 往后每一次 mousemove 都当拖拽：条子粘着鼠标走，而命中判定与 `hovering`
        // 再也不更新，跑马灯停死。`event.buttons` 是这里唯一可信的判据。
        endDrag(drag)
      }
      const hit = hitTest(rects, event.clientX, event.clientY)
      setInteractive(hit)
      setHovering(hit)
    }

    const onMouseUp = (): void => {
      const drag = dragRef.current
      if (drag === null) return
      endDrag(drag)
    }

    // 鼠标快速掠出窗口时可能收不到最后一个 mousemove，
    // 不补这一手会让窗口停在「可交互」状态，把下层应用的点击吃掉 —— C2 的典型破法
    const onMouseLeave = (): void => {
      if (dragRef.current) return
      setInteractive(false)
      // 跟着一起解，否则鼠标快速掠出时跑马灯会停在暂停态再也不动
      setHovering(false)
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
  const fresh = useMemo(
    () => buildTicker(items, quotes, signals, hits, tHints),
    [items, quotes, signals, hits, tHints]
  )

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
  const reducedMotion = usePrefersReducedMotion()
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const lapRef = useRef<HTMLDivElement | null>(null)
  const [scrollSec, setScrollSec] = useState(0)
  useLayoutEffect(() => {
    const lap = lapRef.current
    const view = viewportRef.current
    if (lap === null || view === null || reducedMotion) return
    // 一份内容的宽度就是滚一圈的距离。量的是第一份，所以「加不加第二份」不会反过来影响测量
    const width = lap.scrollWidth
    const next = width > view.clientWidth ? width / SCROLL_PX_PER_SEC : 0
    setScrollSec((prev) => (Math.abs(prev - next) < 0.05 ? prev : next))
  }, [entries, hasAdvice, reducedMotion, viewport])

  // 休市 / 离线 / 免打扰时停下（C7 休市零开销）
  const paused = petState === 'SLEEPY' || petState === 'OFFLINE' || status?.doNotDisturb === true
  /*
    实际停不停 = C7 那三种情况 **或** 鼠标停在条子上
    （想看清某一只时它正好在往外走，是最直接的一种烦人）。

    悬停这一半以前是 CSS `.bar:hover` 干的，但那个 hover 状态在这个窗口上会卡住 ——
    见上面 `hovering` 那段。两者合成一个值，滚动与「一次一只」的定时器共用它，
    否则减少动态效果的那条路上悬停不会停。
  */
  const frozen = paused || hovering

  /**
   * 减少动态效果时的轮播：一次一只，到点换下一只。
   * 免责小字排在最后一张，与滚动模式里它跟在队尾是同一回事。
   */
  const cardCount = entries.length + (hasAdvice ? 1 : 0)
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!reducedMotion || frozen || cardCount <= 1) return
    const timer = window.setInterval(() => setStep((prev) => prev + 1), STEP_MS)
    return () => window.clearInterval(timer)
  }, [reducedMotion, frozen, cardCount])
  const stepIndex = cardCount > 0 ? step % cardCount : 0
  const stepEntry = entries[stepIndex]

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
          {reducedMotion ? (
            // 系统要求减少动态效果：不连续滚动，改成一次一只、定时换（见 usePrefersReducedMotion）
            <div className="lap lap--step">
              {stepEntry === undefined ? (
                <span className="item disclaimer">仅供参考，非投资建议</span>
              ) : (
                <Item entry={stepEntry} />
              )}
            </div>
          ) : (
            <div
              className={`track${scrollSec > 0 ? ' track--scroll' : ''}${frozen ? ' track--paused' : ''}`}
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
          )}
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
