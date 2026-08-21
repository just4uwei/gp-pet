/**
 * **MinTRL（Minimum Track Record Length）**：前向记录要攒多长，一个夏普才算数。
 *
 * ```bash
 * npx tsx scripts/verify/mintrl.ts
 * npx tsx scripts/verify/mintrl.ts --moments etf-train.json   # 换一份报告取高阶矩
 * ```
 *
 * ## 它回答的问题（M2 §5.49）
 *
 * 2026-08-17 用户把 ETF 的判据从「回测统计显著」换成「**前向记录攒够时间**」，
 * 2026-08-19 又拍板停掉个股·日线·择时的研发 ⇒ **前向记录是现在活着的那条路**。
 * 而「够」是多少，在这个脚本之前**没有任何一个数在回答**。
 *
 * DSR（`dsr.ts`）在这条路上**用不上** —— 前向记录 `N = 1`，没有选择偏差可扣。
 *
 * ## 口径与归属
 *
 * - **MinTRL / PSR**：Bailey & López de Prado, *The Sharpe Ratio Efficient Frontier*,
 *   **Journal of Risk 15(2) 3–44**（SSRN 1821643）。MinTRL 就是 PSR 反解出 `T`。
 * - `MinTRL = 1 + [1 − γ₃·SR̂ + ((γ₄−1)/4)·SR̂²] · (Z_α / (SR̂ − SR*))²`
 * - 方括号那一项与 DSR 用的是**同一个**夏普估计量方差（`stats.ts` 的 `sharpeVarianceTerm`，
 *   归属链 Mertens → Christie → Opdyke）。**两个脚本共用一份，别各写各的。**
 *
 * ## ⚠ 四处易读错
 *
 * 1. **同频**：`SR̂`/`SR*` 用什么频率，结果就是**多少个那个频率的观测**。
 *    文献里的著名例子全是**月频**（1404 个月 = 117 年），照抄数量级会差一个数量级。
 * 2. **它假设「观测到的 `SR̂` 就是真值」** —— 答的是「**如果这个夏普保持下去**，多久才显著」。
 *    拿样本内夏普代进去是循环论证；本脚本因此**只喂假设值**，见下面那条。
 * 3. **平方反比**：`∝ (SR̂ − SR*)⁻²`。边缘一小，年数就爆炸。
 * 4. **它假设观测独立**，而我们的日收益不独立（持仓平均 14 根、同池标的同涨同跌）
 *    ⇒ **真实需要的比算出来的更长**。§4 给出方差膨胀因子 ——
 *    **2026-08-21 起那是正式口径**（`sharpeRatioHac`，Lo 2002 的 `V_GMM`，M2 §5.50），
 *    此前是「均值上的 NW」当近似参考，实测两者只差 0.6–0.9%。
 *
 * ## ⚠ 这个脚本**不判**任何既有结果显不显著
 *
 * 它只做**计划计算**：给一个假设的效应量，答需要多少年。
 * 拿它回头去读某份已经报过的回测 = 移动球门（M2 §5.48 判据 4）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { neweyWestVariance } from '../../src/backtest/ic-audit'
import { sharpeRatioHac } from '../../src/backtest/metrics'
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

/** 预承诺的假设年化夏普网格（M2 §5.49 判据 2，看结果之前定死） */
const ASSUMED_ANNUAL_SHARPE = [0.1, 0.2, 0.3, 0.5, 0.8, 1.0, 1.5] as const

/** ETF 训练窗口那份的年化夏普 —— **只当效应量输入**，不对它的显著性作判断（判据 4） */
const ETF_TRAIN_SHARPE_ANNUAL = 0.1337

interface Moments {
  skew: number
  kurt: number
  label: string
}

/** `MinTRL = 1 + varTerm(SR̂) · (Z_α / (SR̂ − SR*))²`，全程用**同一个频率** */
function minTrl(sr: number, srBenchmark: number, m: Moments, alpha = 0.95): number | null {
  const edge = sr - srBenchmark
  if (edge <= 0) return null // 边缘非正 ⇒ 再长也证不出来
  return 1 + sharpeVarianceTerm(sr, m.skew, m.kurt) * Math.pow(normInv(alpha) / edge, 2)
}

/** PSR：给定观测数 `t`，真夏普高于 `srBenchmark` 的概率。MinTRL 是它的反解 */
function psr(sr: number, srBenchmark: number, t: number, m: Moments): number {
  const z =
    ((sr - srBenchmark) * Math.sqrt(t - 1)) / Math.sqrt(sharpeVarianceTerm(sr, m.skew, m.kurt))
  return normCdf(z)
}

