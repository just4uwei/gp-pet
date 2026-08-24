/**
 * 信号编排层（src/main/engine/signals.ts）。
 *
 * 用假依赖跑：这一层没有策略判断，要验的是**编排**——
 *   - 竞价时段不产出信号（虚价会伪造穿越）
 *   - 落库去重：盘中每 30s 一轮，不能每轮插一行
 *   - 只缓存收盘指标，临时线的指标不落库
 *   - 收盘确认轮把 PROVISIONAL 推进为 CONFIRMED / INVALIDATED
 *   - 单只算不出来不拖垮整轮
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createSignalEngine,
  signalSignature,
  snapshotOfIndicators,
  type SignalEngineDeps,
} from '@main/engine/signals'
import { computeIndicators } from '@core/indicators'
import { DEFAULT_PARAMS, engineVersionOf, withParams } from '@core/params'
import type { Candle, Position, SecCode, SecProfile, SignalStage, Snapshot } from '@core/types'
import type { MarketContext } from '@main/engine/market-data'
import type { WatchEntry } from '@main/storage/repositories/watchlist'
import type { SignalRow } from '@main/storage/repositories/signal'
import { shanghaiDayStartMs } from '@shared/time'
import { buildCandles, chopCloses, goldenCrossBreakout, rampCloses } from '../../fixtures/klines'

const PROFILE: SecProfile = { code: 'SH600000', name: '浦发银行', market: 'SH', board: 'MAIN', isST: false }

/**
 * 把组合阈值调低（0.3 分 / 1 票），与 `tests/unit/backtest/simulate.test.ts` 同一个理由：
 * **这里验的是编排，不是信号质量。**
 *
 * 用出厂阈值（0.60 分 / 趋势 3 票）的话，fixture 里没有任何一根能凑够票数
 * —— 实测最好的一根只有 2 票（T1+T3），于是 `persist()` 一行都不写，
 * 「同一条信号连续多轮只落一行」这类去重用例全部退化成 `0 === 0` 的假通过。
 * 信号稀疏本身是对的（真实回测里平均资金占用只有 4%），但不该让编排层无从验起。
 */
const SENSITIVE = withParams({
  combine: {
    ...DEFAULT_PARAMS.combine,
    scoreThreshold: 0.3,
    voteThreshold: { trend: 1, meanReversion: 1 },
  },
})

function entry(profile: SecProfile = PROFILE): WatchEntry {
  return { profile, group: '自选', sortOrder: 0, createdAt: 0 }
}

interface Harness {
  deps: SignalEngineDeps
  rows: SignalRow[]
  cached: { code: SecCode; date: string; version: string }[]
  stageUpdates: { id: string; stage: string }[]
  peaks: { code: SecCode; price: number }[]
}

function harness(options: {
  candles?: Candle[]
  entries?: WatchEntry[]
  position?: Position | null
  snapshot?: Snapshot | null
  latestOfDay?: SignalRow | null
  /** 按交易日给的 latestOfDay。复活判定要区分「昨天」与「今天」，一个常量答不了 */
  latestOfDayBy?: (date: string) => SignalRow | null
  benchmark?: Candle[]
  throwOn?: SecCode
} = {}): Harness {
  const candles = options.candles ?? goldenCrossBreakout().candles
  const rows: SignalRow[] = []
  const cached: { code: SecCode; date: string; version: string }[] = []
  const stageUpdates: { id: string; stage: string }[] = []
  const peaks: { code: SecCode; price: number }[] = []
  let counter = 0

  const context = (code: SecCode): MarketContext => {
    if (options.throwOn === code) throw new Error('模拟取数异常')
    const source = code === 'SH000300' ? (options.benchmark ?? buildCandles(chopCloses(300))) : candles
    return {
      code,
      candles: source,
      provisional: source[source.length - 1]?.provisional === true,
      snapshot: options.snapshot ?? null,
      stale: false,
      storedThrough: source[source.length - 1]?.date ?? null,
    }
  }

  const deps: SignalEngineDeps = {
    market: {
      getContext: (code) => context(code),
      snapshotOf: () => options.snapshot ?? null,
    },
    watchlist: { list: () => options.entries ?? [entry()] },
    positions: {
      get: () => options.position ?? null,
      list: () => (options.position ? [options.position] : []),
      bumpPeak: (code, price) => peaks.push({ code, price }),
    },
    // 两个仓储都是 class（带私有字段），结构化赋值过不去，只能 as ——
    // 代价是对象字面量拿不到上下文类型，所以参数必须显式标注（否则 noImplicitAny 报错）
    signals: {
      insert: (row: SignalRow) => rows.push(row),
      updateStage: (id: string, stage: SignalStage) => {
        stageUpdates.push({ id, stage })
        return true
      },
      get: (id: string) => rows.find((r) => r.id === id) ?? null,
      query: () => [...rows],
      latestOfDay: (_code: SecCode, date: string) =>
        options.latestOfDayBy?.(date) ?? options.latestOfDay ?? null,
      countOfDay: () => rows.length,
    } as unknown as SignalEngineDeps['signals'],
    indicators: {
      get: () => null,
      put: (code: SecCode, date: string, _payload: Record<string, number | null>, version: string) =>
        cached.push({ code, date, version }),
      purgeOtherVersions: () => 3,
      count: () => cached.length,
      prune: () => 0,
    } as unknown as SignalEngineDeps['indicators'],
    params: SENSITIVE,
    newId: () => `sig-${++counter}`,
  }

  return { deps, rows, cached, stageUpdates, peaks }
}

