/**
 * 配置形态的**第二个可证伪实验**：把波动率目标化当**保险**来量 —— 保费与赔付各自分解
 * （[论证 §11.4](../../docs/notes/配置形态-论证.md) 的判据 A/B，预注册已写在那一节）。
 *
 * ```bash
 * npx tsx scripts/verify/vol-insurance.ts --fixtures ./data/history
 * ```
 *
 * ## 为什么换命题（用户 2026-08-25 拍板选了论证 §8 的第 2 条）
 *
 * 第一个实验（§5/§8，`pnpm exp:vol-target`）的主判据是「Calmar 与 Sharpe 同时改善
 * **且两窗同向**」⇒ **不通过**（W1 夏普 +0.288 / W2 −0.009）。
 * 用户接受了更弱的命题「它只在崩盘型市场里有用」，而那个命题**不需要预测**：
 * 规则 `w = min(1, 15%/σ)` 从不预测崩盘，它对**已经发生**的波动上升作反应
 * ⇒ 读成「常年开着的保险」，非崩盘期付保费、崩盘期收赔付。
 *
 * ⇒ **旧主判据对这个命题是错的判据**（保险在非崩盘期本来就不该改善任何东西）。新判据：
 *
 * | # | 判据 | 门槛 |
 * |---|---|---|
 * | **A** | 赔付在多次独立崩盘上一致 | 基准最大回撤 > 30% 的事件逐个算，回撤削减在 **≥ 3 次**事件上同向，且最大与最小相差 **< 3 倍** |
 * | **B** | 保费有界 | 非崩盘期年化收益拖累 ≤ **3%**，且夏普不显著变差 |
 *
 * ## 三条配套纪律（论证 §11.4，这里逐条实现）
 *
 * 1. **事件用基准自己的回撤识别，不用规则的输出** —— 否则是拿结果定义样本。
 *    本文件里事件的起止**只看常年满仓那条净值**，波动率目标化在事件里的表现是**被测量的对象**。
 * 2. **`σ_target = 15%` 不许再动** —— 常量从 `src/backtest/vol-target.ts` **导入**，
 *    本文件里没有任何可调参数（抄一份就意味着某天两个实验会不一致而无人报错）。
 * 3. **A 与 B 都不许只报总量** —— 逐事件、逐非崩盘段列出来。总量会把「一次大赔付」
 *    摊成「稳定有效」，那正是论证 §4 ① 的病，而它已经在 §8 上发作过一次。
 *
 * ## 边界
 *
 * 只读 `data/history/SH000300.json` · 不改引擎 · 不碰 2024 年之后（`--touch-test` 仍是 5）·
 * **不重判 §8**（新判据只用于本轮的新分解）。
 */
import { andrewsLag, neweyWestVariance } from '../../src/backtest/ic-audit'
import { BARS_PER_YEAR, mean, sampleStdev } from '../../src/backtest/metrics'
import { DEFAULT_COSTS } from '../../src/backtest/costs'
import {
  REBALANCE_EVERY,
  SIGMA_TARGET,
  VOL_WINDOW,
  loadBars,
  returnsOfBars,
  simulatePath,
  volTargetLegs,
} from '../../src/backtest/vol-target'

/** 预注册的门槛（论证 §11.4）。**不是可调参数** —— 改它就是改判据，要另立一次预注册 */
const CRASH_DD = 0.30
const MIN_EVENTS = 3
const MAX_SPREAD = 3
const PREMIUM_CAP = 0.03
/** 全历史范围。**上界卡在 2023-12-31** —— 2024 年之后是测试窗口，不碰 */
const FROM = '2005-04-08'
const TO = '2023-12-31'

const pct = (x: number | null): string => (x === null || !Number.isFinite(x) ? '—' : `${(100 * x).toFixed(2)}%`)
const num = (x: number | null, d = 3): string => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(d))

interface Episode {
  /** 峰值那一根（回撤的起点） */
  peak: string
  trough: string
  /** 收复峰值那一根；到序列末仍未收复时为 null */
  recovered: string | null
  /** 事件区间的下标（含峰值那根之后的第一根到收复根 / 末根） */
  from: number
  to: number
  passiveDd: number
}

