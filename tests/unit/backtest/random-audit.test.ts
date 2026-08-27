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
import {
  findBases,
  nearestInPool,
  regimeRuns,
  renderText,
  type RegimeRun,
} from '@backtest/random-audit'
import { andrewsLag, correlation, neweyWestVariance, ranksOf } from '@backtest/ic-audit'

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
    const byRun = findBases([0, 1], [0, 3], [fullPool(), fullPool()], runs, source)
    // **按段分组**返回（§5.43）：这里只有一个合法段
    expect(byRun).toEqual([[20, 21, 22, 23, 24, 25, 26]])
  })

  /**
   * 分组本身就是 §5.43 那个抽样权重的全部依据：按段均匀 = 先在这个数组里选一项，
   * 按位置均匀 = 先 flat() 再选。两段长度悬殊时两者的差别最大，所以这条用例造一长一短。
   */
  it('落点按段分组返回 —— 长段与短段各占一项（抽样权重据此分档）', () => {
    const twoRuns: RegimeRun[] = [
      { start: 0, end: 4, regime: 'RANGE' },
      { start: 5, end: 6, regime: 'RANGE' }, // 短段：2 根
      { start: 7, end: 20, regime: 'RANGE' }, // 长段：14 根
    ]
    const pool = new Set([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    const byRun = findBases([0], [0], [pool], twoRuns, twoRuns[0] as RegimeRun)
    expect(byRun).toHaveLength(2)
    expect(byRun[0]).toHaveLength(2)
    expect(byRun[1]).toHaveLength(14)
    // 按段均匀：两段各 50% —— 按位置均匀：短段只有 2/16 = 12.5%
    expect(byRun.flat()).toHaveLength(16)
  })

  it('**任一**成员落到自己 pool 外就不是合法落点（regime 与边界约束一条都没松）', () => {
    // 第二个成员的池挖掉 24 ⇒ 首成员放 21 会让它落在 24 上 ⇒ 21 必须被排除
    const holed = fullPool()
    holed.delete(24)
    const bases = findBases([0, 1], [0, 3], [fullPool(), holed], runs, source).flat()
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

/**
 * rank IC 的两个纯函数（M2 §5.46）。守的是**并列**那一步 ——
 * 实测 70.1% 的判定根买入得分为 0，Spearman 若不按平均秩处理并列，IC 就是垃圾。
 */
describe('rank IC：平均秩与相关系数', () => {
  it('并列取平均秩（不是先到先得）', () => {
    // [5, 5, 9] ⇒ 前两个并列，秩 (0+1)/2 = 0.5，第三个是 2
    expect(ranksOf([5, 5, 9])).toEqual([0.5, 0.5, 2])
    expect(ranksOf([9, 5, 5])).toEqual([2, 0.5, 0.5])
    // 全并列 ⇒ 全部同一个秩 ⇒ 下游相关系数会因零方差给 null
    expect(ranksOf([3, 3, 3])).toEqual([1, 1, 1])
  })

  it('相关系数：完全同序 +1、完全反序 −1、零方差给 null（不是 0）', () => {
    expect(correlation([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 10)
    expect(correlation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10)
    // 一侧全并列 ⇒ 无定义。给 0 会被读成「无关」，而事实是「算不出」
    expect(correlation([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull()
    expect(correlation([1, 2], [2, 1])).toBeNull()
  })
})

/**
 * Newey-West 长期方差（M2 §5.47）。IC 的前瞻收益是**重叠**的（每天都算一次 h 日收益）
 * ⇒ IC 序列在结构上带 MA(h−1) ⇒ 朴素 `sd/√T` 把交易日当独立样本，t 值虚高。
 *
 * 这几条钉的是**数学本身**，用手算得出来的例子 —— 这个函数错了不会报错，
 * 只会给出一个「看起来很专业」的 t 值，而它是这一节唯一的产出。
 */
describe('Newey-West 长期方差', () => {
  it('L = 0 时退化成 γ₀/T（即除 T 的方差，不是除 T−1）', () => {
    const s = [1, 2, 3, 4, 5]
    // mean 3；偏差 −2,−1,0,1,2；γ₀ = (4+1+0+1+4)/5 = 2 ⇒ Var(x̄) = 2/5
    expect(neweyWestVariance(s, 0)).toBeCloseTo(2 / 5, 12)
  })

  it('正自相关会把方差放大 ⇒ t 变小（这就是这次调整的全部意义）', () => {
    // 交替成块的正自相关序列
    const s = [1, 1, 1, -1, -1, -1, 1, 1, 1, -1, -1, -1]
    const naive = neweyWestVariance(s, 0)
    const adjusted = neweyWestVariance(s, 2)
    expect(naive).not.toBeNull()
    expect(adjusted).not.toBeNull()
    expect(adjusted as number).toBeGreaterThan(naive as number)
  })

  it('负自相关会把方差缩小 —— 调整不是单向变保守', () => {
    const s = [1, -1, 1, -1, 1, -1, 1, -1]
    const naive = neweyWestVariance(s, 0) as number
    const adjusted = neweyWestVariance(s, 1) as number
    expect(adjusted).toBeLessThan(naive)
  })

  it('Bartlett 权重保证非负；全常量序列给 null 而不是 0', () => {
    // 零方差 ⇒ 算不出，不许用 0 冒充（约束 4 的精神）
    expect(neweyWestVariance([2, 2, 2, 2], 2)).toBeNull()
    expect(neweyWestVariance([1], 0)).toBeNull()
    // L 超过序列长度时夹住，不越界读出 undefined
    expect(neweyWestVariance([1, 2, 3], 99)).not.toBeNull()
  })

  it('Andrews(1991) 的滞后阶 ⌊4(T/100)^(2/9)⌋', () => {
    // T=1140 ⇒ 4×11.4^(2/9) ≈ 6.87 ⇒ 6；T=354 ⇒ ≈5.30 ⇒ 5
    expect(andrewsLag(1140)).toBe(6)
    expect(andrewsLag(354)).toBe(5)
    expect(andrewsLag(100)).toBe(4)
    expect(andrewsLag(1)).toBe(0)
  })

  /*
    顺序敏感性：这是加 NW 之前**隐性**的坑。`byDate` 的插入顺序由扫描顺序决定，
    一只起始更早的票会把早期日子追加到尾部；IC 均值与五等分不受影响，
    所以在加 NW 之前没有任何症状。打乱之后自协方差结构没了 ⇒ 数不一样。
  */
  it('对顺序敏感 —— 所以 icOf 必须先按日期排序', () => {
    const ordered = [1, 1, 1, -1, -1, -1, 1, 1, 1, -1, -1, -1]
    const shuffled = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1]
    expect(neweyWestVariance(ordered, 2)).not.toBeCloseTo(neweyWestVariance(shuffled, 2) as number, 6)
  })
})

/**
 * 打散跨度那张表的**读数闸门**（M2 §5.74）。
 *
 * **为什么要钉文案**：`pairedMedianWinFraction ≈ Φ(μ/σ_D)` 是效应量的**饱和变换** ——
 * 灵敏度在 50% 处最大、往两端塌缩，而 `σ_D ∝ 1/√n` ⇒ **层越大胜率越极端**。
 * 实测 33 层里按胜率排 vs 按 `μ` 排 Spearman 只有 **0.865**，最大错位 **11 位**。
 *
 * 这个坑的形状是：**它不会报错，只会让人把放大器读成分辨力**
 * —— §5.73 ④ 就这么读错过一次（把 RANGE 的 13.1pp 当成「分辨力集中在 RANGE」，
 * 而它底层的 `μ` 比 TRANSITION 小 2.7 倍）。
 * ⇒ 唯一有效的防线是**把 `μ` 印出来、把纪律印在表下面**，而这条用例钉住它们还在。
 */
describe('打散跨度表：效应量列与饱和纪律', () => {
  /*
    最小 payload。**刻意用 cast 而不是把 40 个字段全填一遍** —— 这条用例断言的是
    渲染出来的**文本**，不是 payload 的形状；日后 renderText 多读一个字段时它会
    在运行时大声炸掉，那是可接受的失败方式（不是静默通过）。
  */
  const payload = {
    meta: {
      baseline: 'reports/calib/x.json',
      engineVersion: '0.2.8-test',
      paramsFingerprint: 'deadbeef',
      codes: 2,
      from: '2018-01-01',
      to: '2023-12-31',
      capitalPerCode: 100000,
      costs: null,
      knobs: { deviations: [], unverifiable: [] },
      trials: 200,
      seed: 1,
      matchRegime: true,
      crossCode: false,
      crossPool: null,
      timingNull: 'REGIME_BLOCK',
      timingNullReason: '测试',
      blocks: 10,
      blockFallback: 0,
      blockWeight: 'runs',
      blockCoverage: 1,
      blockCoverageByRegime: null,
      snapMedian: 0,
      snapP90: 0,
      capCovered: null,
      warmup: 300,
      minCount: 30,
      positionsTotal: 100,
      positionsPaired: 100,
      skipped: 0,
      regimeSelfCheck: null,
    },
    strata: [
      {
        label: 'RANGE',
        realCount: 639,
        realWeightedPnlPct: 0,
        realWinRate: 0.5,
        realNetPnl: 0,
        passiveCount: 639,
        passiveWeightedPnlPct: 0,
        passiveWinRate: 0.5,
        passivePercentile: 0.5,
        passiveMedianPnlPct: 0,
        randomMedianMean: -0.004,
        passiveMedianPercentile: 0.5,
        shuffled: {
          passiveWeightedMean: 0,
          randomWeightedMean: 0,
          // μ = 0.0125 − (−0.004) = 0.0165 ⇒ 表里应出现 1.65%
          passiveMedianMean: 0.0125,
          randomMedianMean: -0.004,
          pairedWinFraction: 0.5,
          pairedMedianWinFraction: 0.514,
        },
        randomWeightedMean: 0,
        randomWeightedSd: 0,
        randomWeightedP05: 0,
        randomWeightedP50: 0,
        randomWeightedP95: 0,
        realPercentile: 0.5,
        randomWinRateMean: 0.5,
        randomWinRateP05: 0.4,
        randomWinRateP95: 0.6,
        realWinRatePercentile: 0.5,
        randomSampleMean: 0,
      },
    ],
  } as unknown as Parameters<typeof renderText>[0]

  const text = renderText(payload)

  it('表头有**效应量 μ** 那一列', () => {
    expect(text).toContain('**效应量 μ**')
  })

  it('μ 真的被算出来并印在表里（真实中位 − 随机中位）', () => {
    // 0.0125 − (−0.004) = 0.0165 ⇒ pct() 给 "1.65%"
    expect(text).toContain('1.65%')
  })

  it('饱和纪律印在表下面：跨层比胜率的差无效', () => {
    expect(text).toContain('跨层比它的差无效')
    expect(text).toContain('Φ(μ/σ_D)')
  })

  it('样本量那一半也印了：层越大胜率越极端', () => {
    expect(text).toContain('层越大胜率越极端')
    expect(text).toContain('0.865')
  })

  it('**同时**印了「不受影响的用法」—— 否则会被读成「配对胜率作废」', () => {
    expect(text).toContain('不受影响的用法')
    expect(text).toContain('L2 条件①')
  })
})
