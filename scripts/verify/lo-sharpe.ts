/**
 * **Lo (2002) 的夏普自相关修正**：把 [M2 §5.49](../../docs/notes/M2-偏差报告.md) 判据 6
 * 留下的那个「近似 ×1.3」换成正式口径，并判 `η(q)` 在日频上能不能用。
 *
 * ```bash
 * npx tsx scripts/verify/lo-sharpe.ts
 * npx tsx scripts/verify/lo-sharpe.ts --report etf-train.json
 * ```
 *
 * ## 它答什么 / 不答什么
 *
 * 答：**夏普估计量的方差被自相关抬高了多少倍**（`varianceInflation`），
 * 以及那个倍数该不该进 MinTRL 的年数表。
 *
 * **不答**：任何既有实验显不显著。夏普的**点估计**一个字不改
 * （`performance.sharpe` 永久是 rf = 0 + `×√243`，CLAUDE.md 写死）。
 * 拿这里的数回头重判 §5.48 的 DSR 门槛或 §5.49 的年数表 = 移动球门。
 *
 * ## 口径与归属
 *
 * - **Lo, A. W.** (2002), *The Statistics of Sharpe Ratios*, **FAJ 58(4) 36–52**。
 *   `V_GMM = ∇g′ S ∇g` 的实现在 `src/backtest/metrics.ts` 的 `sharpeRatioHac`，
 *   归属链与「Mertens 的闭式≠处理了自相关」那条陷阱写在那个函数的头注释里。
 * - 时间聚合：`SR(q) = η(q)·SR`，`η(q) = q / √(q + 2Σ_{k=1..q−1}(q−k)ρ_k)`（论文 Eq. 20）。
 *   AR(1) 下有闭式（Eq. 22），本脚本用它复现论文 **Table 2** 当外部算例。
 *
 * ## 滞后阶是**预承诺**的（M2 §5.50 判据 3）
 *
 * 主口径 Andrews `⌊4(T/100)^(2/9)⌋`、副口径「持仓期 − 1」，**两个都报**。
 * 别加第三个 —— 调滞后阶到显著为止是文献里有记录的 p-hacking 通道（§5.47）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BARS_PER_YEAR,
  bartlettLongRunCovariance,
  mean,
  sampleStdev,
  sharpeRatioHac,
} from '../../src/backtest/metrics'
import { andrewsLag, neweyWestVariance } from '../../src/backtest/ic-audit'
import { pearsonKurtosis, returnsFromEquity, sharpeVarianceTerm, skewness } from './stats'

const CALIB_DIR = join(process.cwd(), 'reports', 'calib')

/** 样本自相关系数 `ρ_k`（总体口径，除 T） */
function autocorrelations(xs: readonly number[], maxLag: number): number[] {
  const T = xs.length
  const m = mean(xs)
  const dev = xs.map((v) => v - m)
  const g0 = dev.reduce((s, v) => s + v * v, 0) / T
  const out: number[] = []
  for (let k = 1; k <= maxLag; k++) {
    let sum = 0
    for (let t = k; t < T; t++) sum += (dev[t] ?? 0) * (dev[t - k] ?? 0)
    out.push(g0 > 0 ? sum / T / g0 : 0)
  }
  return out
}

/**
 * Lo Eq. 20：`η(q) = q / √(q + 2Σ_{k=1..q−1}(q−k)ρ_k)`。
 * `rho` 短于 `q−1` 时相当于把更高阶的 `ρ_k` 当 0（= 截断）。
 */
function etaFromRho(q: number, rho: readonly number[]): number | null {
  let sum = q
  for (let k = 1; k <= q - 1; k++) sum += 2 * (q - k) * (rho[k - 1] ?? 0)
  if (sum <= 0) return null
  return q / Math.sqrt(sum)
}

/** Lo Eq. 22：AR(1) 的闭式 `η(q) = q·[q + 2(ρ/(1−ρ))(q − (1−ρ^q)/(1−ρ))]^(−1/2)` */
function etaAr1(q: number, rho: number): number {
  const inner = q + 2 * (rho / (1 - rho)) * (q - (1 - Math.pow(rho, q)) / (1 - rho))
  return q / Math.sqrt(inner)
}

interface Check {
  name: string
  got: number
  want: number
  tol: number
}

