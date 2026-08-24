/**
 * **池外参照**：同风险 / 同占用的被动持有，作为「值不值得做」的对照（M2 §5.52）。
 *
 * ```bash
 * npx tsx scripts/verify/outside-pool.ts
 * ```
 *
 * ## 它填的是哪个洞
 *
 * [差距文档 §2.2](../../docs/notes/与机构量化系统的差距.md) 把「池外参照」判成**真空**、
 * 标着优先级最高：报告里的 `benchmarkReturn` 是**满仓**的，而我们占用 3.50%
 * ⇒ 两者不可比（§5.13）。现有的三个数（`exposure` / `beta` / 除法版超额）
 * **指出了病但没给药**。
 *
 * ## 口径与归属
 *
 * - **GH1 / GH2**：Graham & Harvey，**JFE 42 (1996) 397–421** 与 **FAJ 53 (1997) 54–66**。
 *   - `GH1 = R_p − R_{基准@σ_p}`：把**基准**与现金混到 σ 等于组合的 σ，再比收益。
 *   - `GH2 = R_{p@σ_m} − R_m`：反过来把**组合**放大到基准的 σ。
 * - **M² (RAP)**：Modigliani & Modigliani，*Risk-Adjusted Performance*, **JPM 23 (1997) 45–54**。
 *   `RAP = R_f + (R_p − R_f)(σ_m/σ_p)`，差分 `M² = (R_p−R_f)(σ_m/σ_p) − (R_m−R_f)`。
 *   **它是 GH2 的闭式版**，且恒等于 `(SR_p − SR_m)·σ_m`（本脚本数值验证这条恒等式）。
 *
 * ## ⚠ 四处易读错
 *
 * 1. **GH1 与 GH2 不是同一个「能不能做」的问题。** GH1 只需要**减**杠杆（基准与现金混）
 *    ⇒ 散户真能执行；GH2/M² 要把组合放大到基准的 σ，而我们 `σ_m/σ_p ≈ 24`
 *    ⇒ **24 倍杠杆**，A 股个人账户拿不到。
 * 2. **M² 的差分形式是夏普之差乘一个常数** ⇒ **不带新信息**，只是换成百分点单位。
 *    文献推荐它是**可读性**理由（夏普为负时不好读），不是信息量理由。
 * 3. **`σ_m/σ_p` 会把 `R_f` 同倍放大**（M² 里 `R_f` 的系数是 `σ_m/σ_p − 1 ≈ 23`）
 *    ⇒ 低暴露策略上 M² 的符号由 `R_f` 支配，与 §5.41 否掉 CAPM alpha 的机制同源、放大 24 倍。
 * 4. **两个匹配权重是两个问题**：`w = σ_p/σ_m`（GH1 的按波动匹配）
 *    与 `w = exposure`（§2.2 要的按资金占用匹配）。**都报，不许混着引用。**
 *
 * ## 边界
 *
 * - 现金按 **0** 计息（与 `performance.sharpe` 的 rf = 0、与「回测不给现金计息」一致）。
 * - 参照组合是**每日恒定权重**（constant mix）—— 这正是 GH 的原意：
 *   「同波动但权重恒定」才是给择时者的对照。
 * - **`etf-train.json` 刻意不算**：那份是活着的产品决策输入，事后加判定维度 = 移动球门。
 * - 只读 2025-06 之前的报告，`--touch-test` 不变。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BARS_PER_YEAR,
  alignedReturns,
  mean,
  sameRiskPassive,
  sampleStdev,
} from '../../src/backtest/metrics'

const CALIB_DIR = join(process.cwd(), 'reports', 'calib')

/** 用户 2026-08-21 拍板的无风险利率；这里**只用来量 M² 对它有多敏感** */
const RF_ANNUAL = 0.02

interface Report {
  meta: { engineVersion: string; codes: string[]; from: string; to: string; capitalPerCode: number }
  equity: Array<{ date: string; equity: number; benchmark: number | null }>
  performance: {
    totalReturn: number
    benchmarkReturn: number | null
    exposure: number | null
    sharpe: number | null
  }
}

const load = (name: string): Report =>
  JSON.parse(readFileSync(join(CALIB_DIR, `${name}.json`), 'utf8')) as Report

/** 恒定权重 `w` 混现金（现金 0 息）的复利收益：`Π(1 + w·r_t) − 1` */
function mixedReturn(benchmark: readonly number[], w: number): number {
  let growth = 1
  for (const r of benchmark) growth *= 1 + w * r
  return growth - 1
}

