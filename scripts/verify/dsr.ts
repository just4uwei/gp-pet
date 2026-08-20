/**
 * **Deflated Sharpe Ratio（DSR）**：把「我们一共试了多少个候选」这件事折进夏普的显著性。
 *
 * ```bash
 * npx tsx scripts/verify/dsr.ts                    # 默认读 reports/calib/ 下那 10 张网格 + cap-100000.json
 * npx tsx scripts/verify/dsr.ts --baseline cap-100000.json
 * ```
 *
 * ## 它回答的问题（M2 §5.48 / 差距文档 §2.3）
 *
 * 「多重比较的正式处理」此前**只靠人的克制** —— 一条写在文档里的纪律
 * （「每个机制只报一次分位」）。而 2026-08-20 刚证过一次「写下一条纪律不等于装上一道闸门」
 * （§5.44 的预注册当天就被 `pnpm iterate` 的看板违反）。这个脚本给出那个门槛的**数**：
 * 给定我们这次搜索的跨候选夏普离散度与试验数 `N`，未来一个候选要多少夏普才算发现。
 *
 * ## 口径与归属
 *
 * - **DSR**：Bailey & López de Prado (2014), *The Deflated Sharpe Ratio*, JPM 40(5) 94–107。
 *   它是 **PSR**（Bailey & LdP 2012）把门槛从 `SR*` 换成 `SR̂₀` 的版本。
 * - PSR 分母那个「非正态下夏普估计量的渐近方差」更早，通常归 **Mertens (2002)** / Lo (2002)。
 * - `SR̂₀ = √V[{SR̂ₙ}] · ((1−γ)·Z⁻¹[1 − 1/N] + γ·Z⁻¹[1 − (1/N)e⁻¹])`，`γ` = 欧拉–马歇罗尼常数。
 * - `DSR = Φ((SR̂ − SR̂₀)·√(T−1) / √(1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²))`。
 *
 * ## ⚠ 三处易读错（都会静默给出一个荒谬的数，不报错）
 *
 * 1. **`SR̂`、`SR̂₀`、`T` 必须同频，而且是原始频率不是年化。**
 *    我们报告里的 `performance.sharpe` 是 `mean/sd × √243`（`metrics.ts` 的 `BARS_PER_YEAR`）——
 *    把它直接配 `T = 1457 天` 会把统计量放大 **√243 ≈ 15.6 倍**；而 `γ₃/γ₄` 根本不随年化缩放，
 *    混着用是内部不一致。本脚本内部**全程用日频**，只在打印时乘回 `√243` 供人读。
 * 2. **`γ₄` 是皮尔逊峰度（正态 = 3）**，不是超额峰度（正态 = 0）。
 * 3. **`N` 要的是「独立」试验数**，而我们 27 个轴是围绕同一出厂值的 OFAT 微扰 ⇒ 高度相关。
 *    相关性同时朝两个方向偏：让 `N` 偏大（门槛偏高、保守），也让 `V[{SR̂ₙ}]` 被压小
 *    （门槛偏低、反保守）。**不许只说其中一个方向。**
 *
 * ## ⚠ `N` 是这个统计量唯一的软肋
 *
 * 它由研究者自己申报、外部无法审计 ⇒ 与「调滞后阶到显著为止」同一形状的 p-hacking 通道
 * （这里叫「调小 N 到通过为止」）。所以本脚本**一次打印三档 `N`**，不给「选一个」的接口。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  BARS_PER_YEAR,
  mean,
  normCdf,
  normInv,
  pearsonKurtosis,
  returnsFromEquity,
  sampleStdev,
  sharpeVarianceTerm,
  skewness,
} from './stats'

const CALIB_DIR = join(process.cwd(), 'reports', 'calib')
const EULER_MASCHERONI = 0.5772156649015329

/** 那 10 张 `--grid` 报告（顶层含 `candidates` 的都算） */
function gridFiles(): string[] {
  return readdirSync(CALIB_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => {
      try {
        const j = JSON.parse(readFileSync(join(CALIB_DIR, f), 'utf8')) as Record<string, unknown>
        return Array.isArray(j['candidates']) && Array.isArray(j['splits'])
      } catch {
        return false
      }
    })
    .sort()
}