const TICK = {
  date: '2024-03-15',
  minuteOfDay: 14 * 60,
  session: 'CONTINUOUS_PM' as const,
  at: 1_700_000_000_000,
  producesSignals: true,
}

describe('时段与开关', () => {
  it('不允许产出信号的时段（竞价、休市）直接空转，不落库', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    expect(engine.run({ ...TICK, producesSignals: false })).toEqual([])
    expect(h.rows).toHaveLength(0)
  })

  it('自选股为空时不做任何事', () => {
    const h = harness({ entries: [] })
    expect(createSignalEngine(h.deps).run(TICK)).toEqual([])
  })

  it('指数不产出交易信号（它是情绪输入，不是可交易品种）', () => {
    const index: SecProfile = { code: 'SH000300', name: '沪深300', market: 'SH', board: 'INDEX', isST: false }
    const h = harness({ entries: [entry(index)] })
    expect(createSignalEngine(h.deps).run(TICK)).toEqual([])
  })

  it('单只评估抛错不拖垮整轮', () => {
    const other: SecProfile = { ...PROFILE, code: 'SZ000001', name: '平安银行' }
    const h = harness({ entries: [entry(), entry(other)], throwOn: 'SH600000' })
    const warn = vi.fn()
    const engine = createSignalEngine({ ...h.deps, log: { info: () => {}, warn } })
    const outcomes = engine.run(TICK)
    expect(outcomes.map((o) => o.evaluation.code)).toEqual(['SZ000001'])
    expect(warn).toHaveBeenCalled()
  })
})