/** 复利收益（用来核对与报告里的 totalReturn 对得上） */
function compound(rets: readonly number[]): number {
  let g = 1
  for (const r of rets) g *= 1 + r
  return g - 1
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

function pp(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}pp`
}

/**
 * ⚠ **GH1 必须只在「评估期」上算，不能带预热段。**
 *
 * 预热段里策略是**结构性**空仓（300 根预热还没走完，不是它选择不出手），
 * 而基准那 15 个月照常涨跌 ⇒ 把预热段算进去等于**白送给被动参照一段市场暴露**，
 * 这个比较是被做坏了的、方向还固定不利于策略。
 *
 * 踩过：`abl-valid-base`（`--from 2024-01-01`，无段前历史）18 个月里
 * **前 15 个月净值一动不动**，首个变动日 2025-04-07，建仓只有 34 次 ——
 * 那正是 CLAUDE.md「跑验证窗口必须带段前历史」那条坑的原始物证（M2 §5.52）。
 */
function analyze(name: string, label: string, evalFrom?: string): void {
  const rep = load(name)
  const points = evalFrom === undefined ? rep.equity : rep.equity.filter((p) => p.date >= evalFrom)
  const { strategy, benchmark } = alignedReturns(points)
  const T = Math.min(strategy.length, benchmark.length)
  if (evalFrom !== undefined) {
    console.log(`\n> ⚠ 已切到评估期 \`>= ${evalFrom}\`（丢掉预热段 ${rep.equity.length - points.length} 个净值点）`)
  }

  const sdP = sampleStdev(strategy)
  const sdM = sampleStdev(benchmark)
  const rP = compound(strategy)
  const rM = compound(benchmark)
  // ⚠ 切了评估期之后 `performance.exposure` 是**全窗口**的，不能再用它做占用匹配
  const exposure = evalFrom === undefined ? rep.performance.exposure : null

  console.log(`\n## ${label}（\`${name}\`）\n`)
  console.log(
    `${rep.meta.from} → ${rep.meta.to} · ${rep.meta.codes.length} 只 · ` +
      `每标的资金 ${rep.meta.capitalPerCode} · 严格配对 ${T} 期`
  )
  console.log(
    `策略复利 **${pct(rP)}**（报告 totalReturn ${pct(rep.performance.totalReturn)}）· ` +
      `基准复利 **${pct(rM)}**（报告 ${rep.performance.benchmarkReturn === null ? '—' : pct(rep.performance.benchmarkReturn)}）`
  )
  console.log(
    `σ_p(日) ${(sdP * 100).toFixed(4)}% · σ_m(日) ${(sdM * 100).toFixed(4)}% · ` +
      `**σ_m/σ_p = ${(sdM / sdP).toFixed(1)}** · 平均占用 ${exposure === null ? '—' : pct(exposure)}`
  )

  // ---- GH1：两个匹配口径 ----
  // ⚠ σ 匹配那一档 2026-08-24 起**进了报告**（`metrics.sameRiskPassive`）⇒ 这里做一次
  // 交叉自检，防止调研工具与报告分叉。占用匹配仍然只在这个工具里（拍板没选它）。
  const wSigma = sdP / sdM
  const fromMetrics = sameRiskPassive(points)
  if (fromMetrics !== null) {
    const dw = Math.abs(fromMetrics.weight - wSigma)
    const dg = Math.abs(fromMetrics.gh1 - (rP - mixedReturn(benchmark, wSigma)))
    console.log(
      `\n> 自检｜与报告口径（\`metrics.sameRiskPassive\`）差：w ${dw.toExponential(2)} · GH1 ${dg.toExponential(2)}`
    )
  }
  const rows: Array<[string, number]> = [['σ 匹配（GH1 原口径）`w = σ_p/σ_m`', wSigma]]
  if (exposure !== null) rows.push(['占用匹配（§2.2 要的那个）`w = exposure`', exposure])

  // ⚠ 最后一列**不是**「波动拖累」：它是复利的凸性，符号由**基准方向**决定
  // （基准跌 ⇒ 混合组合比线性缩放好；基准涨 ⇒ 比线性缩放差）。实测最大 16.81pp
  // ⇒ `w × 基准收益` 这个线性近似绝对不能用（M2 §5.52 P5 是错的那条）。
  console.log('\n| 参照 | w | 参照收益 | **GH1 = 策略 − 参照** | 线性近似 `w×基准` | 复利凸性差 |')
  console.log('|---|---|---|---|---|---|')
  for (const [how, w] of rows) {
    const ref = mixedReturn(benchmark, w)
    const linear = w * rM
    console.log(
      `| ${how} | ${pct(w)} | ${pct(ref)} | **${pp(rP - ref)}** | ${pct(linear)} | ${pp(ref - linear)} |`
    )
  }
  if (exposure !== null) {
    console.log(`\nσ 匹配 w ÷ 占用 = **${(wSigma / exposure).toFixed(2)}×**（同样的钱我们比指数波动多这么多）`)
  }

  // ---- 现有的除法版超额，并排 ----
  const ratioExcess = (1 + rP) / (1 + rM) - 1
  console.log(
    `\n现有口径（**满仓**基准）：除法版超额 **${pp(ratioExcess)}** · 减法版 ${pp(rP - rM)}`
  )

  // ---- GH2 / M² ----
  console.log('\n| M² 口径 | rf | `(R_p−R_f)(σ_m/σ_p)` | `R_m−R_f` | **M²** |')
  console.log('|---|---|---|---|---|')
  const years = T / BARS_PER_YEAR
  const annP = Math.pow(1 + rP, 1 / years) - 1
  const annM = Math.pow(1 + rM, 1 / years) - 1
  const scale = sdM / sdP
  for (const rf of [0, RF_ANNUAL]) {
    const scaled = (annP - rf) * scale
    const m2 = scaled - (annM - rf)
    console.log(`| 年化 | ${pct(rf)} | ${pct(scaled)} | ${pct(annM - rf)} | **${pp(m2)}** |`)
  }
  const m2Rf0 = (annP - 0) * scale - annM
  const m2Rf2 = (annP - RF_ANNUAL) * scale - (annM - RF_ANNUAL)
  console.log(
    `\n两档 M² 相差 **${pp(m2Rf2 - m2Rf0)}** —— 系数是 \`σ_m/σ_p − 1 = ${(scale - 1).toFixed(1)}\`` +
      `，与 rf 之差 ${pct(RF_ANNUAL)} 相乘即得 ⇒ **符号由 rf 支配**`
  )

  // ---- 恒等式自检：M² ≡ (SR_p − SR_m)·σ_m ----
  const shP = (mean(strategy) / sdP) * Math.sqrt(BARS_PER_YEAR)
  const shM = (mean(benchmark) / sdM) * Math.sqrt(BARS_PER_YEAR)
  const sdMAnn = sdM * Math.sqrt(BARS_PER_YEAR)
  const identity = (shP - shM) * sdMAnn
  // 用算术年化（与夏普同口径）复算一遍 M²，两者应逐位相同
  const m2Arith = mean(strategy) * BARS_PER_YEAR * scale - mean(benchmark) * BARS_PER_YEAR
  console.log(
    `恒等式自检（rf=0，算术年化口径）：\`(SR_p − SR_m)·σ_m\` = ${pp(identity)} · ` +
      `直接算 = ${pp(m2Arith)} · 差 ${Math.abs(identity - m2Arith).toExponential(2)}`
  )
}

function main(): void {
  console.log('# 池外参照：同风险 / 同占用的被动持有（M2 §5.52）\n')
  console.log(
    '> `GH1 = R_p − R_{基准@σ_p}`（Graham & Harvey 1996/1997）· ' +
      '`M² = (R_p−R_f)(σ_m/σ_p) − (R_m−R_f)`（Modigliani & Modigliani 1997）\n' +
      '> 现金 0 息 · 参照是每日恒定权重（constant mix）· `etf-train` 刻意不算（M2 §5.52 判据 5）'
  )

  analyze('cap-100000', '训练窗口 · 出厂口径基线')
  analyze('idx-cap-0517', '2005–2017 单指数择时（**已知答案，用来校准工具**）')
  analyze('abl-valid-base', '验证窗口 · **预注册里挑错的那一份**（无段前历史，15/18 个月空仓 ⇒ 下面的数不可用）')
  analyze(
    'v2-base',
    '验证窗口 · **修正后**（`--from 2022-10-01` 带 302 根预热，切到评估期）',
    '2024-01-01'
  )
}

main()
