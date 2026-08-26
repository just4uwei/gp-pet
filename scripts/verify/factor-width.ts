/**
 * **`B/P` Phase 0：池宽度敏感性** —— 把横截面从 261 只缩到自选池那个尺度（约 64 只），
 * 排序还剩多少？预注册见 [M2 §5.63](../../docs/notes/M2-偏差报告.md)。
 *
 * ```bash
 * npx tsx scripts/verify/factor-width.ts --fixtures ./data/history --financials ./data/financials
 * ```
 *
 * ## 它在防的那件事
 *
 * §5.62 量到 `B/P` 在 **261 只**上 IC +5.18%，而产品的真实横截面是用户自选的 **64 只**
 * —— 这**不是同一个测量**。这个项目在 40 只 → 261 只那次已经被教训过一回
 * （全期 +5.93% → **−0.94%**）：**池子换了，结论就换了。**
 *
 * ⚠ **主判据是「IC 为负的抽样比例」，不是「平均 IC」。**
 * 无放回抽样对秩相关近似无偏 ⇒ **各档的中位 IC 本来就该差不多**，
 * 那不是发现。**真正的信息在离散度里**：如果四分之一的抽样里方向是反的，
 * 而你无法事先知道自己抽到的是哪一种，那它就不是决策依据。
 *
 * ## 三条口径
 *
 * 1. **只跑 `B/P`、只跑 20 日、只跑训练窗口** —— 一次只问一个问题（预注册锁的就是这个）。
 * 2. **`icOf` 从 `ic-audit.ts` 引**，与 §5.62 同一份实现（第三份 IC 实现是不允许的）。
 * 3. **`N = 261` 那一档是自检**：只有一种抽法 ⇒ 必须给出与 §5.62 逐位相同的 5.18%。
 *    对不上就是抽样或载入写错了，**结果一律作废**，不许当成发现。
 *
 * ## 边界
 *
 * 只读 · 不改引擎 · 不碰测试窗口 · **Phase 0 只能否决，不能批准**
 * （通过它只意味着可以去做 Phase A，不意味着 `B/P` 能用）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { icOf, type Row } from '../../src/backtest/ic-audit'
import { loadBars } from '../../src/backtest/vol-target'
import type { SecCode, TradeDate } from '../../src/core/types'

/** 预注册锁定：只这一个因子、只这一个持有期、只训练窗口 */
const HORIZON = 20
const FROM = '2018-01-01'
const TO = '2023-12-31'
/** 预注册锁定的档位与重复次数。**不许改** */
const SIZES = [20, 40, 64, 100, 261] as const
const DRAWS = 200
/** 主判据门槛：`N = 64` 档 IC < 0 的比例 ≥ 25% ⇒ 判不可执行 */
const NEGATIVE_CAP = 0.25

interface Period {
  reportDate: string
  noticeDate: string | null
  bps: number | null
  securityType: string | null
}

