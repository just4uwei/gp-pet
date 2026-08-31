/**
 * 形态样本（docs/07 §5 的 `fixtures/klines/`）。
 *
 * 全部**确定性生成**，不用 Math.random：策略测试断言的是「这段 K 线该产出哪些子信号」，
 * 而随机 fixture 会让同一条断言今天过明天不过。
 *
 * 价格路径都用「一段带噪音的横盘 + 一段有意为之的形态」拼出来：
 *   - 横盘段必须**带噪音**（不能真的一条直线）—— 真直线会让 STD=0、BBW 恒为 0，
 *     带宽分位退化成常量 100，于是所有依赖「带宽上升」的规则永远不成立，
 *     测出来的「不触发」是假通过。
 *   - 噪音还必须**没有周期**。这是上面那条的隐蔽版本，2026-08-13 才发现：
 *     固定错拍的锯齿振幅够、看起来完全正常，但 +DM 与 −DM 长期抵消，
 *     320 根之后 **ADX ≈ 8**，而 `adxRange` 是 15–23 —— 于是 T1 BUY 与 T4
 *     在所有基于本文件的 fixture 里**结构上无法触发**，两条断言因此三次提交没绿过。
 *     判据取自真实数据：46 只 2018 年至今 2709 次金叉里 **60.6% 当日 ADX 就够**，
 *     即真实横盘的 ADX 在 20 上下。详见 docs/notes/M2-偏差报告 §5.19。
 *   - 长度默认 320 根：BBW 分位要 269 根才有首值（见 core/indicators/boll.ts），
 *     短于此的 fixture 会让 T3 / R3 静默失效。
 *
 * **新增场景之后一定要打印一次子信号集合**，确认想测的那条真的出现了。
 * 「断言不触发」通过得太容易 —— 上面三条每一条都能让它无条件通过。
 */

import { priceLimits } from '@core/code'
import { addDays, isWeekend } from '@core/date'
import type { Candle, TradeDate } from '@core/types'

export interface BarOverride {
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  amount?: number | null
  provisional?: boolean
  hasGap?: boolean
}

export interface BuildOptions {
  startDate?: TradeDate
  /** 每根的成交量；给函数则按下标取 */
  volume?: number | ((index: number) => number)
  /** 前复权系数（closeAdj / close）。默认 1，即两套价格相同 */
  factor?: number
  overrides?: Record<number, BarOverride>
}

