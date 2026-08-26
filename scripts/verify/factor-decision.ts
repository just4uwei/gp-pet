/**
 * **`B/P` Phase 0′：逐次决策口径** —— 「你手上有 64 只票，某一天要挑一只买」。
 * 预注册见 [M2 §5.64](../../docs/notes/M2-偏差报告.md)。
 *
 * ```bash
 * npx tsx scripts/verify/factor-decision.ts --fixtures ./data/history --financials ./data/financials
 * ```
 *
 * ## 它与 `factor-width.ts` 问的不是同一件事
 *
 * `factor-width.ts`（§5.63）测的是**估计稳定性**：换一批票，**六年平均** IC 还正不正。
 * 它答不了产品真正要问的那个 —— **某一天排个序然后动手，管不管用**。
 * 两者差着 **1457 天的平均**：窗口平均把日间噪音按 `√T` 压掉了，
 * 所以它稳，**不代表每次决策都对**。
 *
 * ⚠ **§5.63 那个 41.8%（逐日 IC 为负的比例）不许读成「四成决策是错的」**：
 * 一个 IC 均值 +5% 的因子在日频上有四成日子方向为负是**正常的**。
 * 真正要问的是**把那个分布落到一次决策上还剩多少优势**，那就是这个脚本。
 *
 * ## 三条口径
 *
 * 1. **配对**：处理组与对照组取的是**同一池、同一日** —— 市场共同项在配对里被消掉，
 *    这也是 `audit:random` 那一整套存在的理由。
 * 2. **胜率报加权与中位两个视角**：胜率本身是个比例（无所谓口径），但**收益差**必须
 *    中位与均值并排（读数纪律 2：少数大赢家能托起均值）。
 * 3. **分四个时间段各报一次** —— 样本期依赖是这个项目最贵的那个弱点
 *    （配置形态论证 §4 ①：W1 好看 / W2 归零）。
 *
 * ## 边界
 *
 * 只读 · 不改引擎 · 不碰测试窗口 · **通过也只意味着可以去做 Phase A**。
 * **不许拿本脚本的结果回头改 §5.63 的裁决。**
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadBars } from '../../src/backtest/vol-target'

/** 预注册锁定 */
const HORIZON = 20
const FROM = '2018-01-01'
const TO = '2023-12-31'
const POOL_N = 64
const DRAWS = 5000
const WIN_CAP = 0.55
/** 四个时间段（预注册锁定，不许换切法） */
const SEGMENTS = [
  { name: '2018–19', from: '2018-01-01', to: '2019-12-31' },
  { name: '2020–21', from: '2020-01-01', to: '2021-12-31' },
  { name: '2022', from: '2022-01-01', to: '2022-12-31' },
  { name: '2023', from: '2023-01-01', to: '2023-12-31' },
] as const

