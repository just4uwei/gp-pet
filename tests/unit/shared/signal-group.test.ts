import { describe, expect, it } from 'vitest'
import { groupSignals, type GroupableSignal } from '@shared/signal-group'
import type { GatedDirection, SecCode } from '@core/types'

/**
 * 「今日信号」按标的分组（docs/06 §3）。
 *
 * 最要紧的两条：
 *   1. **计数必须等于展开后真能看到的条数。** 徽标写着「卖出 4 条」、展开只有 1 条
 *      这种对不上，比少显示难排查得多。
 *   2. **顺序确定。** 组内、组间、以及并列计数的排列都不许随入参顺序抖动 ——
 *      一个每次渲染都在重排的列表读起来像在闪。
 */
describe('groupSignals', () => {
  const s = (code: string, createdAt: number, direction: GatedDirection, name = code): GroupableSignal => ({
    code: code as SecCode,
    name,
    createdAt,
    direction,
  })

  it('空入参给空数组', () => {
    expect(groupSignals([])).toEqual([])
  })

  it('同一只票收成一组：最新那条当组头，其余按时间倒序折叠', () => {
    const groups = groupSignals([
      s('SH600000', 100, 'BUY'),
      s('SH600000', 300, 'SELL'),
      s('SH600000', 200, 'SELL'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.latest.createdAt).toBe(300)
    expect(groups[0]?.rest.map((r) => r.createdAt)).toEqual([200, 100])
    expect(groups[0]?.total).toBe(3)
  })

  it('只有一条时 rest 为空，total 为 1 —— 列表据此决定不渲染徽标行', () => {
    const groups = groupSignals([s('SH600000', 100, 'BUY')])
    expect(groups[0]?.rest).toEqual([])
    expect(groups[0]?.total).toBe(1)
  })

  it('买卖混合时按方向分别计数', () => {
    const groups = groupSignals([
      s('SH600000', 100, 'SELL'),
      s('SH600000', 200, 'SELL'),
      s('SH600000', 300, 'BUY'),
      s('SH600000', 400, 'SELL'),
      s('SH600000', 500, 'SELL'),
    ])
    expect(groups[0]?.counts).toEqual([
      { direction: 'SELL', count: 4 },
      { direction: 'BUY', count: 1 },
    ])
  })

  it('计数只统计传进来的那批 —— 调用方先按「含被静默的」过滤，再分组', () => {
    // 顺序倒过来（先分组再过滤）会让徽标数上用户看不到的条目
    const all = [s('SH600000', 100, 'SELL'), s('SH600000', 200, 'SELL'), s('SH600000', 300, 'BUY')]
    const visible = all.filter((r) => r.direction !== 'SELL')
    expect(groupSignals(visible)[0]?.counts).toEqual([{ direction: 'BUY', count: 1 }])
    expect(groupSignals(visible)[0]?.total).toBe(1)
  })

  it('组间按组头时间倒序 —— 列表整体仍是一条流水', () => {
    const groups = groupSignals([
      s('SH600000', 100, 'BUY'),
      s('SZ000001', 500, 'SELL'),
      s('SZ300001', 300, 'BUY'),
    ])
    expect(groups.map((g) => g.code)).toEqual(['SZ000001', 'SZ300001', 'SH600000'])
  })

  it('计数并列时次序固定，不随入参顺序变', () => {
    const a = groupSignals([s('SH600000', 100, 'SELL'), s('SH600000', 200, 'BUY')])
    const b = groupSignals([s('SH600000', 200, 'BUY'), s('SH600000', 100, 'SELL')])
    expect(a[0]?.counts).toEqual(b[0]?.counts)
    expect(a[0]?.counts.map((c) => c.direction)).toEqual(['BUY', 'SELL'])
  })

  it('名称取组头那条 —— 同一只票改过名时以最新的为准', () => {
    const groups = groupSignals([
      s('SH600000', 100, 'BUY', '旧名'),
      s('SH600000', 200, 'BUY', '新名'),
    ])
    expect(groups[0]?.name).toBe('新名')
  })

  it('入参无序也不影响结果 —— 不依赖 signal:history 的排序', () => {
    const ordered = groupSignals([s('SH600000', 300, 'BUY'), s('SH600000', 100, 'SELL')])
    const shuffled = groupSignals([s('SH600000', 100, 'SELL'), s('SH600000', 300, 'BUY')])
    expect(shuffled[0]?.latest.createdAt).toBe(ordered[0]?.latest.createdAt)
    expect(shuffled[0]?.rest.map((r) => r.createdAt)).toEqual(ordered[0]?.rest.map((r) => r.createdAt))
  })
})
