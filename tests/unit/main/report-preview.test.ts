/**
 * 「明日预览」（`src/main/engine/preview.ts`）。
 *
 * 这一层同样没有判定逻辑（判定全在 `createSignalEngine`），所以钉的是**接线**与
 * **三条边界**，而它们的每一条错法都是静默的：
 *
 *   - 改成 `run()` → 落库 + 搅乱去重状态 → 次日真信号被误判成「没变」而不再落行
 *   - 用错上下文（拼了临时线）→ 预览与明早的补跑给出不同结论，没人看得出为什么
 *   - 缺当日收盘线的票静默消失 → 「明天没什么要做的」凭空成立
 *   - 一只都算不出来时给空列表 → 「算不出来」被显示成「明天没有要做的」
 */

import { describe, expect, it } from 'vitest'
import { previewNextDay, type NextDayPreviewDeps } from '@main/engine/preview'
import { closeMsOf } from '@main/engine/settle'
import { toShadowAction } from '@main/shadow/portfolio'
import { DEFAULT_PARAMS, withParams } from '@core/params'
import type { Candle, Position, SecCode, SecProfile, TradeDate } from '@core/types'
import type { MarketContext } from '@main/engine/market-data'
import type { WatchEntry } from '@main/storage/repositories/watchlist'
import type { SignalRow } from '@main/storage/repositories/signal'
import { buildCandles, chopCloses, goldenCrossBreakout } from '../../fixtures/klines'

const PROFILE: SecProfile = { code: 'SH600000', name: '浦发银行', market: 'SH', board: 'MAIN', isST: false }

/**
 * 组合阈值调低（0.3 分 / 1 票），与 `settle.test.ts` / `signals.test.ts` 同一份、同一个理由：
 * **这里验的是编排，不是信号质量** —— 用出厂线这段 fixture 一票都凑不够，
 * 于是「预览给出一行」这类用例会退化成 `0 === 0` 的假通过。
 */
const SENSITIVE = withParams({
  combine: { ...DEFAULT_PARAMS.combine, scoreThreshold: 0.3, voteThreshold: { trend: 1, meanReversion: 1 } },
})

const entry = (profile: SecProfile = PROFILE): WatchEntry => ({
  profile,
  group: '自选',
  sortOrder: 0,
  createdAt: 0,
})

interface Harness {
  deps: NextDayPreviewDeps
  /** 任何一次写入都会记在这里 —— 「什么都不写」那条用例的判据 */
  writes: string[]
  asked: { code: SecCode; through: TradeDate }[]
}

function harness(
  options: {
    candles?: Candle[]
    entries?: WatchEntry[]
    position?: Position | null
    holds?: boolean
    hasClose?: (code: SecCode) => boolean
    lockedShares?: number
  } = {}
): Harness {
  const candles = options.candles ?? goldenCrossBreakout().candles
  const writes: string[] = []
  const asked: { code: SecCode; through: TradeDate }[] = []

  const deps: NextDayPreviewDeps = {
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
    },
    watchlist: { list: () => options.entries ?? [entry()] },
    positions: {
      get: () => options.position ?? null,
      list: () => (options.position ? [options.position] : []),
      bumpPeak: () => writes.push('bumpPeak'),
    },
    signals: {
      insert: (row: SignalRow) => writes.push(`insert:${row.id}`),
      updateStage: (id: string) => {
        writes.push(`updateStage:${id}`)
        return true
      },
      get: () => null,
      query: () => [],
      latestOfDay: () => null,
      countOfDay: () => 0,
    } as unknown as NextDayPreviewDeps['signals'],
    indicators: {
      get: () => null,
      put: (code: SecCode, date: string) => writes.push(`put:${code}:${date}`),
      purgeOtherVersions: () => 0,
      count: () => 0,
      prune: () => 0,
    } as unknown as NextDayPreviewDeps['indicators'],
    params: SENSITIVE,
    closedAt: closeMsOf(LAST_DATE),
    holds: () => options.holds ?? options.position !== null,
    hasClose: options.hasClose ?? (() => true),
    ...(options.lockedShares === undefined ? {} : { lockedSharesOf: (): number => options.lockedShares ?? 0 }),
  }

  return { deps, writes, asked }
}

/** fixture 末根的日期 —— 被预览的那一天 */
const LAST_DATE = (goldenCrossBreakout().candles.at(-1)?.date ?? '') as TradeDate

const POSITION: Position = {
  code: PROFILE.code,
  shares: 1000,
  cost: 8,
  openedAt: 0,
  peakPrice: 9,
}

