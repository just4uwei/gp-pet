/**
 * 费率的**显示**口径（017）。纯函数，主进程与渲染层共用。
 *
 * ## 为什么住 `src/shared`
 *
 * 这个字符串出现在三处：设置页那张只读费率表、「校正成本」反解出来的那句结论、
 * 以及主进程的日志与 `costApply` 的返回消息。各写一份的症状是
 * 「界面说万 1.2、日志说 0.00012」—— 同一个数两种说法，而用户没法判断哪个对。
 */

/**
 * 费率 → 券商的说法（`0.00025` → 「万 2.5」）。**只用于文案。**
 *
 * 界面上一律用这个单位：用户在券商那边听到的就是「万几」，
 * 印一个 `0.00025` 出来他得先数几个 0 才知道对不对。
 */
export function ratePerTenThousand(rate: number): string {
  const value = rate * 10_000
  // 万 2.5 要保留一位，万 1 不要拖一个 .0；反解出来的数会有长尾，截到两位
  const text = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0$/, '')
  return `万 ${text}`
}

/** 千分之几（印花税那一档用它）。`0.001` → 「千 1」 */
export function ratePerThousand(rate: number): string {
  const value = rate * 1000
  return `千 ${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0$/, '')}`
}
