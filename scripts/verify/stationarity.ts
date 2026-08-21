/**
 * **平稳性**：M2 §5.51 那六处假设各自站不站得住。
 *
 * ```bash
 * npx tsx scripts/verify/stationarity.ts
 * ```
 *
 * ## 为什么要有它
 *
 * 2026-08-21 §5.50 把 Lo (2002) 的 `V_GMM` 落进代码，而它的第一条前提就是
 * **H1：平稳且遍历**。同一天用户问「我们有做过平稳性检验吗」—— 答案是**没有**，
 * 「平稳」这个词在整个仓库里只出现在归属注释里。而它压着六处（§5.51 那张表），
 * 其中第 3 处（rank IC 的 NW `t`）是当前**唯一**能引用的主判据。
 *
 * ## 只做一个正式检验，且刻意不做另外两个
 *
 * - ✅ **CUSUM-of-squares**：`D = sup|s_k − k/T| · √T · ū / ω`，
 *   `s_k = Σ_{t≤k}u_t / Σ_T u_t`、`u_t = (r_t − μ̂)²`。
 *   临界值 **1.358** = **布朗桥上确界**的 5% 双侧分位（Kolmogorov–Smirnov；
 *   分布函数见 Billingsley 1999 pp. 101–104）。
 *
 *   **归属（2026-08-21 两次独立查询纠正过一次，M2 §5.51）**：
 *   - 这个「除以 `√T·σ̂²` 再比布朗桥上确界」的形式归 **Inclán & Tiao (1994)**（ICSS）。
 *   - **Brown, Durbin & Evans (1975)** 是**祖先不是出处** —— 他们做的是**递归残差**上的
 *     CUSUM / CUSUM-of-squares，边界是 Durbin (1971) 那对**平行直线**，不是布朗桥上确界。
 *     写成 BDE(1975) + 1.358 是把两代东西拼起来。
 *   - **`ω` 取 HAC 长期标准差那一版也有名字**：**Sansó, Aragó & Carrion (2004)** 的 **κ₂**
 *     —— 用非参估的 `ε²` 长期方差换掉 IID 的分母，好让布朗桥临界值在条件异方差与
 *     序列相关下仍然成立。⇒ 本脚本的 `dHac` 就是 κ₂，`dNaive` 是 IID 版
 *     （正态下那个 nuisance 参数 `φ² = 2σ⁴`，所以 `sd(u)` 就是它）。**两条都报。**
 *
 *   ⚠ **它对离群点敏感**（Inclán & Tiao 自己指出，Lee & Park 2001 因此改用截尾）：
 *   离群点会抬高统计量，但**把 HAC 分母抬得更多** ⇒ κ₂ 在肥尾上偏**保守**。
 *   ⚠ 而**无条件方差无限时这个检验没有意义**（统计量不一致）——
 *   我们 γ₄ 在 5.75–79.70 之间，离「无限」不远，所以拒绝要连着峰度一起读。
 * - ❌ **不做 ADF / 单位根**：它检验**水平序列**的单位根，而日收益已经是差分后的量
 *   ⇒ 会以天文数字的显著性「通过」，给出一个**虚假的安心**。
 *   与「日胜率 ≈ 基准下跌天数占比」（M2 §5.41）同一类零信息量指标。
 * - ❌ **不做 `r²` 的 Ljung-Box 来判 H1**：条件异方差**不违反** H1 ——
 *   Lo 原文明确写着平稳性 allows for "serial correlation, time-varying conditional
 *   volatilities, jumps"。H1 要求的是**无条件**矩恒定。混起来会得出两个都错的结论。
 *
 * ## 自检是**经验水平与功效**，不是复现外部算例
 *
 * 这个检验没有公布的算例可复现（§5.49 学到的：没有输入就不算核对）。
 * 所以改成种子固定的蒙特卡洛：IID 序列上朴素带的拒绝率应 ≈ 5%，
 * 「中点方差翻倍」序列上应接近 100%。
 *
 * ## ⚠ 测试窗口不碰
 *
 * 只读训练窗口（2018–2023）、验证窗口（2024-01→2025-06）与 2005–2017 的**基准列**。
 * 跨到 2026-08 的报告（`t3fix` / `baseline-261` / `slip-*`）一份都不读。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BARS_PER_YEAR,
  bartlettLongRunCovariance,
  mean,
  sharpeRatioHac,
} from '../../src/backtest/metrics'
import { andrewsLag } from '../../src/backtest/ic-audit'
import { pearsonKurtosis, skewness } from './stats'

const CALIB_DIR = join(process.cwd(), 'reports', 'calib')

/** 布朗桥上确界的 5% 双侧临界值（Kolmogorov–Smirnov；Billingsley 1999 pp. 101–104） */
const CUSUMSQ_CRITICAL = 1.358

