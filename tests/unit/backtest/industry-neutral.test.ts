/**
 * 行业中性化（`src/backtest/ic-audit.ts` 的 `neutralizeByIndustry`，预注册 M2 §5.68）。
 *
 * **为什么用「不变量」而不是钉具体数字**：中性化写错的症状**不是报错**，
 * 是 IC 悄悄变成另一个数 —— 而我们恰恰要拿它与原始 IC 并排比。所以这里钉的是
 * 两条能把实现判死的恒等式，外加边界行为。
 */

import { describe, expect, it } from 'vitest'
import type { SecCode, TradeDate } from '@core/types'
import {
  icOf,
  neutralizeByIndustry,
  type Row,
} from '../../../src/backtest/ic-audit'

const code = (s: string): SecCode => s as SecCode
const date = (s: string): TradeDate => s as TradeDate

/** 造一天的横截面：`[得分, 前瞻收益]` 若干只 */
function day(pairs: readonly [number, number][], horizon = 10): Row[] {
  return pairs.map(([score, fwd], i) => ({
    code: code(`SH${String(600000 + i).padStart(6, '0')}`),
    score,
    fwd: new Map([[horizon, fwd]]),
  }))
}

const H = 10

describe('neutralizeByIndustry', () => {
  it('【不变量①】全部票在同一个行业时，中性 IC 逐位等于原始 IC', () => {
    /*
      去掉一个**全横截面**的常数不改变秩，而 Spearman 只看秩
      ⇒ 单组中性化必须是恒等变换。这一条能抓住绝大多数实现错误
      （错的分组、错的去均值对象、把残差再标准化了…）。
    */
    const rows = day([
      [0.9, 0.05],
      [0.7, -0.02],
      [0.5, 0.11],
      [0.3, -0.07],
      [0.2, 0.01],
      [0.15, 0.03],
      [0.1, -0.04],
      [0.08, 0.09],
      [0.06, -0.01],
      [0.04, 0.02],
      [0.02, 0.06],
      [0.01, -0.09],
    ])
    const byDate = new Map([[date('2020-01-02'), rows]])
    const raw = icOf(byDate, H)
    const { byDate: neutral, stats } = neutralizeByIndustry(byDate, () => '480000', H)
    const got = icOf(neutral, H)

    expect(raw.days).toBe(1)
    expect(got.days).toBe(1)
    expect(got.meanIc).toBeCloseTo(raw.meanIc, 12)
    expect(stats.rowsOut).toBe(rows.length)
    expect(stats.droppedSmallGroup).toBe(0)
    expect(stats.medianGroupSize).toBe(rows.length)
  })

  it('【不变量②】每只票自成一个行业时，全部被丢弃（残差恒为 0，不携带信息）', () => {
    const rows = day([
      [0.9, 0.05],
      [0.7, -0.02],
      [0.5, 0.11],
    ])
    const byDate = new Map([[date('2020-01-02'), rows]])
    const { byDate: neutral, stats } = neutralizeByIndustry(byDate, (c) => c, H)
    expect(neutral.size).toBe(0)
    expect(stats.droppedSmallGroup).toBe(rows.length)
    expect(stats.rowsOut).toBe(0)
    // 关键：它不是「IC = 0」而是「没有可用观测」—— icOf 因此给 days = 0
    expect(icOf(neutral, H).days).toBe(0)
  })

  it('拿不到行业的行被丢弃并计数，**不并成一个「其它」组**', () => {
    const rows = day([
      [0.9, 0.05],
      [0.7, -0.02],
      [0.5, 0.11],
      [0.3, -0.07],
    ])
    const byDate = new Map([[date('2020-01-02'), rows]])
    // 前两只有行业、后两只没有
    const { stats } = neutralizeByIndustry(
      byDate,
      (c) => (c === rows[0]?.code || c === rows[1]?.code ? '480000' : null),
      H
    )
    expect(stats.droppedNoIndustry).toBe(2)
    expect(stats.rowsOut).toBe(2)
    // 若把 null 并成一个组，rowsOut 会是 4 —— 那会把两只互不相关的票绑成伪行业
  })

  it('行业按**时点**取：同一只票在不同日期可以属于不同组', () => {
    const rows = day([
      [0.9, 0.05],
      [0.7, -0.02],
    ])
    const byDate = new Map([
      [date('2019-01-02'), rows],
      [date('2022-01-04'), rows],
    ])
    const seen: string[] = []
    neutralizeByIndustry(
      byDate,
      (_c, d) => {
        const ind = d < '2021-07-30' ? '440000' : '480000'
        seen.push(`${d}:${ind}`)
        return ind
      },
      H
    )
    expect(seen).toContain('2019-01-02:440000')
    expect(seen).toContain('2022-01-04:480000')
  })

  it('只算给定持有期上有前瞻收益的行（与 icOf 的 usable 同一口径）', () => {
    const rows: Row[] = [
      { code: code('SH600000'), score: 0.9, fwd: new Map([[10, 0.05]]) },
      { code: code('SH600001'), score: 0.7, fwd: new Map([[10, -0.02]]) },
      // 这一只只有 5 日，不该进 10 日那一臂
      { code: code('SH600002'), score: 0.5, fwd: new Map([[5, 0.11]]) },
    ]
    const byDate = new Map([[date('2020-01-02'), rows]])
    const { stats } = neutralizeByIndustry(byDate, () => '480000', 10)
    expect(stats.rowsIn).toBe(2)
    expect(stats.rowsOut).toBe(2)
  })
})
