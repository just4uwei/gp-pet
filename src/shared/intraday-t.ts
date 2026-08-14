/**
 * 日内做T建议的中文措辞。**主进程之外的两个渲染入口共用这一份。**
 *
 * 搬到 shared 的理由与 `watch-metrics.ts` 一模一样：这种表一旦有两份，
 * 「同一件事在悬浮条上叫高抛、在面板里叫减仓」就只是时间问题，
 * 而用户会以为那是两个不同的建议。
 *
 * ## 措辞纪律
 *
 * 说的是**一次日内往返**，不是对这只票的看法 —— 所以不许写成「卖出 / 买入」，
 * 那两个词在这个软件里已经是引擎结论的专有措辞（`ACTION_LABEL`）。
 * 更不许出现「抄底」「稳赚」一类（CLAUDE.md 措辞纪律）。
 *
 * 判据、三条边界、以及「为什么这几个阈值标不了」都在
 * [`src/core/risk/intraday-t.ts`](../core/risk/intraday-t.ts) 的头注释里。
 */

export type TSide = 'HIGH_SELL' | 'LOW_BUY'

export const T_HINT_LABEL: Record<TSide, string> = {
  HIGH_SELL: '日内高抛',
  LOW_BUY: '日内低吸',
}

/** 悬停时的一句话解释。做T对没做过的人不是自明的，标签本身讲不完 */
export const T_HINT_TITLE: Record<TSide, string> = {
  HIGH_SELL: '现价处于今日振幅高位，持有底仓时可考虑先减一部分、等回落再接回',
  LOW_BUY: '现价处于今日振幅低位，持有底仓时可考虑先买回一部分（T+1 下当日卖出的是老仓）',
}
