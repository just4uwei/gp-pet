/**
 * 收益形态三因子（`src/backtest/ic-audit.ts` 的 `priceFactorsAt`，预注册 M2 §5.83）。
 *
 * **钉的是三条会静默出错的东西**，不是「算得对不对」那种一眼能看出来的：
 *   1. **窗口不满时返回空 Map，不是 0**（约束 4）—— `max_ret = 0` 会被读成
 *      「这 20 天一天都没涨」，而它其实是「算不出来」。这两件事在 IC 上完全不同：
 *      前者会进横截面并参与排序，后者该被剔掉。
 *   2. **偏度除 n**（`m₃/m₂^{3/2}`），与布林带除 n 同一条口径纪律。
 *      写成除 n−1 不会报错，只会让这个因子与项目里其他二阶量不同口径。
 *   3. **`m₂ = 0` 时偏度缺项**（不是 0，也不是 NaN）—— 停牌段的 20 天逐日收益完全相同
 *      会走到这里，而 NaN 进了横截面会污染整天的 Spearman。
 */

import { describe, expect, it } from 'vitest'
import { priceFactorsAt } from '../../../src/backtest/ic-audit'

/** 由日收益率序列造 closeAdj（首值 100）。`rets[i]` 是第 i+1 根相对第 i 根的收益 */
function closesFrom(rets: readonly number[]): number[] {
  const out = [100]
  for (const r of rets) out.push((out[out.length - 1] as number) * (1 + r))
  return out
}

/*
  **索引约定（写出来是因为我在写这条用例时就先算错了一次）**：
  `priceFactorsAt(closes, index)` 取的是 `closes` 下标 `index−19 .. index` 这 20 根的**日收益**，
  每根都要它前一根 ⇒ 最小可用的 `index` 是 **20**（`index = 19` 时最小的 `k−1` 是 −1）。
  而 `closesFrom(rets)` 里 `rets[j]` 对应 `closes[j+1]` 的收益
  ⇒ `index` 处的窗口 = `rets[index−20 .. index−1]`。
*/
describe('priceFactorsAt', () => {
  it('窗口不满 / 有非正价时返回空 Map —— 不是 0（约束 4）', () => {
    const closes = closesFrom(new Array(30).fill(0.01))
    expect(priceFactorsAt(closes, 20).size).toBeGreaterThan(0)
    expect(priceFactorsAt(closes, 19).size).toBe(0)
    expect(priceFactorsAt(closes, 5).size).toBe(0)

    // 窗口里混进一个 null / 0 / 负价 ⇒ 整个窗口作废，而不是跳过那一根
    for (const bad of [null, 0, -1, undefined]) {
      const dirty: (number | null | undefined)[] = [...closes]
      dirty[10] = bad
      expect(priceFactorsAt(dirty, 25).size).toBe(0)
    }
  })

  it('max_ret 与 up_days：只看窗口内那 20 根收益', () => {
    // rets = 10 天 +1% · 10 天 −2% · 一根 +30% · 25 天 −0.5%（下标 0..45）
    const closes = closesFrom([
      ...new Array(10).fill(0.01),
      ...new Array(10).fill(-0.02),
      0.3,
      ...new Array(25).fill(-0.005),
    ])
    // index 20 ⇒ rets[0..19]：10 涨 10 跌，**不含**那根 +30%
    const before = priceFactorsAt(closes, 20)
    expect(before.get('max_ret_20d')).toBeCloseTo(0.01, 10)
    expect(before.get('up_days_20d')).toBeCloseTo(0.5, 10)

    // index 21 ⇒ rets[1..20]：窗口右移一根就吃进了那根 +30%
    expect(priceFactorsAt(closes, 21).get('max_ret_20d')).toBeCloseTo(0.3, 10)

    // index 41 ⇒ rets[21..40]：整段都是 −0.5% ⇒ 一天没涨。
    // **这里必须是 0 而不是缺项** ——「真的一天没涨」与「算不出来」是两件事，
    // 上一条用例钉的是后者，这一条钉的是前者。
    const flatDown = priceFactorsAt(closes, 41)
    expect(flatDown.get('up_days_20d')).toBe(0)
    expect(flatDown.get('max_ret_20d')).toBeCloseTo(-0.005, 10)
  })

  it('偏度除 n，且 m₂ = 0 时缺项而不是 0 / NaN', () => {
    // 19 天 0%，1 天 +10% ⇒ 右偏。除 n 的解析值：
    //   mean = 0.1/20，m₂ = (19·mean² + (0.1−mean)²)/20，m₃ = (19·(−mean)³ + (0.1−mean)³)/20
    const rets = [...new Array(19).fill(0), 0.1]
    const closes = closesFrom(rets)
    const mean = 0.1 / 20
    const m2 = (19 * mean ** 2 + (0.1 - mean) ** 2) / 20
    const m3 = (19 * (-mean) ** 3 + (0.1 - mean) ** 3) / 20
    const expected = m3 / m2 ** 1.5
    expect(priceFactorsAt(closes, 20).get('ret_skew_20d')).toBeCloseTo(expected, 8)
    // 除 n−1 会给出一个不同的数 ⇒ 这条断言就是「口径没被顺手换掉」的闸门
    const m2Sample = (19 * mean ** 2 + (0.1 - mean) ** 2) / 19
    expect(expected).not.toBeCloseTo(m3 / m2Sample ** 1.5, 6)

    // 20 天收益完全相同 ⇒ m₂ = 0 ⇒ 偏度缺项，另两个因子照样有值
    const constant = priceFactorsAt(closesFrom(new Array(30).fill(0.005)), 25)
    expect(constant.has('ret_skew_20d')).toBe(false)
    expect(constant.get('up_days_20d')).toBe(1)
    expect(constant.get('max_ret_20d')).toBeCloseTo(0.005, 10)
  })
})