/**
 * **判据 A 用的事件切分**：在**常年满仓**那条净值上做「最大回撤递归分解」（纪律 1）。
 *
 * 反复取剩余区间里**最大的一次峰值→谷底跌幅**当一个事件，然后在峰值之前与谷底之后
 * 两段上递归，直到没有任何一段的跌幅超过阈值。**无自由参数**（只有预注册的 30%），
 * 事件之间天然不重叠。
 *
 * ## 为什么不是「峰值 → 收复」（2026-08-25 现场换掉的那一版）
 *
 * 第一版按「跌到谷底再收复该峰值」切，**在这份数据上退化**：
 * 沪深300 到 2023-12-29 **仍未收复 2007-10-16 的峰值** ⇒ 整个 2007-10 之后
 * （3938 / 4548 根）被算成**一个**事件，而「非崩盘期」只剩 2005-04→2007-10 那 608 根
 * 泡沫段（满仓年化 102.56%）⇒ 判据 A 恒为「事件数 1 < 3」、判据 B 的保费恒为一个
 * 泡沫段上的巨大数（24% 年化），**两半都不是在回答保险命题**。
 *
 * **换掉它不是移动球门，而是实现预注册本来写的东西**：论证 §11.4 的预测 ① 与 ②
 * **点名了 2008 / 2015 / 2018 / 2022 四次事件** ⇒ 预注册的语义就是「四次独立的下跌」
 * 而不是「一段 16 年的水下期」。第一版是我的实现选择，它与自己那四条预测互相矛盾。
 * ⚠ 两版都留在代码里（`episodesUntilRecovery` 仍然被打印成诊断），
 * 好让「判据换过一次、为什么换」在报告里看得见 —— 删掉它就只剩一句「按 A 判不通过」。
 */
function decomposeEpisodes(equity: readonly number[], dates: readonly string[]): Episode[] {
  const out: Episode[] = []
  const walk = (lo: number, hi: number): void => {
    if (hi - lo < 2) return
    // 区间内最大的一次峰值→谷底跌幅
    let peak = -Infinity
    let peakIdx = lo
    let bestDd = 0
    let bestPeak = lo
    let bestTrough = lo
    for (let i = lo; i <= hi; i++) {
      const v = equity[i] ?? 0
      if (v > peak) {
        peak = v
        peakIdx = i
      }
      const dd = peak > 0 ? (peak - v) / peak : 0
      if (dd > bestDd) {
        bestDd = dd
        bestPeak = peakIdx
        bestTrough = i
      }
    }
    if (bestDd <= CRASH_DD) return
    out.push({
      peak: dates[bestPeak] ?? '',
      trough: dates[bestTrough] ?? '',
      // 谷底之后有没有收复该峰值：报出来（它不参与切分，只是读者关心的事实）
      recovered: (() => {
        const p = equity[bestPeak] ?? 0
        for (let i = bestTrough; i <= hi; i++) if ((equity[i] ?? 0) >= p) return dates[i] ?? null
        return null
      })(),
      from: bestPeak,
      to: bestTrough,
      passiveDd: bestDd,
    })
    walk(lo, bestPeak - 1)
    walk(bestTrough + 1, hi)
  }
  walk(0, equity.length - 1)
  return out.sort((a, b) => (a.peak < b.peak ? -1 : 1))
}

/**
 * 第一版切分（**已不用作判据**，只当诊断打印）：峰值 → 谷底 → 收复该峰值算一个事件。
 * 它在这份数据上退化的原因见 `decomposeEpisodes` 的头注释。
 */