interface Report {
  meta: { engineVersion: string; codes: string[]; from: string; to: string; capitalPerCode: number }
  equity: Array<{ date: string; equity: number; benchmark: number | null }>
  performance: { trades?: { avgHoldingBars?: number } }
}

const load = (name: string): Report =>
  JSON.parse(readFileSync(join(CALIB_DIR, `${name}.json`), 'utf8')) as Report

/** 逐期收益；`benchmark` 列缺值的期直接跳过（不与 equity 列对齐 —— 这里两列各自独立分析） */
function returnsOf(rep: Report, key: 'equity' | 'benchmark'): number[] {
  const out: number[] = []
  for (let i = 1; i < rep.equity.length; i++) {
    const prev = rep.equity[i - 1]?.[key]
    const now = rep.equity[i]?.[key]
    if (prev === null || prev === undefined || now === null || now === undefined || prev <= 0) continue
    out.push(now / prev - 1)
  }
  return out
}

interface Moments {
  label: string
  T: number
  mean: number
  sd: number
  skew: number
  kurt: number
  rho1: number
  lag: number
  vif: number | null
  sharpeAnn: number | null
  seAnn: number | null
}

function momentsOf(label: string, xs: readonly number[]): Moments {
  const T = xs.length
  const m = mean(xs)
  const m2 = xs.reduce((s, v) => s + (v - m) ** 2, 0) / T
  const lag = andrewsLag(T)
  const hac = sharpeRatioHac(xs, lag)
  let rho1 = 0
  if (m2 > 0) {
    let sum = 0
    for (let t = 1; t < T; t++) sum += (xs[t]! - m) * (xs[t - 1]! - m)
    rho1 = sum / T / m2
  }
  return {
    label,
    T,
    mean: m,
    sd: Math.sqrt(m2),
    skew: skewness(xs),
    kurt: pearsonKurtosis(xs),
    rho1,
    lag,
    vif: hac?.varianceInflation ?? null,
    sharpeAnn: hac === null ? null : hac.sharpe * Math.sqrt(BARS_PER_YEAR),
    seAnn: hac === null ? null : hac.standardError * Math.sqrt(BARS_PER_YEAR),
  }
}

/** 等长切成 k 段（**预承诺等长，不搜索断点**） */
function split<T>(xs: readonly T[], k: number): T[][] {
  const out: T[][] = []
  const size = Math.floor(xs.length / k)
  for (let i = 0; i < k; i++) out.push(xs.slice(i * size, i === k - 1 ? xs.length : (i + 1) * size))
  return out
}

interface Cusum {
  /** IID 版（Inclán & Tiao 1994，分母 `sd(u)`；正态下 `φ² = 2σ⁴`） */
  dNaive: number
  /** κ₂ 版（Sansó, Aragó & Carrion 2004，分母换成 `u` 的 HAC 长期标准差） */
  dHac: number
  lag: number
  /** 上确界出现的位置，占全长的比例 —— 用来看断点大概在哪（**不是搜出来的断点**） */
  argmax: number
}

function cusumSq(xs: readonly number[], lag: number): Cusum | null {
  const T = xs.length
  if (T < 4) return null
  const m = mean(xs)
  const u = xs.map((v) => (v - m) ** 2)
  const ubar = mean(u)
  if (ubar <= 0) return null
  let running = 0
  let sup = 0
  let argmax = 0
  for (let k = 0; k < T; k++) {
    running += (u[k] ?? 0) - ubar
    const dev = Math.abs(running) / (T * ubar)
    if (dev > sup) {
      sup = dev
      argmax = (k + 1) / T
    }
  }
  const sdU = Math.sqrt(u.reduce((s, v) => s + (v - ubar) ** 2, 0) / T)
  const lrv = bartlettLongRunCovariance(u, u, lag)
  if (sdU <= 0 || lrv === null || lrv <= 0) return null
  const scale = sup * Math.sqrt(T) * ubar
  return { dNaive: scale / sdU, dHac: scale / Math.sqrt(lrv), lag, argmax }
}

