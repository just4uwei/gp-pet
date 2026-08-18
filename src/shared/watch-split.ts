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
