/**
 * **两条相关曲线的夏普之差**：标准误、自检、以及「朴素合成 SE 高估多少倍」
 * —— [学习任务 · A 道](../../.claude/skills/迭代/SKILL.md)，预注册在
 * [M2 §5.60](../../docs/notes/M2-偏差报告.md)。
 *
 * ```bash
 * npx tsx scripts/verify/sharpe-diff.ts
 * npx tsx scripts/verify/sharpe-diff.ts --report reports/calib/cap-100000.json --fixtures ./data/history
 * ```
 *
 * ## 它在补的缺口
 *
 * 项目有**单条**曲线夏普的 HAC 方差（`sharpeRatioHac`，Lo 2002，M2 §5.50），
 * 但**两条曲线之差**一处都没有 ⇒ §5.59 判据 B 的夏普那半条只能报 Δ 不能判、
 * §5.51 ③ 那张表只能拿「合成 HAC SE」（两条单腿 SE 平方相加）当参照。
 * 而合成口径隐含 `Cov = 0`：**两条腿越相关，它越偏大** ⇒ 把测得出的差别判成测不出，
 * 方向**不保守**。
 *
 * ## 三节
 *
 * 1. **自检**（`selfCheck`）—— 这一节是本文件唯一的正确性保证，别删：
 *    - ① 在 IID 二元正态的解析 `Ψ` 上算 `∇f′Ψ∇f`，与 **Memmel (2003) 的闭式**比。
 *      两个候选闭式一起打（网上流传两种写法，其中一种是错的，见 M2 §5.60）。
 *    - ② 拿定种子的模拟二元正态样本喂 `sharpeDiffHac(lag = 0)`，与 ① 的解析值比。
 *      ①只验代数，②验从数据到结果那条完整路径。
 * 2. **低 `ρ` 配对**：回测策略净值 vs 基准（训练窗口，平均占用 3.50%）。
 * 3. **高 `ρ` 配对**：波动率目标化 vs 常年满仓（SH000300 全期）。
 *
 * ## 边界
 *
 * - **只读**：不改引擎、不改任何点估计、不落库。上界卡 2023-12-31 ⇒ `--touch-test` 不变。
 * - **不重判任何已报过的实验**（§8 / §12 的裁决保持原样）。这里的数只是口径演示，
 *   新判据的用途是**下一次预注册时挑**，不是回头重读。
 * - 滞后阶一律走 Andrews 规则，**不许看着结果挑**。
 */
import { readFileSync } from 'node:fs'
import { andrewsLag } from '../../src/backtest/ic-audit'
import { BARS_PER_YEAR, alignedReturns, sharpeDiffHac } from '../../src/backtest/metrics'
import { DEFAULT_COSTS } from '../../src/backtest/costs'
import { loadBars, returnsOfBars, simulatePath, volTargetLegs } from '../../src/backtest/vol-target'

const num = (x: number | null | undefined, d = 4): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d)

/** 命令行取值 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback
}

// ────────────────────────────── 1. 自检 ──────────────────────────────

/**
 * IID 二元正态下 `Ψ` 的解析形式（LW 记法：未中心化二阶矩坐标）。
 *
 * `y_t = (u, v, u²−σ_a²+2μ_a u, v²−σ_b²+2μ_b v)′`，其中 `u = r_a−μ_a`、`v = r_b−μ_b`。
 * 用到的只有联合正态的三阶矩为 0 与 `Cov(u²,v²) = 2σ_ab²`。
 */
function analyticPsi(muA: number, muB: number, sdA: number, sdB: number, rho: number): number[][] {
  const va = sdA * sdA
  const vb = sdB * sdB
  const cab = rho * sdA * sdB
  return [
    [va, cab, 2 * muA * va, 2 * muB * cab],
    [cab, vb, 2 * muA * cab, 2 * muB * vb],
    [2 * muA * va, 2 * muA * cab, 2 * va * va + 4 * muA * muA * va, 2 * cab * cab + 4 * muA * muB * cab],
    [2 * muB * cab, 2 * muB * vb, 2 * cab * cab + 4 * muA * muB * cab, 2 * vb * vb + 4 * muB * muB * vb],
  ]
}

/** LW Eq. (4) 的 `∇f`，参数是 `(μ_a, μ_b, γ_a, γ_b)` */
function gradient(muA: number, muB: number, sdA: number, sdB: number): number[] {
  const va = sdA * sdA
  const vb = sdB * sdB
  const gA = va + muA * muA
  const gB = vb + muB * muB
  return [gA / va ** 1.5, -gB / vb ** 1.5, (-muA / 2) * va ** -1.5, (muB / 2) * vb ** -1.5]
}