describe('previewNextDay', () => {
  it('⚠ 什么都不写：不落 signal 表、不写指标缓存、不 bumpPeak', () => {
    const h = harness()
    const preview = previewNextDay(LAST_DATE, h.deps)
    // 先确认它真的算出了东西 —— 否则「零写入」会因为「压根没跑」而假通过
    expect(preview.coverage.withClose).toBeGreaterThan(0)
    expect(h.writes).toEqual([])
  })

  it('问的是「截至那一天」的上下文，不是「此刻」', () => {
    const h = harness()
    previewNextDay(LAST_DATE, h.deps)
    expect(h.asked.length).toBeGreaterThan(0)
    expect(h.asked.every((a) => a.through === LAST_DATE)).toBe(true)
  })

  it('日期原样带出来，且状态是 READY', () => {
    const h = harness()
    const preview = previewNextDay(LAST_DATE, h.deps)
    expect(preview.date).toBe(LAST_DATE)
    expect(preview.status).toBe('READY')
  })

  it('⚠ 缺当日收盘线的票进 missing，不静默消失', () => {
    const other: SecProfile = { ...PROFILE, code: 'SH600001', name: '别的票' }
    const h = harness({
      entries: [entry(), entry(other)],
      hasClose: (code) => code === PROFILE.code,
    })
    const preview = previewNextDay(LAST_DATE, h.deps)
    expect(preview.coverage).toEqual({ total: 2, withClose: 1, missing: ['SH600001'] })
    expect(preview.rows.some((row) => row.code === 'SH600001')).toBe(false)
  })

  it('⚠ 一只都没有当日收盘线 ⇒ UNAVAILABLE，不是「明天没有要做的」', () => {
    const h = harness({ hasClose: () => false })
    const preview = previewNextDay(LAST_DATE, h.deps)
    expect(preview.status).toBe('UNAVAILABLE')
    expect(preview.rows).toEqual([])
    expect(preview.coverage.withClose).toBe(0)
  })

  it('指数不进覆盖率的分母，也不出现在清单里（它不是可交易品种）', () => {
    const index: SecProfile = { code: 'SH000300', name: '沪深300', market: 'SH', board: 'INDEX', isST: false }
    const h = harness({ entries: [entry(), entry(index)] })
    const preview = previewNextDay(LAST_DATE, h.deps)
    expect(preview.coverage.total).toBe(1)
    expect(preview.rows.some((row) => row.code === 'SH000300')).toBe(false)
  })

  it('每一行都带方向与动作，而两者不是一回事（「明日观察」在未持仓时才变成买）', () => {
    const h = harness()
    const preview = previewNextDay(LAST_DATE, h.deps)
    for (const row of preview.rows) {
      expect(['BUY', 'SELL', 'REDUCE']).toContain(row.action)
      expect(row.direction).toBeTruthy()
      expect(row.name).toBe(PROFILE.name)
    }
  })

  /**
   * ⚠ 这一条**必须**写成「拿 `toShadowAction` 对答案」，不能写成
   * 「未持仓那侧应该都是买」——第一版就是那么写的，而它在**空数组上假通过**：
   * 这段 fixture 的收盘方向在卖出侧，未持仓时一行都出不来，
   * 而 `[].every(...)` 恒为 true（§5.19 那类假通过的同一形状）。
   */
  it('⚠ 动作严格等于 toShadowAction(方向, 持仓) —— 判据只有那一处', () => {
    const held = previewNextDay(LAST_DATE, harness({ position: POSITION }).deps)
    expect(held.rows.length).toBeGreaterThan(0)
    for (const row of held.rows) {
      expect(row.holding).toBe(true)
      expect(row.action).toBe(toShadowAction(row.direction, true))
    }

    // 同一根 K 线、只把持仓拿掉：这段 fixture 的收盘方向在卖出侧
    // ⇒ 未持仓时**无动作可做**，一行都不该出 —— 而这正是 toShadowAction 说的
    const direction = held.rows[0]!.direction
    expect(toShadowAction(direction, false)).toBeNull()
    expect(previewNextDay(LAST_DATE, harness({ position: null }).deps).rows).toEqual([])
  })

  it('⚠ 硬抑制的不进清单：全仓被 T+1 锁住时，卖出那一行必须消失', () => {
    const sellable = previewNextDay(
      LAST_DATE,
      harness({ position: POSITION, lockedShares: 0 }).deps
    )
    const locked = previewNextDay(
      LAST_DATE,
      harness({ position: POSITION, lockedShares: POSITION.shares }).deps
    )
    // 先确认没锁的时候确实有一行 —— 否则这条用例会因为「本来就没有」而假通过
    expect(sellable.rows.length).toBeGreaterThan(0)
    expect(locked.rows).toEqual([])
  })
})
