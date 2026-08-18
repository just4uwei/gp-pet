/**
 * 收盘日报的聚合判据（2026-08-14）。**纯模块**：不读时钟、不碰 IO、不 import Electron。
 *
 * 与 `watch/evaluate.ts`、`alerts/candidates.ts` 同一类 —— 可测的判据下沉，
 * 不埋进 JSX（项目里**没有渲染层测试**，埋进组件就只能靠肉眼验收）。
 *
 * ## 一条纪律：只复述，不推导
 *
 * 日报里必然有「明天该关注什么」，而那正是 `NEXT_DAY_WATCH` 信号在回答的问题。
 * 若这里自己去推导一份「明日关注」（比如「今天涨了 5% 且放量，明天值得看」），
 * 就会出现两个来源、可能互相矛盾的结论，**而用户没有办法判断该信哪个**。
 *
 * 所以 `tomorrow` 的每一项都必须指回一个**已经存在**的东西：
 * 一条今日的 `NEXT_DAY_WATCH` 信号、一个仍在盯的观察点、一条未了结的持仓风控裁决。
 * 与「观察点命中不写进 signal 表」「状态点只认闸门」是同一条纪律。
 *
 * ## 两个数据来源不能混，而且必须让用户看得见用的是哪个
 *
 * 当日收盘线（`CLOSE`）与盘中最后一个快照（`SNAPSHOT`）在数字上会差一点 ——
 * 集合竞价会改收盘价。混着用、或者不标注，用户看到的就是一份**看不出准不准**的报告。
 * 所以每只票各带 `source`，报告整体再给一个 `stage`。
 *
 * 拿不到行情时 `quote` 是 **null**，不是一堆 0（约束 4 的同一条纪律）。
 */

import type {
  AlertRecord,
  DailyReport,
  DailyReportStock,
  DailyReportTomorrow,
  PositionView,
  ReportEnvironment,
  SignalRecord,
  WatchItem,
  WatchPointView,
} from '@shared/ipc-types'
import type { Candle, GatedDirection, SecCode, Snapshot, TradeDate } from '@core/types'
import { SESSION_BOUNDS } from '@core/session'

export interface BuildReportInput {
  date: TradeDate
  /** 生成时刻（墙上时间）。本模块不读时钟 */
  at: number
  /**
   * `date` 那天**北京时间 15:00** 的 epoch ms。收盘线的「数据时刻」用它。
   *
   * 由调用方给（`engine/settle.ts` 的 `closeMsOf`）—— 本模块不读时钟、也不做时区换算。
   */
  closeMs: number
  items: readonly WatchItem[]
  /**
   * 当日收盘线：code → [前一根, 当日那根]。**当日那根缺席时整条不给**
   * （停牌，或数据还没到）—— 调用方按 `recentThrough(code, date, 2)` 取，
   * 末根日期不等于 `date` 时就别放进来。
   */
  bars: ReadonlyMap<SecCode, { day: Candle; prev?: Candle }>
  /** 盘中最后一个快照（内存缓存）。收盘线还没入库时的退路 */
  snapshots: ReadonlyMap<SecCode, Snapshot>
  /** 当日全部信号，**含被硬抑制的**（面板要能回答「它为什么没提醒我」） */
  signals: readonly SignalRecord[]
  positions: readonly PositionView[]
  /** 观察点全量（ACTIVE / HIT / EXPIRED 都要，各自计数口径不同） */
  watchPoints: readonly WatchPointView[]
  /** 当日提醒日志 */
  alerts: readonly AlertRecord[]
  /**
   * 固定止损比例（`params.risk.stopLossPct`）。**由调用方传** ——
   * 这一层不认识引擎参数，传进来才能在用例里钉住「距止损线」的算法。
   */
  stopLossPct: number
  /** 当日零点。判断观察点「明天到期」用，同样不在这里读时钟 */
  dayStart: number
  /**
   * 今日环境（基准 + 行业 ETF），由 `report/environment.ts` 先算好传进来。
   *
   * **必填而不是可选**：可选会让调用方漏传时静默少一整节，而界面上只是"那块没了"。
   * 本模块只做透传 —— 它不认识行业 ETF，也不该认识（那一节的判据在 environment.ts）。
   */
  environment: ReportEnvironment
}

/** 方向标签在 `tomorrow.note` 里出现，与面板/悬浮条同一份措辞 */
const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

/** 计数并列时的稳定次序，与 `shared/signal-group.ts` 同一张表（顺序抖动的列表读起来像在闪） */
const DIRECTION_ORDER: readonly GatedDirection[] = ['BUY', 'SELL', 'REDUCE', 'NEXT_DAY_WATCH', 'NONE']