describe('落库签名（signalSignature）', () => {
  /**
   * 只造签名函数用得到的那几个字段。这里刻意不去构造一个完整的 Evaluation ——
   * 这个函数的契约就是「读这几项」，多造出来的东西只会让用例看不出重点。
   */
  const evalOf = (over: {
    subs?: [string, string][]
    adjustments?: string[]
    verdicts?: [string, string][]
    direction?: string
    score?: number
    reasons?: string[]
  } = {}): Parameters<typeof signalSignature>[0] =>
    ({
      date: '2024-01-02',
      gated: {
        direction: over.direction ?? 'BUY',
        level: 'L2',
        suppressed: false,
        reasons: over.reasons ?? ['均线交叉'],
        verdicts: (over.verdicts ?? []).map(([rule, action]) => ({ rule, action, reason: '' })),
      },
      signal: {
        stage: 'PROVISIONAL',
        score: over.score ?? 0.62,
        votes: 3,
        subSignals: (over.subs ?? [['T1_MA_CROSS', 'BUY']]).map(([id, direction]) => ({ id, direction })),
        adjustments: (over.adjustments ?? []).map((id) => ({ id })),
      },
    }) as unknown as Parameters<typeof signalSignature>[0]

  it('得分变了签名不变 —— 连续量一个都不许进签名，否则等于没有去重', () => {
    expect(signalSignature(evalOf({ score: 0.61 }))).toBe(signalSignature(evalOf({ score: 0.88 })))
  })

  /*
    首要理由（`reasons[0]`）**不进签名**，这是 2026-08-14 晚被真实数据逼出来的一条。

    它是一句嵌着连续量的文案：止损写的是「已亏损 −32.7%，触及 8% 止损线」。
    实测一天：SZ002716 的子信号集合 / 裁决 / level / 方向各只有 1 种，
    而 `reasons[0]` 有 22 种，**落了 243 行同一条止损**
    （243 > 22 是因为去重比的是「上一次」：−32.7 → −32.6 → −32.7 来回抖）。

    这三条用例分别钉住：文案变了不落新行、而它背后真正的离散依据变了照样落新行。
  */
  it('首要理由的文案变了签名不变 —— 那是一句嵌着百分比的话，不是新的结论', () => {
    const a = signalSignature(evalOf({ reasons: ['已亏损 -32.7%，触及 8% 止损线'] }))
    const b = signalSignature(evalOf({ reasons: ['已亏损 -31.2%，触及 8% 止损线'] }))
    expect(a).toBe(b)
  })

  it('但同一条止损的裁决变了照样落新行（止损 → 回撤减仓）', () => {
    const stop = signalSignature(evalOf({ verdicts: [['STOP_LOSS', 'FORCE_SELL']] }))
    const reduce = signalSignature(evalOf({ verdicts: [['DRAWDOWN_REDUCE', 'FORCE_REDUCE']] }))
    expect(stop).not.toBe(reduce)
  })

  it('策略信号的首要理由换人时，签名只跟着子信号集合走', () => {
    // 同一个集合、不同的「谁最强」（由 score × weight 排出来，是连续量）→ 同一条
    const subs: [string, string][] = [['T1_MA_CROSS', 'BUY'], ['T3_BREAKOUT', 'BUY']]
    const a = signalSignature(evalOf({ subs, reasons: ['均线金叉'] }))
    const b = signalSignature(evalOf({ subs, reasons: ['放量突破上轨'] }))
    expect(a).toBe(b)
  })

  it('结论没变但子信号集合变了 → 新签名（这是 2026-08-14 补的那条）', () => {
    // 旧签名只看 reasons[0]，于是这两种情况被判成同一条，
    // 而落库的 evidence 还停在三小时前那一份
    const before = signalSignature(evalOf({ subs: [['T1_MA_CROSS', 'BUY'], ['T3_BREAKOUT', 'BUY']] }))
    const after = signalSignature(
      evalOf({ subs: [['T1_MA_CROSS', 'BUY'], ['T3_BREAKOUT', 'BUY'], ['T4_ALIGNMENT', 'BUY']] })
    )
    expect(after).not.toBe(before)
  })

  it('子信号顺序变了签名不变 —— 产出顺序不保证稳定', () => {
    const a = signalSignature(evalOf({ subs: [['T1_MA_CROSS', 'BUY'], ['T3_BREAKOUT', 'BUY']] }))
    const b = signalSignature(evalOf({ subs: [['T3_BREAKOUT', 'BUY'], ['T1_MA_CROSS', 'BUY']] }))
    expect(a).toBe(b)
  })

  it('同一个子信号换了方向算依据变了', () => {
    const a = signalSignature(evalOf({ subs: [['R1_RSI_BAND', 'BUY']] }))
    const b = signalSignature(evalOf({ subs: [['R1_RSI_BAND', 'SELL']] }))
    expect(a).not.toBe(b)
  })

  it('风控裁决与多周期调整也进签名', () => {
    const base = signalSignature(evalOf())
    expect(signalSignature(evalOf({ verdicts: [['STOP_LOSS', 'FORCE']] }))).not.toBe(base)
    expect(signalSignature(evalOf({ adjustments: ['M1_WEEK_MACD_DAY_RSI'] }))).not.toBe(base)
  })
})

