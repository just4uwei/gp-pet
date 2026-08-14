import { describe, expect, it } from 'vitest'
import {
  applyOrder,
  buildTicker,
  orderFingerprint,
  type TickerItem,
  type TickerQuote,
  type TickerSignal,
} from '@shared/ticker'
import type { MarkableHit } from '@shared/watch-mark'
import type { GatedDirection, SecCode } from '@core/types'

/**
 * 悬浮条改成跑马灯之后，「显示哪一只」不再是问题，**顺序与标注**才是（docs/06 §2.1）。
 *
 * 三条钉在这里：
 * - 顺序确定 —— 同幅同分不许随快照的数组顺序换位，一条常驻置顶的条子来回抖比不显示更烦人。
 * - 没有报价是 `null` 不是 0（约束 4 的同一条纪律，渲染层画「—」）。
 * - 没有信号是 `null` 不是某个中性方向 —— 引擎没说话，条子不许替它说（措辞纪律）。
 */
describe('buildTicker', () => {
  const item = (code: string, name: string): TickerItem => ({ code: code as SecCode, name })
  const quote = (code: string, last: number, changePct: number, stale = false): TickerQuote => ({
    code: code as SecCode,
    last,
    changePct,
    stale,
  })
  const signal = (
    code: string,
    score: number,
    extra: { at?: number; id?: string; direction?: GatedDirection; suppressedReason?: string } = {}
  ): TickerSignal => ({
    id: extra.id ?? `sig-${code}-${extra.at ?? 1_000}`,
    code: code as SecCode,
    name: `信号-${code}`,
    createdAt: extra.at ?? 1_000,
    direction: extra.direction ?? 'BUY',
    score,
    level: 'L2',
    ...(extra.suppressedReason === undefined ? {} : { suppressedReason: extra.suppressedReason }),
  })

  it('自选一只不落，没有报价的也在（跑马灯是「全部自选」，不是「有行情的自选」）', () => {
    const entries = buildTicker([item('SH600000', '浦发银行'), item('SZ000001', '平安银行')], [
      quote('SH600000', 10.2, 1.5),
    ])
    expect(entries.map((e) => e.code)).toEqual(['SH600000', 'SZ000001'])
    const [, second] = entries
    expect(second?.last).toBeNull()
    expect(second?.changePct).toBeNull()
  })

  it('有未静默信号的排在前面，按置信度降序', () => {
    const items = [item('SH600000', 'A'), item('SZ000001', 'B'), item('SZ300001', 'C')]
    const quotes = [quote('SH600000', 10, 0.1), quote('SZ000001', 20, -9), quote('SZ300001', 30, 0.2)]
    const entries = buildTicker(items, quotes, [signal('SH600000', 0.7), signal('SZ300001', 0.9)])
    // SZ000001 跌 9% 也排在两条信号之后 —— 条子的意义是「值得看一眼」而不是行情牌
    expect(entries.map((e) => e.code)).toEqual(['SZ300001', 'SH600000', 'SZ000001'])
  })

  it('被风控静默的信号不算「有信号」（docs/05 §6：它在提醒日志里可查，但不该占前排）', () => {
    const entries = buildTicker(
      [item('SH600000', 'A'), item('SZ000001', 'B')],
      [quote('SH600000', 10, 0.1), quote('SZ000001', 20, -3)],
      [signal('SH600000', 0.95, { suppressedReason: 'HARD_LIMIT_UP' })]
    )
    expect(entries.map((e) => e.code)).toEqual(['SZ000001', 'SH600000'])
    expect(entries.every((e) => e.action === null)).toBe(true)
  })

  it('动作取当日最后一条信号，收盘失效的撤销不会被上午那条得分更高的买入盖住', () => {
    const entries = buildTicker(
      [item('SH600000', 'A')],
      [quote('SH600000', 10, 0.1)],
      [
        signal('SH600000', 0.88, { at: 1_000, direction: 'BUY' }),
        signal('SH600000', 0.42, { at: 2_000, direction: 'NONE' }),
      ]
    )
    expect(entries[0]?.action).toBe('NONE')
  })

  /*
    观察点命中改写标签（2026-08-14）。判据只有一条：命中的**来源信号就是当前这条**。
    钉在这里的是那条边界 —— 拿一条针对别的信号的命中去改写当前结论，
    症状是「条子说已失效，而那条失效说的根本不是这件事」，从界面上完全看不出来。
  */
  const hit = (signalId: string, meaning: 'INVALIDATE' | 'CONFIRM', at = 3_000): MarkableHit => ({
    signalId,
    meaning,
    hitAt: at,
  })

  it('失效条件命中 → 当前那条结论标记为已失效', () => {
    const entries = buildTicker(
      [item('SH600000', 'A')],
      [quote('SH600000', 10, 0.1)],
      [signal('SH600000', 0.8, { id: 'sig-1', direction: 'BUY' })],
      [hit('sig-1', 'INVALIDATE')]
    )
    // 方向本身不改（signal 表里那条仍然是买入），改的是它现在还算不算数
    expect(entries[0]?.action).toBe('BUY')
    expect(entries[0]?.mark).toBe('INVALIDATED')
  })

  it('确认条件命中 → 标记为已确认', () => {
    const entries = buildTicker(
      [item('SH600000', 'A')],
      [quote('SH600000', 10, 0.1)],
      [signal('SH600000', 0.8, { id: 'sig-1' })],
      [hit('sig-1', 'CONFIRM')]
    )
    expect(entries[0]?.mark).toBe('CONFIRMED')
  })

  it('命中指向别的信号时不改写 —— 包括同一只票今天更早的那条', () => {
    const entries = buildTicker(
      [item('SH600000', 'A')],
      [quote('SH600000', 10, 0.1)],
      [
        signal('SH600000', 0.9, { id: 'sig-morning', at: 1_000 }),
        signal('SH600000', 0.5, { id: 'sig-noon', at: 2_000, direction: 'SELL' }),
      ],
      [hit('sig-morning', 'INVALIDATE')]
    )
    // 标签取的是 sig-noon，而命中否掉的是上午那条 —— 两件事，不许串
    expect(entries[0]?.action).toBe('SELL')
    expect(entries[0]?.mark).toBeNull()
  })

  it('同一条信号挂多个观察点时取最近一次；同一时刻失效压过确认', () => {
    const build = (hits: MarkableHit[]): ReturnType<typeof buildTicker> =>
      buildTicker(
        [item('SH600000', 'A')],
        [quote('SH600000', 10, 0.1)],
        [signal('SH600000', 0.8, { id: 'sig-1' })],
        hits
      )
    expect(build([hit('sig-1', 'CONFIRM', 3_000), hit('sig-1', 'INVALIDATE', 4_000)])[0]?.mark).toBe(
      'INVALIDATED'
    )
    expect(build([hit('sig-1', 'INVALIDATE', 4_000), hit('sig-1', 'CONFIRM', 5_000)])[0]?.mark).toBe(
      'CONFIRMED'
    )
    expect(build([hit('sig-1', 'CONFIRM', 3_000), hit('sig-1', 'INVALIDATE', 3_000)])[0]?.mark).toBe(
      'INVALIDATED'
    )
  })

  it('还没命中的观察点（没有 hitAt）一律忽略', () => {
    const entries = buildTicker(
      [item('SH600000', 'A')],
      [quote('SH600000', 10, 0.1)],
      [signal('SH600000', 0.8, { id: 'sig-1' })],
      [{ signalId: 'sig-1', meaning: 'INVALIDATE' }]
    )
    expect(entries[0]?.mark).toBeNull()
  })

  it('无信号是 null，不是某个中性方向', () => {
    const entries = buildTicker([item('SH600000', 'A')], [quote('SH600000', 10, 0.1)])
    expect(entries[0]?.action).toBeNull()
    expect(entries[0]?.level).toBeNull()
    expect(entries[0]?.score).toBeNull()
  })

  it('无信号时按 |涨跌幅| 降序 —— 跌 5% 和涨 5% 一样值得看一眼', () => {
    const entries = buildTicker(
      [item('SH600000', 'A'), item('SZ000001', 'B'), item('SZ300001', 'C')],
      [quote('SH600000', 10, 1.2), quote('SZ000001', 20, -5.4), quote('SZ300001', 30, 3.1)]
    )
    expect(entries.map((e) => e.code)).toEqual(['SZ000001', 'SZ300001', 'SH600000'])
  })

  it('同幅同分按代码升序兜底，与入参顺序无关', () => {
    const items = [item('SZ000001', 'B'), item('SH600000', 'A')]
    const quotes = [quote('SZ000001', 20, 2), quote('SH600000', 10, -2)]
    expect(buildTicker(items, quotes).map((e) => e.code)).toEqual(['SH600000', 'SZ000001'])
    expect(buildTicker([...items].reverse(), [...quotes].reverse()).map((e) => e.code)).toEqual([
      'SH600000',
      'SZ000001',
    ])

    const signals = [signal('SZ000001', 0.8), signal('SH600000', 0.8)]
    expect(buildTicker(items, quotes, signals).map((e) => e.code)).toEqual(['SH600000', 'SZ000001'])
    expect(
      buildTicker(items, quotes, [...signals].reverse()).map((e) => e.code)
    ).toEqual(['SH600000', 'SZ000001'])
  })

  it('名称以自选为准，自选还没读到时退到信号里的名称，再退到代码', () => {
    const withWatch = buildTicker([item('SH600000', '浦发银行')], [], [signal('SH600000', 0.7)])
    expect(withWatch[0]?.name).toBe('浦发银行')

    const beforeWatch = buildTicker([], [], [signal('SH600000', 0.7)])
    expect(beforeWatch[0]?.name).toBe('信号-SH600000')

    const bareQuote = buildTicker([], [quote('SZ000001', 20, 1)])
    expect(bareQuote[0]?.name).toBe('SZ000001')
  })

  it('stale 原样透传 —— 渲染层要据此灰显，不假装实时', () => {
    const entries = buildTicker([item('SH600000', 'A')], [quote('SH600000', 10, 1, true)])
    expect(entries[0]?.stale).toBe(true)
  })

  it('自选为空时给空数组（渲染层显示「未添加自选」，不是一条空白跑马灯）', () => {
    expect(buildTicker([], [])).toEqual([])
  })

  /**
   * 排序规则里有 |涨跌幅|，而它每轮取数都在变。照单重排会让跑马灯在滚动中把条目换位
   * —— 看起来像卡带。指纹与重排这一对就是为了让「价格在动、位置不动」。
   */
  describe('顺序稳定性', () => {
    const items = [item('SH600000', 'A'), item('SZ000001', 'B')]

    it('只有涨跌幅变化时指纹不变（位置不动）', () => {
      const before = buildTicker(items, [quote('SH600000', 10, 1), quote('SZ000001', 20, 2)])
      const after = buildTicker(items, [quote('SH600000', 11, 9), quote('SZ000001', 19, 0.1)])
      expect(orderFingerprint(after)).toBe(orderFingerprint(before))
      // 顺序照旧，但数字是新的
      const kept = applyOrder(after, before.map((e) => e.code))
      expect(kept.map((e) => e.code)).toEqual(before.map((e) => e.code))
      expect(kept[0]?.last).toBe(after.find((e) => e.code === kept[0]?.code)?.last)
    })

    it('出现新方向或增删标的时指纹变（该重排就重排）', () => {
      const base = buildTicker(items, [quote('SH600000', 10, 1), quote('SZ000001', 20, 2)])
      const withSignal = buildTicker(items, [quote('SH600000', 10, 1), quote('SZ000001', 20, 2)], [
        signal('SZ000001', 0.8),
      ])
      expect(orderFingerprint(withSignal)).not.toBe(orderFingerprint(base))

      const added = buildTicker([...items, item('SZ300001', 'C')], [quote('SH600000', 10, 1)])
      expect(orderFingerprint(added)).not.toBe(orderFingerprint(base))
    })

    it('不在旧顺序里的留在末尾，相对次序不变', () => {
      const entries = buildTicker(
        [item('SH600000', 'A'), item('SZ000001', 'B'), item('SZ300001', 'C')],
        []
      )
      const ordered = applyOrder(entries, ['SZ300001' as SecCode])
      expect(ordered[0]?.code).toBe('SZ300001')
      expect(ordered.slice(1).map((e) => e.code)).toEqual(
        entries.filter((e) => e.code !== 'SZ300001').map((e) => e.code)
      )
    })
  })
})