interface Trial {
  file: string
  fingerprint: string
  axis: string | null
  incumbent: boolean
  sharpeAnnual: number
  bars: number
}

function collectTrials(files: readonly string[]): Trial[] {
  const out: Trial[] = []
  for (const file of files) {
    const j = JSON.parse(readFileSync(join(CALIB_DIR, file), 'utf8')) as {
      candidates: Array<{
        fingerprint: string
        axis: string | null
        incumbent?: boolean
        train?: { sharpe?: number | null; bars?: number }
      }>
    }
    for (const c of j.candidates) {
      const sr = c.train?.sharpe
      const bars = c.train?.bars
      if (typeof sr !== 'number' || !Number.isFinite(sr) || typeof bars !== 'number') continue
      out.push({
        file,
        fingerprint: c.fingerprint,
        axis: c.axis ?? null,
        incumbent: c.incumbent === true,
        sharpeAnnual: sr,
        bars,
      })
    }
  }
  return out
}

/**
 * 期望最大夏普 `SR̂₀`（零均值零假设下）。`sdTrials` 与返回值同频。
 *
 * `SR̂₀ = sd · ((1−γ)·Z⁻¹[1 − 1/N] + γ·Z⁻¹[1 − (1/N)e⁻¹])`
 */
function expectedMaxSharpe(sdTrials: number, n: number): number {
  const g = EULER_MASCHERONI
  return sdTrials * ((1 - g) * normInv(1 - 1 / n) + g * normInv(1 - 1 / (n * Math.E)))
}

/** DSR。`denomAt` 决定分母那一项用观测到的 `SR̂`（原式）还是 `SR̂₀`（某些转述里的写法） */
function dsr(
  srDaily: number,
  sr0Daily: number,
  t: number,
  skew: number,
  kurt: number,
  denomAt: 'observed' | 'benchmark',
): { z: number; p: number; denom: number } {
  const s = denomAt === 'observed' ? srDaily : sr0Daily
  const denom = Math.sqrt(sharpeVarianceTerm(s, skew, kurt))
  const z = ((srDaily - sr0Daily) * Math.sqrt(t - 1)) / denom
  return { z, p: normCdf(z), denom }
}