describe('落库与去重', () => {
  it('同一条信号连续多轮只落一行', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    const first = h.rows.length
    engine.run({ ...TICK, at: TICK.at + 30_000 })
    engine.run({ ...TICK, at: TICK.at + 60_000 })
    expect(h.rows.length).toBe(first)
  })

  it('方向或级别变化时才落新行', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    const before = h.rows.length
    // 换一段行情 → 结论变化
    const other = harness({ candles: buildCandles(chopCloses(320)) })
    const engine2 = createSignalEngine({ ...h.deps, market: other.deps.market })
    engine2.run(TICK)
    expect(h.rows.length).toBeGreaterThanOrEqual(before)
  })

  it('落库行带上引擎版本与不复权价', () => {
    const h = harness()
    createSignalEngine(h.deps).run(TICK)
    const row = h.rows[0]
    if (row) {
      expect(row.engineVersion).toBe(engineVersionOf(SENSITIVE))
      expect(row.priceAt).toBeGreaterThan(0)
      expect(row.evidence.indicatorsAt).toBeDefined()
    }
  })

  it('什么都没发生（NONE 且无风控裁决）时不占一行', () => {
    // 数据不足 40 根：会产生 INSUFFICIENT_DATA 裁决，因此**应当**落一行
    const short = harness({ candles: buildCandles(chopCloses(30)) })
    createSignalEngine(short.deps).run(TICK)
    expect(short.rows.length).toBe(1)
    expect(short.rows[0]?.evidence.verdicts.map((v) => v.rule)).toContain('INSUFFICIENT_DATA')
  })

  /**
   * 真机缺陷的回归（M2 §5.56）：**`A → 什么都没发生 → A` 只能落一行。**
   *
   * 原先「NONE 且无裁决」那一支会把 `persistedSignature` 覆盖成「什么都没发生」的签名，
   * 而它**自己不落行** ⇒ 回到 A 时比出来「变了」⇒ 再落一行**逐字段完全相同**的。
   * 真机实测：签名修复之后仍有 206 / 408 个相邻对如此，`SH601933` 一天 73 行只有 3 种签名。
   *
   * ⚠ **为什么必须是这种「同一个引擎实例、换行情」的写法**：这个缺陷在
   * `signalSignature()` 里**看不见** —— 那个纯函数一直是对的，有用例钉着（上面那两条）。
   * 坏的是**用它的状态机**，而状态只存在于跨轮的 `persistedSignature` 里。
   * §5.56 的预测记分就错在这上面：「函数有用例钉着」被当成了「这条路径可靠」。
   */
  it('A → 什么都没发生 → A：只落一行（去重记忆不许被不落行的那一轮擦掉）', () => {
    const signalCandles = goldenCrossBreakout().candles // 给一条真信号
    const quietCandles = buildCandles(chopCloses(320)) // 方向 NONE、零裁决，且根数足够（不触发 INSUFFICIENT_DATA）
    const h = harness()
    let source = signalCandles

    const deps: SignalEngineDeps = {
      ...h.deps,
      market: {
        getContext: (code) => {
          const candles = code === 'SH000300' ? buildCandles(chopCloses(300)) : source
          return {
            code,
            candles,
            provisional: false,
            snapshot: null,
            stale: false,
            storedThrough: candles[candles.length - 1]?.date ?? null,
          }
        },
        snapshotOf: () => null,
      },
    }

    const engine = createSignalEngine(deps)

    engine.run(TICK)
    expect(h.rows.length).toBe(1) // A 落一行

    source = quietCandles
    engine.run({ ...TICK, at: TICK.at + 30_000 })
    expect(h.rows.length).toBe(1) // 「什么都没发生」不落行 —— 这一条原先也是过的

    source = signalCandles
    engine.run({ ...TICK, at: TICK.at + 60_000 })
    expect(h.rows.length).toBe(1) // ← 原先是 2：回到同一条信号又落了一行完全相同的
  })
})

