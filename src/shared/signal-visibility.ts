/**
 * 「今日信号」列表的持仓相关收窄（2026-08-28 用户拍板）。
 *
 * **没有持仓的标的不显示卖出/减仓结论。** 理由是这条结论对用户不可执行：
 * 手上没有的东西卖不掉，而列表里那枚暖橙的「卖出」标签在这个应用里只有一个意思
 * —— 「引擎认为该出手了」。给一只从没买过的票挂上它，用户要么去查自己是不是持有，
 * 要么把它读成「别买」（而那是另一件事，引擎表达「别买」的方式是不给买入信号）。
 *
 * 放在 shared 而非渲染组件里，理由与 `signal-group.ts` / `ticker.ts` 相同：
 * 这是可测的纯判据，而项目里**没有渲染层测试** —— 埋进 JSX 就只能靠肉眼验收。
 *
 * ## 三条边界
 *
 * 1. **这一层只管展示，不许上移到引擎。** `signal` 表答的是「引擎判了什么」，
 *    影子运行、回测口径、alpha 统计全都读它 —— 在落库那一侧按持仓过滤，
 *    等于让「用户当时有没有持仓」污染策略绩效记录。
 *    ⚠ 同理**不许拿它去挡提醒**：提醒该不该发由四道闸门回答（docs/05 §4），
 *    而无持仓的卖出信号本来就不会走持仓强制通道。
 *
 * 2. **`REDUCE` 一起收窄，尽管它现在到不了这里。** 减仓只由 `positionVerdict()`
 *    产出、而那条通道以有持仓为前提。写进来是为了让判据表达的是「不可执行的离场结论」
 *    这件事本身，而不是今天恰好的调用图 —— 日后若有别的地方产出 `REDUCE`，
 *    这里不必再改一次。
 *
 * 3. **持仓未知时不隐藏任何东西。** `held` 传 `null` = 自选/持仓还没读到
 *    （首屏那一瞬，或者 `watchlist:list` 抛错）。此时把「不知道」当成「没持仓」，
 *    会让一条真正的 L3 止损从列表里消失 —— 而**少显示的错误用户发现不了**
 *    （与 `entryCheck` 拿不到评估时给 `UNKNOWN` 而不是 `CLEAR` 是同一条纪律）。
 *
 * ## 为什么要在「含被静默的 N 条」之前跑
 *
 * 那个计数必须等于展开后真能看到的条数（`signal-group.ts` 头注释第 1 条）。
 * 先数静默再收窄，复选框会宣称几条用户无论如何都看不到的信号。
 */

import type { GatedDirection, SecCode } from '@core/types'

/** 只要求这两项，方便调用方原样传完整的 `SignalRecord` 进来 */
export interface PositionScopedSignal {
  code: SecCode
  direction: GatedDirection
}

/** 需要持仓才有执行意义的方向 */
function isExitDirection(direction: GatedDirection): boolean {
  return direction === 'SELL' || direction === 'REDUCE'
}

/**
 * 滤掉「无持仓标的的卖出/减仓」。
 *
 * @param records 今日信号，任意顺序（原顺序保持不变）
 * @param held    有持仓的代码集合；**`null` 表示还不知道，此时原样返回**（见上面第 3 条）
 */
export function dropUnheldExits<T extends PositionScopedSignal>(
  records: readonly T[],
  held: ReadonlySet<SecCode> | null
): T[] {
  if (held === null) return [...records]
  return records.filter((record) => !isExitDirection(record.direction) || held.has(record.code))
}
