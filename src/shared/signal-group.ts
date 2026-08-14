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
 * ## 三条口径
 *
 * 1. **计数只统计传进来的那批。** 列表上「含被静默的 N 条」那个开关会先过滤一次，
 *    过滤后的结果才传到这里 —— 于是徽标上的「卖出 4 条」永远等于展开后真能看到的条数。
 *    若改成在这里统计全量，徽标会宣称几条用户根本看不到的信号，而那种对不上
 *    比少显示更难排查。
 * 2. **组内、组间都按 `createdAt` 倒序**，最新的那条当组头 —— 列表整体仍是一条流水，
 *    只是同一只票的旧条目收进了组里。
 * 3. **观察点命中与信号合流成一条时间线**（2026-08-14），见下面 `events`。
 *
 * ## 观察点命中为什么在这里合流，而不是写进 signal 表
 *
 * 用户看一只票时想看的是**变化**：早上出了买入信号 → 下午他自己设的失效条件命中了
 * → 引擎又给了卖出。这三件事必须挨着看才有意义，所以 `events` 把它们按时间穿插。
 *
 * 但**绝不能把命中写成一条 signal**（那样合流会更省事）：`signal` 表答的是
 * 「引擎判了什么」，而观察点是用户自己设的条件、判定是一次纯比较。混进去之后
 * 「今天引擎给了几条信号」再也答不准，影子运行与各处统计也会被污染。
 *
 * 同一个理由让 `counts` / `total` **只数信号**：「今天有几条信号」与
 * 「今天命中了几次观察点」是两个问题，合成一个数就再也拆不开。命中数单独给。
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

/** 观察点命中在这一层只需要这两项。`WatchPointView` 结构上就满足它 */
export interface GroupableHit {
  code: SecCode
  /** 命中时刻。`WatchPointView.hitAt` —— 没命中的观察点不该传进来 */
  hitAt?: number
}

/** 时间线上的一项：引擎判的，或用户设的条件命中了 */
export type StockEvent<T, H> = { kind: 'SIGNAL'; at: number; signal: T } | { kind: 'HIT'; at: number; hit: H }

export interface SignalGroup<T extends GroupableSignal, H extends GroupableHit = GroupableHit> {
  code: SecCode
  /** 取组头那条的名称：同一只票改名时以最新的为准 */
  name: string
  /** `createdAt` 最大的**信号**，常显。注意时间线的头是 `events[0]`，两者可能不同 */
  latest: T
  /** 其余信号，`createdAt` 倒序。只有一条信号时为空数组 */
  rest: T[]
  /** 该股的观察点命中，命中时刻倒序 */
  hits: H[]
  /**
   * 信号 ∪ 命中，按时间倒序。**这是列表要画的那条时间线** ——
   * 「下午命中了失效条件」会出现在最上面，而不是被压在一条上午的信号下面。
   */
  events: StockEvent<T, H>[]
  /** 按数量倒序；同数按方向在 `DIRECTION_ORDER` 里的次序，避免每次渲染顺序抖动 */
  counts: DirectionCount[]
  /** = 1 + rest.length。**只数信号**，不含命中（见文件头第 3 条） */
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

export function groupSignals<T extends GroupableSignal, H extends GroupableHit = GroupableHit>(
  records: readonly T[],
  watchHits: readonly H[] = []
): SignalGroup<T, H>[] {
  const byCode = new Map<SecCode, T[]>()
  for (const record of records) {
    const bucket = byCode.get(record.code)
    if (bucket) bucket.push(record)
    else byCode.set(record.code, [record])
  }

  // 命中按 code 归堆。**没有 hitAt 的一律丢掉** —— 那说明它还没命中，
  // 放进时间线里得给它编一个时刻，而编出来的时刻会排到错的位置上
  const hitsByCode = new Map<SecCode, H[]>()
  for (const hit of watchHits) {
    if (typeof hit.hitAt !== 'number' || !Number.isFinite(hit.hitAt)) continue
    const bucket = hitsByCode.get(hit.code)
    if (bucket) bucket.push(hit)
    else hitsByCode.set(hit.code, [hit])
  }

  const groups: SignalGroup<T, H>[] = []
  for (const [code, bucket] of byCode) {
    // 入参不保证有序（signal:history 是倒序，但别依赖它 —— 那是另一个模块的实现细节）
    const sorted = [...bucket].sort((a, b) => b.createdAt - a.createdAt)
    const latest = sorted[0]
    if (!latest) continue

    const tally = new Map<GatedDirection, number>()
    for (const record of sorted) tally.set(record.direction, (tally.get(record.direction) ?? 0) + 1)

    const hits = [...(hitsByCode.get(code) ?? [])].sort((a, b) => (b.hitAt ?? 0) - (a.hitAt ?? 0))
    const events: StockEvent<T, H>[] = [
      ...sorted.map((signal) => ({ kind: 'SIGNAL' as const, at: signal.createdAt, signal })),
      ...hits.map((hit) => ({ kind: 'HIT' as const, at: hit.hitAt ?? 0, hit })),
    ].sort(
      (a, b) =>
        // 同一时刻时命中排在信号前面：命中是「你自己设的条件到了」，
        // 用户先看它比先看引擎结论更合他的预期（与提醒层的排序同一取舍）
        b.at - a.at || (a.kind === b.kind ? 0 : a.kind === 'HIT' ? -1 : 1)
    )

    groups.push({
      code,
      name: latest.name,
      latest,
      rest: sorted.slice(1),
      hits,
      events,
      counts: [...tally]
        .map(([direction, count]) => ({ direction, count }))
        .sort((a, b) => b.count - a.count || rankOf(a.direction) - rankOf(b.direction)),
      // **只数信号**：「今天几条信号」与「命中几次观察点」是两个问题（见文件头第 3 条）
      total: sorted.length,
    })
  }

  // 组间也按时间线的头排：下午刚命中的那只票该冒到最上面去
  return groups.sort((a, b) => (b.events[0]?.at ?? 0) - (a.events[0]?.at ?? 0))
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
export function pinnedSignal<T extends GroupableSignal & { id: string }, H extends GroupableHit>(
  group: SignalGroup<T, H>,
  expandedId: string | null
): T | null {
  if (expandedId === null) return null
  // 时间线的头可能是一次命中，此时组头那条信号仍在渲染 —— 它不需要再钉一遍
  const head = group.events[0]
  if (head?.kind === 'SIGNAL' && head.signal.id === expandedId) return null
  if (group.latest.id === expandedId) return null
  return group.rest.find((record) => record.id === expandedId) ?? null
}
