/**
 * 池层面的流动性 / 市值过滤（`src/backtest/liquidity.ts`，预注册见 M2 §5.29）。
 *
 * 这一层的每个错误都是**单向偏向乐观**的，所以必须逐条钉：
 *   - 剔多了 → 训练窗口凭空变好，而看报告的人只会看到 Calmar 上移
 *   - 缺数当成「不合格」→ 停牌复牌那天的正常标的被判出去
 *   - 用整段中位数算分位 → 前视偏差，结论整体无效（这一条由 `allows` 的逐日语义保证）
 *   - 挡住卖出 → 造出永远持有的仓，那是改风控不是筛标的
 */

import { describe, expect, it } from 'vitest'
import type { SecCode } from '@core/types'
import {
  ALLOW_ALL,
  createPoolFilter,
  lowerThreshold,
  trailingAmount,
  type LiquidityRow,
  type LiquiditySeries,
} from '../../../src/backtest/liquidity'

const code = (s: string): SecCode => s as SecCode

function row(date: string, cap: number | null, amount: number | null): LiquidityRow {
  return {
    date,
    amount,
    turnoverRate: amount === null ? null : 1,
    avgPrice: 10,
    floatShares: cap === null ? null : cap / 10,
    floatCap: cap,
  }
}

/** 四只票、两天。市值 1 亿 / 2 亿 / 3 亿 / 4 亿 —— 剔 30% 应当只剔掉最小那一只 */
function pool(): LiquiditySeries[] {
  return [
    { code: code('SH600001'), rows: [row('2024-01-02', 1e8, 1e6), row('2024-01-03', 1e8, 1e6)] },
    { code: code('SH600002'), rows: [row('2024-01-02', 2e8, 2e6), row('2024-01-03', 2e8, 2e6)] },
    { code: code('SH600003'), rows: [row('2024-01-02', 3e8, 3e6), row('2024-01-03', 3e8, 3e6)] },
    { code: code('SH600004'), rows: [row('2024-01-02', 4e8, 4e6), row('2024-01-03', 4e8, 4e6)] },
  ]
}

const codes = [code('SH600001'), code('SH600002'), code('SH600003'), code('SH600004')]

describe('lowerThreshold：下侧分位', () => {
  it('剔 30%：四个值里剔掉最小的一个', () => {
    // floor(4 × 30 / 100) = 1 ⇒ 阈值是排序后第 1 个（0-based），**低于它**的被剔
    expect(lowerThreshold([1, 2, 3, 4], 30)).toBe(2)
  })

  it('样本太少时不剔 —— 3 个值剔 30% 得到 k = 0', () => {
    expect(lowerThreshold([1, 2, 3], 30)).toBeNull()
  })

  it('pct = 0 或空数组一律不剔', () => {
    expect(lowerThreshold([1, 2, 3, 4], 0)).toBeNull()
    expect(lowerThreshold([], 30)).toBeNull()
  })
})

describe('trailingAmount：过去 N 个**有值**交易日的均额', () => {
  const rows = [row('d1', 1e8, 100), row('d2', 1e8, null), row('d3', 1e8, 300), row('d4', 1e8, 500)]

  it('跳过缺值的那天，而不是把它当 0', () => {
    // 若把 d2 当 0，(100+0+300)/3 = 133；正确答案是 (100+300)/2 = 200
    expect(trailingAmount(rows, 2, 3)).toBe(200)
  })

  it('长期停牌不该被算成低流动性 —— 取「有值的最近 N 个」', () => {
    expect(trailingAmount(rows, 3, 2)).toBe(400)
  })

  it('一个有值的都没有时返回 null（不返回 0）', () => {
    expect(trailingAmount([row('d1', null, null)], 0, 20)).toBeNull()
  })
})

