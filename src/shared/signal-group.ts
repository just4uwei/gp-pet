/**
 * 「今日信号」按标的分组（面板右栏，docs/06 §3）。
 *
 * 为什么要分组：同一只票一天里会出好几条 —— 盘中每轮 tick 都可能产出 `PROVISIONAL`，
 * 收盘轮再来一条 `CONFIRMED` 或 `INVALIDATED`。平铺时一只票就能把那个 ~300px 宽、
 * 内部滚动的列表刷满，用户看不出「今天一共有几只票出了信号」。
 *
 * 放在 shared 而非 renderer 组件里，理由与 `hit-test.ts` / `featured.ts` 相同：
 * 这是可测的纯判据，项目里**没有渲染层测试**，埋进组件就只能靠肉眼验收。
 *
 * ## 两条口径
 *
 * 1. **计数只统计传进来的那批。** 列表上「含被静默的 N 条」那个开关会先过滤一次，
 *    过滤后的结果才传到这里 —— 于是徽标上的「卖出 4 条」永远等于展开后真能看到的条数。
 *    若改成在这里统计全量，徽标会宣称几条用户根本看不到的信号，而那种对不上
 *    比少显示更难排查。
 * 2. **组内、组间都按 `createdAt` 倒序**，最新的那条当组头 —— 列表整体仍是一条流水，
 *    只是同一只票的旧条目收进了组里。
 */

import type { GatedDirection, SecCode } from '@core/types'

/** 只要求 SignalRecord 的这几个字段，方便调用方原样传完整记录进来 */
export interface GroupableSignal {
  code: SecCode
  name: string
  createdAt: number
  direction: GatedDirection
}

export interface DirectionCount {
  direction: GatedDirection
  count: number
}

export interface SignalGroup<T extends GroupableSignal> {
  code: SecCode
  /** 取组头那条的名称：同一只票改名时以最新的为准 */
  name: string
  /** `createdAt` 最大的一条，常显 */
  latest: T
  /** 其余，`createdAt` 倒序。只有一条信号时为空数组 */
  rest: T[]
  /** 按数量倒序；同数按方向在 `DIRECTION_ORDER` 里的次序，避免每次渲染顺序抖动 */
  counts: DirectionCount[]
  /** = 1 + rest.length，省得调用方到处 +1 */
  total: number
}

/**
 * 计数并列时的稳定次序。**不是**重要性排序，只是为了让同数的两个方向
 * 每次渲染都排在同一个位置 —— 顺序随渲染抖动的列表读起来像在闪。
 */
const DIRECTION_ORDER: readonly GatedDirection[] = ['BUY', 'SELL', 'REDUCE', 'NEXT_DAY_WATCH', 'NONE']

function rankOf(direction: GatedDirection): number {
  const index = DIRECTION_ORDER.indexOf(direction)
  return index === -1 ? DIRECTION_ORDER.length : index
}

export function groupSignals<T extends GroupableSignal>(records: readonly T[]): SignalGroup<T>[] {
  const byCode = new Map<SecCode, T[]>()
  for (const record of records) {
    const bucket = byCode.get(record.code)
    if (bucket) bucket.push(record)
    else byCode.set(record.code, [record])
  }

  const groups: SignalGroup<T>[] = []
  for (const [code, bucket] of byCode) {
    // 入参不保证有序（signal:history 是倒序，但别依赖它 —— 那是另一个模块的实现细节）
    const sorted = [...bucket].sort((a, b) => b.createdAt - a.createdAt)
    const latest = sorted[0]
    if (!latest) continue

    const tally = new Map<GatedDirection, number>()
    for (const record of sorted) tally.set(record.direction, (tally.get(record.direction) ?? 0) + 1)

    groups.push({
      code,
      name: latest.name,
      latest,
      rest: sorted.slice(1),
      counts: [...tally]
        .map(([direction, count]) => ({ direction, count }))
        .sort((a, b) => b.count - a.count || rankOf(a.direction) - rankOf(b.direction)),
      total: sorted.length,
    })
  }

  return groups.sort((a, b) => b.latest.createdAt - a.latest.createdAt)
}

/**
 * 组里除组头之外、**必须继续渲染**的那一条：用户正展开着的那条。
 *
 * ## 这不是「顺便多显示一条」，是在挡一个会烧钱的 bug
 *
 * 列表常显的只有 `latest`。同一只票再来一条信号（盘中每轮 tick 都可能），
 * `latest` 就换人了 —— 于是用户**正展开着、AI 解读正在流式生成**的那条
 * 直接从列表里消失，`AiExplain` 跟着卸载，而它是「卸载即取消」的。
 * 用户看到的是：等了四十秒的分析界面自己没了，什么提示都没有，
 * 而那次调用已经按对方规则计过费了。
 *
 * 组头照旧是 `latest`（新信号必须立刻可见，这是这个列表的本职），
 * 正在看的那条**钉在它下面**，两条都在。
 *
 * 返回 null 的三种情况：没有展开任何一条、展开的那条就是组头（已经在渲染了）、
 * 展开的那条不属于这个组。
 */
export function pinnedSignal<T extends GroupableSignal & { id: string }>(
  group: SignalGroup<T>,
  expandedId: string | null
): T | null {
  if (expandedId === null || group.latest.id === expandedId) return null
  return group.rest.find((record) => record.id === expandedId) ?? null
}