function rankOf(direction: GatedDirection): number {
  const index = DIRECTION_ORDER.indexOf(direction)
  return index === -1 ? DIRECTION_ORDER.length : index
}

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100
}

/**
 * 日报的 `overview` / `stocks` / `tomorrow` 三节要算哪些标的（2026-08-15 定，08-18 补例外）。
 *
 * 内置的「行业ETF」组默认摘掉：日报答的是「我这些票今天怎么样」，
 * 15 只观察标的混进 7 只真持仓里，用户自己的票会被埋掉一多半，
 * 而 `highlights` / `tomorrow` 的计数也会被它们顶满。
 *
 * **但有持仓的不摘**：行业 ETF 现在可以真的建仓，而持仓就是「我这些票」——
 * 一只压着真金白银的 ETF 不出现在日报里，那是漏，不是克制。
 * 而这种漏在界面上看不出来（少一行不会报错），所以判据下沉到这里、由用例钉住。
 *
 * 行业动向仍由独立的「今日环境」那一节回答（`report/environment.ts`），
 * 它列全部 15 只，**含已被这里收走的那几只持仓 ETF** —— 两节答的是两个问题。
 *
 * @param etfGroup `INDUSTRY_ETF_GROUP`，由调用方传（本模块不 import `@shared/industry-etf`）
 */
export function reportableItems<T extends { group: string; hasPosition: boolean }>(
  items: readonly T[],
  etfGroup: string
): T[] {
  return items.filter((item) => item.group !== etfGroup || item.hasPosition)
}

/**
 * 日报该报**哪一天**（2026-08-18）。
 *
 * 改动之前这个判据是「库里最后一根日线的日期」，而当日日线 15:05–15:30 才发布、
 * 应用 15:10 之后不再取数 ⇒ 今天的那根要到**次日盘前**才入库 ⇒ **整个今天
 * （含盘中）日报都停在昨天，还打着「已定稿」**；而同一屏的信号 / 提醒统计按
 * 「今天北京 00:00」切 —— 一份报告里混着「昨天的价 + 今天的信号」，界面上看不出来。
 *
 * 所以判据改成「当前交易日」：**开盘之后就是今天**，今天的收盘线还没入库不要紧，
 * 那正是 `stage = PROVISIONAL` 在说的事。
 *
 * 阈值取 `SESSION_BOUNDS.open`（09:30）而不是 09:00：开盘前今天一个数都没有，
 * 那时给昨天的定稿版比给一屏「—」有用。休市日同理退回最后一天有数据的那天。
 *
 * 名字不叫 `reportDateOf` —— 那个名字被 `@shared/ai-target` 占着（解析 `report:<date>`）。
 */
export function reportSubjectDate(input: {
  /** 北京日，由调用方给（本模块不读时钟） */
  today: TradeDate
  /** 今天是不是交易日，由调用方问日历 */
  todayIsOpen: boolean
  minuteOfDay: number
  /** 库里已有收盘线的最后一天；一根都没有时 null */
  lastDataDate: TradeDate | null
}): TradeDate {
  if (input.todayIsOpen && input.minuteOfDay >= SESSION_BOUNDS.open) return input.today
  return input.lastDataDate ?? input.today
}

/**
 * 一只票的行情。优先当日收盘线，其次盘中快照，都没有则 null。
 *
 * **两者不混用**：涨跌幅与振幅必须与 `close` 出自同一份数据，
 * 拿收盘价配快照的昨收会算出一个哪边都不对的数。
 *
 * `closeMs` 是那一天的北京 15:00，只用来给收盘线那一支盖时刻。
 */