function main(): void {
  const reportArg = process.argv.includes('--report')
    ? process.argv[process.argv.indexOf('--report') + 1]!
    : 'cap-100000.json'

  const rep = JSON.parse(readFileSync(join(CALIB_DIR, reportArg), 'utf8')) as {
    meta: { engineVersion: string; codes: string[] }
    equity: Array<{ date: string; equity: number; benchmark: number | null }>
    performance: { sharpe?: number | null; trades?: { avgHoldingBars?: number } }
  }
  const rets = returnsFromEquity(rep.equity)
  const T = rets.length

  console.log('# Lo (2002)：夏普的自相关修正（M2 §5.50）\n')

  // ---------- 自检 ----------
  console.log('## 0. 自检（三条，**两条是论文自己的表格**）\n')

  const hac0 = sharpeRatioHac(rets, 0)!
  const closed = sharpeVarianceTerm(hac0.sharpe, skewness(rets), pearsonKurtosis(rets))
  const checks: Check[] = [
    {
      name: '① 嵌套：lag=0 的 V_GMM 应逐位等于 `sharpeVarianceTerm`（Mertens/Christie 闭式）',
      got: hac0.varTerm,
      want: closed,
      tol: 1e-10,
    },
    {
      name: '② 论文 **Table 1**：IID 正态、SR=1.00、T=12 ⇒ SE = 0.354',
      got: Math.sqrt(sharpeVarianceTerm(1, 0, 3) / 12),
      want: 0.354,
      tol: 5e-4,
    },
    {
      name: '③ 论文 **Table 2**：AR(1) ρ=+0.20、q=12 ⇒ η = 2.88（IID 是 3.46 = √12）',
      got: etaAr1(12, 0.2),
      want: 2.88,
      tol: 5e-3,
    },
    {
      name: '③b 同上、用 Eq. 20 的通式喂 AR(1) 的 ρ_k = ρ^k，应与闭式一致',
      got: etaFromRho(
        12,
        Array.from({ length: 11 }, (_, i) => Math.pow(0.2, i + 1))
      )!,
      want: etaAr1(12, 0.2),
      tol: 1e-12,
    },
  ]
  let ok = true
  for (const c of checks) {
    const pass = Math.abs(c.got - c.want) < c.tol
    ok = ok && pass
    console.log(`${pass ? '✅' : '❌'} ${c.name}`)
    console.log(`   得 ${c.got.toFixed(10)} · 期望 ${c.want} · 容差 ${c.tol}`)
  }
  console.log(`\n⇒ ${ok ? '✅ 全过' : '❌ 没过，先别看下面的数'}`)
  if (!ok) process.exitCode = 1

  // ---------- 输入 ----------
  console.log('\n## 1. 输入\n')
  const holding = rep.performance.trades?.avgHoldingBars
  const lagA = andrewsLag(T)
  const lagH = holding !== undefined ? Math.max(1, Math.round(holding) - 1) : lagA
  console.log(`报告 ${reportArg}（${rep.meta.engineVersion} · ${rep.meta.codes.length} 只 · ${T} 个日收益）`)
  console.log(
    `日频夏普（总体口径）= ${hac0.sharpe.toFixed(6)} ⇒ 年化 ${(hac0.sharpe * Math.sqrt(BARS_PER_YEAR)).toFixed(4)}` +
      `（报告里印的是 ${rep.performance.sharpe ?? '—'}，÷(n−1) 口径）`
  )
  console.log(`预承诺滞后阶：Andrews **L = ${lagA}** · 持仓期−1 **L = ${lagH}**`)

  // ---------- 夏普方差的 VIF ----------
  console.log('\n## 2. 夏普方差的 VIF（本节是交付物）\n')
  console.log('| 滞后阶 | V_GMM | V_iid | **夏普方差 VIF** | 标准误(日) | 均值 VIF（§5.49 那个） |')
  console.log('|---|---|---|---|---|---|')
  const iidMeanVar = Math.pow(sampleStdev(rets), 2) / T
  for (const [label, L] of [
    [`Andrews ${lagA}`, lagA],
    [`持仓期 ${lagH}`, lagH],
  ] as const) {
    const h = sharpeRatioHac(rets, L)!
    const nw = neweyWestVariance(rets, L)
    const meanVif = nw === null ? null : nw / iidMeanVar
    console.log(
      `| ${label} | ${h.varTerm.toFixed(6)} | ${h.varTermIid.toFixed(6)} | **${h.varianceInflation.toFixed(4)}** | ` +
        `${h.standardError.toFixed(6)} | ${meanVif === null ? '—' : meanVif.toFixed(4)} |`
    )
  }

  // ---------- 三项分解（P4） ----------
  console.log('\n## 3. `V_GMM` 三项分解 —— 权重把哪一项抹掉了\n')
  const mu = mean(rets)
  const m2 = rets.reduce((s, v) => s + (v - mu) ** 2, 0) / T
  const dev = rets.map((v) => v - mu)
  const sq = dev.map((d) => d * d - m2)
  const vAndrews = sharpeRatioHac(rets, lagA)!.varTerm
  console.log('| 项 | lag=0 | lag=Andrews | 它自己的膨胀 | 在 V_GMM 里占 |')
  console.log('|---|---|---|---|---|')
  // [名字, 左序列, 右序列, 权重] —— 权重就是 ∇g′S∇g 展开后那三项的系数
  const terms: Array<[string, number[], number[], number]> = [
    ['S₁₁/σ²（均值那一项）', dev, dev, 1 / m2],
    ['−(μ/σ⁴)·S₁₂（偏度项）', dev, sq, -mu / (m2 * m2)],
    ['(μ²/4σ⁶)·S₂₂（肥尾/波动聚集项）', sq, sq, (mu * mu) / (4 * m2 * m2 * m2)],
  ]
  for (const [name, a, b, weight] of terms) {
    const s0 = bartlettLongRunCovariance(a, b, 0)!
    const sL = bartlettLongRunCovariance(a, b, lagA)!
    console.log(
      `| ${name} | ${(s0 * weight).toFixed(6)} | ${(sL * weight).toFixed(6)} | ` +
        `${(sL / s0).toFixed(3)}× | ${(((sL * weight) / vAndrews) * 100).toFixed(2)}% |`
    )
  }

  // ---------- η(q) ----------
  console.log('\n## 4. `η(q)`：日频→年化那一步能不能走它\n')
  const rhoFull = autocorrelations(rets, Math.max(BARS_PER_YEAR - 1, lagA))
  const rhoTrunc = rhoFull.slice(0, lagA)
  console.log('| q | η(q)·满阶 | η(q)·截断到 Andrews | √q（IID） | 满阶 vs 截断 |')
  console.log('|---|---|---|---|---|')
  for (const q of [5, 21, BARS_PER_YEAR] as const) {
    const full = etaFromRho(q, rhoFull)
    const trunc = etaFromRho(q, rhoTrunc)
    const gap = full !== null && trunc !== null ? `${(((full - trunc) / trunc) * 100).toFixed(1)}%` : '—'
    console.log(
      `| ${q} | ${full === null ? '—' : full.toFixed(3)} | ${trunc === null ? '—' : trunc.toFixed(3)} | ` +
        `${Math.sqrt(q).toFixed(3)} | ${gap} |`
    )
  }
  const etaYear = etaFromRho(BARS_PER_YEAR, rhoTrunc)
  if (etaYear !== null) {
    console.log(
      `\n按截断口径把日频夏普年化：**${(hac0.sharpe * etaYear).toFixed(4)}**（朴素 √243 给 ${(hac0.sharpe * Math.sqrt(BARS_PER_YEAR)).toFixed(4)}）`
    )
  }
  console.log(
    '\n> ⚠ 我们的夏普是**负**的 ⇒ η(q) < √q 表现为「把坏放大」，' +
      '不许说成「高估了收益」（M2 §5.50 易读错 ②）。'
  )

  // ---------- 顺带：这个夏普自己的 t ----------
  console.log('\n## 5. 顺带：这条曲线的夏普自己的 t（**描述性，不是对任何结论的重判**）\n')
  console.log('| 滞后阶 | 年化夏普 | 年化标准误 | \\|t\\| |')
  console.log('|---|---|---|---|')
  for (const [label, L] of [
    ['iid（lag=0）', 0],
    [`Andrews ${lagA}`, lagA],
    [`持仓期 ${lagH}`, lagH],
  ] as const) {
    const h = sharpeRatioHac(rets, L)!
    const annSe = h.standardError * Math.sqrt(BARS_PER_YEAR)
    console.log(
      `| ${label} | ${(h.sharpe * Math.sqrt(BARS_PER_YEAR)).toFixed(4)} | ${annSe.toFixed(4)} | ` +
        `${Math.abs(h.sharpe / h.standardError).toFixed(3)} |`
    )
  }
  console.log(
    '\n> `t` 与年化无关（分子分母同乘 √243）。**这不推翻任何既有结论** —— ' +
      '从来没有任何一处声称过这条曲线的夏普显著；它只是把「不显著」这件事写成了一个数，' +
      '并给已登记的「回测报告加一行显著性门槛」那条备好了标准误。'
  )
}

main()