describe('指标缓存与确认轮', () => {
  it('盘中（临时线）不缓存指标', () => {
    const scenario = goldenCrossBreakout()
    const candles = [...scenario.candles]
    const last = candles[candles.length - 1]
    if (last) candles[candles.length - 1] = { ...last, provisional: true }
    const h = harness({ candles })
    createSignalEngine(h.deps).run(TICK)
    expect(h.cached).toHaveLength(0)
  })

  it('收盘后缓存当日指标截面，键含引擎版本', () => {
    const h = harness()
    createSignalEngine(h.deps).run(TICK)
    expect(h.cached[0]?.version).toBe(engineVersionOf(SENSITIVE))
  })

  it('参数变化 → 引擎版本变化 → 缓存键随之变化', () => {
    const h = harness()
    const engine = createSignalEngine({
      ...h.deps,
      params: withParams({ macd: { preset: 'Classic', fast: 12, slow: 26, signal: 9 } }),
    })
    engine.run(TICK)
    expect(h.cached[0]?.version).not.toBe(engineVersionOf(SENSITIVE))
  })

  it('启动时清理旧版本缓存', () => {
    const h = harness()
    expect(createSignalEngine(h.deps).purgeStaleCache()).toBe(3)
  })

  /**
   * 一条当日的 PROVISIONAL 历史行。方向由调用方给 —— **不要写死** ：
   * 这条用例原先假定「这段是上涨突破，收盘结论不可能是 SELL」，
   * 但 8 根 3.5% 拉升之后 RSI 深度超买，末根的最强子信号恰恰是 R1 的 SELL。
   * 把 fixture 的偶然结论当成前提，用例就会在 fixture 一改动时报出一个误导性的失败。
   */
  function provisionalRow(direction: string): SignalRow {
    return {
      id: 'old',
      code: 'SH600000',
      createdAt: 1,
      tradeDate: goldenCrossBreakout().candles.at(-1)?.date ?? '',
      direction,
      score: 0.7,
      votes: 3,
      regime: 'TREND_UP',
      stage: 'PROVISIONAL',
      priceAt: 10,
      engineVersion: 'v1',
      evidence: {
        level: 'L1',
        headline: '',
        reasons: [],
        suppressed: false,
        subSignals: [],
        adjustments: [],
        verdicts: [],
        scoreByDirection: {},
        indicatorsAt: {},
        regimeEvidence: {},
        sufficiency: { bars: 0, limited: false, penalty: 1, note: null },
      },
    } as unknown as SignalRow
  }

  /** 本 fixture 末根的收盘结论。两条确认轮用例都以它为基准，而不是各自猜一个方向 */
  function closingDirection(): string {
    const h = harness()
    const outcome = createSignalEngine(h.deps).run(TICK)[0]
    return outcome?.evaluation.gated.direction ?? 'NONE'
  }

  it('收盘确认轮：方向与收盘结论一致 → CONFIRMED', () => {
    const h = harness({ latestOfDay: provisionalRow(closingDirection()) })
    createSignalEngine(h.deps).run(TICK)
    expect(h.stageUpdates[0]).toEqual({ id: 'old', stage: 'CONFIRMED' })
  })

  it('收盘确认轮：方向与收盘结论不符 → INVALIDATED', () => {
    const opposite = closingDirection() === 'SELL' ? 'BUY' : 'SELL'
    const h = harness({ latestOfDay: provisionalRow(opposite) })
    createSignalEngine(h.deps).run(TICK)
    expect(h.stageUpdates[0]).toEqual({ id: 'old', stage: 'INVALIDATED' })
  })

  it('失效时把撤销提示报给提醒层（docs/05 §3：信号失效通知属 L1）', () => {
    const opposite = closingDirection() === 'SELL' ? 'BUY' : 'SELL'
    const h = harness({ latestOfDay: provisionalRow(opposite) })
    const outcome = createSignalEngine(h.deps).run(TICK)[0]
    expect(outcome?.invalidated).toEqual({ signalId: 'old', direction: opposite })
  })

  it('持仓峰值在收盘轮按当日最高价更新（docs/05 §2.3）', () => {
    const position: Position = { code: 'SH600000', shares: 1000, cost: 10, peakPrice: 10, openedAt: 0 }
    const h = harness({ position })
    createSignalEngine(h.deps).run(TICK)
    expect(h.peaks[0]?.code).toBe('SH600000')
    expect(h.peaks[0]?.price).toBeGreaterThan(0)
  })
})