/**
 * 自检两条，都不依赖外部算例（文献里那两个著名例子**没有公布输入**，复现不了 —— 如实说）：
 *
 * 1. **往返一致**：把 `MinTRL` 的结果代回 `PSR`，必须拿回 0.95。这钉住反解的代数。
 * 2. **跨脚本一致**：`dsr.ts` 报过「N=1（无选择偏差）时，`T = 1456` 上需要年化夏普 **0.6810**」。
 *    反过来喂 0.6810 给 `MinTRL`，必须拿回 **1456** —— 两个脚本共用同一个估计量，
 *    对不上就说明有一边写错了。
 */
function selfTest(m: Moments): { roundTrip: number; crossCheck: number; ok: boolean } {
  const sr = 0.5 / Math.sqrt(BARS_PER_YEAR)
  const n = minTrl(sr, 0, m)!
  const roundTrip = psr(sr, 0, n, m)
  const crossCheck = minTrl(0.681 / Math.sqrt(BARS_PER_YEAR), 0, m)!
  return {
    roundTrip,
    crossCheck,
    ok: Math.abs(roundTrip - 0.95) < 1e-4 && Math.abs(crossCheck - 1456) < 5,
  }
}

function years(obs: number | null): string {
  if (obs === null) return '—'
  return (obs / BARS_PER_YEAR).toFixed(1)
}

