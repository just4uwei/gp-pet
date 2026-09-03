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

/**
 * 证券交易印花税**减半**的生效日与前后两档。
 *
 * ⚠ **一处定义，两边共用**：`src/backtest/costs.ts` 从这里 re-export
 * （渲染层不能 import `src/backtest`，而设置页要把这个日期显示给用户看）。
 * 依据是财政部、税务总局 2023-08-27 公告：自 2023-08-28 起减半征收，
 * 卖出方按成交金额的 0.05%（此前 0.1%），买入方不征。
 *
 * 它存在的理由与 `MAIN_ST_LIMIT_WIDENED_ON` 一模一样：**不带生效日期的规则常量
 * 迟早会错，而它错的时候没有任何东西会报警。**
 */
export const STAMP_TAX_HALVED_ON = '2023-08-28'
/** 减半之前：卖出方 0.1% */
export const STAMP_TAX_RATE_BEFORE = 0.001
/** 减半之后：卖出方 0.05% */
export const STAMP_TAX_RATE_AFTER = 0.0005

/**
 * 过户费率（双边，场内基金免）。自 2022-04-29 起沪深统一为成交金额的 0.001%。
 *
 * ⚠ 它**也是规则**，理论上同样该带生效日期（2022-04-29 之前上交所是 0.002%）。
 * 眼下没做，理由是量级：回测窗口内它最多差 万0.1，而印花税那一项差的是**一倍**。
 * 记在这里，别当成「已经处理好了」。
 */
export const TRANSFER_FEE_RATE = 0.00001
