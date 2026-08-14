import { describe, expect, it } from 'vitest'
import { groupSignals, pinnedSignal, type GroupableSignal } from '@shared/signal-group'
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

/**
 * 「正展开着的那条要留在组里」（2026-08-14 修的 bug）。
 *
 * 症状是**只有在正好来了新信号的那一刻**才出现，而且现场什么都不剩：
 * 用户展开一条信号、点了 AI 解读，四十秒的流式生成跑到一半，同一只票再来一条
 * 信号 → 组头换人 → 那条被挤出列表 → `AiExplain` 卸载 → 请求被取消，
 * 界面自己没了。日志上看不出异常，而那次调用已经按对方规则计过费。
 */
describe('pinnedSignal', () => {
  const r = (id: string, code: string, createdAt: number): GroupableSignal & { id: string } => ({
    id,
    code: code as SecCode,
    name: code,
    createdAt,
    direction: 'BUY',
  })

  const group = (...records: (GroupableSignal & { id: string })[]) => {
    const groups = groupSignals(records)
    const first = groups[0]
    if (!first) throw new Error('fixture 至少要给一条')
    return first
  }

  it('展开的那条已经是组头 → 不用钉（它本来就在渲染）', () => {
    const g = group(r('new', 'SH600000', 200), r('old', 'SH600000', 100))
    expect(pinnedSignal(g, 'new')).toBeNull()
  })

  it('新信号把它挤下组头 → 必须钉住，否则 AI 解读会被卸载取消', () => {
    const g = group(r('new', 'SH600000', 200), r('old', 'SH600000', 100))
    expect(pinnedSignal(g, 'old')?.id).toBe('old')
    // 组头仍是新来的那条 —— 新信号必须立刻可见，这是这个列表的本职
    expect(g.latest.id).toBe('new')
  })

  it('什么都没展开 → null', () => {
    expect(pinnedSignal(group(r('a', 'SH600000', 100)), null)).toBeNull()
  })

  it('展开的是别的票 → 不钉到这个组里来', () => {
    const g = group(r('a', 'SH600000', 100))
    expect(pinnedSignal(g, '别的票的信号 id')).toBeNull()
  })

  it('连来两条新信号，钉住的仍是最初展开的那条', () => {
    const g = group(
      r('newer', 'SH600000', 300),
      r('new', 'SH600000', 200),
      r('watching', 'SH600000', 100)
    )
    expect(g.latest.id).toBe('newer')
    expect(pinnedSignal(g, 'watching')?.id).toBe('watching')
  })
})

/**
 * 观察点命中合流成一条**按股票**的时间线（2026-08-14）。
 *
 * 用户看一只票时想看的是**变化**：早上出了买入信号 → 下午他自己设的失效条件命中了
 * → 引擎又给了卖出。这三件事必须挨着看才有意义。
 *
 * 而 `counts` / `total` 仍然**只数信号** —— 「今天几条信号」与「命中几次观察点」
 * 是两个问题，合成一个数就再也拆不开。
 */
describe('groupSignals · 合流观察点命中', () => {
  const s = (code: string, createdAt: number, direction: GatedDirection = 'BUY') => ({
    id: `sig-${code}-${createdAt}`,
    code: code as SecCode,
    name: code,
    createdAt,
    direction,
  })
  // exactOptionalPropertyTypes：'没命中' 要表达成「没有这个键」，不是 hitAt: undefined
  const h = (code: string, hitAt: number | undefined, id = `hit-${code}-${hitAt}`) => ({
    id,
    code: code as SecCode,
    ...(hitAt === undefined ? {} : { hitAt }),
  })

  it('不传命中时行为与以前一字不差', () => {
    const groups = groupSignals([s('SH600000', 100)])
    expect(groups[0]?.hits).toEqual([])
    expect(groups[0]?.events.map((e) => e.kind)).toEqual(['SIGNAL'])
  })

  it('events 按时间倒序穿插，命中排在它该在的位置', () => {
    const groups = groupSignals(
      [s('SH600000', 100), s('SH600000', 300)],
      [h('SH600000', 200), h('SH600000', 400)]
    )
    expect(groups[0]?.events.map((e) => `${e.kind}@${e.at}`)).toEqual([
      'HIT@400',
      'SIGNAL@300',
      'HIT@200',
      'SIGNAL@100',
    ])
  })

  it('时间线的头可以是一次命中 —— 那正是「下午命中了失效条件」该有的位置', () => {
    const groups = groupSignals([s('SH600000', 100)], [h('SH600000', 500)])
    expect(groups[0]?.events[0]?.kind).toBe('HIT')
    // 但 latest 仍然是最新那条**信号**：两个字段回答两个问题
    expect(groups[0]?.latest.createdAt).toBe(100)
  })

  it('**counts 与 total 不把命中算进去**', () => {
    const groups = groupSignals([s('SH600000', 100, 'SELL')], [h('SH600000', 200), h('SH600000', 300)])
    expect(groups[0]?.total).toBe(1)
    expect(groups[0]?.counts).toEqual([{ direction: 'SELL', count: 1 }])
    expect(groups[0]?.hits).toHaveLength(2)
  })

  it('没有 hitAt 的一律丢掉 —— 编一个时刻会让它排到错的位置上', () => {
    const groups = groupSignals([s('SH600000', 100)], [h('SH600000', undefined)])
    expect(groups[0]?.hits).toEqual([])
    expect(groups[0]?.events).toHaveLength(1)
  })

  it('命中挂到对应的票上，不串组', () => {
    const groups = groupSignals(
      [s('SH600000', 100), s('SZ000001', 100)],
      [h('SZ000001', 500)]
    )
    const byCode = new Map(groups.map((g) => [g.code, g]))
    expect(byCode.get('SZ000001')?.hits).toHaveLength(1)
    expect(byCode.get('SH600000')?.hits).toHaveLength(0)
  })

  it('只有命中、没有信号的票不成组 —— 这个列表叫「今日信号」', () => {
    // 那种票的命中在观察点页里看得到；硬塞进信号列表会让「今天有几只票出了信号」失真
    expect(groupSignals([s('SH600000', 100)], [h('SZ000001', 500)])).toHaveLength(1)
  })

  it('组间按时间线的头排：刚命中的那只冒到最上面', () => {
    const groups = groupSignals(
      [s('SH600000', 100), s('SZ000001', 200)],
      [h('SH600000', 900)]
    )
    expect(groups[0]?.code).toBe('SH600000')
  })

  it('同一时刻时命中排在信号前面（与提醒层同一取舍）', () => {
    const groups = groupSignals([s('SH600000', 500)], [h('SH600000', 500)])
    expect(groups[0]?.events.map((e) => e.kind)).toEqual(['HIT', 'SIGNAL'])
  })

  it('pinnedSignal：时间线头是命中时，组头那条信号不需要再钉一遍', () => {
    const groups = groupSignals([s('SH600000', 100)], [h('SH600000', 500)])
    const group = groups[0]
    if (!group) throw new Error('fixture 至少要给一组')
    expect(pinnedSignal(group, group.latest.id)).toBeNull()
  })
})
