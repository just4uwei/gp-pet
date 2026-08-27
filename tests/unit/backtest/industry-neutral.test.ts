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
  neutralizeByRegression,
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

/**
 * 秩上的横截面回归（`neutralizeByRegression`，预注册 M2 §5.70）。
 *
 * **手写 OLS 是这一族里风险最高的一块** —— 解错了不报错，只会给出一个别的数，
 * 而我们要拿它与原始 IC 并排比。所以这里钉的是四条能把实现判死的恒等式，
 * 其中一条**拿已经通过测试的分组去均值做交叉验证**。
 */
describe('neutralizeByRegression', () => {
  const rows12 = day([
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
  const one = new Map([[date('2020-01-02'), rows12]])

  it('【不变量①】只有截距（控制变量为空）时，IC 逐位等于原始 IC', () => {
    // 只减去全横截面均值 ⇒ 不改变秩 ⇒ Spearman 不变
    const raw = icOf(one, H)
    const { byDate, stats } = neutralizeByRegression(one, [], H)
    expect(icOf(byDate, H).meanIc).toBeCloseTo(raw.meanIc, 12)
    expect(stats.medianColumns).toBe(1) // 只有截距
    expect(stats.droppedMissing).toBe(0)
  })

  it('【不变量②】单一类别的哑变量等价于只有截距 ⇒ 仍等于原始 IC', () => {
    const raw = icOf(one, H)
    const { byDate, stats } = neutralizeByRegression(
      one,
      [{ kind: 'categorical', name: 'ind', groupOf: () => '480000' }],
      H
    )
    expect(icOf(byDate, H).meanIc).toBeCloseTo(raw.meanIc, 12)
    // 只有一个类别 ⇒ 丢掉参照后没有哑变量列 ⇒ 仍是 1 列
    expect(stats.medianColumns).toBe(1)
  })

  it('【不变量③·交叉验证】两个类别的哑变量回归 = 分组去均值（两套实现必须给同一个数）', () => {
    const groupOf = (c: SecCode): string =>
      rows12.slice(0, 6).some((r) => r.code === c) ? 'A' : 'B'
    const viaGroups = neutralizeByIndustry(one, groupOf, H, 1)
    const viaOls = neutralizeByRegression(
      one,
      [{ kind: 'categorical', name: 'g', groupOf }],
      H
    )
    const a = icOf(viaGroups.byDate, H)
    const b = icOf(viaOls.byDate, H)
    expect(a.days).toBe(1)
    expect(b.days).toBe(1)
    // 这一条是整块 OLS 的正确性证明：它必须复现一条独立实现的结果
    expect(b.meanIc).toBeCloseTo(a.meanIc, 10)
  })

  it('【不变量④】拿得分自己当控制变量 ⇒ 残差全为 0 ⇒ 没有可用横截面，不是「IC = 0」', () => {
    const { byDate } = neutralizeByRegression(
      one,
      [
        {
          kind: 'continuous',
          name: 'self',
          valueOf: (c) => rows12.find((r) => r.code === c)?.score ?? null,
        },
      ],
      H
    )
    // 得分的秩被自己完全解释 ⇒ 残差恒 0 ⇒ correlation 返回 null ⇒ 不计入
    expect(icOf(byDate, H).days).toBe(0)
  })

  it('共线的重复列被丢弃并计数，不是硬解出一个爆炸的系数', () => {
    const valueOf = (c: SecCode): number =>
      rows12.findIndex((r) => r.code === c)
    const { stats } = neutralizeByRegression(
      one,
      [
        { kind: 'continuous', name: 'x', valueOf },
        { kind: 'continuous', name: 'x-again', valueOf },
      ],
      H
    )
    expect(stats.droppedColumns).toBeGreaterThan(0)
    expect(stats.medianColumns).toBe(2) // 截距 + 一份 x
  })

  it('控制变量缺数的行整行丢弃并计数（约束 4：不许拿 0 冒充）', () => {
    const { stats } = neutralizeByRegression(
      one,
      [
        {
          kind: 'continuous',
          name: 'cap',
          valueOf: (c) => (c === rows12[0]?.code ? null : 1),
        },
      ],
      H
    )
    expect(stats.droppedMissing).toBe(1)
    expect(stats.rowsIn).toBe(rows12.length)
    expect(stats.rowsOut).toBe(rows12.length - 1)
  })
})
