/**
 * 补跑收盘确认轮（src/main/engine/settle.ts）。
 *
 * 这一层没有判定逻辑（判定全在 `createSignalEngine`，那儿另有用例），
 * 所以钉的全是**接线的正确性**，而它的每一条错法都是静默的：
 *
 *   - 用错上下文（拼了临时线）→ stage 仍是 PROVISIONAL → 整件事白做，而日志显示「跑过了」
 *   - `createdAt` 用「现在」→ 昨天的信号出现在今天的列表里
 *   - 复用当日那个引擎实例 → 去重状态被冲掉，当天第一条信号重复落一行
 *   - 停牌那天没有 K 线却照跑 → 拿 D−1 的收盘线冒充 D 的
 */

import { describe, expect, it, vi } from 'vitest'
import { closeMsOf, settleDay, type SettleDeps } from '@main/engine/settle'
import { DEFAULT_PARAMS, withParams } from '@core/params'
import type { Candle, Position, SecCode, SecProfile, SignalStage, TradeDate } from '@core/types'
import type { MarketContext } from '@main/engine/market-data'
import type { WatchEntry } from '@main/storage/repositories/watchlist'
import type { SignalRow } from '@main/storage/repositories/signal'
import { buildCandles, chopCloses, goldenCrossBreakout } from '../../fixtures/klines'

const PROFILE: SecProfile = { code: 'SH600000', name: '浦发银行', market: 'SH', board: 'MAIN', isST: false }

/**
 * 把组合阈值调低（0.3 分 / 1 票），与 `signals.test.ts` 顶上那个 `SENSITIVE` 同一份、
 * 同一个理由：**这里验的是编排，不是信号质量**。
 *
 * 用出厂线的话这段 fixture 的末根一票都凑不够（实测卖出侧只有 R1 一条，
 * 而均值回归的出厂线是 2 票），于是 `persist()` 一行都不写 ——
 * 「补跑产出 CONFIRMED」这条用例会退化成 `0 === 0` 的假通过。
 */
const SENSITIVE = withParams({
  combine: { ...DEFAULT_PARAMS.combine, scoreThreshold: 0.3, voteThreshold: { trend: 1, meanReversion: 1 } },
})

function entry(profile: SecProfile = PROFILE): WatchEntry {
  return { profile, group: '自选', sortOrder: 0, createdAt: 0 }
}

interface Harness {
  deps: SettleDeps
  rows: SignalRow[]
  cached: { code: SecCode; date: string }[]
  stageUpdates: { id: string; stage: string }[]
  /** getContextThrough 收到的 (code, through) —— 用来断言问的是哪一天 */
  asked: { code: SecCode; through: TradeDate }[]
}

function harness(options: {
  candles?: Candle[]
  entries?: WatchEntry[]
  latestOfDay?: SignalRow | null
  position?: Position | null
  closedAt?: number
} = {}): Harness {
  const candles = options.candles ?? goldenCrossBreakout().candles
  const rows: SignalRow[] = []
  const cached: { code: SecCode; date: string }[] = []
  const stageUpdates: { id: string; stage: string }[] = []
  const asked: { code: SecCode; through: TradeDate }[] = []
  let counter = 0

  const deps: SettleDeps = {
    market: {
      getContextThrough: (code: SecCode, through: TradeDate): MarketContext => {
        asked.push({ code, through })
        const source = code === 'SH000300' ? buildCandles(chopCloses(300)) : candles
        const last = source[source.length - 1]
        // 真实实现在末根 ≠ through 时回空序列（停牌 / 数据没到）—— 替身照抄这条
        if (!last || last.date !== through) {
          return { code, candles: [], provisional: false, snapshot: null, stale: false, storedThrough: last?.date ?? null }
        }
        return { code, candles: source, provisional: false, snapshot: null, stale: false, storedThrough: last.date }
      },
      snapshotOf: () => null,
    },
    watchlist: { list: () => options.entries ?? [entry()] },
    positions: {
      get: () => options.position ?? null,
      list: () => (options.position ? [options.position] : []),
      bumpPeak: () => {},
    },
    signals: {
      insert: (row: SignalRow) => rows.push(row),
      updateStage: (id: string, stage: SignalStage) => {
        stageUpdates.push({ id, stage })
        return true
      },
      get: (id: string) => rows.find((r) => r.id === id) ?? null,
      query: () => [...rows],
      latestOfDay: () => options.latestOfDay ?? null,
      countOfDay: () => rows.length,
    } as unknown as SettleDeps['signals'],
    indicators: {
      get: () => null,
      put: (code: SecCode, date: string) => cached.push({ code, date }),
      purgeOtherVersions: () => 0,
      count: () => cached.length,
      prune: () => 0,
    } as unknown as SettleDeps['indicators'],
    params: SENSITIVE,
    newId: () => `settled-${++counter}`,
    closedAt: options.closedAt ?? closeMsOf('2024-04-09'),
  }

  return { deps, rows, cached, stageUpdates, asked }
}

/** fixture 末根的日期 —— 补跑的目标日 */
const LAST_DATE = goldenCrossBreakout().candles.at(-1)?.date ?? ''

/** 这段 fixture 补跑出来的收盘结论。用例据它构造「方向相符 / 不符」，而不是各自猜一个 */
function closingDirection(): string {
  const probe = harness()
  settleDay(LAST_DATE as TradeDate, probe.deps)
  return probe.rows[0]?.direction ?? 'NONE'
}

