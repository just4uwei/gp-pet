/**
 * 择时零分布的**块位移**（迭代计划 §4.6，2026-08-19）。
 *
 * 旧口径给每一次真实建仓独立抽一个随机日，而真实建仓**不是独立发生的** ——
 * 引擎在同一段行情里成批出手。独立抽日把这种聚集打散 ⇒ 零分布方差偏小 ⇒ 分位偏向显著。
 * 修法是按建仓月整块位移，块内共用一个 δ，各成员再**吸附**到自己 `pool` 里最近的合法日。
 *
 * 下面守的是吸附那一步：它是整个修法里唯一有方向性风险的地方 ——
 * 吸附若偏向某一侧，就等于给零分布加了偏置，而零分布的中立性是这个工具全部可信度的来源。
 */

import { describe, expect, it } from 'vitest'
import { findBases, nearestInPool, regimeRuns, type RegimeRun } from '@backtest/random-audit'

describe('块位移的吸附：nearestInPool', () => {
  it('目标就在池里时原样返回', () => {
    expect(nearestInPool([10, 20, 30, 40], 30, -1)).toBe(30)
  })

  it('目标不在池里时取**值**上最近的那个', () => {
    expect(nearestInPool([10, 20, 30, 40], 27, -1)).toBe(30)
    expect(nearestInPool([10, 20, 30, 40], 23, -1)).toBe(20)
  })

  it('目标落在池两端之外时夹到端点', () => {
    expect(nearestInPool([10, 20, 30], 5, -1)).toBe(10)
    expect(nearestInPool([10, 20, 30], 99, -1)).toBe(30)
  })

  /**
   * **这条是第一版实现的回归**。第一版从二分落点按**池下标**交替外扩：
   * 下标 ±1 在稀疏池上对应的真实距离可以差几十倍，于是它会稳定地挑错一侧。
   * 这里左边一格跳 40、右边一格跳 1，按下标外扩会先看左边、返回 60；
   * 按值比才返回 101。零分布因此不带方向偏置。
   */
  it('稀疏且不等距的池：按值比而不是按下标外扩（否则零分布带方向偏置）', () => {
    expect(nearestInPool([20, 60, 101, 400], 100, -1)).toBe(101)
    expect(nearestInPool([20, 60, 61, 400], 100, -1)).toBe(61)
  })

  /**
   * `exclude` 是真实成交那一根。留着它，那次抽样就退化成「真实入场」本身，
   * 会把分位往 50% 拽 —— 与「δ = 0 要从候选里删掉」是同一条理由。
   */
  it('排除真实入场那一根，取次近的', () => {
    // 次近无歧义：21 离 20 更近
    expect(nearestInPool([10, 20, 21, 30], 20, 20)).toBe(21)
    // 两侧等距时排除中间那个 ⇒ 仍要给出一个合法结果，不许返回 exclude
    expect(nearestInPool([18, 20, 22], 20, 20)).not.toBe(20)
  })

  /**
   * 等距平局固定偏向一侧，累积起来就是零分布的一个系统性时间偏移。
   * 按 `target` 奇偶分是确定性的（可复现，与 `--seed` 那条纪律一致）且两侧各占一半。
   */
  it('等距平局按 target 奇偶分两侧，不固定偏向一边', () => {
    expect(nearestInPool([10, 30], 20, -1)).toBe(30) // 20 是偶数 ⇒ 先看右
    expect(nearestInPool([10, 32], 21, -1)).toBe(10) // 21 是奇数 ⇒ 先看左（|10−21| = 11 = |32−21|）
  })

  it('池里只有 exclude 一个元素 ⇒ null（调用方据此退回独立抽样，不许静默用 exclude）', () => {
    expect(nearestInPool([20], 20, 20)).toBeNull()
    expect(nearestInPool([], 20, -1)).toBeNull()
  })
})