function main(): void {
  const momentsArg = process.argv.includes('--moments')
    ? process.argv[process.argv.indexOf('--moments') + 1]!
    : 'cap-100000.json'

  const rep = JSON.parse(readFileSync(join(CALIB_DIR, momentsArg), 'utf8')) as {
    meta: { engineVersion: string; codes: string[] }
    equity: Array<{ date: string; equity: number; benchmark: number | null }>
    performance: { trades?: { avgHoldingBars?: number } }
  }
  const rets = returnsFromEquity(rep.equity)
  const measured: Moments = {
    skew: skewness(rets),
    kurt: pearsonKurtosis(rets),
    label: `实测（${momentsArg}）`,
  }
  const normal: Moments = { skew: 0, kurt: 3, label: '正态' }

  // 基准（沪深300）同窗口的日频夏普 —— 市场事实，不是策略结论
  const benchPoints = rep.equity
    .filter((p): p is { date: string; equity: number; benchmark: number } => p.benchmark !== null)
    .map((p) => ({ equity: p.benchmark }))
  const benchRets = returnsFromEquity(benchPoints)
  const srBenchDaily = mean(benchRets) / sampleStdev(benchRets)

  console.log('# MinTRL —— 前向记录要攒多长才算数（M2 §5.49）\n')

  const st = selfTest(measured)
  console.log('## 0. 自检（两条，都不依赖外部算例）\n')
  console.log(`① 往返：MinTRL 的结果代回 PSR ⇒ **${st.roundTrip.toFixed(6)}**（应为 0.95）`)
  console.log(
    `② 跨脚本：喂 dsr.ts 报的「N=1 需要年化 0.6810」⇒ MinTRL = **${st.crossCheck.toFixed(1)}** 个观测（应为 1456）`,
  )
  console.log(`⇒ ${st.ok ? '✅ 两条都过' : '❌ 没过，先别看下面的数'}`)
  if (!st.ok) process.exitCode = 1
  console.log(
    `\n> ⚠ 文献里那两个著名例子（比特币 184 个月 · 南非 1404 个月 = 117 年）**没有公布输入**，`,
  )
  console.log(`> 复现不了 ⇒ 只能确认「117 年 = 1404/12」这一步算术，不能当口径核对。`)

  console.log('\n## 1. 输入\n')
  console.log(`高阶矩来源：${momentsArg}（${rep.meta.codes.length} 只 · ${rets.length} 个日收益）`)
  console.log(`γ₃ = ${measured.skew.toFixed(4)} · γ₄ = ${measured.kurt.toFixed(4)}（皮尔逊）`)
  console.log(
    `基准（沪深300）同窗口日频夏普 = **${srBenchDaily.toFixed(6)}** ⇒ 年化 **${(srBenchDaily * Math.sqrt(BARS_PER_YEAR)).toFixed(4)}**`,
  )
  console.log(`置信度 95%（Z = ${normInv(0.95).toFixed(4)}）· 一年按 ${BARS_PER_YEAR} 个交易日`)

  console.log('\n## 2. 查表：假设的年化夏普 → 需要多少**年**前向记录\n')
  console.log('| 假设年化夏普 | `SR*`=0 · 正态矩 | `SR*`=0 · 实测矩 | 肥尾罚 | `SR*`=基准 · 实测矩 |')
  console.log('|---|---|---|---|---|')
  for (const ann of ASSUMED_ANNUAL_SHARPE) {
    const sr = ann / Math.sqrt(BARS_PER_YEAR)
    const a = minTrl(sr, 0, normal)
    const b = minTrl(sr, 0, measured)
    const c = minTrl(sr, srBenchDaily, measured)
    const penalty = a !== null && b !== null ? `${(((b - a) / a) * 100).toFixed(2)}%` : '—'
    console.log(`| ${ann.toFixed(1)} | ${years(a)} | **${years(b)}** | ${penalty} | ${years(c)} |`)
  }

  console.log('\n## 3. 近似关系与那一行效应量\n')
  const z = normInv(0.95)
  console.log(`经验式 \`年数 ≈ Z²/SR_年²\`（Z=${z.toFixed(4)} ⇒ 系数 ${(z * z).toFixed(4)}）与实算对照：`)
  for (const ann of [0.3, 0.5, 1.0] as const) {
    const exact = minTrl(ann / Math.sqrt(BARS_PER_YEAR), 0, measured)! / BARS_PER_YEAR
    const approx = (z * z) / (ann * ann)
    console.log(
      `- SR=${ann.toFixed(1)}：实算 ${exact.toFixed(2)} 年 · 近似 ${approx.toFixed(2)} 年 · 偏差 ${(((exact - approx) / approx) * 100).toFixed(2)}%`,
    )
  }
  const etfSr = ETF_TRAIN_SHARPE_ANNUAL / Math.sqrt(BARS_PER_YEAR)
  console.log(
    `\n**效应量那一行**（etf-train.json 的年化夏普 ${ETF_TRAIN_SHARPE_ANNUAL} 当**输入**，` +
      `⚠ 不是对它显不显著的判断）：`,
  )
  console.log(
    `- \`SR*\`=0 ⇒ **${years(minTrl(etfSr, 0, measured))} 年** · \`SR*\`=基准 ⇒ **${years(minTrl(etfSr, srBenchDaily, measured))} 年**`,
  )

  console.log('\n## 4. 自相关的方差膨胀\n')
  const iidVar = Math.pow(sampleStdev(rets), 2) / rets.length
  const lagAndrews = Math.floor(4 * Math.pow(rets.length / 100, 2 / 9))
  const holding = rep.performance.trades?.avgHoldingBars
  const lagHolding = holding !== undefined ? Math.max(1, Math.round(holding) - 1) : lagAndrews
  console.log('| 滞后阶 | **夏普方差 VIF**（Lo 2002，口径） | 均值 VIF（旧的近似参考） |')
  console.log('|---|---|---|')
  for (const [name, lag] of [
    [`Andrews (1991) ⌊4(T/100)^(2/9)⌋ L=${lagAndrews}`, lagAndrews],
    [`持仓期 ⌊avgHoldingBars⌋−1 L=${lagHolding}`, lagHolding],
  ] as const) {
    const nw = neweyWestVariance(rets, lag)
    const meanVif = nw === null ? null : nw / iidVar
    const hac = sharpeRatioHac(rets, lag)
    console.log(
      `| ${name} | **${hac === null ? '—' : hac.varianceInflation.toFixed(3)}**` +
        `${hac === null ? '' : `（年数 ×${hac.varianceInflation.toFixed(2)}）`}` +
        ` | ${meanVif === null ? '—' : meanVif.toFixed(3)} |`,
    )
  }
  console.log(
    `\n> **2026-08-21 起这一节是口径，不再是「量级参考」**（M2 §5.50）：夏普方差的 VIF 由` +
      ` \`sharpeRatioHac\`（Lo 2002 的 \`V_GMM\`，HAC 长期协方差）直接算出。` +
      `\n> 旧的「均值 VIF」那一列留着是因为它**当时判对了** —— 两者实测只差 0.6–0.9%，` +
      `根因是日频下 \`SR_日 ≈ 0\` 让 \`S₁₁/σ²\` 独自支配 \`V_GMM\`。` +
      `\n> ⚠ 这个 VIF **仍然不是写回门槛**（门槛判的是逐折配对 Δ），它只作用在 MinTRL 的年数上。`,
  )
}

main()