export function quoteOf(
  code: SecCode,
  bars: BuildReportInput['bars'],
  snapshots: BuildReportInput['snapshots'],
  closeMs: number
): DailyReportStock['quote'] {
  const bar = bars.get(code)
  if (bar) {
    const prevClose = bar.prev?.close
    const hasPrev = prevClose !== undefined && prevClose > 0
    return {
      close: bar.day.close,
      changePct: hasPrev ? pct(bar.day.close - prevClose, prevClose) : 0,
      // 昨收拿不到时振幅给 null 而不是拿今开当分母 —— 那是另一个量
      amplitudePct: hasPrev ? pct(bar.day.high - bar.day.low, prevClose) : null,
      open: bar.day.open,
      high: bar.day.high,
      low: bar.day.low,
      source: 'CLOSE',
      // 收盘线的时刻就是那天的收盘 —— 它是哪一分钟被抓进库的与这个数无关
      at: closeMs,
    }
  }

  const snapshot = snapshots.get(code)
  if (snapshot && snapshot.last > 0) {
    const hasPrev = snapshot.preClose > 0
    return {
      close: snapshot.last,
      changePct: hasPrev ? pct(snapshot.last - snapshot.preClose, snapshot.preClose) : 0,
      amplitudePct:
        hasPrev && snapshot.high > 0 && snapshot.low > 0
          ? pct(snapshot.high - snapshot.low, snapshot.preClose)
          : null,
      open: snapshot.open > 0 ? snapshot.open : null,
      high: snapshot.high > 0 ? snapshot.high : null,
      low: snapshot.low > 0 ? snapshot.low : null,
      source: 'SNAPSHOT',
      /*
        `Snapshot.at` 是**最后成交时刻**，不是「现在」——停牌与冷门股会合法地落后很久。
        作为「这个价是什么时候的」它正合适（那种落后恰恰要让用户看见），
        但**不许拿它当钟用**：`clock-sync.ts` 的头注释记着同一条（校时只认 HTTP Date 头）。
      */
      at: snapshot.at,
    }
  }

  return null
}

/**
 * 距固定止损线还有多远（百分比，负数 = 已经跌破）。
 *
 * **用户重画过线时按他画的那条算**（`stopAck.stopFloor`）：那才是当前生效的判据，
 * 照旧按成本的百分比算会显示一条早已不适用的距离
 * （009_position_stop.sql：重画只作用于固定止损这一条规则）。
 */
export function toStopPct(
  position: PositionView,
  price: number | null,
  stopLossPct: number
): number | null {
  if (price === null || price <= 0) return null
  const floor =
    position.stopAck && position.stopAck.stopFloor > 0
      ? position.stopAck.stopFloor
      : position.cost * (1 - stopLossPct)
  if (floor <= 0) return null
  return pct(price - floor, price)
}