function quadratic(g: readonly number[], m: readonly number[][]): number {
  let sum = 0
  for (let i = 0; i < g.length; i++) {
    for (let j = 0; j < g.length; j++) sum += (g[i] ?? 0) * (g[j] ?? 0) * (m[i]?.[j] ?? 0)
  }
  return sum
}

/** 定种子 LCG + Box–Muller ⇒ 可复现的二元正态样本 */
function bivariateNormal(
  n: number,
  muA: number,
  muB: number,
  sdA: number,
  sdB: number,
  rho: number
): { a: number[]; b: number[] } {
  /*
    mulberry32 —— **必须用 32 位整数运算**（`Math.imul` + `>>>`）。
    第一版写的是教科书 LCG `seed = (seed*1103515245 + 12345) % 2^31`，
    在 JS 的双精度里乘积超过 2^53 ⇒ 低位被截掉 ⇒ 生成的正态样本相关与峰度都偏
    ⇒ 自检 ② 稳定差 **2.56% 且不随 T 收敛**。那个形状值得记住：
    **「不收敛」而不是「收敛到别处」，指的是生成器坏了，不是估计量有偏。**
  */
  let seed = 20260826 >>> 0
  const unif = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 + 1e-12
  }
  const a: number[] = []
  const b: number[] = []
  for (let i = 0; i < n; i++) {
    const u1 = unif()
    const u2 = unif()
    const r = Math.sqrt(-2 * Math.log(u1))
    const z1 = r * Math.cos(2 * Math.PI * u2)
    const z2 = r * Math.sin(2 * Math.PI * u2)
    a.push(muA + sdA * z1)
    b.push(muB + sdB * (rho * z1 + Math.sqrt(1 - rho * rho) * z2))
  }
  return { a, b }
}

function selfCheck(): void {
  console.log('## 1. 自检\n')
  const cases = [
    { muA: 0.0008, muB: 0.0005, sdA: 0.011, sdB: 0.014, rho: 0.92 },
    { muA: 0.0003, muB: -0.0002, sdA: 0.004, sdB: 0.013, rho: 0.18 },
    { muA: 0.002, muB: 0.001, sdA: 0.02, sdB: 0.02, rho: -0.4 },
  ]
  console.log('### ① 解析 `Ψ` 上的 `∇f′Ψ∇f` vs 三种写法的 Memmel 闭式\n')
  console.log(
    '**正**：`θ̂ = (1/T)[2σ_a²σ_b² − 2σ_aσ_bσ_ab + ½μ_a²σ_b² + ½μ_b²σ_a² − (μ_aμ_b/(σ_aσ_b))σ_ab²]`\n' +
      '除以 `σ_a²σ_b²` ⇒ **`2 − 2ρ + ½SR_a² + ½SR_b² − ρ²·SR_a·SR_b`**（Jobson–Korkie 的统计量是\n' +
      '`σ_b μ̂_a − σ_a μ̂_b = σ_aσ_b·Δ̂`，所以要除的正是 `σ_a²σ_b²`）。\n' +
      '**误甲**：把最后一项写成 `−½(1+ρ²)SR_aSR_b`（网上常见）· **误乙**：`2 + ½(SR_a²+SR_b²−2ρSR_aSR_b)`（第一次检索给的）\n'
  )
  console.log('| # | ρ | SR_a | SR_b | **∇f′Ψ∇f**（LW 原文的 Ψ/∇f） | 正 | 相对差 | 误甲 | 相对差 | 误乙 | 相对差 |')
  console.log('|---|---|---|---|---|---|---|---|---|---|---|')
  let analytic0 = 0
  cases.forEach((c, k) => {
    const srA = c.muA / c.sdA
    const srB = c.muB / c.sdB
    const q = quadratic(
      gradient(c.muA, c.muB, c.sdA, c.sdB),
      analyticPsi(c.muA, c.muB, c.sdA, c.sdB, c.rho)
    )
    if (k === 0) analytic0 = q
    const base = 2 - 2 * c.rho + 0.5 * srA * srA + 0.5 * srB * srB
    const ok = base - c.rho * c.rho * srA * srB
    const bad1 = base - ((srA * srB) / 2) * (1 + c.rho * c.rho)
    const bad2 = 2 + 0.5 * (srA * srA + srB * srB - 2 * c.rho * srA * srB)
    console.log(
      `| ${k + 1} | ${c.rho} | ${num(srA)} | ${num(srB)} | **${num(q, 8)}** | ${num(ok, 8)} | ` +
        `${num(Math.abs(ok / q - 1), 12)} | ${num(bad1, 6)} | ${num(Math.abs(bad1 / q - 1), 6)} | ` +
        `${num(bad2, 6)} | ${num(Math.abs(bad2 / q - 1), 6)} |`
    )
  })

  console.log('\n### ② 模拟数据（定种子）喂 `sharpeDiffHac(lag = 0)` vs ① 的解析值\n')
  const c0 = cases[0]
  if (!c0) return
  console.log('| T | 实测 `T·SE²` | 解析 `∇f′Ψ∇f` | 相对差 |')
  console.log('|---|---|---|---|')
  for (const n of [20000, 200000, 1000000]) {
    const { a, b } = bivariateNormal(n, c0.muA, c0.muB, c0.sdA, c0.sdB, c0.rho)
    const r = sharpeDiffHac(a, b, 0)
    if (!r) continue
    const q = r.standardError * r.standardError * n
    console.log(`| ${n} | ${num(q, 6)} | ${num(analytic0, 6)} | ${num(Math.abs(q / analytic0 - 1), 6)} |`)
  }
}

