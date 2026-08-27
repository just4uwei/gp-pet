/**
 * 配置形态第三次预注册的工具（`src/backtest/risk-budget.ts`）。
 *
 * 钉的是**三件能静默给出错数的事**：
 *
 * 1. **ERC 解得对不对** —— 用有解析解的协方差（对角、等相关）逐位核。
 *    这一条没有用例的话，一个解错的求解器会给出一条完全正常的净值曲线，
 *    而「ERC 这一臂」实际上是别的东西。**这个项目最贵的缺陷都是这个形状。**
 * 2. **不收敛/退化时抛错，不许静默退回等权**（同上，只是失败路径）。
 * 3. **成本记账与「同日生效就是未来函数」** —— 权重由调用方给，模拟器只按 t 期
 *    已生效的权重吃当期收益；换手先扣费再吃收益，与 `vol-target.ts` 逐字同口径。
 */

import { describe, expect, it } from 'vitest'
import {
  COV_WINDOW,
  FIXED_WEIGHTS,
  covarianceMatrix,
  erc,
  simulateLegs,
} from '@backtest/risk-budget'
import { DEFAULT_COSTS } from '@backtest/costs'

const close = (a: number, b: number, tol = 1e-9): void => {
  expect(Math.abs(a - b)).toBeLessThan(tol)
}