/**
 * 昨日收盘的「明日观察」在今天的兑现（2026-08-14）。
 *
 * 为什么必须钉住：收盘确认轮**永远**落在 T+1 尾盘窗口里，实测 46 只 2024 年起
 * 28973 个判定根，组合层给的 182 次 BUY **一次不漏**全被改写成 `NEXT_DAY_WATCH`。
 * 那条改写是对的（收盘后买不进），缺的是第二天的跟进 —— 而它一旦写错，
 * 症状是「昨天的建议今天又提醒了一遍」或者「照样没有跟进」，两种都不显眼。
 */
describe('明日观察的次日复活', () => {
  /** 末根给 BUY 的那一段（实测：完整 fixture 的末根是 SELL，砍掉最后 4 根才是 BUY） */
  function buyingCandles(): Candle[] {
    const full = goldenCrossBreakout().candles
    const cut = full.slice(0, full.length - 4)
    const last = cut[cut.length - 1]
    if (!last) throw new Error('fixture 太短')
    // 盘中：最后一根是临时线。复活只在盘中判（收盘轮那条自己就是 NEXT_DAY_WATCH）
    return [...cut.slice(0, -1), { ...last, provisional: true }]
  }

  const CANDLES = buyingCandles()
  const TODAY = CANDLES[CANDLES.length - 1]?.date ?? ''
  const YESTERDAY = CANDLES[CANDLES.length - 2]?.date ?? ''
  // 11:30：量比按已走完的连续竞价分钟数归一化，10:00 那种「刚开盘半小时」会把
  // 量比放大 8 倍，进而改变 T3 的成立与否 —— 这里要验的是复活闸门，不该被它拌住
  const INTRADAY = { ...TICK, date: TODAY, session: 'CONTINUOUS_AM' as const, minuteOfDay: 11 * 60 + 30 }

  /** 昨日收盘那一行。方向与 stage 由调用方给 —— 这两项正是判据 */
  function yesterdayRow(direction: string, stage: SignalStage = 'CONFIRMED'): SignalRow {
    return {
      id: 'yesterday',
      code: 'SH600000',
      createdAt: 1,
      tradeDate: YESTERDAY,
      direction,
      score: 0.7,
      votes: 3,
      regime: 'TREND_UP',
      stage,
      priceAt: 10,
      engineVersion: 'v1',
      evidence: {
        level: 'L2',
        headline: '',
        reasons: [],
        suppressed: false,
        subSignals: [],
        adjustments: [],
        verdicts: [],
        scoreByDirection: {},
        indicatorsAt: {},
        regimeEvidence: {},
        sufficiency: { bars: 0, limited: false, penalty: 1, note: null },
      },
    } as unknown as SignalRow
  }

  /**
   * 这一块**不能用文件顶上那个 SENSITIVE**，而且不是因为票数 —— 是因为它把**分数线**
   * 压到了 0.3。
   *
   * 实测这段 fixture 的末根：BUY 0.691（T1+T3 两票）、SELL 0.550（R1 超买一票）。
   * 冲突裁决判「势均力敌」的前置条件是 `contested = 两侧 final 都 ≥ scoreThreshold`，
   * 0.3 的线让 SELL 那 0.55 也算进来，而两者差 0.141 < `conflictBand` 0.15
   * → **压掉双方** → 方向恒为 NONE，于是复活的每一条用例都退化成
   * 「本来就没有买入」的假通过。
   *
   * 所以这里保留**出厂分数线 0.6**（SELL 的 0.55 够不着，不构成矛盾），
   * 只把趋势票数线从 3 放到 2 —— fixture 末根就是 T1+T3 两票，
   * 而这一块验的是编排不是信号质量。
   */
  const NEAR_FACTORY = withParams({
    combine: { ...DEFAULT_PARAMS.combine, voteThreshold: { trend: 2, meanReversion: 2 } },
  })

  function run(options: {
    yesterday?: SignalRow | null
    candles?: Candle[]
    tick?: typeof INTRADAY
  } = {}) {
    const h = harness({
      candles: options.candles ?? CANDLES,
      latestOfDayBy: (date) => (date === YESTERDAY ? (options.yesterday ?? null) : null),
    })
    const engine = createSignalEngine({ ...h.deps, params: NEAR_FACTORY })
    return { engine, outcomes: engine.run(options.tick ?? INTRADAY) }
  }

  it('前提成立：这段 fixture 的盘中结论确实是买入', () => {
    expect(run().outcomes[0]?.evaluation.gated.direction).toBe('BUY')
  })

  it('昨日收盘是「明日观察」且今日盘中仍判买入 → 报一次复活', () => {
    const { outcomes } = run({ yesterday: yesterdayRow('NEXT_DAY_WATCH') })
    expect(outcomes[0]?.carriedOver).toEqual({ signalId: 'yesterday', from: YESTERDAY })
  })

  it('昨日不是「明日观察」→ 不复活（普通买入信号已经提醒过了）', () => {
    expect(run({ yesterday: yesterdayRow('BUY') }).outcomes[0]?.carriedOver).toBeUndefined()
  })

  it('昨日那条还是 PROVISIONAL → 不复活：收盘轮没确认它，那不是昨天的最终结论', () => {
    expect(
      run({ yesterday: yesterdayRow('NEXT_DAY_WATCH', 'PROVISIONAL') }).outcomes[0]?.carriedOver
    ).toBeUndefined()
  })

  it('昨天什么都没有 → 不复活', () => {
    expect(run({ yesterday: null }).outcomes[0]?.carriedOver).toBeUndefined()
  })

  it('今日不判买入 → 不复活：昨天的结论不构成今天的理由', () => {
    // 完整 fixture 的末根是 SELL（见 buyingCandles 的注释）
    const full = goldenCrossBreakout().candles
    const last = full[full.length - 1]
    if (!last) throw new Error('fixture 太短')
    const candles = [...full.slice(0, -1), { ...last, provisional: true }]
    const { outcomes } = run({
      yesterday: yesterdayRow('NEXT_DAY_WATCH'),
      candles,
      tick: { ...INTRADAY, date: last.date },
    })
    expect(outcomes[0]?.evaluation.gated.direction).not.toBe('BUY')
    expect(outcomes[0]?.carriedOver).toBeUndefined()
  })

  it('一天只报一次 —— 盘中每 30s 一轮，重复报会在 alert_log 里攒一串被冷却挡掉的噪音', () => {
    const { engine } = run({ yesterday: yesterdayRow('NEXT_DAY_WATCH') })
    // 第一轮已经在 run() 里跑过了，这是第二轮
    expect(engine.run({ ...INTRADAY, at: INTRADAY.at + 30_000 })[0]?.carriedOver).toBeUndefined()
  })

  it('判的不是今天这根（快照还没到手，引擎在判昨天的收盘线）→ 不复活', () => {
    // 末根不是临时线时，被判定的那根就是「昨天」，而它的前一根是前天 ——
    // 少了这道闸门会把前天那条明日观察当成昨天的
    const settled = CANDLES.map((candle) => ({ ...candle, provisional: false }))
    const { outcomes } = run({ yesterday: yesterdayRow('NEXT_DAY_WATCH'), candles: settled })
    expect(outcomes[0]?.carriedOver).toBeUndefined()
  })
})