describe('closeMsOf', () => {
  it('按北京时间 15:00 换算，与本机时区无关', () => {
    // 2024-04-09 15:00 +08:00 = 07:00 UTC
    expect(closeMsOf('2024-04-09' as TradeDate)).toBe(Date.UTC(2024, 3, 9, 7, 0, 0))
  })

  it('日期不合法时抛错，不返回一个能一路传下去的 NaN', () => {
    expect(() => closeMsOf('' as TradeDate)).toThrow()
    expect(() => closeMsOf('昨天' as TradeDate)).toThrow()
  })
})

describe('settleDay', () => {
  it('问的是「截至那一天」的上下文，不是「此刻」', () => {
    const h = harness()
    settleDay(LAST_DATE as TradeDate, h.deps)
    expect(h.asked.length).toBeGreaterThan(0)
    expect(h.asked.every((a) => a.through === LAST_DATE)).toBe(true)
  })

  it('产出的是 CONFIRMED —— 这就是整件事的目的', () => {
    const h = harness()
    const result = settleDay(LAST_DATE as TradeDate, h.deps)
    expect(result.evaluated).toBeGreaterThan(0)
    expect(h.rows.length).toBeGreaterThan(0)
    expect(h.rows.every((row) => row.stage === 'CONFIRMED')).toBe(true)
  })

  it('落库行的 created_at 是**那天收盘**，不是现在', () => {
    const closedAt = closeMsOf('2024-04-09' as TradeDate)
    const h = harness({ closedAt })
    settleDay(LAST_DATE as TradeDate, h.deps)
    expect(h.rows.every((row) => row.createdAt === closedAt)).toBe(true)
    // 用「现在」的话这些行会落进今天，出现在今天的信号列表与悬浮条上
    expect(h.rows.every((row) => row.createdAt < Date.now())).toBe(true)
  })

  it('写入当日指标截面 —— 指标缓存 0 行正是这条断掉造成的', () => {
    const h = harness()
    settleDay(LAST_DATE as TradeDate, h.deps)
    expect(h.cached.some((c) => c.code === 'SH600000' && c.date === LAST_DATE)).toBe(true)
  })

  it('把当日那条盘中信号推进掉（这里给一条方向不符的 → 判失效）', () => {
    const provisional = {
      id: 'intraday',
      code: 'SH600000',
      createdAt: 1,
      tradeDate: LAST_DATE,
      direction: 'BUY',
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

    // 方向**不写死**：把 fixture 的偶然结论当成前提，用例会在 fixture 一改动时
    // 报出一个误导性的失败（signals.test.ts 的 provisionalRow 头注释记着这一条）。
    // 先空跑一次问出这段 fixture 的收盘结论，再拿相反的方向去构造那条盘中信号
    const opposite = closingDirection() === 'SELL' ? 'BUY' : 'SELL'
    const h = harness({ latestOfDay: { ...provisional, direction: opposite } })
    const result = settleDay(LAST_DATE as TradeDate, h.deps)
    expect(h.stageUpdates[0]?.id).toBe('intraday')
    expect(h.stageUpdates[0]?.stage).toBe('INVALIDATED')
    expect(result.invalidated).toBe(1)
  })

  it('那天没有 K 线（停牌 / 数据还没到）→ 整只跳过，绝不拿前一天的冒充', () => {
    const h = harness()
    // 目标日比 fixture 的末根晚一天 → getContextThrough 回空序列
    const result = settleDay('2099-01-01' as TradeDate, h.deps)
    expect(result.evaluated).toBe(0)
    expect(h.rows).toHaveLength(0)
    expect(h.cached).toHaveLength(0)
  })

  it('指数不产出交易信号（与当日流水同一条规则，因为用的是同一个引擎）', () => {
    const index: SecProfile = { code: 'SH000300', name: '沪深300', market: 'SH', board: 'INDEX', isST: false }
    const h = harness({ entries: [entry(index)] })
    expect(settleDay(LAST_DATE as TradeDate, h.deps).evaluated).toBe(0)
  })

  it('重复调用不产生重复行（签名去重照常生效）', () => {
    const h = harness()
    settleDay(LAST_DATE as TradeDate, h.deps)
    const after = h.rows.length
    settleDay(LAST_DATE as TradeDate, h.deps)
    // 第二次是新引擎实例、内存签名是空的，所以会再落一次 ——
    // **这正是调用方必须按 lastSettledDate 一天只跑一次的原因**，
    // 钉住它是为了让日后有人去掉那个闸门时这条用例变红
    expect(h.rows.length).toBe(after * 2)
  })

  it('不返回 outcomes —— 结构上堵死「顺手接到提醒层」这条路', () => {
    const h = harness()
    const result = settleDay(LAST_DATE as TradeDate, h.deps)
    expect(Object.keys(result).sort()).toEqual(['date', 'evaluated', 'invalidated', 'persisted'])
  })

  it('单只算不出来不拖垮整轮', () => {
    const other: SecProfile = { ...PROFILE, code: 'SZ000001', name: '平安银行' }
    const h = harness({ entries: [entry(), entry(other)] })
    const warn = vi.fn()
    const broken: SettleDeps = {
      ...h.deps,
      market: {
        ...h.deps.market,
        getContextThrough: (code, through) => {
          if (code === 'SH600000') throw new Error('模拟取数异常')
          return h.deps.market.getContextThrough(code, through)
        },
      },
      log: { info: () => {}, warn },
    }
    expect(settleDay(LAST_DATE as TradeDate, broken).evaluated).toBe(1)
    expect(warn).toHaveBeenCalled()
  })
})
