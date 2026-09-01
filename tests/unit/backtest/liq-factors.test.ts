/**
 * 流动性两因子（`src/backtest/ic-audit.ts` 的 `liquidityFactorsAt`，预注册 M2 §5.88）。
 *
 * **钉的是四条会静默出错的东西**，不是「算得对不对」那种一眼能看出来的：
 *   1. **DVOL 走不复权轨，收益走复权轨** —— 两个入参分开就是为了防混用，
 *      而混用**不报错**：`closeAdj × volume` 只是把老票的成交额放大上百倍
 *      （后复权锚在上市日，§5.40 那条「平安银行 2018 年首根 2069 元」）
 *      ⇒ 它们会被系统性判成「最流动」，而报告上一切正常。
 *   2. **零成交 / 缺值返回空 Map，不是 0**（约束 4）—— `amihud = 0` 会被读成
 *      「流动性完美」，那是最活跃的一档，方向正好反了。
 *      零成交日是 Amihud 这个估计量最主要的机械缺陷（除零），本地今天为 0 行，
 *      但判据要留着：换数据源或接上停牌日之后它会立刻变活。
 *   3. **`neg_dvol_20d` 是负数** —— 取负号是为了让它与 `amihud` 同向（都是越大越不流动）。
 *      少个负号不会报错，只会让 B2 那条臂的控制变量符号反了，而回归对符号不敏感
 *      ⇒ 中性化结果不变、只有 `corrWithDvol` 那一列翻符号，而那一列正是判据的一半。
 *   4. **缩放常数对秩零影响** —— ×1e9 只为可读；若有人日后改成「取 log 再缩放」，
 *      单调性还在、结论不变，但这条用例会提醒他那是个自由参数。
 */

import { describe, expect, it } from 'vitest'
import { liquidityFactorsAt, ranksOf } from '../../../src/backtest/ic-audit'

/** 由日收益率序列造收盘价（首值 10）。`rets[i]` 是第 i+1 根相对第 i 根的收益 */
function closesFrom(rets: readonly number[]): number[] {
  const out = [10]
  for (const r of rets) out.push((out[out.length - 1] as number) * (1 + r))
  return out
}

/*
  索引约定与 `priceFactorsAt` 逐条相同：`liquidityFactorsAt(…, index)` 取下标
  `index−19 .. index` 这 20 根的**日收益**，每根都要它前一根 ⇒ 最小可用 `index` 是 **20**。
*/
describe('liquidityFactorsAt', () => {
  it('窗口不满 / 非正价 / 零成交时返回空 Map —— 不是 0（约束 4）', () => {
    const closes = closesFrom(new Array(30).fill(0.01))
    const vol = new Array(31).fill(1_000_000)
    expect(liquidityFactorsAt(closes, closes, vol, 20).size).toBeGreaterThan(0)
    expect(liquidityFactorsAt(closes, closes, vol, 19).size).toBe(0)

    // 零成交那一根落在窗口内 ⇒ 整个窗口作废（除零是 Amihud 的头号机械缺陷）
    const holed = [...vol]
    holed[25] = 0
    expect(liquidityFactorsAt(closes, closes, holed, 30).size).toBe(0)
    expect(liquidityFactorsAt(closes, closes, holed, 24).size).toBeGreaterThan(0)

    // 价格非正（退市整理期的加性后复权会到这里，§5.26）
    const badPrice = [...closes]
    badPrice[25] = -0.5
    expect(liquidityFactorsAt(closes, badPrice, vol, 30).size).toBe(0)
  })

  it('DVOL 走不复权轨：把复权价传进第二个入参会给出不同的数，且不报错', () => {
    const raw = closesFrom(new Array(30).fill(0.01))
    // 后复权轨 = 同一条形状 × 100（除权累积造成的量级差，只是被夸张了）
    const adj = raw.map((p) => p * 100)
    const vol = new Array(31).fill(1_000_000)

    const correct = liquidityFactorsAt(adj, raw, vol, 25).get('amihud_20d') as number
    const mixedUp = liquidityFactorsAt(adj, adj, vol, 25).get('amihud_20d') as number
    expect(correct).toBeGreaterThan(0)
    expect(mixedUp).toBeGreaterThan(0)
    // 分母被放大 100 倍 ⇒ 这只票凭空「流动 100 倍」，而两个数都长得很正常
    expect(correct / mixedUp).toBeCloseTo(100, 6)
  })

  it('收益走复权轨：除权那根不该被算成一次暴跌', () => {
    const flat = new Array(30).fill(0)
    const adj = closesFrom(flat) // 复权轨完全平
    const raw = [...adj]
    raw[25] = (raw[25] as number) * 0.5 // 不复权轨在第 25 根除权腰斩
    const vol = new Array(31).fill(1_000_000)

    // 复权轨算收益 ⇒ 20 天一动不动 ⇒ amihud 恰好 0（这是真的「没有价格冲击」，不是缺值）
    expect(liquidityFactorsAt(adj, raw, vol, 30).get('amihud_20d')).toBe(0)
    // 不复权轨算收益（§5.88 的稳健性臂）⇒ 那一跳被记成 −50%，因子被凭空抬起来
    expect(liquidityFactorsAt(raw, raw, vol, 30).get('amihud_20d') as number).toBeGreaterThan(0)
  })

  it('neg_dvol_20d 是负数，且与 amihud 同向（都是越大越不流动）', () => {
    const closes = closesFrom(new Array(30).fill(0.01))
    const thin = new Array(31).fill(100_000)
    const thick = new Array(31).fill(100_000_000)

    const thinOut = liquidityFactorsAt(closes, closes, thin, 25)
    const thickOut = liquidityFactorsAt(closes, closes, thick, 25)

    expect(thinOut.get('neg_dvol_20d') as number).toBeLessThan(0)
    // 冷门票：amihud 更大（更不流动）· neg_dvol 也更大（负得更少）⇒ 两者同向
    expect(thinOut.get('amihud_20d') as number).toBeGreaterThan(
      thickOut.get('amihud_20d') as number
    )
    expect(thinOut.get('neg_dvol_20d') as number).toBeGreaterThan(
      thickOut.get('neg_dvol_20d') as number
    )
  })

  it('缩放常数只影响可读性，不影响秩 —— 这就是「不取 log」那个决定的依据', () => {
    const closes = closesFrom(new Array(30).fill(0.01))
    const values: number[] = []
    for (const v of [100_000, 1_000_000, 10_000_000, 500_000]) {
      const out = liquidityFactorsAt(closes, closes, new Array(31).fill(v), 25)
      values.push(out.get('amihud_20d') as number)
    }
    // 任意单调变换（缩放、log）之后秩不变 ⇒ IC 与横截面回归的输入不变
    expect(ranksOf(values)).toEqual(ranksOf(values.map((x) => Math.log(x) * 3 + 7)))
  })
})