/** 一只票在训练窗口内的逐日 (日期, B/P, 20 日前瞻收益) */
interface Point {
  date: TradeDate
  bp: number
  fwd: number
}

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback
}
const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(100 * v).toFixed(d)}%` : '—')

/** PIT：取 `noticeDate <= date` 的最新一期（与 factor-ic.ts 同一条口径） */
function pitBps(periods: readonly Period[], date: string): number | null {
  let best: Period | null = null
  for (const p of periods) {
    if (p.noticeDate === null || p.noticeDate > date) continue
    if (best === null || p.reportDate > best.reportDate) best = p
  }
  return best?.bps ?? null
}

/** mulberry32 —— 32 位整数运算，可复现是硬要求（教科书 LCG 在 JS 双精度里会溢出） */
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

/** 无放回抽样（Fisher–Yates 前 n 个） */
function sample<T>(items: readonly T[], n: number, next: () => number): T[] {
  const arr = [...items]
  for (let i = 0; i < Math.min(n, arr.length - 1); i++) {
    const j = i + Math.floor(next() * (arr.length - i))
    const a = arr[i]
    const b = arr[j]
    if (a !== undefined && b !== undefined) {
      arr[i] = b
      arr[j] = a
    }
  }
  return arr.slice(0, n)
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[i] ?? Number.NaN
}

function main(): void {
  const fixtures = argOf('--fixtures', './data/history')
  const financials = argOf('--financials', './data/financials')
  const codes = (JSON.parse(readFileSync('params/universe-broad.json', 'utf8')) as { codes: string[] })
    .codes

  console.log('# `B/P` Phase 0：池宽度敏感性（预注册 M2 §5.63）\n')

  // ── 一次性把每只票的逐日点算好，之后各档抽样只是重组 ──
  const byCode = new Map<string, Point[]>()
  for (const code of codes) {
    const finFile = join(financials, `${code}.json`)
    if (!existsSync(finFile) || !existsSync(join(fixtures, `${code}.json`))) continue
    const periods = (
      JSON.parse(readFileSync(finFile, 'utf8')) as { periods: Period[] }
    ).periods.filter((p) => p.securityType === null || p.securityType === 'A股')
    if (periods.length === 0) continue
    const bars = loadBars(fixtures, code)
    const points: Point[] = []
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      if (!bar || bar.date < FROM || bar.date > TO) continue
      const base = bar.closeAdj
      const later = bars[i + HORIZON]
      if (base === null || base <= 0 || later?.closeAdj === null || later?.closeAdj === undefined) continue
      if (later.closeAdj <= 0) continue
      const bps = pitBps(periods, bar.date)
      if (bps === null || bar.close <= 0) continue
      points.push({ date: bar.date as TradeDate, bp: bps / bar.close, fwd: later.closeAdj / base - 1 })
    }
    if (points.length > 0) byCode.set(code, points)
  }
  const usable = [...byCode.keys()]
  console.log(`可用标的 **${usable.length}** 只 · 窗口 ${FROM} → ${TO} · 持有期 **${HORIZON} 日**\n`)

  /** 给定子池，算这一次抽样的 (平均 IC, Q5−Q1, 有效日数, **逐日 IC 为负的比例**) */
  const measure = (
    sub: readonly string[]
  ): { ic: number; spread: number; days: number; dailyNeg: number } => {
    const byDate = new Map<TradeDate, Row[]>()
    for (const code of sub) {
      for (const p of byCode.get(code) ?? []) {
        const rows = byDate.get(p.date) ?? []
        rows.push({ code: code as SecCode, score: p.bp, fwd: new Map([[HORIZON, p.fwd]]) })
        byDate.set(p.date, rows)
      }
    }
    const r = icOf(byDate, HORIZON)
    const q1 = r.quintileMedians[0]
    const q5 = r.quintileMedians[4]
    return {
      ic: r.meanIc,
      spread: q1 === null || q1 === undefined || q5 === null || q5 === undefined ? Number.NaN : q5 - q1,
      days: r.days,
      // **逐日**方向反了的比例 —— 与主判据问的不是同一件事，见下面那一节
      dailyNeg: r.dailyIc.length === 0 ? Number.NaN : r.dailyIc.filter((d) => d.ic < 0).length / r.dailyIc.length,
    }
  }

  console.log('| N | 抽样次数 | IC 中位 | IC 5% | IC 95% | **IC < 0 比例** | `Q5−Q1` 中位 | **`Q5−Q1` < 0 比例** | 有效日 | **逐日 IC < 0 的比例（描述性）** |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')

  let verdict64 = Number.NaN
  let selfCheck = Number.NaN
  for (const n of SIZES) {
    const reps = n >= usable.length ? 1 : DRAWS
    const ics: number[] = []
    const spreads: number[] = []
    const days: number[] = []
    const dailyNegs: number[] = []
    for (let k = 0; k < reps; k++) {
      // 种子按 (N, 第几次) 定死 —— 换台机器要给出同一批数字
      const sub = reps === 1 ? usable : sample(usable, n, rng(n * 1_000_003 + k))
      const m = measure(sub)
      if (!Number.isFinite(m.ic)) continue
      ics.push(m.ic)
      if (Number.isFinite(m.spread)) spreads.push(m.spread)
      if (Number.isFinite(m.dailyNeg)) dailyNegs.push(m.dailyNeg)
      days.push(m.days)
    }
    ics.sort((a, b) => a - b)
    spreads.sort((a, b) => a - b)
    days.sort((a, b) => a - b)
    dailyNegs.sort((a, b) => a - b)
    const negIc = ics.filter((v) => v < 0).length / Math.max(1, ics.length)
    const negSp = spreads.filter((v) => v < 0).length / Math.max(1, spreads.length)
    if (n === 64) verdict64 = negIc
    if (n === 261) selfCheck = quantile(ics, 0.5)
    const star = n === 64 ? '**' : ''
    console.log(
      `| ${star}${n}${star} | ${reps} | ${star}${pct(quantile(ics, 0.5))}${star} | ${pct(quantile(ics, 0.05))} | ` +
        `${pct(quantile(ics, 0.95))} | ${star}${pct(negIc, 1)}${star} | ${pct(quantile(spreads, 0.5))} | ` +
        `${pct(negSp, 1)} | ${quantile(days, 0.5).toFixed(0)} | **${pct(quantile(dailyNegs, 0.5), 1)}** |`
    )
  }

  console.log('\n## 自检\n')
  const ok = Math.abs(selfCheck - 0.0518) < 0.0002
  console.log(
    `\`N = 261\` 只有一种抽法 ⇒ 必须逐位复现 §5.62 的 **5.18%**：实测 **${pct(selfCheck)}** ⇒ ` +
      `**${ok ? '通过' : '❌ 不通过 —— 抽样或载入写错了，下面的结果一律作废'}**`
  )

  console.log('\n## 主判据（预注册 §5.63）\n')
  console.log(
    `\`N = 64\` 档 **IC < 0 的抽样比例 = ${pct(verdict64, 1)}**（门槛 ≥ ${pct(NEGATIVE_CAP, 0)} 判不可执行）\n`
  )
  console.log(
    verdict64 >= NEGATIVE_CAP
      ? '⇒ 🛑 **判「在自选池尺度上这个排序不可执行」，`B/P` 全案到此为止**（Phase A/B/C 都不做）。\n' +
          '   四分之一以上的抽样里方向是反的，而你**无法事先知道自己抽到的是哪一种**。'
      : '⇒ **没有被 Phase 0 否掉。** ⚠ 这**只**意味着可以去做 Phase A（找有退市股的财务源），\n' +
          '   **不意味着 `B/P` 能用** —— §5.62 的三条减记一条都没解开，而 Phase 0 与它们正交。'
  )
  console.log(
    '\n⚠ **不要读「各档中位 IC 差不多」这件事** —— 无放回抽样对秩相关近似无偏，' +
      '那是**设计使然**，不是发现。信息全在离散度与负比例那两列里。'
  )

  console.log('\n## ⚠ 我这个主判据测的不是决策可靠性（**事后发现的设计缺陷，不改裁决**）\n')
  console.log(
    '主判据问的是「**换一批 64 只票，窗口平均 IC 还是不是正的**」—— 那是**估计稳定性**。\n' +
      '而用户实际做的是「**某一天**把手上 64 只排个序，然后动手」—— 那要看**逐日** IC。\n' +
      '两者差着 1457 天的平均：窗口平均把日间噪音开方地压掉了，所以它稳，**不代表每天都对**。\n\n' +
      '⇒ 最后那一列（描述性，**不参与裁决**）才是「某一天方向反了的概率」。\n' +
      '⚠ **这条限制是看完结果才想到的** ⇒ 按纪律**不许拿它回头改裁决**（那是移动球门）。\n' +
      '   它的正确用途是：**下一次预注册时把主判据改成逐日口径**。'
  )
}

main()