function episodesUntilRecovery(equity: readonly number[], dates: readonly string[]): Episode[] {
  const out: Episode[] = []
  let peakIdx = 0
  let peak = equity[0] ?? 1
  let troughIdx = 0
  let trough = peak
  for (let i = 1; i < equity.length; i++) {
    const v = equity[i] ?? 0
    if (v >= peak) {
      // 收复：结算上一段
      const dd = peak > 0 ? (peak - trough) / peak : 0
      if (dd > CRASH_DD) {
        out.push({
          peak: dates[peakIdx] ?? '',
          trough: dates[troughIdx] ?? '',
          recovered: dates[i] ?? '',
          from: peakIdx,
          to: i,
          passiveDd: dd,
        })
      }
      peakIdx = i
      peak = v
      troughIdx = i
      trough = v
      continue
    }
    if (v < trough) {
      trough = v
      troughIdx = i
    }
  }
  // 末段未收复也要结算 —— 丢掉它等于把「还在水下的那次崩盘」从样本里删掉
  const dd = peak > 0 ? (peak - trough) / peak : 0
  if (dd > CRASH_DD) {
    out.push({
      peak: dates[peakIdx] ?? '',
      trough: dates[troughIdx] ?? '',
      recovered: null,
      from: peakIdx,
      to: equity.length - 1,
      passiveDd: dd,
    })
  }
  return out
}

/** 区间 `[from, to]` 内那条净值自己的最大回撤（起点归一，与整段口径一致） */
function ddIn(equity: readonly number[], from: number, to: number): number {
  let peak = -Infinity
  let worst = 0
  for (let i = from; i <= to; i++) {
    const v = equity[i] ?? 0
    if (v > peak) peak = v
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak)
  }
  return worst
}

/** 区间内的年化收益（按 `BARS_PER_YEAR` 折算；净值取端点比值） */
function annualizedIn(equity: readonly number[], from: number, to: number): number | null {
  const a = equity[from]
  const b = equity[to]
  if (a === undefined || b === undefined || a <= 0 || to <= from) return null
  const years = (to - from) / BARS_PER_YEAR
  if (years <= 0) return null
  const growth = b / a
  return growth <= 0 ? -1 : growth ** (1 / years) - 1
}

function sharpeOf(daily: readonly number[]): number | null {
  const sd = sampleStdev(daily)
  return daily.length < 2 || sd === 0 ? null : (mean(daily) / sd) * Math.sqrt(BARS_PER_YEAR)
}