describe('createPoolFilter', () => {
  it('两个阈值都是 0 时退化成 ALLOW_ALL —— 旧命令要逐位复现', () => {
    const filter = createPoolFilter(pool(), codes, {
      dropCapPct: 0,
      dropAmountPct: 0,
      amountWindow: 20,
    })
    expect(filter).toBe(ALLOW_ALL)
    expect(filter.blockedBars()).toBe(0)
  })

  it('按市值剔 30%：只有最小那只被挡，其余照常', () => {
    const filter = createPoolFilter(pool(), codes, {
      dropCapPct: 30,
      dropAmountPct: 0,
      amountWindow: 20,
    })
    expect(filter.allows(code('SH600001'), '2024-01-02')).toBe(false)
    expect(filter.allows(code('SH600002'), '2024-01-02')).toBe(true)
    expect(filter.allows(code('SH600004'), '2024-01-03')).toBe(true)
    // 两天各挡一只
    expect(filter.blockedBars()).toBe(2)
  })

  it('逐日判定：同一只票在市值上去的那天不再被挡（不是按整段中位数）', () => {
    /*
      这一条钉的是**前视偏差**。用整段中位数算分位的话，SH600001 在两天都会被挡；
      而正确行为是「哪天小就哪天挡」——第二天它涨到 5 亿、变成最大的一只，必须放行。
    */
    const series = pool()
    series[0] = {
      code: code('SH600001'),
      rows: [row('2024-01-02', 1e8, 1e6), row('2024-01-03', 5e8, 5e6)],
    }
    const filter = createPoolFilter(series, codes, {
      dropCapPct: 30,
      dropAmountPct: 0,
      amountWindow: 20,
    })
    expect(filter.allows(code('SH600001'), '2024-01-02')).toBe(false)
    expect(filter.allows(code('SH600001'), '2024-01-03')).toBe(true)
    // 第二天最小的变成了 SH600002
    expect(filter.allows(code('SH600002'), '2024-01-03')).toBe(false)
  })

  it('缺数不构成剔除理由（约束 4 的方向）', () => {
    const series = pool()
    series[0] = {
      code: code('SH600001'),
      rows: [row('2024-01-02', null, null), row('2024-01-03', 1e8, 1e6)],
    }
    const filter = createPoolFilter(series, codes, {
      dropCapPct: 30,
      dropAmountPct: 0,
      amountWindow: 20,
    })
    // 那天它没有市值 ⇒ 不参与分位、也不被挡
    expect(filter.allows(code('SH600001'), '2024-01-02')).toBe(true)
    expect(filter.allows(code('SH600001'), '2024-01-03')).toBe(false)
  })

  it('完全没有数据的标的全程不被剔，且必须能报出来', () => {
    const withExtra = [...codes, code('SZ000999')]
    const filter = createPoolFilter(pool(), withExtra, {
      dropCapPct: 30,
      dropAmountPct: 0,
      amountWindow: 20,
    })
    expect(filter.missing()).toEqual([code('SZ000999')])
    expect(filter.allows(code('SZ000999'), '2024-01-02')).toBe(true)
  })

  it('两条阈值并用时任一命中即剔', () => {
    const series = pool()
    // SH600004 市值最大但成交额垫底 ⇒ 应被流动性那条剔掉
    series[3] = {
      code: code('SH600004'),
      rows: [row('2024-01-02', 4e8, 1), row('2024-01-03', 4e8, 1)],
    }
    const filter = createPoolFilter(series, codes, {
      dropCapPct: 30,
      dropAmountPct: 30,
      amountWindow: 20,
    })
    expect(filter.allows(code('SH600004'), '2024-01-02')).toBe(false)
    expect(filter.allows(code('SH600001'), '2024-01-02')).toBe(false)
    expect(filter.allows(code('SH600003'), '2024-01-02')).toBe(true)
  })

  it('有文件但那一列全空的要单独报出来 —— 比缺文件更隐蔽', () => {
    /*
      `data/liquidity/` 可能混着 `--from-fixtures` 的代理文件（floatCap 全 null）
      与东财真值文件，抓取中途熔断也是同一形状。混装时 `--drop-cap-pct` 只作用于
      一部分池子，而报告上一切正常 —— 所以 noData() 必须把它们点出来。
    */
    const series = pool()
    series[0] = {
      code: code('SH600001'),
      rows: [row('2024-01-02', null, 1e6), row('2024-01-03', null, 1e6)],
    }
    const filter = createPoolFilter(series, codes, {
      dropCapPct: 30,
      dropAmountPct: 0,
      amountWindow: 20,
    })
    expect(filter.noData().forCap).toEqual([code('SH600001')])
    // 那一档没开就不报（免得「成交额全空」在只按市值剔的运行里变成噪音）
    expect(filter.noData().forAmount).toEqual([])
    // 而 missing() 只答「连文件都没有」，这两个问题不能混成一个
    expect(filter.missing()).toEqual([])
  })

  it('describe() 要写明横截面只在本池之内 —— 报告不许省这一句', () => {
    const filter = createPoolFilter(pool(), codes, {
      dropCapPct: 30,
      dropAmountPct: 30,
      amountWindow: 20,
    })
    expect(filter.describe()).toContain('仅本池')
    expect(filter.describe()).toContain('缺数不剔')
  })
})