/**
 * regime 段块（M2 §5.42，2026-08-19）—— **同 regime 口径的第二版修法**。
 *
 * 第一版（建仓月 + 吸附）在这一档失败了：候选池只含同状态的天、稀疏，共用位移要靠吸附
 * 落地（实测中位 11 / P90 116 根），而吸附方向依赖该状态在这只票上的分布 ⇒ 按分层引入偏置。
 * 第二版换块的定义：块 = **(标的, 一段连续同状态行情)**，整段刚性平移到**同状态的另一段**。
 *
 * 下面守的是这一版的两条结构性质 —— 它们是「吸附恒 0」的全部依据：
 * ① 段的切法与判定根的错位（`regimeAt(i) = seq[i-1]`）；
 * ② 落点必须让**每个**成员都落在自己的 `pool` 里，否则不算合法落点。
 */
describe('regime 段块：regimeRuns', () => {
  it('切成极大同状态段，且下标按「成交根 = 判定根 + 1」错一位', () => {
    // 判定序列下标 0,1 是 RANGE ⇒ 成交下标 1,2；下标 2,3,4 是 TREND_UP ⇒ 成交下标 3,4,5
    const runs = regimeRuns(['RANGE', 'RANGE', 'TREND_UP', 'TREND_UP', 'TREND_UP'])
    expect(runs).toEqual([
      { start: 1, end: 2, regime: 'RANGE' },
      { start: 3, end: 5, regime: 'TREND_UP' },
    ])
  })

  it('同一个状态被别的状态隔开时算两段（这正是「另一段」的来源）', () => {
    const runs = regimeRuns(['RANGE', 'TREND_UP', 'RANGE'])
    expect(runs.map((r) => r.regime)).toEqual(['RANGE', 'TREND_UP', 'RANGE'])
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  it('空序列不抛错', () => {
    expect(regimeRuns([])).toEqual([])
  })
})

describe('regime 段块：findBases', () => {
  const runs: RegimeRun[] = [
    { start: 0, end: 9, regime: 'RANGE' },
    { start: 10, end: 19, regime: 'TREND_UP' },
    { start: 20, end: 29, regime: 'RANGE' },
  ]
  const source = runs[0] as RegimeRun
  /** 池 = 目标段那 10 根全合法 */
  const fullPool = () => new Set([20, 21, 22, 23, 24, 25, 26, 27, 28, 29])

  it('整段刚性平移：块内间距逐位保留，落点只在同状态的另一段里', () => {
    // 两次建仓相距 3 根 ⇒ 首成员能放在 20..26（26+3 = 29 是段尾）
    const bases = findBases([0, 1], [0, 3], [fullPool(), fullPool()], runs, source)
    expect(bases).toEqual([20, 21, 22, 23, 24, 25, 26])
  })

  it('**任一**成员落到自己 pool 外就不是合法落点（regime 与边界约束一条都没松）', () => {
    // 第二个成员的池挖掉 24 ⇒ 首成员放 21 会让它落在 24 上 ⇒ 21 必须被排除
    const holed = fullPool()
    holed.delete(24)
    const bases = findBases([0, 1], [0, 3], [fullPool(), holed], runs, source)
    expect(bases).not.toContain(21)
    expect(bases).toContain(20)
  })

  it('不同状态的段与源段本身都不是候选（源段本身会把样本落回真实入场附近）', () => {
    // 只有 TREND_UP 段的下标进池 ⇒ 一个合法落点都没有（状态不匹配）
    const trendOnly = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    expect(findBases([0], [0], [trendOnly], runs, source)).toEqual([])
    // 池里只有源段自己的下标 ⇒ 同样没有落点
    const sourceOnly = new Set([0, 1, 2, 3, 4])
    expect(findBases([0], [0], [sourceOnly], runs, source)).toEqual([])
  })

  it('目标段短于块的跨度时放不进去 ⇒ 该块无落点（会被记进 blockFallback）', () => {
    const shortRuns: RegimeRun[] = [
      { start: 0, end: 9, regime: 'RANGE' },
      { start: 10, end: 12, regime: 'RANGE' },
    ]
    const pool = new Set([10, 11, 12])
    // 块跨度 5 根，目标段只有 3 根
    expect(findBases([0, 1], [0, 5], [pool, pool], shortRuns, shortRuns[0] as RegimeRun)).toEqual([])
  })
})
