import { describe, expect, it } from 'vitest'
import { dropUnheldExits, type PositionScopedSignal } from '@shared/signal-visibility'
import type { GatedDirection, SecCode } from '@core/types'

/**
 * 「今日信号」不显示无持仓标的的卖出/减仓（2026-08-28）。
 *
 * 最要紧的两条：
 *   1. **有持仓的一条都不能少。** 止损那条 L3 从列表里消失是「少显示」的错误，
 *      而少显示用户发现不了 —— 这正是这一层唯一的风险。
 *   2. **持仓未知时什么都不隐藏。** 把「不知道」当成「没持仓」会踩上面那一条。
 */
describe('dropUnheldExits', () => {
  const s = (code: string, direction: GatedDirection): PositionScopedSignal => ({
    code: code as SecCode,
    direction,
  })
  const held = (...codes: string[]): ReadonlySet<SecCode> => new Set(codes as SecCode[])

  it('无持仓标的的 SELL 被滤掉', () => {
    expect(dropUnheldExits([s('SH600000', 'SELL')], held())).toEqual([])
  })

  it('无持仓标的的 REDUCE 也滤掉 —— 判据是「不可执行的离场结论」，不是今天的调用图', () => {
    expect(dropUnheldExits([s('SH600000', 'REDUCE')], held())).toEqual([])
  })

  it('有持仓时 SELL / REDUCE 原样保留（止损那条 L3 绝不能被吞）', () => {
    const rows = [s('SH600000', 'SELL'), s('SH600000', 'REDUCE')]
    expect(dropUnheldExits(rows, held('SH600000'))).toEqual(rows)
  })

  it('买入类不受持仓影响：BUY / NEXT_DAY_WATCH / NONE 一律保留', () => {
    const rows = [s('SH600000', 'BUY'), s('SH600000', 'NEXT_DAY_WATCH'), s('SH600000', 'NONE')]
    expect(dropUnheldExits(rows, held())).toEqual(rows)
  })

  it('held 为 null（持仓还不知道）时原样返回 —— 不许把「不知道」当成「没持仓」', () => {
    const rows = [s('SH600000', 'SELL'), s('SZ000001', 'REDUCE')]
    expect(dropUnheldExits(rows, null)).toEqual(rows)
  })

  it('逐只判定，不是全有全无', () => {
    const rows = [
      s('SH600000', 'SELL'), // 有持仓 → 留
      s('SZ000001', 'SELL'), // 无持仓 → 滤
      s('SZ000002', 'BUY'), // 无持仓但是买入 → 留
    ]
    expect(dropUnheldExits(rows, held('SH600000')).map((r) => r.code)).toEqual([
      'SH600000',
      'SZ000002',
    ])
  })

  it('保持入参顺序，且不改动入参数组', () => {
    const rows = [s('SZ000001', 'SELL'), s('SH600000', 'BUY'), s('SH600000', 'SELL')]
    const out = dropUnheldExits(rows, held('SH600000'))
    expect(out.map((r) => `${r.code}:${r.direction}`)).toEqual(['SH600000:BUY', 'SH600000:SELL'])
    expect(rows).toHaveLength(3)
    expect(out).not.toBe(rows)
  })
})