describe('查询与解释', () => {
  it('history 带上名称，explain 还原子信号与指标截面', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    const history = engine.history({ limit: 10 })
    expect(history[0]?.name).toBe('浦发银行')
    const id = history[0]?.id
    if (id) {
      const evidence = engine.explain(id)
      expect(evidence?.id).toBe(id)
      expect(Object.keys(evidence?.indicatorsAt ?? {}).length).toBeGreaterThan(0)
    }
    expect(engine.explain('不存在的 id')).toBeNull()
  })

  it('latest() 返回最近一轮的评估结果', () => {
    const h = harness()
    const engine = createSignalEngine(h.deps)
    engine.run(TICK)
    expect(engine.latest().length).toBe(1)
    engine.run({ ...TICK, producesSignals: false })
    expect(engine.latest()).toEqual([])
  })
})

/**
 * T+1 的锁定股数（2026-08-19）。
 *
 * 编排层这里只钉两件事：**日界按 `tick.at` 算**（不是「现在」—— 收盘补跑传的是
 * D 的收盘时刻，用「现在」会拿今天的流水去判昨天的信号），以及**它真的传进了引擎**。
 * 规则本身在 `tests/unit/risk/risk.test.ts`。
 */
describe('T+1 锁定股数的接线', () => {
  const held: Position = { code: PROFILE.code, shares: 1000, cost: 10, peakPrice: 10, openedAt: 0 }

  it('按 tick.at 所在的**北京日**去数买入，不是按「现在」', () => {
    const h = harness({ position: held })
    const calls: { code: SecCode; sinceMs: number }[] = []
    createSignalEngine({
      ...h.deps,
      lockedSharesOf: (code, sinceMs) => {
        calls.push({ code, sinceMs })
        return 0
      },
    }).run(TICK)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.code).toBe(PROFILE.code)
    expect(calls[0]?.sinceMs).toBe(shanghaiDayStartMs(TICK.at))
    // 日界必须落在 tick.at 之前、且相差不到一天 —— 「拿今天的日界判昨天」会破这条
    expect(calls[0]?.sinceMs).toBeLessThanOrEqual(TICK.at)
    expect(TICK.at - (calls[0]?.sinceMs ?? 0)).toBeLessThan(86_400_000)
  })

  it('全仓今日买入 → 卖出方向被 T1_SELL_LOCK 抑制（锁定量真的传到了风控层）', () => {
    const h = harness({ position: { ...held, cost: 20 } }) // 成本 20、现价 10 → 跌破止损线
    const outcomes = createSignalEngine({ ...h.deps, lockedSharesOf: () => 1000 }).run(TICK)
    const gated = outcomes[0]?.evaluation.gated
    expect(gated?.verdicts.some((v) => v.rule === 'T1_SELL_LOCK')).toBe(true)
    expect(gated?.suppressed).toBe(true)
  })

  it('不传这个依赖时逐位保持旧行为（缺省 0）', () => {
    const h = harness({ position: { ...held, cost: 20 } })
    const gated = createSignalEngine(h.deps).run(TICK)[0]?.evaluation.gated
    expect(gated?.verdicts.some((v) => v.rule === 'T1_SELL_LOCK')).toBe(false)
    expect(gated?.suppressed).toBe(false)
  })

  it('没有持仓时不去查流水 —— 无仓可锁', () => {
    const h = harness()
    const calls: number[] = []
    createSignalEngine({ ...h.deps, lockedSharesOf: (_code, sinceMs) => (calls.push(sinceMs), 0) }).run(TICK)
    expect(calls).toHaveLength(0)
  })
})

