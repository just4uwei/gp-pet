/**
 * 序列原语的边界与属性测试（docs/07 §2.1 的第二、三类）。
 *
 * 这一层最值得测的不是「算得对不对」（黄金用例已经比过独立实现了），
 * 而是**null 的传播**：预热期、序列中途空洞、越界下标。
 * 用 0 冒充未定义值是回测失真的经典来源（CLAUDE.md 第 4 条），
 * 而那种错误在数值上完全看不出来。
 */

import { describe, expect, it } from 'vitest'
import {
  at,
  changeOver,
  clamp,
  crossDown,
  crossUp,
  ema,
  existsWithin,
  fallingFor,
  nulls,
  percentileRank,
  populationStdev,
  risingFor,
  rollingPercentile,
  sma,
  wilderSum,
  approxEqual,
  EPS,
} from '@core/indicators/series'
import type { Series } from '@core/types'

describe('at', () => {
  it('越界、undefined、非有限值一律归为 null', () => {
    const series: Series = [1, null, 3]
    expect(at(series, -1)).toBeNull()
    expect(at(series, 3)).toBeNull()
    expect(at(series, 1)).toBeNull()
    expect(at(series, 0)).toBe(1)
    expect(at([Number.NaN], 0)).toBeNull()
    expect(at([Number.POSITIVE_INFINITY], 0)).toBeNull()
  })
})

describe('clamp / approxEqual / nulls', () => {
  it('clamp 夹紧并把非数字归到下界', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(clamp(-5, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
    expect(clamp(Number.NaN, 2, 3)).toBe(2)
  })

  it('approxEqual 用 1e-9 容差（docs/04 §1.1）', () => {
    expect(approxEqual(1, 1 + EPS / 2)).toBe(true)
    expect(approxEqual(1, 1.001)).toBe(false)
  })

  it('nulls 的负长度不抛错', () => {
    expect(nulls(-3)).toEqual([])
    expect(nulls(2)).toEqual([null, null])
  })
})

describe('sma', () => {
  it('预热期为 null，之后是窗口均值', () => {
    const out = sma([1, 2, 3, 4, 5], 3)
    expect(out).toEqual([null, null, 2, 3, 4])
  })

  it('窗口内出现 null 即为 null，且窗口滑过之后恢复', () => {
    const out = sma([1, null, 3, 4, 5, 6], 3)
    expect(out.slice(0, 4)).toEqual([null, null, null, null])
    expect(out[4]).toBeCloseTo(4, 10)
    expect(out[5]).toBeCloseTo(5, 10)
  })

  it('周期非正时整条为 null，不抛错', () => {
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null])
  })

  it('属性：输出必落在窗口的 min/max 之间（docs/07 §2.1）', () => {
    const values = [3, 9, 1, 7, 5, 2, 8, 4]
    const out = sma(values, 4)
    for (let i = 3; i < values.length; i++) {
      const window = values.slice(i - 3, i + 1)
      expect(out[i]).toBeGreaterThanOrEqual(Math.min(...window))
      expect(out[i]).toBeLessThanOrEqual(Math.max(...window))
    }
  })
})

