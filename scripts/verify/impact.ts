/**
 * **成本模型的凸性**：常数比例滑点在多大资金上失效（M2 §5.54）。
 *
 * ```bash
 * npx tsx scripts/verify/impact.ts
 * ```
 *
 * ## 它填的是哪个洞
 *
 * [差距文档 §2.6](../../docs/notes/与机构量化系统的差距.md)：机构按成交量占比建**凸**成本函数，
 * 本项目是**常数比例**（`DEFAULT_COSTS.slippage = 0.001`，双向不利方向）。
 * 那一节写着「对 3.5% 占用的小资金影响有限，**但任何『放大资金』的讨论里它会立刻变成主导项**」——
 * 而 2026-08-19 用户已经把研发方向拍到**仓位/配置层**上，
 * [§5.44](../../docs/notes/M2-偏差报告.md) 还把 `--capital` 放大到 **5×** 判过一个候选，
 * 当时没有任何依据说 5× 的成本模型还成立。**这个脚本给的就是那个依据。**
 *
 * ## 口径与归属
 *
 * `I(Q) = Y · σ_D · √(Q / V_D)` —— 平方根冲击律。
 *
 * - 经验规律 **Loeb (1983)**；平方根形式由 **Torre & Ferrari (1997)**,
 *   *Market Impact Model Handbook*, BARRA Inc. 首次提出；
 *   **Grinold & Kahn**, *Active Portfolio Management* (McGraw-Hill, 1999/2000) 沿用；
 *   大样本实证见 **Almgren, Thum, Hauptmann & Li (2005)**,
 *   *Direct Estimation of Equity Market Impact*, **Risk 18(7) 58–62**。
 * - 原始机制是做市商的**存货风险**补偿：吃下 `Q` 要花 `T_off ∝ Q/(V/T)` 卸货，
 *   期间不利价移 `∝ σ√(T_off/T)` ⇒ `√(Q/V)`。
 *
 * ## ⚠ 五处易读错
 *
 * 1. **「平方根律」与「Almgren 2005」不是同一个说法。** Almgren 等**拒绝**了临时冲击的
 *    平方根、改判 **3/5 次幂**；后续实证给出 0.45 / 0.47 / 0.5 / 0.6
 *    ⇒ **指数本身有 0.45–0.6 的分散**。这里取 0.5 主报、0.6 作敏感性。
 * 2. **`Y` 的文献取值 0.34 – 1.0** ⇒ 水平有约 **3× 不确定度**。所以这个脚本的产出是
 *    **一个资金量级门槛**，不是一个能加进报告的成本数字。
 * 3. **平方根律说冲击只取决于总量 `Q`，几乎不取决于执行时长与路径**
 *    ⇒ **「把单子摊到更多天」在这一项上省不下钱**。极易读反。
 * 4. **冲击有临时/永久之分**，执行完成后只部分衰减（长期残留约峰值 2/3）
 *    ⇒ 单边冲击不能简单当成往返摩擦的一半。
 * 5. **`σ_D` 必须是日频**。混进年化 σ 会把结果放大约 15.6 倍（同 §5.48 那个 `×√243` 的坑）。
 *
 * ## 边界
 *
 * - **只读既有报告**（`reports/calib/cap-100000.json`）与 `data/history/` 的 fixture，
 *   **不跑任何新模拟** ⇒ `--touch-test` 不变。
 * - **不改 `DEFAULT_COSTS`**。本轮只判「常数模型在多大规模上失效」，不换模型。
 * - **不重判任何已报绩效**（预注册规则 3 / P6）。
 * - `ADV` 与 `σ` 都取入场日**之前** 20 根（不含当日）—— 信号日的成交量可能被信号本身
 *   选中（量能子信号 / 带宽扩张），用当日会让参与率系统性偏低。当日口径并列报作对照。
 * - 拿不到 `σ` / `ADV` 的建仓**显式计入 missing，不当 0**（约束 4）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { correlation, ranksOf } from '../../src/backtest/ic-audit'
import { sampleStdev } from '../../src/backtest/metrics'

const CALIB_DIR = join(process.cwd(), 'reports', 'calib')
const HISTORY_DIR = join(process.cwd(), 'data', 'history')

/** 出厂假设：单边滑点 0.1%（`DEFAULT_COSTS.slippage`），这是被比较的那条线 */
const ASSUMED_SLIPPAGE = 0.001

