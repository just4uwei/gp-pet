/**
 * 自选列表分屏与排序的判据（2026-08-18）。
 *
 * ## 分屏按「它是什么」，不是「它怎么进来的」
 *
 * 面板左栏那两个 tab 此前分的是 `WatchItem.group`（`自选` vs `行业ETF`），
 * 于是用户自己加的黄金ETF 留在「个股」那一屏，与内置的 15 只行业 ETF 分居两处 ——
 * 同一类品种看不到一起。现在改按**代码段推出的板块**分：`board === 'ETF'` 进 ETF 屏。
 *
 * **从代码段推而不是读 `watchlist.board`**，与 `controller.boardOf` 同一条理由：
 * 后者是 provider 抓来的画像，可能缺（缺失时仓储层回退成 `'MAIN'`，
 * 那会让一只 ETF 静默地跑到个股屏去）。代码段是确定的。
 *
 * 覆盖范围是 `src/core/code.ts` 的 SH `51/56/58` + SZ `15/16`，即全部场内基金
 * （ETF 与 LOF 都在内）—— 与成本模型的 `isFundBoard` 口径一致：
 * 分到 ETF 屏的那些，恰好就是免印花税与过户费的那些。
 *
 * ## 排序：持仓优先，但**段内保持用户自己排的顺序**
 *
 * 两条约束缺一条就出问题（2026-08-16 踩过，原先写在 `panel/App.tsx` 里）：
 *
 * 1. 只按 `hasPosition` 稳定排一次（`Array.prototype.sort` 在现代 JS 里是稳定的）。
 *    整个重排会把上移/下移按钮的成果抹掉。
 * 2. 调用方的上移/下移必须按**段**禁用，不是按整屏。`move()` 交换的是全局 `sortOrder`，
 *    而这里每次都会重新把持仓提到前面 —— 跨段交换之后显示顺序**一点变化都没有**，
 *    表现就是「点了没反应」。
 *
 * ## 拖动排序（2026-08-24）也受第 2 条约束，只是必须**拒绝**而不是禁用
 *
 * 上移/下移能靠 `disabled` 把跨段那一步堵在按钮上；拖动没有这个位置可用 ——
 * 鼠标可以落在任何一行上。所以判据挪进 `reorderWatchItems()`：
 * 同段才给新顺序，跨段（跨屏 或 跨持仓边界）一律返回 `null`。
 *
 * **不许把跨段拖动实现成「拖过去就当持仓/非持仓处理」** —— 段是从
 * `hasPosition` 派生的事实，不是用户能排的东西；让它跟着拖动走，等于让
 * 「这只票有没有持仓」变成一个可以拖出来的状态。
 */

import { splitCode } from '@core/code'
import type { SecCode } from '@core/types'

/** 面板左栏的两屏。`STOCK` 是「不是场内基金的一切」，不是「主板」 */
export type WatchTab = 'STOCK' | 'ETF'

/** 分屏判据。认不出的代码（理论上进不了自选）归 `STOCK`，不额外造一屏 */
export function watchTabOf(code: SecCode): WatchTab {
  return splitCode(code)?.board === 'ETF' ? 'ETF' : 'STOCK'
}

/** 只要求这两个字段，方便调用方直接传 `WatchItem` */
export interface SplittableWatchItem {
  code: SecCode
  hasPosition: boolean
}

/**
 * 按屏拆开并各自把持仓提到前面。**输入顺序即用户排的顺序**（全局 `sortOrder`），
 * 段内原样保留 —— 见头注释第 1 条。
 */
export function splitWatchItems<T extends SplittableWatchItem>(
  items: readonly T[]
): { stock: T[]; etf: T[] } {
  const stock: T[] = []
  const etf: T[] = []
  for (const item of items) {
    if (watchTabOf(item.code) === 'ETF') etf.push(item)
    else stock.push(item)
  }
  const held = (rows: T[]): T[] => rows.sort((a, b) => Number(b.hasPosition) - Number(a.hasPosition))
  return { stock: held(stock), etf: held(etf) }
}

/**
 * 一行所在的「段」= 屏 × 有无持仓。**同段才能互换位置**，因为 `splitWatchItems`
 * 每次都会重新按这两件事分组，跨段换到的位置在下一次渲染里就被排回去了。
 */
export function watchSegmentOf(item: SplittableWatchItem): string {
  return `${watchTabOf(item.code)}:${item.hasPosition ? 'HELD' : 'FREE'}`
}

/** 两行能不能互换位置（拖动的落点判据）。同一行也算不能 —— 拖回原处什么都不该发生 */
export function canReorderWatch(
  a: SplittableWatchItem | undefined,
  b: SplittableWatchItem | undefined
): boolean {
  if (!a || !b || a.code === b.code) return false
  return watchSegmentOf(a) === watchSegmentOf(b)
}

/**
 * 把 `fromCode` 那一行挪到 `toCode` **当前占的那一格**，返回新的全局顺序
 * （= 要写回 `sort_order` 的那份）。跨段或找不到时返回 `null`，调用方什么都不做。
 *
 * 三件事值得写下来：
 *
 * 1. **落点语义是「占掉目标那一格」**，于是往下拖会落在目标**之后**、往上拖落在目标
 *    **之前** —— 与上移/下移按钮在相邻两行上的行为逐位一致（有用例钉着）。
 *    换成「一律插在目标之前」的话，往下拖一格会变成原地不动，表现是「拖了没反应」。
 *
 * 2. **只重排那一段在全局数组里原本占的那些下标**，别的行一个都不挪。
 *    段内相对顺序就是屏上看到的顺序（`splitWatchItems` 段内保序），所以把新的段内
 *    序列按原下标写回去，屏上看到的就是拖动后的样子 —— 不需要在这里再模拟一次分屏。
 *
 * 3. 不改入参。调用方会先 `setItems(next)` 抢一步显示，落库失败再由 reload 纠正。
 */
export function reorderWatchItems<T extends SplittableWatchItem>(
  items: readonly T[],
  fromCode: SecCode,
  toCode: SecCode
): T[] | null {
  const from = items.find((item) => item.code === fromCode)
  const to = items.find((item) => item.code === toCode)
  if (!canReorderWatch(from, to) || !from || !to) return null

  const segment = watchSegmentOf(from)
  const slots: number[] = []
  items.forEach((item, index) => {
    if (watchSegmentOf(item) === segment) slots.push(index)
  })

  const seq = slots.map((index) => items[index] as T)
  const at = seq.indexOf(from)
  const target = seq.indexOf(to)
  if (at < 0 || target < 0) return null
  seq.splice(at, 1)
  // 用**移除前**的目标下标插入：往下拖时它已经因为移除左移了一格 ⇒ 落在目标之后
  seq.splice(target, 0, from)

  const next = [...items]
  slots.forEach((index, i) => {
    next[index] = seq[i] as T
  })
  return next
}