describe('ERC 求解器', () => {
  it('单位协方差（同方差、零相关）⇒ 等权', () => {
    const w = erc([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    for (const v of w) close(v, 1 / 3)
  })

  it('对角协方差、零相关 ⇒ w ∝ 1/σ（风险平价的解析解）', () => {
    // σ = 1, 2, 4 ⇒ w ∝ 1/1 : 1/2 : 1/4 = 4 : 2 : 1
    const w = erc([
      [1, 0, 0],
      [0, 4, 0],
      [0, 0, 16],
    ])
    close(w[0] ?? 0, 4 / 7)
    close(w[1] ?? 0, 2 / 7)
    close(w[2] ?? 0, 1 / 7)
  })

  it('等相关 + 同方差 ⇒ 仍是等权（相关性不改变对称解）', () => {
    const r = 0.6
    const w = erc([
      [1, r, r],
      [r, 1, r],
      [r, r, 1],
    ])
    for (const v of w) close(v, 1 / 3)
  })

  it('解出来的风险贡献真的相等（这才是 ERC 的定义）', () => {
    const cov = [
      [1.29e-4, -1.43e-6, 2.44e-5],
      [-1.43e-6, 2.18e-6, 1.7e-6],
      [2.44e-5, 1.7e-6, 1.14e-4],
    ]
    const w = erc(cov)
    const rc = w.map((wi, i) => wi * (cov[i] as number[]).reduce((s, v, j) => s + v * (w[j] ?? 0), 0))
    const total = rc.reduce((a, b) => a + b, 0)
    // 三条腿的风险贡献占比都该是 1/3
    for (const v of rc) close(v / total, 1 / 3, 1e-8)
    // 顺带钉住那个「债腿主导」的算术后果（论证 §13.5 ①）：方差最小那条腿拿到大部分权重
    expect(w[1] ?? 0).toBeGreaterThan(0.6)
  })

  it('方差非正 ⇒ 抛错，**不许**静默退回等权', () => {
    expect(() =>
      erc([
        [1, 0],
        [0, 0],
      ])
    ).toThrow(/方差非正/)
    expect(() => erc([])).toThrow(/空的/)
  })

  it('迭代上限用尽 ⇒ 抛错（宁可停下也不给一个半收敛的权重）', () => {
    expect(() =>
      erc(
        [
          [1, 0],
          [0, 4],
        ],
        1,
        1e-300
      )
    ).toThrow(/未收敛/)
  })
})

describe('协方差矩阵', () => {
  it('对称，且对角等于各列的样本方差（÷(n−1)）', () => {
    const rows = [
      [1, 2],
      [2, 4],
      [3, 5],
      [4, 9],
    ]
    const cov = covarianceMatrix(rows)
    close(cov[0]?.[1] ?? 0, cov[1]?.[0] ?? 0)
    // 第一列 1,2,3,4 ⇒ 均值 2.5，Σ(x−μ)² = 5 ⇒ /3 = 1.6667
    close(cov[0]?.[0] ?? 0, 5 / 3)
  })
})

describe('多腿净值模拟', () => {
  const flat = (w: readonly number[], n: number): number[][] => Array.from({ length: n }, () => [...w])

  it('零成本、单腿满仓 ⇒ 净值就是那条腿的复利', () => {
    const rets = [
      [0.1, 0, 0],
      [-0.05, 0, 0],
    ]
    const zero = { ...DEFAULT_COSTS, slippage: 0, commissionRate: 0 }
    const arm = simulateLegs('x', rets, flat([1, 0, 0], 2), zero)
    close(arm.totalReturn, 1.1 * 0.95 - 1)
    expect(arm.rebalances).toBe(1) // 建仓那一次
  })

  it('换手先扣费再吃当期收益（与 vol-target 逐字同口径）', () => {
    // 单边费率 = slippage + commissionRate；首日从 0 → 1 换手 1
    const rate = DEFAULT_COSTS.slippage + DEFAULT_COSTS.commissionRate
    const arm = simulateLegs('x', [[0.1, 0, 0]], flat([1, 0, 0], 1), DEFAULT_COSTS)
    close(arm.totalReturn, (1 - rate) * 1.1 - 1)
    close(arm.costPaid, rate)
    close(arm.turnover, 1)
  })

  it('权重是调用方给的 t 期已生效值 —— 模拟器不看未来，也不自己调仓', () => {
    // 第 2 期才换到第二条腿：第 1 期的收益只能按第一条腿算
    const rets = [
      [0.1, 0.5, 0],
      [0.1, 0.5, 0],
    ]
    const zero = { ...DEFAULT_COSTS, slippage: 0, commissionRate: 0 }
    const arm = simulateLegs('x', rets, [
      [1, 0, 0],
      [0, 1, 0],
    ], zero)
    close(arm.totalReturn, 1.1 * 1.5 - 1)
    expect(arm.rebalances).toBe(2)
  })

  it('平均暴露与各腿平均权重都报（§5.13：离开暴露读收益差会读反）', () => {
    const zero = { ...DEFAULT_COSTS, slippage: 0, commissionRate: 0 }
    const arm = simulateLegs('x', flat([0, 0, 0], 4), flat(FIXED_WEIGHTS, 4), zero)
    close(arm.exposure, 1)
    for (const v of arm.legWeights) close(v, 1 / 3)
  })
})

describe('预注册的常量', () => {
  it('COV_WINDOW 是 60、固定权重是等权 —— 改它们等于改预注册（论证 §13.4）', () => {
    expect(COV_WINDOW).toBe(60)
    expect([...FIXED_WEIGHTS]).toEqual([1 / 3, 1 / 3, 1 / 3])
  })
})

describe('月内漂移（2026-08-27 加，M2 §5.78）', () => {
  const zero = { ...DEFAULT_COSTS, slippage: 0, commissionRate: 0 }

  /*
    这一组钉的是「`weights` 是**目标**不是实际」。
    旧写法把它当实际 ⇒ 调仓之间被无成本地拉回目标 ⇒ **每条臂都白得逐日再平衡**，
    而第四轮的承重对照恰恰是「不随时间变的权重」⇒ 那个偏差压在主判据正中央。
  */
  it('目标不变而两腿收益不同 ⇒ 实际权重必须偏离目标，且期间零换手', () => {
    const arm = simulateLegs(
      'x',
      [
        [0.2, 0, 0], // 第一腿涨 20%
        [0, 0, 0],
      ],
      [
        [0.5, 0.5, 0],
        [0.5, 0.5, 0],
      ],
      zero
    )
    // t=0 实际 0.5 / 0.5；t=1 漂移成 0.6/1.1 = 0.5454…
    close(arm.legWeights[0] ?? 0, (0.5 + 0.6 / 1.1) / 2)
    close(arm.legWeights[1] ?? 0, (0.5 + 0.5 / 1.1) / 2)
    // 漂移真的发生了（旧写法这里恰好等于 0.5）
    expect(arm.legWeights[0] ?? 0).toBeGreaterThan(0.5)
    // 只有建仓那一次交易
    expect(arm.rebalances).toBe(1)
    close(arm.turnover, 1)
    close(arm.totalReturn, 0.1)
  })

  it('目标变化那一根的换手按「目标 − 漂移后的实际」算，不是「目标 − 上次目标」', () => {
    const arm = simulateLegs(
      'x',
      [
        [0.2, 0, 0],
        [0, 0, 0],
      ],
      [
        [0.5, 0.5, 0],
        [0.4, 0.6, 0], // 目标变了 ⇒ 交易
      ],
      zero
    )
    const drifted0 = 0.6 / 1.1
    const drifted1 = 0.5 / 1.1
    const expected = 1 + Math.abs(0.4 - drifted0) + Math.abs(0.6 - drifted1)
    close(arm.turnover, expected)
    expect(arm.rebalances).toBe(2)
    // 按「目标 − 上次目标」算会是 1 + 0.1 + 0.1 = 1.2，明显不同
    expect(Math.abs(arm.turnover - 1.2)).toBeGreaterThan(1e-3)
  })

  it('单腿满仓 ⇒ 漂移不产生任何换手（权重恒为 1）', () => {
    const arm = simulateLegs('x', [
      [0.1, 0, 0],
      [-0.05, 0, 0],
      [0.03, 0, 0],
    ], [
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ], zero)
    expect(arm.rebalances).toBe(1)
    close(arm.turnover, 1)
    close(arm.totalReturn, 1.1 * 0.95 * 1.03 - 1)
    close(arm.legWeights[0] ?? 0, 1)
  })
})