// ────────────────────────────── 2/3. 两个配对 ──────────────────────────────

function report(
  title: string,
  a: readonly number[],
  b: readonly number[],
  labelA: string,
  labelB: string
): void {
  const lag = andrewsLag(Math.min(a.length, b.length))
  const r = sharpeDiffHac(a, b, lag)
  console.log(`\n### ${title}\n`)
  if (!r) {
    console.log('算不出（样本不足或方差为 0）')
    return
  }
  const ann = Math.sqrt(BARS_PER_YEAR)
  console.log(`| 量 | 值 |`)
  console.log(`|---|---|`)
  console.log(`| 配对根数 | ${r.bars} · 滞后阶 ${r.lag}（Andrews） |`)
  console.log(`| 年化夏普 ${labelA} | **${num(r.sharpeA * ann, 3)}** |`)
  console.log(`| 年化夏普 ${labelB} | **${num(r.sharpeB * ann, 3)}** |`)
  console.log(`| 年化 Δ | **${num(r.delta * ann, 3)}** |`)
  console.log(`| **两腿相关 ρ** | **${num(r.rho, 4)}** |`)
  console.log(`| LW SE（年化） | **±${num(r.standardError * ann, 3)}** |`)
  console.log(`| 同一份数据 IID 档（lag 0） | ±${num(r.standardErrorIid * ann, 3)} |`)
  console.log(`| HAC / IID | ${num(r.standardError / r.standardErrorIid, 3)} |`)
  console.log(`| **朴素合成 SE**（两条单腿平方相加） | ±${num(r.naiveCombinedSe * ann, 3)} |`)
  console.log(`| **朴素 / LW** | **${num(r.naiveRatio, 2)} 倍** |`)
  console.log(`| \`z\` | **${num(r.z, 3)}** · p = ${num(r.pValue, 4)} |`)
}

function main(): void {
  const fixtures = arg('--fixtures', './data/history')
  const reportPath = arg('--report', 'reports/calib/cap-100000.json')
  console.log('# 两条相关曲线的夏普之差（Jobson–Korkie → Memmel → Ledoit–Wolf 2008）\n')
  selfCheck()

  console.log('\n## 2. 低 `ρ` 配对：回测策略 vs 基准\n')
  try {
    const raw = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      meta?: { engineVersion?: string }
      equity?: { date: string; equity: number; benchmark: number | null }[]
    }
    const points = raw.equity ?? []
    const { strategy, benchmark } = alignedReturns(points)
    console.log(
      `来源 \`${reportPath}\`（${raw.meta?.engineVersion ?? '—'} · ` +
        `${points[0]?.date ?? '—'} → ${points[points.length - 1]?.date ?? '—'}）`
    )
    report('策略 vs 沪深300', strategy, benchmark, '策略', '基准')
  } catch (e) {
    console.log(`读不到 \`${reportPath}\`：${String(e)}`)
  }

  console.log('\n## 3. 高 `ρ` 配对：波动率目标化 vs 常年满仓（SH000300 全期）\n')
  const bars = loadBars(fixtures, 'SH000300')
  const rets = returnsOfBars(bars)
  const idx: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]?.date ?? ''
    if (d >= '2005-04-08' && d <= '2023-12-31') idx.push(i)
  }
  const legs = volTargetLegs(rets, idx)
  const vol = simulatePath(legs.returns, legs.volWeights, DEFAULT_COSTS)
  const pas = simulatePath(legs.returns, legs.passiveWeights, DEFAULT_COSTS)
  console.log(`${legs.returns.length} 根 · 与 §5.59 同一份数据、同一套常量（\`σ_target\` 未动）`)
  report('目标化 vs 满仓', vol.daily, pas.daily, '目标化', '满仓')

  console.log(
    '\n---\n\n⚠ **这里的数不重判任何已报过的实验**（§8 / §12 的裁决保持原样）。' +
      '新判据的用途是**下一次预注册时从里面挑**，不是回头重读 —— 那是移动球门。'
  )
}

main()