/** 解出让 `DSR = target` 的最小日频 `SR̂`（分母用观测值 ⇒ 单调，二分即可） */
function requiredSharpe(sr0Daily: number, t: number, skew: number, kurt: number, target = 0.95): number {
  const z = normInv(target)
  let lo = sr0Daily
  let hi = sr0Daily + 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const got = dsr(mid, sr0Daily, t, skew, kurt, 'observed').z
    if (got < z) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function pct(x: number, digits = 4): string {
  return x.toFixed(digits)
}

/**
 * **自检：复现作者自己那个算例**（López de Prado, *Deflating the Sharpe Ratio* 讲稿
 * 「Numerical Example」那两页，2026-08-20 从 semanticscholar 镜像取到正文核对）。
 *
 * 原话：*"An analyst uncovers a daily strategy with annualized SR=2.5, after running N=100
 * independent trials, where [V=0.5], T=1250 … QUESTION: Is this a legitimate discovery,
 * at a 95% conf.? ANSWER: No. There is only a **90%** probability that the true Sharpe
 * ratio is above zero."*（偏度 −3 / 峰度 10）
 *
 * 这个算例同时钉住那条最容易错的口径：**作者给的是年化 2.5，而计算要在日频做** ——
 * 不除 √252、不把 `V[SR]` 除 252，得到的数与 90% 差得没边。所以这条自检不是形式主义，
 * 它就是在守「频率」那一条。
 */
function selfTest(): { ok: boolean; got: number } {
  const T = 1250
  const srDaily = 2.5 / Math.sqrt(252) // ⚠ 去年化
  const sdTrials = Math.sqrt(0.5 / 252) // ⚠ 方差同样要除 252
  const sr0 = expectedMaxSharpe(sdTrials, 100)
  const got = dsr(srDaily, sr0, T, -3, 10, 'observed').p
  return { ok: Math.abs(got - 0.9) < 0.005, got }
}

function main(): void {
  const baselineArg = process.argv.includes('--baseline')
    ? process.argv[process.argv.indexOf('--baseline') + 1]!
    : 'cap-100000.json'

  // ---- 1. 跨候选的夏普分布 -------------------------------------------------
  const files = gridFiles()
  const trials = collectTrials(files)
  const byFingerprint = new Map<string, Trial>()
  for (const t of trials) if (!byFingerprint.has(t.fingerprint)) byFingerprint.set(t.fingerprint, t)
  const uniq = [...byFingerprint.values()]
  const annual = uniq.map((t) => t.sharpeAnnual)
  const daily = annual.map((s) => s / Math.sqrt(BARS_PER_YEAR))
  const sdDaily = sampleStdev(daily)
  const sorted = [...annual].sort((a, b) => a - b)

  console.log('# DSR —— 多重比较的正式处理（M2 §5.48）\n')
  const st = selfTest()
  console.log(
    `## 0. 自检：复现作者讲稿里的算例（年化 SR 2.5 · N=100 · V=0.5 · T=1250 · 偏度 −3 · 峰度 10）\n`,
  )
  console.log(`作者的答案是「只有 **90%**」，本脚本算出 **${st.got.toFixed(4)}** ⇒ ${st.ok ? '✅ 一致' : '❌ 不一致，先别看下面的数'}`)
  if (!st.ok) process.exitCode = 1
  console.log('\n## 1. 跨候选的夏普分布（`V[{SR̂ₙ}]`）\n')
  console.log(`网格报告 ${files.length} 份：${files.join(' · ')}`)
  console.log(`候选行 ${trials.length} 行 ⇒ 去重（按 paramsFingerprint）后 **${uniq.length}** 个配置`)
  console.log(`其中出厂配置 ${uniq.filter((t) => t.incumbent).length} 个 · OFAT 轴 ${new Set(uniq.map((t) => t.axis).filter(Boolean)).size} 个`)
  console.log(`训练窗口 bars = ${uniq[0]!.bars}`)
  console.log('')
  console.log(`年化夏普：最小 ${pct(sorted[0]!)} · 中位 ${pct(sorted[Math.floor(sorted.length / 2)]!)} · 最大 ${pct(sorted[sorted.length - 1]!)} · 极差 ${pct(sorted[sorted.length - 1]! - sorted[0]!)}`)
  console.log(`年化夏普 sd = ${pct(sampleStdev(annual))} ⇒ 日频 sd = ${pct(sdDaily, 6)}`)
  const m = mean(annual)
  const sdA = sampleStdev(annual)
  const outliers = uniq.filter((t) => Math.abs(t.sharpeAnnual - m) > 3 * sdA)
  console.log(`离群（|x−mean| > 3sd）：${outliers.length === 0 ? '无' : outliers.map((t) => `${t.file}:${t.axis}=${pct(t.sharpeAnnual)}`).join(' · ')}`)
  console.log(`夏普为正的候选：${annual.filter((s) => s > 0).length} / ${annual.length}`)

  // ---- 2. 基线的逐日收益 ---------------------------------------------------
  const base = JSON.parse(readFileSync(join(CALIB_DIR, baselineArg), 'utf8')) as {
    meta: { engineVersion: string; codes: string[] }
    performance: { sharpe: number | null; totalReturn: number; maxDrawdown: number }
    equity: Array<{ date: string; equity: number }>
  }
  const rets = returnsFromEquity(base.equity)
  const t = rets.length
  const srDaily = mean(rets) / sampleStdev(rets)
  const skew = skewness(rets)
  const kurt = pearsonKurtosis(rets)

  console.log('\n## 2. 基线（出厂口径）的逐日收益\n')
  console.log(`来源 ${baselineArg} · ${base.meta.engineVersion} · ${base.meta.codes.length} 只`)
  console.log(`T = ${t} 个日收益（equity ${base.equity.length} 点）`)
  console.log(`日频 SR̂ = ${pct(srDaily, 6)} ⇒ ×√243 = ${pct(srDaily * Math.sqrt(BARS_PER_YEAR))}（报告里印的是 ${pct(base.performance.sharpe ?? NaN)} —— 接线核对）`)
  console.log(`γ₃（偏度） = ${pct(skew)} · γ₄（**皮尔逊**峰度） = ${pct(kurt)}（正态 = 3；超额峰度 = ${pct(kurt - 3)}）`)

  // ---- 3. 三档 N ----------------------------------------------------------
  console.log('\n## 3. `SR̂₀`（期望最大夏普）与门槛：三档 `N` 预承诺，不许挑\n')
  console.log('| N | 口径 | `SR̂₀`（日频） | `SR̂₀` 年化 | DSR>0.95 需要的年化夏普 | 基线 DSR（分母用 SR̂） | 基线 DSR（分母用 SR̂₀） |')
  console.log('|---|---|---|---|---|---|---|')
  const labels: Record<number, string> = {
    27: '下界：一个 OFAT 轴算一次试验',
    99: '**主口径**：去重后的网格配置数',
    300: '上界：粗覆盖「所有试过的东西」',
  }
  for (const n of [27, uniq.length, 300]) {
    const sr0 = expectedMaxSharpe(sdDaily, n)
    const need = requiredSharpe(sr0, t, skew, kurt)
    const a = dsr(srDaily, sr0, t, skew, kurt, 'observed')
    const b = dsr(srDaily, sr0, t, skew, kurt, 'benchmark')
    console.log(
      `| ${n} | ${labels[n] ?? '—'} | ${pct(sr0, 6)} | ${pct(sr0 * Math.sqrt(BARS_PER_YEAR))} | **${pct(need * Math.sqrt(BARS_PER_YEAR))}** | ${a.p.toFixed(6)} | ${b.p.toFixed(6)} |`,
    )
  }
  // 分解：门槛里有多少是「样本长度」、多少是「多重比较」。
  // ⚠ 这一段是**看过结果之后**加的（M2 §5.48 如实披露）——它只是把上面那张表拆开，
  // 不引入新判据、不换 N，纯粹为了回答「那 0.98 里哪一部分是选择偏差的锅」。
  const needSingle = requiredSharpe(0, t, skew, kurt)
  const needMain = requiredSharpe(expectedMaxSharpe(sdDaily, uniq.length), t, skew, kurt)
  console.log('\n### 分解：门槛里样本长度占多少、多重比较占多少（事后加的）\n')
  console.log(`单次试验（N=1 ⇒ SR̂₀=0，只有 √(T−1) 那一项在起作用）：需要年化夏普 **${pct(needSingle * Math.sqrt(BARS_PER_YEAR))}**`)
  console.log(`主口径（N=${uniq.length}）：需要年化夏普 **${pct(needMain * Math.sqrt(BARS_PER_YEAR))}**`)
  console.log(`⇒ 多重比较那一刀只加了 **${pct(needMain * Math.sqrt(BARS_PER_YEAR) - needSingle * Math.sqrt(BARS_PER_YEAR))}**（占门槛的 ${((1 - needSingle / needMain) * 100).toFixed(1)}%），剩下的 ${pct(needSingle * Math.sqrt(BARS_PER_YEAR))} 全是「1457 根 K 线就是不够长」`)

  const z27 = Math.sqrt(2 * Math.log(27))
  const z300 = Math.sqrt(2 * Math.log(300))
  console.log(`\n`)
  console.log(`√(2 ln N)：N=27 ⇒ ${pct(z27)} · N=99 ⇒ ${pct(Math.sqrt(2 * Math.log(uniq.length)))} · N=300 ⇒ ${pct(z300)}（E[max Z] 随 N 只按这个速度长）`)
  console.log(`两种分母写法在基线上的 DSR 之差：${Math.abs(dsr(srDaily, expectedMaxSharpe(sdDaily, uniq.length), t, skew, kurt, 'observed').p - dsr(srDaily, expectedMaxSharpe(sdDaily, uniq.length), t, skew, kurt, 'benchmark').p).toExponential(2)}`)
  console.log(
    `\n⚠ 门槛那一列用的是**基线的** γ₃/γ₄（${pct(skew)}/${pct(kurt)}）当替身 —— 未来那个候选的高阶矩不会一样，` +
      `所以它是量级而不是一条精确的线。`,
  )
}

main()