// ---------- 自检：经验水平与功效 ----------

/** 种子固定的 LCG + Box-Muller。要的是可复现，不是密码学质量 */
function makeNormal(seed: number): () => number {
  let state = seed >>> 0
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state >>> 8) / 16777216
  }
  return () => {
    const u1 = Math.max(next(), 1e-12)
    const u2 = next()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
}

function monteCarlo(trials: number, T: number, breakAt: number | null): number {
  let rejects = 0
  for (let s = 1; s <= trials; s++) {
    const rnd = makeNormal(s * 7919 + 13)
    const xs: number[] = []
    for (let t = 0; t < T; t++) {
      const scale = breakAt !== null && t >= breakAt * T ? Math.SQRT2 : 1
      xs.push(rnd() * scale)
    }
    const c = cusumSq(xs, andrewsLag(T))
    if (c !== null && c.dNaive > CUSUMSQ_CRITICAL) rejects++
  }
  return rejects / trials
}

// ---------- 输出 ----------

function momentRow(m: Moments): string {
  const f = (v: number | null, d: number): string => (v === null ? '—' : v.toFixed(d))
  return (
    `| ${m.label} | ${m.T} | ${(m.mean * 1e4).toFixed(2)} | ${(m.sd * 100).toFixed(3)}% | ` +
    `${f(m.skew, 3)} | ${f(m.kurt, 2)} | ${f(m.rho1, 4)} | ${m.lag} | ${f(m.vif, 4)} | ` +
    `${f(m.sharpeAnn, 3)} | ±${f(m.seAnn, 3)} |`
  )
}

const HEAD =
  '| 段 | T | 日均(bp) | σ(日) | γ₃ | γ₄ | ρ₁ | L | **VIF** | 年化夏普 | HAC SE |'
const RULE = '|---|---|---|---|---|---|---|---|---|---|---|'

function spread(values: Array<number | null>): string {
  const vs = values.filter((v): v is number => v !== null).map(Math.abs)
  if (vs.length < 2) return '—'
  const lo = Math.min(...vs)
  return lo === 0 ? '∞' : `${(Math.max(...vs) / lo).toFixed(2)}×`
}

function section(title: string, xs: readonly number[], label: string): Moments[] {
  console.log(`\n### ${title}\n`)
  const rows = [
    momentsOf(`${label}·全段`, xs),
    ...split(xs, 2).map((seg, i) => momentsOf(`${label}·半${i + 1}`, seg)),
    ...split(xs, 3).map((seg, i) => momentsOf(`${label}·三${i + 1}`, seg)),
  ]
  console.log(HEAD)
  console.log(RULE)
  for (const r of rows) console.log(momentRow(r))
  const thirds = rows.slice(3)
  console.log(
    `\n三段极差：**σ ${spread(thirds.map((r) => r.sd))}** · ` +
      `γ₄ ${spread(thirds.map((r) => r.kurt))} · **VIF ${spread(thirds.map((r) => r.vif))}**`
  )
  const c = cusumSq(xs, andrewsLag(xs.length))
  if (c !== null) {
    console.log(
      `CUSUMSQ：IID版 **D = ${c.dNaive.toFixed(3)}** · κ₂(L=${c.lag}) **D = ${c.dHac.toFixed(3)}** ` +
        `（临界 ${CUSUMSQ_CRITICAL}）⇒ ${c.dHac > CUSUMSQ_CRITICAL ? '**拒绝方差恒定**' : '不拒绝'}` +
        ` · 上确界在 ${(c.argmax * 100).toFixed(0)}% 处`
    )
  }
  return rows
}