export function buildDailyReport(input: BuildReportInput): DailyReport {
  const { date, at, closeMs, items, bars, snapshots, signals, positions, watchPoints, alerts, stopLossPct, dayStart, environment } =
    input

  const positionOf = new Map(positions.map((p) => [p.code, p]))
  const signalsOf = new Map<SecCode, SignalRecord[]>()
  for (const signal of signals) {
    const bucket = signalsOf.get(signal.code)
    if (bucket) bucket.push(signal)
    else signalsOf.set(signal.code, [signal])
  }
  const pointsOf = new Map<SecCode, WatchPointView[]>()
  for (const point of watchPoints) {
    const bucket = pointsOf.get(point.code)
    if (bucket) bucket.push(point)
    else pointsOf.set(point.code, [point])
  }

  const stocks: DailyReportStock[] = []
  const tomorrow: DailyReportTomorrow[] = []
  const missing: SecCode[] = []
  const directionTally = new Map<GatedDirection, number>()
  let withClose = 0
  let withSignal = 0
  let belowStop = 0
  /*
    「逐只」那一节里信号侧的最新时刻。

    单独累一个数是必须的：`DailyReportStock.signals` 只留了**最后一条的方向**，
    没留时刻（那一节要的是结论不是时刻）；而 `signals` 入参覆盖的是**全部自选**，
    含被 `reportableItems` 摘掉的那些没持仓的行业 ETF —— 拿它去算这一节的时刻，
    会把一条屏幕上根本不存在的 ETF 信号当成「这一节刚更新过」。
  */
  let lastSignalAt: number | null = null

  for (const item of items) {
    const quote = quoteOf(item.code, bars, snapshots, closeMs)
    if (quote === null) missing.push(item.code)
    if (quote?.source === 'CLOSE') withClose++

    // ── 信号 ──────────────────────────────────────────────────
    const rows = [...(signalsOf.get(item.code) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
    const visible = rows.filter((row) => row.suppressedReason === undefined)
    // 「当日最后一条未静默」—— 与悬浮条 tag 同一口径（收盘失效那条不该被上午的盖住）
    const last = visible[visible.length - 1] ?? null
    if (visible.length > 0) withSignal++
    for (const row of visible) {
      directionTally.set(row.direction, (directionTally.get(row.direction) ?? 0) + 1)
      if (lastSignalAt === null || row.createdAt > lastSignalAt) lastSignalAt = row.createdAt
    }

    const suppressedReasons = [
      ...new Set(rows.map((row) => row.suppressedReason).filter((r): r is string => r !== undefined)),
    ]

    // ── 持仓 ──────────────────────────────────────────────────
    const held = positionOf.get(item.code)
    const price = quote?.close ?? null
    const stock: DailyReportStock = {
      code: item.code,
      name: item.name,
      ...(item.industry === undefined ? {} : { industry: item.industry }),
      quote,
      signals: {
        total: rows.length,
        actionable: visible.length,
        last: last
          ? { direction: last.direction, level: last.level, stage: last.stage, score: last.score }
          : null,
        suppressedReasons,
      },
      watch: {
        hit: (pointsOf.get(item.code) ?? []).filter((p) => p.status === 'HIT' && (p.hitAt ?? 0) >= dayStart).length,
        expired: (pointsOf.get(item.code) ?? []).filter((p) => p.status === 'EXPIRED').length,
        active: (pointsOf.get(item.code) ?? []).filter((p) => p.status === 'ACTIVE').length,
      },
    }

    if (held && held.shares > 0) {
      const distance = toStopPct(held, price, stopLossPct)
      if (distance !== null && distance <= 0) belowStop++
      stock.position = {
        shares: held.shares,
        cost: held.cost,
        pnlPct: price !== null && held.cost > 0 ? pct(price - held.cost, held.cost) : null,
        toStopPct: distance,
        ...(held.stopAck ? { stopFloor: held.stopAck.stopFloor } : {}),
      }
    }

    stocks.push(stock)

    // ── 明日关注：**只复述**（见文件头）──────────────────────────
    if (last?.direction === 'NEXT_DAY_WATCH') {
      tomorrow.push({
        code: item.code,
        name: item.name,
        kind: 'NEXT_DAY_WATCH',
        note: `今日收盘给出「${DIRECTION_LABEL.NEXT_DAY_WATCH}」，置信 ${Math.round(last.score * 100)}%`,
        // 时刻也是「复述」的一部分：被复述的那条信号自己是几点得出的
        at: last.createdAt,
      })
    }
    for (const point of pointsOf.get(item.code) ?? []) {
      if (point.status !== 'ACTIVE') continue
      tomorrow.push({
        code: item.code,
        name: item.name,
        kind: 'WATCH_POINT',
        note: `仍在盯：${point.metric} ${point.op === 'LTE' ? '跌破' : '升破'} ${point.threshold}`,
        // 观察点的时刻用**建立时刻**：它是「用户什么时候让我盯的」。
        // 不用 expiresAt（那是未来）、也不用 hitAt（ACTIVE 的还没命中）
        at: point.createdAt,
      })
    }
    // 未了结的持仓风控：**复述当日那条信号自己的方向**，不另起一个结论
    if (stock.position && (last?.direction === 'SELL' || last?.direction === 'REDUCE')) {
      tomorrow.push({
        code: item.code,
        name: item.name,
        kind: 'POSITION_RISK',
        note: `持仓未了结：今日最后一条为「${DIRECTION_LABEL[last.direction]}」`,
        at: last.createdAt,
      })
    }
  }

  // ── 提醒统计 ────────────────────────────────────────────────
  const delivered = alerts.filter((a) => a.channels.length > 0).length
  const reasonTally = new Map<string, number>()
  for (const alert of alerts) {
    if (alert.reason === undefined || alert.reason === '') continue
    reasonTally.set(alert.reason, (reasonTally.get(alert.reason) ?? 0) + 1)
  }

  // ── 阶段 ────────────────────────────────────────────────────
  // 「有数据的都用上了收盘线」才叫定稿。一只都没有数据时也不能叫定稿 ——
  // 那是「什么都还没有」，不是「已经确定」
  const withQuote = stocks.filter((s) => s.quote !== null)
  const stage: DailyReport['stage'] =
    withQuote.length > 0 && withQuote.every((s) => s.quote?.source === 'CLOSE') ? 'FINAL' : 'PROVISIONAL'

  const byDirection = [...directionTally]
    .map(([direction, count]) => ({ direction, count }))
    .sort((a, b) => b.count - a.count || rankOf(a.direction) - rankOf(b.direction))

  return {
    date,
    stage,
    at,
    overview: {
      watchCount: items.length,
      withSignal,
      byDirection,
      positions: stocks.filter((s) => s.position !== undefined).length,
      belowStop,
    },
    stocks,
    alerts: {
      delivered,
      gated: alerts.length - delivered,
      reasons: [...reasonTally]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
    },
    tomorrow,
    data: { withClose, missing },
    // 透传。**不要**把 environment 的数字掺进 highlights ——
    // 那几句答的是「我的票今天怎么样」，环境是另一节，混起来就再也分不清
    // 「3 只跌破止损」是我的票的事还是大盘的事
    environment,
    highlights: highlightsOf({ items, withSignal, byDirection, belowStop, delivered, gated: alerts.length - delivered, tomorrow, stage }),
    stamps: stampsOf({ stocks, environment, lastSignalAt, tomorrow, alerts }),
  }
}

/** 一串时刻里最新的那个。全是 null / 空 → null（**绝不退化成 0 或「现在」**） */
function newestOf(values: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (best === null || value > best) best = value
  }
  return best
}

/**
 * 每一节的「数据时刻」（2026-08-18）。
 *
 * 口径是**数据时刻**不是重算时刻：这一节的事实里最新那一条是几点的。
 * 理由写在 `DailyReport.stamps` 的类型注释里 —— 全部标成生成时刻等于告诉用户
 * 「今日提醒也是刚更新的」，而它可能从早上 09:03 起就没变过。
 *
 * 三条边界：
 * 1. **取最新（max）而不是最旧。** 停牌股的快照可以是几天前的，
 *    拿它当整节的时刻会让一屏刚刷出来的数字显示成「三天前」。
 *    单只有多旧由那一行自己的 `quote.at` 回答。
 * 2. **一条事实都没有就是 null。** 用 0 或生成时刻顶替，等于替一节空白内容担保。
 * 3. **`summary` 是派生节**，取它复述的那几节里最新的一条 —— 它自己没有独立事实。
 */
export function stampsOf(input: {
  stocks: readonly DailyReportStock[]
  environment: ReportEnvironment
  /** 「逐只」那一节里当日未静默信号的最新时刻（`stocks` 里不带时刻，见 buildDailyReport） */
  lastSignalAt: number | null
  tomorrow: readonly DailyReportTomorrow[]
  alerts: readonly AlertRecord[]
}): DailyReport['stamps'] {
  const { stocks, environment, lastSignalAt, tomorrow, alerts } = input

  const quotesAt = newestOf(stocks.map((stock) => stock.quote?.at))
  const stampStocks = newestOf([quotesAt, lastSignalAt])
  const stampTomorrow = newestOf(tomorrow.map((row) => row.at))
  const stampAlerts = newestOf(alerts.map((row) => row.createdAt))

  return {
    environment: newestOf([
      environment.benchmark?.quote?.at,
      ...environment.industries.map((row) => row.quote?.at),
    ]),
    stocks: stampStocks,
    summary: newestOf([stampStocks, stampTomorrow, stampAlerts]),
    tomorrow: stampTomorrow,
    alerts: stampAlerts,
  }
}

/**
 * 几句陈述。**刻意不叫「评价」** —— 规则拼出来的句子只能陈述事实。
 *
 * 每一句都必须能从上面那些计数里逐字推出来。不许出现「今天表现不错」这种话：
 * 它读起来像结论，而它背后没有任何依据，用户却会当成软件的判断。
 * 真正的评价是 AI 那个按钮的事（措辞纪律：不得出现胜率/概率/必涨/抄底）。
 */
export function highlightsOf(input: {
  items: readonly WatchItem[]
  withSignal: number
  byDirection: { direction: GatedDirection; count: number }[]
  belowStop: number
  delivered: number
  gated: number
  tomorrow: readonly DailyReportTomorrow[]
  stage: DailyReport['stage']
}): string[] {
  const { items, withSignal, byDirection, belowStop, delivered, gated, tomorrow, stage } = input
  const lines: string[] = []

  if (items.length === 0) return ['还没有自选股。']

  if (withSignal === 0) {
    lines.push(`${items.length} 只自选，今日无信号。`)
  } else {
    const spread = byDirection.map((d) => `${DIRECTION_LABEL[d.direction]} ${d.count} 条`).join('、')
    lines.push(`${items.length} 只自选，其中 ${withSignal} 只今日出现信号（${spread}）。`)
  }

  if (belowStop > 0) lines.push(`${belowStop} 只持仓已跌破止损线。`)

  if (delivered > 0 || gated > 0) {
    lines.push(`今日发出 ${delivered} 条提醒，另有 ${gated} 条被闸门挡下或降级。`)
  }

  if (tomorrow.length > 0) {
    const codes = new Set(tomorrow.map((t) => t.code)).size
    lines.push(`明日关注 ${codes} 只、共 ${tomorrow.length} 项。`)
  }

  if (stage === 'PROVISIONAL') {
    // 「收盘后可能微调」这句原先在收盘之后读起来自相矛盾（2026-08-18 改）：
    // 新口径下这份报告从开盘那一刻起就是今天的，而当日日线要到次日盘前才入库，
    // 于是这一句在 16:00 也会出现
    lines.push('当日日线尚未入库，数字取自盘中最后一次行情，次日盘前定稿后可能微调。')
  }

  return lines
}