/** 从起始日开始的连续工作日（不查节假日 —— 那会引入 hasGap，缺口有自己的用例） */
export function weekdaysFrom(start: TradeDate, count: number): TradeDate[] {
  const dates: TradeDate[] = []
  let cursor = start
  while (dates.length < count) {
    if (!isWeekend(cursor)) dates.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return dates
}

/**
 * 用收盘序列造 K 线。开盘取上一根收盘，高低价按当日振幅外扩 0.5%
 * —— 形状不重要，重要的是 `high ≥ max(open,close)`、`low ≤ min(open,close)`，
 * 否则 core/quality.ts 会判为非法 K 线。
 */
export function buildCandles(closes: readonly number[], options: BuildOptions = {}): Candle[] {
  const { startDate = '2023-01-02', volume = 1_000_000, factor = 1, overrides = {} } = options
  const dates = weekdaysFrom(startDate, closes.length)

  return closes.map((rawClose, i) => {
    const override = overrides[i] ?? {}
    const close = override.close ?? rawClose
    const open = override.open ?? closes[i - 1] ?? close
    const high = override.high ?? Math.max(open, close) * 1.005
    const low = override.low ?? Math.min(open, close) * 0.995
    const vol = override.volume ?? (typeof volume === 'function' ? volume(i) : volume)
    const candle: Candle = {
      date: dates[i] ?? '2023-01-02',
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      openAdj: round(open * factor),
      highAdj: round(high * factor),
      lowAdj: round(low * factor),
      closeAdj: round(close * factor),
      volume: Math.round(vol),
      amount: override.amount === undefined ? Math.round(vol * close) : override.amount,
    }
    if (override.provisional) candle.provisional = true
    if (override.hasGap) candle.hasGap = true
    return candle
  })
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 带噪音的横盘段：**确定性伪随机游走 + 温和回拉**。
 *
 * ## 为什么不是固定周期的锯齿（2026-08-13 改）
 *
 * 原实现是 `((i%7)-3)/3 + ((i%3)-1)/6` 的错拍波形，振幅够、但**方向性运动几乎为零**：
 * 每一步的涨跌幅都取自同一个小集合，+DM 与 −DM 长期抵消，320 根之后 **ADX ≈ 8**。
 * 而 `adxRange` 在出厂参数下是 15–23 —— 于是**凡是建立在 chopCloses 之上的 fixture，
 * 所有要求 `ADX > adxRange` 的规则（T1 BUY、T4）都永远不成立**，
 * `tests/integration/engine/engine.test.ts` 的两条断言因此从写下来那天起就没绿过。
 *
 * 这是本文件开头那个坑的**更隐蔽版本**：真直线让 BBW 恒为 0 是一眼能看出来的，
 * 「规则锯齿让 ADX 恒低」不是 —— 序列看起来完全正常，只是测出来的「不触发」全是假通过。
 *
 * 判据取自真实数据：46 只 2018 至今、2709 次 `crossUp(MA5,MA20)` 中
 * **60.6% 当日就满足 `adx > adxRange`**，即真实横盘的 ADX 在 20 上下，不是 8。
 * 换成随机游走后横盘段 ADX 落在 `adxRange` 与 `adxTrend` 之间 ——
 * 那正是这两条线要表达的语义：**够得上「不是纯震荡」，够不上「已成趋势」**。
 *
 * 仍然**不用 `Math.random`**：随机 fixture 会让同一条断言今天过明天不过。
 * 种子写死，序列每次都一样。
 */
export function chopCloses(count: number, base = 10, amplitude = 0.02): number[] {
  // 线性同余，参数取自 glibc。要的只是「步长互不相同且不成周期」，不需要统计学意义上的好
  let seed = 20260813
  const unit = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return (seed / 2147483648) * 2 - 1
  }

  const out: number[] = []
  let price = base
  for (let i = 0; i < count; i++) {
    price *= 1 + amplitude * unit()
    // 回拉系数刻意小：大了会把游走压回锯齿（回到上面那个坑），
    // 小了则会走出趋势 —— 横盘段必须是横盘，rangeBound() 那条「不出 T4」靠的就是它
    price += (base - price) * 0.06
    out.push(round(price))
  }
  return out
}

/** 单调上涨段：每根涨 `step` */
export function rampCloses(count: number, start: number, step: number): number[] {
  return Array.from({ length: count }, (_, i) => start * (1 + step) ** i)
}

// ─────────────────────────── 场景 ───────────────────────────

export interface Scenario {
  name: string
  candles: Candle[]
  /** 该场景意在触发（或明确不该触发）的子信号，供用例自我说明 */
  expect: { fires: string[]; silent: string[] }
}

/**
 * 突破形态的价格路径：**横盘 → 回调 → 放量拉升**，金叉与缩量两个场景共用。
 *
 * ## 那 5 根回调不是装饰（2026-08-13 加）
 *
 * 没有它就没有金叉。横盘段末尾 MA5 与 MA20 的相对位置是随机的，直接接拉升时
 * MA5 往往**已经**在 MA20 之上 —— 拉升只会让它越走越高，而 `crossUp` 是个**事件**，
 * 不会因为「涨得更多」而补发一次（docs/04 §2 的穿越纪律）。
 * 先用 5 根 −1.5% 把 MA5 压到 MA20 之下，拉升途中上穿，金叉才落在被观察的窗口里。
 *
 * ## 拉升给 8 根而不是 6 根
 *
 * 金叉与突破**不同时发生**：MA5 上穿 MA20 只需要涨回回调段，而 `close > UPPER`
 * 还要再往上走一截。6 根的窗口里只装得下前者，于是 T3 会假性「不触发」。
 * 8 根之后两个事件都落在最后 6 根里 —— 这也是现实：**突破晚于金叉**。
 */
function breakoutCloses(): { closes: number[]; surgeStart: number } {
  const chop = chopCloses(320)
  let price = chop[chop.length - 1] ?? 10
  const dip: number[] = []
  for (let i = 0; i < 5; i++) {
    price = price * 0.985
    dip.push(price)
  }
  const surge = Array.from({ length: 8 }, (_, i) => price * 1.035 ** (i + 1))
  return { closes: [...chop, ...dip, ...surge], surgeStart: chop.length + dip.length }
}

/**
 * 「一段标准的金叉放量突破」：横盘 → 回调 → 连续 8 根放量拉升。
 *
 * 期望：MA5 上穿 MA20（T1）、收盘越上轨且带宽扩张且放量（T3）、均线多头排列（T4）。
 */
export function goldenCrossBreakout(): Scenario {
  const { closes, surgeStart } = breakoutCloses()
  return {
    name: '金叉放量突破',
    candles: buildCandles(closes, {
      // 拉升段放量 3 倍：量比确认项（≥1.2）要真的成立
      volume: (i) => (i >= surgeStart ? 3_000_000 : 1_000_000),
    }),
    expect: { fires: ['T1_MA_CROSS', 'T3_BREAKOUT'], silent: [] },
  }
}

/**
 * 「一段假突破」：**同样的价格路径**，但拉升段缩量。
 *
 * 期望：T3 不成立（量比确认失败）而 T1 仍在。这是 docs/04 §3.1 里 T3 那条
 * 「量比 ≥ 1.2」的反例，也是最容易被实现漏掉的确认项 ——
 * 两个场景必须共用 `breakoutCloses()`，各自复制一份价格路径的话，
 * 「只有量不同」这个前提会在某次改动后悄悄不成立，而用例照样绿。
 */
export function falseBreakout(): Scenario {
  const { closes, surgeStart } = breakoutCloses()
  return {
    name: '缩量假突破',
    candles: buildCandles(closes, {
      // 拉升段反而缩量到 0.5 倍
      volume: (i) => (i >= surgeStart ? 500_000 : 1_000_000),
    }),
    expect: { fires: ['T1_MA_CROSS'], silent: ['T3_BREAKOUT'] },
  }
}

/**
 * 「突破次日一字涨停」：横盘 → 回调 → **2 根**放量拉升 → 连续 3 根一字涨停。
 *
 * 用途只有一个：让回测的「次日开盘涨停 → 买单作废」这条路径**真的被走到**。
 *
 * ## 它替掉了什么（2026-08-13）
 *
 * 原来那条用例在测试里就地造了一段 fixture：320 根**字面意义的直线**（全部 10.000、
 * open=high=low=close、成交量恒定）接 30 根涨停。结果是 STD=0、ATR=0、量比恒为 1.0，
 * **一个买入信号都产不出来** —— 实测 27 次评估、0 次抑制、0 张委托，
 * 于是 `limitBlocked` 恒为 0，而 `expect(trades).toHaveLength(0)` 在真空里通过着。
 * 这条安全路径此前是**零覆盖**，用例看起来却像有人管。
 *
 * ## 为什么拉升只给 2 根
 *
 * 再长下去 RSI 就进超买区，末根的组合结论会翻成卖出 —— 待成交的委托也就不是买单，
 * 测不到「买单作废」。2 根刚好：金叉与放量都成立，RSI 还没到顶。
 *
 * 涨停价必须用 `priceLimits` 按板块规则算，**不能写 ×1.1**：
 * 模拟器判的是 `bar.open >= limitUp - 0.001`，而 limitUp 是分到两位的，
 * 差半分钱就成了「没涨停」。
 */
export function limitUpBreakout(): Scenario {
  const chop = chopCloses(320)
  let price = chop[chop.length - 1] ?? 10
  const dip: number[] = []
  for (let i = 0; i < 5; i++) {
    price = price * 0.985
    dip.push(price)
  }
  const surge = Array.from({ length: 2 }, (_, i) => price * 1.035 ** (i + 1))
  const closes = [...chop, ...dip, ...surge]
  const surgeStart = chop.length + dip.length

  const overrides: Record<number, BarOverride> = {}
  let last = closes[closes.length - 1] ?? 10
  for (let i = 0; i < 3; i++) {
    last = priceLimits(last, 'MAIN', false, '2020-01-02')?.limitUp ?? round(last * 1.1)
    closes.push(last)
    // 一字涨停：开=高=低=收
    overrides[closes.length - 1] = { open: last, high: last, low: last, close: last }
  }

  return {
    name: '突破次日一字涨停',
    candles: buildCandles(closes, {
      volume: (i) => (i >= surgeStart ? 3_000_000 : 1_000_000),
      overrides,
    }),
    expect: { fires: ['T1_MA_CROSS'], silent: [] },
  }
}

/** 「一段震荡」：全程横盘，用于 RANGE 判定与 R4 中轨超调 */
export function rangeBound(): Scenario {
  return {
    name: '震荡',
    candles: buildCandles(chopCloses(340)),
    expect: { fires: [], silent: ['T4_ALIGNMENT'] },
  }
}

/**
 * 「连续跌停」：横盘之后连续 4 根 -10%。
 *
 * 期望：卖出方向被硬抑制（跌停卖不掉，docs/05 §2.1）。
 * 注意跌幅要用**不复权**价算 —— 涨跌停是真实价格的规则。
 */
export function limitDownStreak(): Scenario {
  const chop = chopCloses(320)
  const last = chop[chop.length - 1] ?? 10
  const closes = [...chop]
  let price = last
  for (let i = 0; i < 4; i++) {
    price = round(price * 0.9)
    closes.push(price)
  }
  const overrides: Record<number, BarOverride> = {}
  for (let i = chop.length; i < closes.length; i++) {
    const close = closes[i] ?? 0
    // 一字跌停：开=高=低=收
    overrides[i] = { open: close, high: close, low: close, close }
  }
  return {
    name: '连续跌停',
    candles: buildCandles(closes, { overrides }),
    expect: { fires: [], silent: [] },
  }
}

/** 长期下跌：用于 TREND_DOWN 与「均值回归买入被降权」 */
export function downTrend(): Scenario {
  const chop = chopCloses(200)
  const last = chop[chop.length - 1] ?? 10
  const slide = Array.from({ length: 140 }, (_, i) => last * 0.985 ** (i + 1))
  return {
    name: '下跌趋势',
    candles: buildCandles([...chop, ...slide]),
    expect: { fires: [], silent: [] },
  }
}

/** 读取 scripts/verify 生成的 500 根合成日线（含四段行情，覆盖面最广） */
export const SYNTHETIC_FIXTURE = 'tests/fixtures/klines/synthetic-500.json'