/**
 * **事后**从 Almgren et al. (2005) 原文 Table 3 反解出来的 `Y`（**不在预注册里**，
 * 是拿到原文之后加的，所以在输出里单独标注）。
 *
 * 他们的两只样本股在 `X/V = 10%` 上的 **realized cost** 是 32 bp（IBM，σ 1.57%）
 * 与 43 bp（DRI，σ 2.26%），而同一参与率下 `Y=1` 的平方根律给 49.6 / 71.5 bp
 * ⇒ 反解 `Y = 0.64 / 0.60`（若比的是**永久**冲击则是 0.40 / 0.30）。
 * ⚠ 两处限制：① 他们的数据集**全是美国大盘股**；
 * ② 他们的形式是 `(X/(V·T))^{3/5}`（**交易速率**），我们套的是 `(Q/V)^{1/2}`（**总量**）
 * ⇒ 这个 `Y` 只是「什么前因子能在 10% 参与率上复现他们的观测」，跨 2.7 个数量级外推要打折。
 */
const ALMGREN_Y = 0.6
/** 回看窗口：ADV 与 σ 都用入场日之前这么多根 */
const LOOKBACK = 20

interface TradeRow {
  code: string
  entryDate: string
  shares: number
  entryPriceRaw: number
}

interface Report {
  meta: { engineVersion: string; from: string; to: string; capitalPerCode: number }
  trades: TradeRow[]
}

interface Candle {
  date: string
  close: number
  closeAdj: number
  volume: number
}

const median = (xs: readonly number[]): number => quantile(xs, 0.5)

function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  const a = sorted[lo]
  const b = sorted[hi]
  if (a === undefined || b === undefined) return Number.NaN
  return a + (b - a) * (idx - lo)
}

function loadCandles(code: string): Candle[] | null {
  try {
    const raw = readFileSync(join(HISTORY_DIR, `${code}.json`), 'utf8')
    const parsed = JSON.parse(raw) as { candles?: Candle[] }
    return parsed.candles ?? null
  } catch {
    return null
  }
}

interface Entry {
  code: string
  date: string
  /** 模拟里真的下到市场上的金额（元，不复权价） */
  qSim: number
  /** 名义资金（元）—— 真实资金口径 */
  qNominal: number
  /** 入场日之前 20 根的日成交额中位数（元） */
  adv: number
  /** 当日成交额（元），对照口径 */
  advSameDay: number
  /** 入场日之前 20 根的已实现日波动 */
  sigma: number
}

/** 平方根冲击：`I = Y·σ·(Q/ADV)^exp` */
const impactOf = (q: number, adv: number, sigma: number, y: number, exp: number): number =>
  y * sigma * (q / adv) ** exp

/** 使冲击达到出厂假设滑点的资金倍数：`I ∝ k^exp` ⇒ `k* = (线/I₁)^(1/exp)` */
const criticalMultiple = (impact1x: number, exp: number): number =>
  (ASSUMED_SLIPPAGE / impact1x) ** (1 / exp)

function pct(x: number): string {
  return `${(x * 100).toFixed(4)}%`
}
function bps(x: number): string {
  return `${(x * 10000).toFixed(2)} bp`
}