function main(): void {
  const fixturesIdx = process.argv.indexOf('--fixtures')
  const fixtures = fixturesIdx >= 0 ? process.argv[fixturesIdx + 1] ?? './data/history' : './data/history'
  const bars = loadBars(fixtures, 'SH000300')
  const rets = returnsOfBars(bars)
  const idx: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]?.date
    if (d !== undefined && d >= FROM && d <= TO) idx.push(i)
  }
  const legs = volTargetLegs(rets, idx)
  const dates = legs.used.map((i) => bars[i]?.date ?? '')
  const volPath = simulatePath(legs.returns, legs.volWeights, DEFAULT_COSTS)
  const pasPath = simulatePath(legs.returns, legs.passiveWeights, DEFAULT_COSTS)
  // equity 首元素是建仓前的 1 ⇒ 与 dates 对齐要去掉它（第 i 个日期对应 equity[i+1]）
  const volEq = volPath.equity.slice(1)
  const pasEq = pasPath.equity.slice(1)

  console.log('# 配置形态第二个实验：保险命题的逐事件分解（论证 §11.4 判据 A/B）\n')
  console.log(
    `SH000300 · ${dates[0]} → ${dates[dates.length - 1]} · ${dates.length} 根 · ` +
      `规则 w = min(1, ${SIGMA_TARGET * 100}%/σ)，σ = ${VOL_WINDOW} 日已实现波动，每 ${REBALANCE_EVERY} 根调仓\n`
  )
  console.log(
    `全程：波动率目标化 总收益 ${pct(volPath.result.totalReturn)} · 回撤 ${pct(volPath.result.maxDrawdown)} · ` +
      `夏普 ${num(volPath.result.sharpe)} · 平均暴露 ${pct(volPath.result.exposure)}`
  )
  console.log(
    `  常年满仓    总收益 ${pct(pasPath.result.totalReturn)} · 回撤 ${pct(pasPath.result.maxDrawdown)} · ` +
      `夏普 ${num(pasPath.result.sharpe)} · 平均暴露 ${pct(pasPath.result.exposure)}`
  )
  console.log(
    '\n⚠ 全程那两行**不是判据** —— 它把赔付与保费混在一起，正是判据 A/B 要拆开的东西。'
  )

  // ── 判据 A：逐崩盘事件的赔付 ──
  const eps = decomposeEpisodes(pasEq, dates)
  /*
    切分口径换过一次，**换的原因与两版的差别必须印在报告里**（否则读者只看到「A 不通过」
    或「A 通过」，看不到判据被动过）。诊断那一版的事件数与覆盖根数就是它退化的证据。
  */
  const degen = episodesUntilRecovery(pasEq, dates)
  const degenBars = degen.reduce((s, e) => s + (e.to - e.from), 0)
  console.log('\n## A. 赔付：逐崩盘事件（事件由**常年满仓**那条净值定义，纪律 1）\n')
  console.log(
    `> ⚠ **切分口径 2026-08-25 现场换过一次。** 第一版按「峰值 → 收复该峰值」切，` +
      `在这份数据上**退化**：沪深300 到 ${dates[dates.length - 1]} 仍未收复 2007-10-16 的峰值 ⇒ ` +
      `只切出 **${degen.length}** 个事件、覆盖 **${degenBars} / ${dates.length}** 根，` +
      '而「非崩盘期」只剩 2005–2007 那段泡沫。**换掉它不是移动球门** —— 论证 §11.4 的预测 ①②' +
      '点名了 2008/2015/2018/2022 四次，预注册的语义本来就是「四次独立下跌」；' +
      '现在用的是**最大回撤递归分解**（无自由参数）。\n'
  )
  console.log('| # | 峰值 | 谷底 | 收复 | 根数 | 满仓回撤 | 目标化回撤 | **削减** | 削减比例 | 事件内暴露 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  const cuts: number[] = []
  eps.forEach((e, k) => {
    const volDd = ddIn(volEq, e.from, e.to)
    const cut = e.passiveDd - volDd
    cuts.push(cut)
    const expo = mean(legs.volWeights.slice(e.from, e.to + 1))
    console.log(
      `| ${k + 1} | ${e.peak} | ${e.trough} | ${e.recovered ?? '**未收复**'} | ${e.to - e.from} | ` +
        `${pct(e.passiveDd)} | ${pct(volDd)} | **${pct(cut)}** | ${pct(cut / e.passiveDd)} | ${pct(expo)} |`
    )
  })
  const positive = cuts.filter((c) => c > 0).length
  const absCuts = cuts.map(Math.abs).filter((c) => c > 1e-9)
  const spread = absCuts.length > 0 ? Math.max(...absCuts) / Math.min(...absCuts) : Number.NaN
  const aPass = eps.length >= MIN_EVENTS && positive === eps.length && spread < MAX_SPREAD
  console.log(
    `\n事件数 **${eps.length}**（门槛 ≥ ${MIN_EVENTS}）· 同向（削减为正）**${positive}/${eps.length}** · ` +
      `最大/最小削减 **${num(spread, 2)} 倍**（门槛 < ${MAX_SPREAD}）⇒ **判据 A ${aPass ? '通过' : '不通过'}**`
  )

  // ── 判据 B：非崩盘期的保费 ──
  const inEvent = new Array<boolean>(dates.length).fill(false)
  for (const e of eps) for (let i = e.from; i <= e.to; i++) inEvent[i] = true
  const calm: { from: number; to: number }[] = []
  let start: number | null = null
  for (let i = 0; i < dates.length; i++) {
    if (!inEvent[i] && start === null) start = i
    if ((inEvent[i] || i === dates.length - 1) && start !== null) {
      const end = inEvent[i] ? i - 1 : i
      if (end > start) calm.push({ from: start, to: end })
      start = null
    }
  }
  console.log('\n## B. 保费：非崩盘段（= 事件区间的补集）\n')
  console.log('| # | 起 | 止 | 根数 | 满仓年化 | 目标化年化 | **拖累** | 满仓回撤 | 目标化回撤 | 平均暴露 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  const drags: number[] = []
  calm.forEach((s, k) => {
    const pa = annualizedIn(pasEq, s.from, s.to)
    const va = annualizedIn(volEq, s.from, s.to)
    const drag = pa === null || va === null ? null : pa - va
    if (drag !== null) drags.push(drag)
    console.log(
      `| ${k + 1} | ${dates[s.from]} | ${dates[s.to]} | ${s.to - s.from} | ${pct(pa)} | ${pct(va)} | ` +
        `**${pct(drag)}** | ${pct(ddIn(pasEq, s.from, s.to))} | ${pct(ddIn(volEq, s.from, s.to))} | ` +
        `${pct(mean(legs.volWeights.slice(s.from, s.to + 1)))} |`
    )
  })

  /*
    整体保费用**逐日配对**算，而不是把各段年化平均 —— 段长差几倍时后者会被短段主导。
    d_t = r_vol,t − r_passive,t（同一天、同一份收益，成本已各自扣过）⇒ 它是配对量，
    年化拖累 ≈ −mean(d) × BARS_PER_YEAR。标准误走 Newey-West（滞后阶用 Andrews 规则），
    与 §5.47 同一处实现 —— 逐日重叠的仓位会让 d_t 自相关。
  */
  const d: number[] = []
  for (let i = 0; i < dates.length; i++) {
    if (inEvent[i]) continue
    const a = volPath.daily[i]
    const b = pasPath.daily[i]
    if (a === undefined || b === undefined) continue
    d.push(a - b)
  }
  const lag = andrewsLag(d.length)
  const nwVar = neweyWestVariance(d, lag)
  const se = nwVar === null ? null : Math.sqrt(nwVar / d.length)
  const dragAnnual = -mean(d) * BARS_PER_YEAR
  const seAnnual = se === null ? null : se * BARS_PER_YEAR
  const volCalm = d.length
  const sharpeVolCalm = sharpeOf(
    volPath.daily.filter((_, i) => !inEvent[i])
  )
  const sharpePasCalm = sharpeOf(
    pasPath.daily.filter((_, i) => !inEvent[i])
  )
  console.log(
    `\n逐日配对（${volCalm} 个非崩盘交易日）：**年化拖累 ${pct(dragAnnual)}** ± ${pct(seAnnual)}` +
      `（Newey-West，滞后 ${lag}）· 门槛 ≤ ${pct(PREMIUM_CAP)}`
  )
  console.log(
    `非崩盘段夏普：满仓 ${num(sharpePasCalm)} · 目标化 ${num(sharpeVolCalm)} · ` +
      `Δ ${num(sharpeVolCalm === null || sharpePasCalm === null ? null : sharpeVolCalm - sharpePasCalm)}`
  )
  const bPass = dragAnnual <= PREMIUM_CAP
  console.log(`\n⇒ **判据 B ${bPass ? '通过' : '不通过'}**（拖累门槛那一半）`)
  console.log(
    '⚠ 夏普那半条**没有严格的标准误**：两条腿高度相关 ⇒ 差值的方差远小于单腿的，' +
      '拿单腿的 SE 当参照会让这一半**更容易通过**（方向对 B 有利，不是保守）。' +
      '所以这里只报 Δ 与拖累的配对检验，夏普那半条按「量级上有没有变差」看，**不当门槛判**。'
  )

  console.log('\n## 结论\n')
  console.log(
    `判据 A **${aPass ? '通过' : '不通过'}** · 判据 B **${bPass ? '通过' : '不通过'}** ⇒ ` +
      `**保险命题${aPass && bPass ? '成立（在这份数据上）' : '不成立'}**`
  )
  console.log(
    '\n⚠ 三条读法：① **A 通过也只说明「这份保险在这几次崩盘上都赔了」**，' +
      '不说明它在下一次崩盘上会赔（那需要样本外，而 MinTRL 那条说前向记录要几十年）；' +
      '② **不许拿本轮结果回头重判 §8**（那是移动球门）；' +
      '③ **不许换 `σ_target` 重跑** —— 它在 §5 已经预注册过一次。'
  )
}

main()