interface Period {
  reportDate: string
  noticeDate: string | null
  bps: number | null
  securityType: string | null
}
interface Point {
  bp: number
  fwd: number
}

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback
}
const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(100 * v).toFixed(d)}%` : '—')

function pitBps(periods: readonly Period[], date: string): number | null {
  let best: Period | null = null
  for (const p of periods) {
    if (p.noticeDate === null || p.noticeDate > date) continue
    if (best === null || p.reportDate > best.reportDate) best = p
  }
  return best?.bps ?? null
}

/** mulberry32 —— 可复现是硬要求 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] ?? Number.NaN) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length

interface Trial {
  date: string
  /** top-K 的平均前瞻收益 − 随机 K 只的平均前瞻收益 */
  diff: number
  /** top-1 的前瞻收益 与 池内中位（自检用） */
  topFwd: number
  poolMedianFwd: number
}

function main(): void {
  const fixtures = argOf('--fixtures', './data/history')
  const financials = argOf('--financials', './data/financials')
  const codes = (JSON.parse(readFileSync('params/universe-broad.json', 'utf8')) as { codes: string[] })
    .codes

  console.log('# `B/P` Phase 0′：逐次决策口径（预注册 M2 §5.64）\n')

  // 日期 → (标的 → 点)。一次算好，抽样只是重组
  const byDate = new Map<string, Map<string, Point>>()
  for (const code of codes) {
    const finFile = join(financials, `${code}.json`)
    if (!existsSync(finFile) || !existsSync(join(fixtures, `${code}.json`))) continue
    const periods = (
      JSON.parse(readFileSync(finFile, 'utf8')) as { periods: Period[] }
    ).periods.filter((p) => p.securityType === null || p.securityType === 'A股')
    if (periods.length === 0) continue
    const bars = loadBars(fixtures, code)
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      if (!bar || bar.date < FROM || bar.date > TO) continue
      const base = bar.closeAdj
      const later = bars[i + HORIZON]
      if (base === null || base <= 0 || later?.closeAdj === null || later?.closeAdj === undefined) continue
      if (later.closeAdj <= 0 || bar.close <= 0) continue
      const bps = pitBps(periods, bar.date)
      if (bps === null) continue
      const day = byDate.get(bar.date) ?? new Map<string, Point>()
      day.set(code, { bp: bps / bar.close, fwd: later.closeAdj / base - 1 })
      byDate.set(bar.date, day)
    }
  }
  const dates = [...byDate.keys()].filter((d) => (byDate.get(d)?.size ?? 0) >= POOL_N).sort()
  console.log(
    `可用交易日 **${dates.length}** 天（横截面 ≥ ${POOL_N}）· 窗口 ${FROM} → ${TO} · 持有期 **${HORIZON} 日**\n`
  )

  /** 跑一批决策场合。`topK` = 处理组取几只（对照组取同样多） */
  const run = (topK: number, seed: number): Trial[] => {
    const next = rng(seed)
    const out: Trial[] = []
    for (let k = 0; k < DRAWS; k++) {
      const date = dates[Math.floor(next() * dates.length)]
      if (date === undefined) continue
      const day = byDate.get(date)
      if (day === undefined) continue
      // 该日全部可用标的 → 无放回抽 64 只作为「你手上那批票」
      const all = [...day.keys()]
      for (let i = 0; i < POOL_N; i++) {
        const j = i + Math.floor(next() * (all.length - i))
        const a = all[i]
        const b = all[j]
        if (a !== undefined && b !== undefined) {
          all[i] = b
          all[j] = a
        }
      }
      const pool = all.slice(0, POOL_N)
      const pts = pool.map((c) => day.get(c)).filter((p): p is Point => p !== undefined)
      if (pts.length < POOL_N) continue

      // 处理组：B/P 最高的 topK 只
      const byBp = [...pts].sort((x, y) => y.bp - x.bp)
      const treat = mean(byBp.slice(0, topK).map((p) => p.fwd))
      // 对照组：同池同日随机 topK 只（**不排除处理组** —— 随机就是随机）
      const idx = pts.map((_, i) => i)
      for (let i = 0; i < topK; i++) {
        const j = i + Math.floor(next() * (idx.length - i))
        const a = idx[i]
        const b = idx[j]
        if (a !== undefined && b !== undefined) {
          idx[i] = b
          idx[j] = a
        }
      }
      const control = mean(idx.slice(0, topK).map((i) => pts[i]?.fwd ?? 0))
      out.push({
        date,
        diff: treat - control,
        topFwd: byBp[0]?.fwd ?? Number.NaN,
        poolMedianFwd: median(pts.map((p) => p.fwd)),
      })
    }
    return out
  }

  const report = (label: string, trials: readonly Trial[], judge: boolean): number => {
    const wins = trials.filter((t) => t.diff > 0).length / Math.max(1, trials.length)
    console.log(
      `| ${judge ? '**' : ''}${label}${judge ? '**' : ''} | ${trials.length} | ` +
        `${judge ? '**' : ''}${pct(wins, 1)}${judge ? '**' : ''} | ` +
        `${pct(median(trials.map((t) => t.diff)))} | ${pct(mean(trials.map((t) => t.diff)))} |`
    )
    return wins
  }

  const top1 = run(1, 20260826)
  const top5 = run(5, 20260827)

  console.log('## 主判据 ①：配对胜率\n')
  console.log('| 组 | 场合数 | **配对胜率** | 收益差·中位 | 收益差·均值 |')
  console.log('|---|---|---|---|---|')
  const win1 = report('top-1 vs 随机 1（主判据）', top1, true)
  const win5 = report('top-5 vs 随机 5（描述性，不判）', top5, false)

  console.log('\n## 主判据 ②：四个时间段（样本期依赖检验）\n')
  console.log('| 段 | 场合数 | **配对胜率** | 收益差·中位 |')
  console.log('|---|---|---|---|')
  let allSegOk = true
  for (const seg of SEGMENTS) {
    const sub = top1.filter((t) => t.date >= seg.from && t.date <= seg.to)
    const w = sub.filter((t) => t.diff > 0).length / Math.max(1, sub.length)
    if (!(w > 0.5)) allSegOk = false
    console.log(
      `| ${seg.name} | ${sub.length} | **${pct(w, 1)}**${w > 0.5 ? '' : ' ❌'} | ${pct(median(sub.map((t) => t.diff)))} |`
    )
  }

  console.log('\n## 自检\n')
  const topMean = mean(top1.map((t) => t.topFwd))
  const poolMean = mean(top1.map((t) => t.poolMedianFwd))
  const dirOk = topMean > poolMean
  console.log(
    `\`top-1\` 平均前瞻收益 **${pct(topMean)}** vs 池内中位 **${pct(poolMean)}** ⇒ ` +
      `**${dirOk ? '方向正确（B/P 越高越便宜 ⇒ 应为正）' : '❌ 方向取反了 —— 结果一律作废'}**`
  )

  console.log('\n## 裁决（预注册 §5.64）\n')
  const pass = win1 >= WIN_CAP && allSegOk && dirOk
  console.log(
    `① 配对胜率 ${pct(win1, 1)} ${win1 >= WIN_CAP ? '≥' : '<'} ${pct(WIN_CAP, 0)} ⇒ ` +
      `**${win1 >= WIN_CAP ? '过' : '不过'}** · ② 四段全部 > 50% ⇒ **${allSegOk ? '过' : '不过'}**\n`
  )
  console.log(
    pass
      ? '⇒ **两条都过。** ⚠ 这**只**意味着可以去做 Phase A（找有退市股的财务源），\n' +
          '   **不意味着 `B/P` 能用** —— §5.62 的三条减记一条都没解开。'
      : '⇒ 🛑 **判「`B/P` 在单次决策尺度上不构成可用的决策依据」，全案到此为止。**\n' +
          '   ⚠ 这**不推翻** §5.62 的 IC +5.18%、也不推翻 §5.63 的裁决 —— ' +
          '三者问的是三个不同的问题：\n' +
          '   「这个因子有没有信息」（有）· 「换池子还在不在」（在）· ' +
          '「一次决策能不能靠它」（← 本节）。'
  )
  console.log(
    `\nⓘ 描述性：\`top-5\` 那一档 ${pct(win5, 1)}（分散掉一部分选股噪音）—— **不参与裁决**。`
  )

  /*
    预注册 P5：`R = 5000` 下这个胜率本身该**很精确**（换种子波动 < 1pp）。
    这一条是刻意在检验「§5.63 那个教训学会了没有」——
    噪音进的是**逐次**那一层，不是这个**汇总估计**那一层。
  */
  console.log('\n## P5：换种子的稳定性（预注册的检验，不是新实验）\n')
  const seeds = [20260826, 777, 424242]
  const wins = seeds.map((s) => {
    const t = run(1, s)
    return t.filter((x) => x.diff > 0).length / Math.max(1, t.length)
  })
  console.log(`三个种子下的配对胜率：${wins.map((w) => pct(w, 1)).join(' · ')}`)
  const spread = Math.max(...wins) - Math.min(...wins)
  console.log(
    `极差 **${pct(spread, 2)}** ⇒ **${spread < 0.01 ? 'P5 成立' : 'P5 不成立'}**（预测：< 1pp）` +
      `${spread < 0.01 ? ' —— 汇总估计确实是精确的，不确定性在「水平」不在「估计」' : ''}`
  )
}

main()