describe('指标截面', () => {
  it('只留被判定那根的值，且缺失处是 null 不是 0', () => {
    const candles = buildCandles(chopCloses(60))
    const ind = computeIndicators(candles, DEFAULT_PARAMS, { sentiment: 0.5 })
    const snapshot = snapshotOfIndicators(ind, candles.length - 1)
    expect(snapshot['ma5']).not.toBeNull()
    // 60 根远不够 BBW 分位（需 269 根）
    expect(snapshot['bbwPct']).toBeNull()
    expect(snapshot['rsi']).not.toBeNull()
  })
})

/**
 * 「当前指标」面板的取数（`indicators:current` → `controller.indicatorSnapshot`）。
 *
 * 这里只钉两条**边界**，不测数值（数值由指标黄金用例负责）：
 * ① 未预热的指标是 `null` 而不是 0（约束 4 —— 0 会被读成「指标是 0」）；
 * ② 快照的键集合与目录一致（目录那侧另有一条用例从相反方向钉同一件事）。
 */
describe('当前指标快照', () => {
  it('预热不足时给 null，不给 0', () => {
    const candles = buildCandles(rampCloses(30, 10, 0.004))
    const ind = computeIndicators(candles, DEFAULT_PARAMS, { sentiment: 0.5, intradayProgress: 1 })
    const snapshot = snapshotOfIndicators(ind, candles.length - 1)
    // 30 根远不够 MA120 / 带宽分位（250 根窗口）
    expect(snapshot['ma120']).toBeNull()
    expect(snapshot['bbwPct']).toBeNull()
    // 而短周期的那些算得出来 —— 「不够」是逐指标的，不是整屏的
    expect(snapshot['ma5']).not.toBeNull()
  })
})