function main(): number {
  const report = JSON.parse(readFileSync(join(CALIB_DIR, 'cap-100000.json'), 'utf8')) as Report
  const nominal = report.meta.capitalPerCode

  // 建仓 = 按 (code, entryDate) 分组求和 shares —— 回撤减仓会把一次建仓拆成多行
  const grouped = new Map<string, { code: string; date: string; shares: number; priceRaw: number }>()
  for (const t of report.trades) {
    const key = `${t.code}:${t.entryDate}`
    const prev = grouped.get(key)
    if (prev) prev.shares += t.shares
    else grouped.set(key, { code: t.code, date: t.entryDate, shares: t.shares, priceRaw: t.entryPriceRaw })
  }

  const candleCache = new Map<string, Candle[] | null>()
  const entries: Entry[] = []
  const missing = { noFixture: 0, noBar: 0, shortHistory: 0, zeroAdv: 0, zeroSigma: 0 }
  const missingCodes = new Set<string>()

  for (const g of grouped.values()) {
    if (!candleCache.has(g.code)) candleCache.set(g.code, loadCandles(g.code))
    const candles = candleCache.get(g.code) ?? null
    if (!candles) {
      missing.noFixture++
      missingCodes.add(g.code)
      continue
    }
    const i = candles.findIndex((c) => c.date === g.date)
    if (i < 0) {
      missing.noBar++
      continue
    }
    if (i < LOOKBACK + 1) {
      missing.shortHistory++
      continue
    }

    const window = candles.slice(i - LOOKBACK, i) // 入场日之前 20 根，不含当日
    const amounts = window.map((c) => c.volume * c.close).filter((a) => a > 0)
    if (amounts.length < LOOKBACK) {
      missing.zeroAdv++
      continue
    }
    const rets: number[] = []
    for (let k = i - LOOKBACK; k < i; k++) {
      const prev = candles[k - 1]
      const cur = candles[k]
      if (!prev || !cur || prev.closeAdj <= 0 || cur.closeAdj <= 0) continue
      rets.push(Math.log(cur.closeAdj / prev.closeAdj))
    }
    const sigma = rets.length >= LOOKBACK - 1 ? sampleStdev(rets) : Number.NaN
    if (!Number.isFinite(sigma) || sigma <= 0) {
      missing.zeroSigma++
      continue
    }
    const sameDay = candles[i]
    entries.push({
      code: g.code,
      date: g.date,
      qSim: g.shares * g.priceRaw,
      qNominal: nominal,
      adv: median(amounts),
      advSameDay: sameDay ? sameDay.volume * sameDay.close : Number.NaN,
      sigma,
    })
  }

  const total = grouped.size
  console.log('# 平方根冲击律：常数比例滑点在多大资金上失效')
  console.log('')
  console.log(`来源报告 cap-100000.json（${report.meta.engineVersion} · ${report.meta.from} → ${report.meta.to}）`)
  console.log(`建仓（按 code+entryDate 归组）**${total}** 次 · 逐笔行 ${report.trades.length}`)
  console.log(`可算 **${entries.length}** 次（覆盖率 ${((entries.length / total) * 100).toFixed(1)}%）`)
  console.log(
    `missing：无 fixture ${missing.noFixture} · 无该日 K 线 ${missing.noBar} · 段前不足 21 根 ${missing.shortHistory} · 成交额缺口 ${missing.zeroAdv} · σ 无效 ${missing.zeroSigma}`
  )
  if (missingCodes.size > 0) console.log(`无 fixture 的标的：${[...missingCodes].join(' ')}`)
  console.log('')

  const cols: Array<[string, (e: Entry) => number]> = [
    ['ADV_20（万元）', (e) => e.adv / 10000],
    ['σ_20（日）', (e) => e.sigma],
    ['参与率（Q=名义 10 万）', (e) => e.qNominal / e.adv],
    ['参与率（Q=模拟实际）', (e) => e.qSim / e.adv],
    ['参与率（Q=名义 / 当日成交额）', (e) => e.qNominal / e.advSameDay],
    ['名义/模拟 之比（= 后复权倍数）', (e) => e.qNominal / e.qSim],
  ]

  console.log('## 分布')
  console.log('')
  console.log('| 量 | 中位 | p90 | p95 | 最大 |')
  console.log('|---|---|---|---|---|')
  for (const [name, f] of cols) {
    const xs = entries.map(f).filter((x) => Number.isFinite(x))
    const fmt = name.startsWith('参与率')
      ? (x: number) => pct(x)
      : (x: number) => x.toFixed(name.startsWith('σ') ? 4 : 2)
    console.log(
      `| ${name} | ${fmt(median(xs))} | ${fmt(quantile(xs, 0.9))} | ${fmt(quantile(xs, 0.95))} | ${fmt(Math.max(...xs))} |`
    )
  }
  console.log('')

  console.log('## 冲击成本（单边）与临界资金倍数')
  console.log('')
  console.log(`被比较的线：出厂 DEFAULT_COSTS.slippage = ${bps(ASSUMED_SLIPPAGE)}（单边）`)
  console.log('')
  console.log(
    '| 口径 | 冲击·中位 | 冲击·p90 | 冲击·p95 | 冲击·最大 | 超过 10bp 的占比 | k*·中位 | k*·最先失效的 5% |'
  )
  console.log('|---|---|---|---|---|---|---|---|')
  const variants: Array<[string, number, number]> = [
    ['Y=1 · exp=0.5（主口径）', 1, 0.5],
    ['Y=0.5 · exp=0.5（下界）', 0.5, 0.5],
    ['Y=1 · exp=0.6（Almgren 指数）', 1, 0.6],
    [`Y=${ALMGREN_Y} · exp=0.5（**事后**外部锚定，见下）`, ALMGREN_Y, 0.5],
  ]
  for (const [label, y, exp] of variants) {
    const impacts = entries.map((e) => impactOf(e.qNominal, e.adv, e.sigma, y, exp))
    const over = impacts.filter((x) => x > ASSUMED_SLIPPAGE).length / impacts.length
    const ks = impacts.map((x) => criticalMultiple(x, exp))
    console.log(
      `| ${label} | ${bps(median(impacts))} | ${bps(quantile(impacts, 0.9))} | ${bps(quantile(impacts, 0.95))} | ${bps(Math.max(...impacts))} | ${(over * 100).toFixed(1)}% | ${median(ks).toFixed(1)}× | ${quantile(ks, 0.05).toFixed(1)}× |`
    )
  }
  console.log('')
  console.log('> `k*` = 使该次建仓的冲击等于 10 bp 的资金倍数。**中位**那一列答「典型的一次建仓」，')
  console.log('> 最后一列取的是 `k*` 分布的 **5% 分位**（= 最先失效的那 5% 建仓），**不是** 95% 分位。')
  console.log('')

  // 模拟实际口径下的冲击（对照）：它是「回测里真的下了多少」
  const impactsSim = entries.map((e) => impactOf(e.qSim, e.adv, e.sigma, 1, 0.5))
  console.log(
    `对照｜按**模拟实际**下单额算（Y=1 · exp=0.5）：中位 ${bps(median(impactsSim))} · p95 ${bps(quantile(impactsSim, 0.95))} · 超 10bp 占比 ${((impactsSim.filter((x) => x > ASSUMED_SLIPPAGE).length / impactsSim.length) * 100).toFixed(1)}%`
  )
  console.log('')

  // 「还能不能交易」：业界常用的参与率上限是单日 1–10%
  for (const limit of [0.01, 0.05]) {
    const hit = entries.filter((e) => e.qNominal / e.adv > limit)
    const codes = new Set(hit.map((e) => e.code))
    console.log(
      `参与率 > ${(limit * 100).toFixed(0)}%（名义 10 万口径）：**${hit.length}** 次建仓（${((hit.length / entries.length) * 100).toFixed(1)}%）· 涉及 ${codes.size} 只`
    )
  }
  console.log('')

  // P4：σ 与参与率同向？
  const sig = entries.map((e) => e.sigma)
  const logPart = entries.map((e) => Math.log(e.qNominal / e.adv))
  const rho = correlation(ranksOf(sig), ranksOf(logPart))
  console.log(`## P4｜σ_20 与 log(参与率) 的 Spearman = **${rho === null ? '—' : rho.toFixed(4)}**`)
  console.log('')

  // 最先失效的十只
  const worst = [...entries]
    .map((e) => ({ e, i: impactOf(e.qNominal, e.adv, e.sigma, 1, 0.5) }))
    .sort((a, b) => b.i - a.i)
    .slice(0, 10)
  console.log('## 最先失效的十次建仓（Y=1 · exp=0.5）')
  console.log('')
  console.log('| 标的 | 入场日 | ADV_20（万元） | σ_20 | 参与率 | 冲击 | k* |')
  console.log('|---|---|---|---|---|---|---|')
  for (const w of worst) {
    console.log(
      `| ${w.e.code} | ${w.e.date} | ${(w.e.adv / 10000).toFixed(0)} | ${w.e.sigma.toFixed(4)} | ${pct(w.e.qNominal / w.e.adv)} | ${bps(w.i)} | ${criticalMultiple(w.i, 0.5).toFixed(2)}× |`
    )
  }
  console.log('')
  // 自检：从 Almgren et al. (2005) 原文 Table 3 的两列各自反解 γ，看能不能对上
  // 二手转述的「γ ≈ 0.314」。对上 ⇒ 说明我们读原文那张表读对了。
  console.log('## 自检｜从 Almgren (2005) Table 3 反解 γ（`I = γ·σ·(X/V)·(Θ/V)^{1/4}`）')
  console.log('')
  const table3 = [
    { name: 'IBM', invTurnover: 263, sigma: 0.0157, iOverSigma: 0.126, realizedBp: 32 },
    { name: 'DRI', invTurnover: 87, sigma: 0.0226, iOverSigma: 0.096, realizedBp: 43 },
  ]
  for (const r of table3) {
    const gamma = r.iOverSigma / (0.1 * r.invTurnover ** 0.25)
    const sqrtLawBp = r.sigma * Math.sqrt(0.1) * 10000
    console.log(
      `- ${r.name}：γ = **${gamma.toFixed(4)}**（二手转述是 0.314 ⇒ 对上了）· 同参与率下 Y=1 的平方根律给 ${sqrtLawBp.toFixed(1)} bp，而他们观测 ${r.realizedBp} bp ⇒ **反解 Y = ${(r.realizedBp / sqrtLawBp).toFixed(2)}**`
    )
  }
  console.log('')
  console.log('⚠ `Y` 的文献取值 0.34–1.0、指数 0.45–0.6 ⇒ **水平有约 3× 不确定度**。')
  console.log('⇒ 这些数只能当**资金量级门槛**，不许加进任何报告、不许重判任何已报绩效。')
  return 0
}

process.exitCode = main()
