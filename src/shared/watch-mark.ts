/**
 * 「这条结论被用户自己设的条件否掉了 / 确认了」——观察点命中对**买卖 tag** 的改写判据。
 *
 * 放在 shared 而非任一渲染入口里：悬浮条的跑马灯标签与面板的信号行标签必须给出
 * 同一个结论。两处各写一份的症状是「条子说已失效、面板还写着买入」，
 * 而用户没有任何办法判断哪个才对（与 `watch-metrics.ts` 搬到 shared 是同一条理由）。
 *
 * ## 判据只有一条：命中的来源信号**就是**当前那条结论
 *
 * `watch_point.signal_id` 指向「这个观察点是看哪条解读设的」。只有当它恰好是
 * 当前显示的那条信号时才改写 tag —— 否则就是拿一条针对三天前那条信号的命中，
 * 去改写今天早上这条毫不相干的结论。
 *
 * 代价是**有些命中不会改 tag**（来源信号不是今天的、或今天又来了新信号把它挤下去了）。
 * 那是对的：面板的时间线里那次命中照样在，而 tag 只回答「当前这条结论现在还算不算数」。
 *
 * ## 为什么不看 `watch_point.verdict`
 *
 * 那个字段是**模型**当时的方向判断（UP/DOWN/RANGE），不是引擎的结论。
 * 拿它去改写买卖 tag 等于让 AI 直接给交易建议，与「AI 只读、不回流」冲突
 * （CLAUDE.md 的 AI 纪律）。这里只用 `meaning` —— 那是**用户确认过**的语义：
 * 命中意味着原判断失效，还是得到确认。
 */

/** 命中对结论的改写。null（不在此类型里）表示 tag 照旧 */
export type WatchMark = 'INVALIDATED' | 'CONFIRMED'

/** `WatchPointView` 结构上就满足它 —— 调用方直接传完整记录即可 */
export interface MarkableHit {
  /** 来源信号 id */
  signalId: string
  /** 命中意味着什么。**只认这个字段**，见文件头 */
  meaning: 'INVALIDATE' | 'CONFIRM'
  /** 命中时刻。没有它说明还没命中，一律忽略 */
  hitAt?: number
}

export const WATCH_MARK_LABEL: Record<WatchMark, string> = {
  INVALIDATED: '已失效',
  CONFIRMED: '已确认',
}

/**
 * 这条信号被命中改写成什么。没有相关命中时返回 null。
 *
 * 同一条信号可以挂着好几个观察点。取**最近一次**命中为准（与「tag 取当日最后一条信号」
 * 同一条取舍：后来发生的事覆盖先前的）。同一时刻既有失效又有确认时**失效优先** ——
 * 少说一句「已确认」的代价，远小于在一条已被否掉的结论上继续写「已确认」。
 */
export function watchMarkOf(signalId: string, hits: readonly MarkableHit[]): WatchMark | null {
  let mark: WatchMark | null = null
  let at = -1
  for (const hit of hits) {
    if (hit.signalId !== signalId) continue
    if (typeof hit.hitAt !== 'number' || !Number.isFinite(hit.hitAt)) continue
    const next: WatchMark = hit.meaning === 'INVALIDATE' ? 'INVALIDATED' : 'CONFIRMED'
    // 同一时刻的两条：失效压过确认
    if (hit.hitAt > at || (hit.hitAt === at && next === 'INVALIDATED')) {
      at = hit.hitAt
      mark = next
    }
  }
  return mark
}