function main(): void {
  console.log('# 平稳性：那六处假设站不站得住（M2 §5.51）\n')

  console.log('## 0. 自检：经验水平与功效（种子固定，200 次）\n')
  for (const [name, T, brk, want] of [
    ['IID（H0 为真）· T=1456', 1456, null, '≈ 5%'],
    ['IID（H0 为真）· T=485', 485, null, '≈ 5%'],
    ['中点方差翻倍 · T=1456', 1456, 0.5, '接近 100%'],
    ['中点方差翻倍 · T=485', 485, 0.5, '高'],
  ] as const) {
    const rate = monteCarlo(200, T, brk)
    console.log(`- ${name}：拒绝率 **${(rate * 100).toFixed(1)}%**（应 ${want}）`)
  }

  const train = load('cap-100000')
  const valid = load('abl-valid-base')
  const idx = load('idx-cap-0517')

  console.log('\n## 1. 样本（口径行）\n')
  for (const [name, r] of [
    ['cap-100000（策略·训练）', train],
    ['abl-valid-base（策略·验证）', valid],
    ['idx-cap-0517（**只用它的 benchmark 列**）', idx],
  ] as const) {
    console.log(
      `- ${name}：${r.meta.from} → ${r.meta.to} · ${r.meta.codes.length} 只 · ` +
        `每标的资金 ${r.meta.capitalPerCode} · ${r.meta.engineVersion}`
    )
  }
  console.log(
    '\n> `idx-cap-0517` 的每标的资金是 1e7（拿指数回测必须调大，否则一手都买不起）—— ' +
      '**但这里只用它的 `benchmark` 列**（沪深300 被动持有），那一列与资金无关。'
  )

  console.log('\n## 2. 分段矩（预承诺等长切分，不搜索断点）')
  const trainRows = section('2.1 策略 · 训练窗口 2018–2023', returnsOf(train, 'equity'), '策略')
  const benchRows = section('2.2 基准（沪深300）· 同期 2018–2023', returnsOf(train, 'benchmark'), '基准')
  section('2.3 基准（沪深300）· 2005–2017（长跨度对照）', returnsOf(idx, 'benchmark'), '基准05')

  console.log('\n### 2.4 训练 vs 验证（样本外的矩漂移）\n')
  const trainAll = momentsOf('策略·训练', returnsOf(train, 'equity'))
  const validAll = momentsOf('策略·验证', returnsOf(valid, 'equity'))
  console.log(HEAD)
  console.log(RULE)
  console.log(momentRow(trainAll))
  console.log(momentRow(validAll))
  console.log(
    `\nσ 之比 **${(validAll.sd / trainAll.sd).toFixed(2)}×** · ` +
      `γ₄ 之比 **${(Math.abs(validAll.kurt) / Math.abs(trainAll.kurt)).toFixed(2)}×** · ` +
      `VIF ${trainAll.vif?.toFixed(3)} → ${validAll.vif?.toFixed(3)}`
  )

  console.log('\n## 3. 均值那一侧：分段夏普的差异 vs 它自己的标准误\n')
  console.log('| 对比 | 差 | 两段 HAC SE 的合成 | \\|z\\| | 测得出吗 |')
  console.log('|---|---|---|---|---|')
  const thirds = trainRows.slice(3)
  const pairs: Array<[Moments, Moments]> = [
    [thirds[0]!, thirds[1]!],
    [thirds[1]!, thirds[2]!],
    [thirds[0]!, thirds[2]!],
    [trainAll, validAll],
  ]
  for (const [a, b] of pairs) {
    if (a.sharpeAnn === null || b.sharpeAnn === null || a.seAnn === null || b.seAnn === null) continue
    const diff = b.sharpeAnn - a.sharpeAnn
    const se = Math.sqrt(a.seAnn ** 2 + b.seAnn ** 2)
    const z = Math.abs(diff / se)
    console.log(
      `| ${a.label} → ${b.label} | ${diff.toFixed(3)} | ±${se.toFixed(3)} | ${z.toFixed(2)} | ` +
        `${z > 1.96 ? '**是**' : '否'} |`
    )
  }
  console.log(
    '\n> 基准侧同期三段夏普：' +
      benchRows
        .slice(3)
        .map((r) => `${r.sharpeAnn?.toFixed(2)}±${r.seAnn?.toFixed(2)}`)
        .join(' · ')
  )
}

main()