describe('ema', () => {
  it('种子是首 n 个有效值的 SMA', () => {
    const out = ema([2, 4, 6], 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(4, 10)
  })

  it('按**有效值**计数种子 —— 前缀 null 不占预热额度', () => {
    // DEA 就是这个形状：EMA 套在前段为 null 的 DIF 上
    const out = ema([null, null, 2, 4, 6], 3)
    expect(out[3]).toBeNull()
    expect(out[4]).toBeCloseTo(4, 10)
  })

  it('中途遇到 null 会重新预热，而不是跨过空洞继续递推', () => {
    const out = ema([2, 4, 6, null, 2, 4, 6], 3)
    expect(out[2]).toBeCloseTo(4, 10)
    expect(out[3]).toBeNull()
    expect(out[4]).toBeNull()
    expect(out[5]).toBeNull()
    expect(out[6]).toBeCloseTo(4, 10)
  })

  it('周期非正时整条为 null', () => {
    expect(ema([1, 2], -1)).toEqual([null, null])
  })
})

describe('wilderSum', () => {
  it('种子为首 n 个有效值之和，之后按 W - W/n + x 递推', () => {
    const out = wilderSum([1, 1, 1, 1], 3)
    expect(out[2]).toBeCloseTo(3, 10)
    expect(out[3]).toBeCloseTo(3 - 1 + 1, 10)
  })

  it('前缀 null 不占预热额度（TR/DM 的首根就是 null）', () => {
    const out = wilderSum([null, 2, 2], 2)
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(4, 10)
  })

  it('周期非正时整条为 null', () => {
    expect(wilderSum([1, 2], 0)).toEqual([null, null])
  })
})

describe('populationStdev', () => {
  it('除 n 而非 n-1（国内平台口径，docs/04 §1.4）', () => {
    // [2,4] 的总体标准差是 1，样本标准差是 1.414…
    expect(populationStdev([2, 4])).toBeCloseTo(1, 10)
  })

  it('空数组与全等值给 0', () => {
    expect(populationStdev([])).toBe(0)
    expect(populationStdev([5, 5, 5])).toBe(0)
  })
})

describe('crossUp / crossDown', () => {
  const a: Series = [1, 3]
  const b: Series = [2, 2]

  it('相邻两根之间判定一次（docs/04 §1.9）', () => {
    expect(crossUp(a, b, 1)).toBe(true)
    expect(crossDown(b, a, 1)).toBe(true)
    expect(crossUp(a, b, 0)).toBe(false)
  })

  it('任一侧为 null 则为 false', () => {
    expect(crossUp([null, 3], b, 1)).toBe(false)
    expect(crossUp(a, [null, 2], 1)).toBe(false)
    expect(crossUp([1, null], b, 1)).toBe(false)
    expect(crossDown([null, 1], [2, 2], 1)).toBe(false)
  })

  it('前一根相等也算穿越（带 EPS 容差）', () => {
    expect(crossUp([2, 3], [2, 2], 1)).toBe(true)
    expect(crossDown([2, 1], [2, 2], 1)).toBe(true)
  })

  it('仅贴近但未越过不算穿越', () => {
    expect(crossUp([1, 2], [2, 2], 1)).toBe(false)
  })
})

describe('percentileRank / rollingPercentile', () => {
  it('分位 = 小于等于当前值的样本占比 × 100', () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(75)
    expect(percentileRank([], 1)).toBe(0)
  })

  it('滚动分位要求窗口内无 null', () => {
    const out = rollingPercentile([1, 2, null, 4, 5], 2)
    expect(out[1]).toBe(100)
    expect(out[2]).toBeNull()
    expect(out[3]).toBeNull()
    expect(out[4]).toBe(100)
  })

  it('回看长度非正时整条为 null', () => {
    expect(rollingPercentile([1, 2], 0)).toEqual([null, null])
  })
})

describe('risingFor / fallingFor', () => {
  const up: Series = [1, 2, 3, 4]
  it('连续 n 步严格单调', () => {
    expect(risingFor(up, 3, 2)).toBe(true)
    expect(risingFor(up, 3, 5)).toBe(false)
    expect(fallingFor([4, 3, 2, 1], 3, 2)).toBe(true)
  })

  it('平走不算上升；步数非正为 false；含 null 为 false', () => {
    expect(risingFor([1, 1, 1], 2, 1)).toBe(false)
    expect(fallingFor([1, 1, 1], 2, 1)).toBe(false)
    expect(risingFor(up, 3, 0)).toBe(false)
    expect(fallingFor(up, 3, 0)).toBe(false)
    expect(risingFor([null, 2, 3], 1, 1)).toBe(false)
    expect(fallingFor([null, 2, 1], 1, 1)).toBe(false)
  })
})

describe('existsWithin / changeOver', () => {
  it('回溯窗口含当根，且不越过 0', () => {
    const hits: number[] = []
    expect(
      existsWithin(2, 5, (i) => {
        hits.push(i)
        return false
      })
    ).toBe(false)
    expect(hits).toEqual([2, 1, 0])
    expect(existsWithin(4, 2, (i) => i === 3)).toBe(true)
    expect(existsWithin(4, 2, (i) => i === 2)).toBe(false)
  })

  it('changeOver 任一侧 null 则 null', () => {
    expect(changeOver([1, 2, 5], 2, 2)).toBe(4)
    expect(changeOver([null, 2, 5], 2, 2)).toBeNull()
    expect(changeOver([1, 2, 5], 1, 5)).toBeNull()
  })
})
