#!/usr/bin/env node
/**
 * 配置形态的**第一个可证伪实验**：纯波动率目标化 vs 常年满仓。
 *
 * ```bash
 * pnpm exp:vol-target -- --fixtures ./data/history
 * ```
 *
 * ## 它在回答什么
 *
 * [配置形态 · 论证](../../docs/notes/配置形态-论证.md) §5 提的问题：
 * **在完全不预测方向的前提下，波动率目标化能不能改善风险调整后收益？**
 *
 * 选它当第一个实验的三个理由（原文）：① **不用引擎**（不碰任何未标定参数，
 * 绕开「继承 TRANSITION 无效性」那个风险）· ② 半天能做完 · ③ **若连它都不成立，
 * 整条路不用再走**。
 *
 * ⚠ 论证里写的是「甚至可以是个独立脚本」，这里仍然放进 `src/backtest`，
 * 理由与 CLAUDE.md 那条横向边一致：**成本模型与绩效口径各写一份，两边数字就再也对不上**，
 * 而这个实验的全部意义就在于它的数字要能和回测/影子的数字并排读。
 * 它确实不 import `src/core` 的任何引擎代码 —— 「不用引擎」这一条没有被违反。
 *
 * ## 预注册（写在看到结果之前，docs/07 §3.6 的顺序）
 *
 * | 项 | 设定 |
 * |---|---|
 * | 标的 | SH000300（2005-04→2017-12 **全新窗口** + 2018-01→2023-12 同期对照） |
 * | 规则 | `w = min(1, σ_target / σ)`，σ = 过去 20 日已实现波动（年化）。**无方向、无 regime、无指标** |
 * | 阈值 | `σ_target = 15%`，**预注册一个值，不搜索** |
 * | 调仓 | 每 5 个交易日一次；成本照扣（佣金 + 滑点，ETF 载体免印花税与过户费） |
 * | 对照 | 常年满仓（被动持有），同窗口同成本口径 |
 * | **主判据** | **Calmar 与 Sharpe 同时改善，且两个窗口同向** |
 * | 次判据 | 最大回撤下降；总收益不低于被动的 80% |
 * | 报告 | **一次**。两个窗口算一次 |
 * | 不碰 | 2024 年之后 |
 *
 * **预测**：Calmar 与 Sharpe 改善、最大回撤显著下降、总收益略低于被动。
 * 若**总收益反而更高**，要警惕 —— 那通常意味着规则恰好躲过了某一次特定崩盘（样本期运气），
 * 届时必须看两个窗口是否同向。
 *
 * ## 三条不许省的读数纪律
 *
 * 1. **必须报平均暴露**。`w ≤ 1` 让波动率目标化天然低于满仓，收益低一截可能**只是仓位低**
 *    而不是择时差 —— 这就是 §5.13 那条「超额收益离开平均占用就会被读反」的同一个坑。
 * 2. **无信号 = 现金，利率按 0**。给现金记利息会凭空造出一条与本实验无关的收益来源，
 *    而 2005–2017 的真实货币利率无本地可靠来源（与夏普 rf = 0 同一条理由）。
 * 3. **判定用 t 日收盘的数据，仓位从 t+1 日的收益开始生效**。同日生效就是未来函数。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_COSTS, type CostModel } from './costs'
import { BARS_PER_YEAR, mean, sampleStdev } from './metrics'

/** 预注册的三个数，**不许在本文件里做成可搜索的网格** —— 那正是这个实验要避开的东西 */
const VOL_WINDOW = 20
const REBALANCE_EVERY = 5
const SIGMA_TARGET = 0.15

interface Bar {
  date: string
  closeAdj: number | null
  close: number
}

interface Window {
  name: string
  from: string
  to: string
  note: string
}

const WINDOWS: readonly Window[] = [
  { name: 'W1', from: '2005-04-08', to: '2017-12-31', note: '全新窗口（从未被本项目读过）' },
  { name: 'W2', from: '2018-01-01', to: '2023-12-31', note: '同期对照（= 引擎的训练窗口）' },
]

interface ArmResult {
  totalReturn: number
  annualized: number | null
  maxDrawdown: number
  sharpe: number | null
  calmar: number | null
  /** 平均暴露。满仓恒为 1；波动率目标化 < 1，读收益差之前必须先看它 */
  exposure: number
  /** 调仓次数与累计换手（Σ|Δw|），成本的来源 */
  rebalances: number
  turnover: number
  costPaid: number
  bars: number
}

/**
 * 单边成本率：滑点作用在成交价上，佣金按成交额收。
 *
 * ETF 载体 ⇒ `isFundBoard` 那一档：**免印花税、免过户费**（2026-08-17 起，见 costs.ts）。
 * `minCommission` 在这里忽略不计 —— 组合层面每次调仓的成交额都远大于 5 元 / 万 2.5 的拐点
 * （2 万元），而这个实验只有组合层，没有逐笔。
 */
function oneWayRate(costs: CostModel): number {
  return costs.slippage + costs.commissionRate
}

function maxDrawdownOf(equity: readonly number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const v of equity) {
    if (v > peak) peak = v
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak)
  }
  return worst
}

/**
 * 跑一条净值。
 *
 * @param returns  逐日标的收益率，与 `weights` 同序
 * @param weights  逐日**已生效**的仓位（调用方保证它只用了 t−1 及以前的信息）
 */
function simulate(
  returns: readonly number[],
  weights: readonly number[],
  costs: CostModel
): ArmResult {
  const rate = oneWayRate(costs)
  const equity: number[] = [1]
  const daily: number[] = []
  let value = 1
  let held = 0
  let rebalances = 0
  let turnover = 0
  let costPaid = 0
  for (let i = 0; i < returns.length; i++) {
    const w = weights[i] ?? 0
    const r = returns[i] ?? 0
    // 换手发生在这一根开盘之前（仓位由 i−1 收盘定），成本先扣再吃当日收益
    const delta = Math.abs(w - held)
    if (delta > 1e-12) {
      const fee = value * delta * rate
      costPaid += fee
      value -= fee
      turnover += delta
      rebalances++
      held = w
    }
    const before = value
    value *= 1 + w * r
    daily.push(before > 0 ? value / before - 1 : 0)
    equity.push(value)
  }
  const totalReturn = value - 1
  const bars = returns.length
  const years = bars / BARS_PER_YEAR
  const growth = 1 + totalReturn
  const annualized = years <= 0 ? null : growth <= 0 ? -1 : growth ** (1 / years) - 1
  const sd = sampleStdev(daily)
  const sharpe = daily.length < 2 || sd === 0 ? null : (mean(daily) / sd) * Math.sqrt(BARS_PER_YEAR)
  const maxDrawdown = maxDrawdownOf(equity)
  return {
    totalReturn,
    annualized,
    maxDrawdown,
    sharpe,
    // 回撤为 0 时不给 Infinity —— 与 calibrate.ts 的 calmar() 同一条守卫
    calmar: annualized === null ? null : maxDrawdown <= 0 ? null : annualized / maxDrawdown,
    exposure: mean(weights),
    rebalances,
    turnover,
    costPaid,
    bars,
  }
}

function loadBars(fixtures: string, code: string): Bar[] {
  const raw: unknown = JSON.parse(readFileSync(join(fixtures, `${code}.json`), 'utf8'))
  const list = Array.isArray(raw) ? raw : (raw as { candles?: unknown[] }).candles
  if (!Array.isArray(list)) throw new Error(`${code}.json 里没有 candles`)
  return list.map((row) => {
    const r = row as Bar
    return { date: r.date, close: r.close, closeAdj: r.closeAdj }
  })
}

interface WindowResult {
  window: Window
  first: string
  last: string
  vol: ArmResult
  passive: ArmResult
}

function runWindow(bars: readonly Bar[], window: Window, costs: CostModel): WindowResult {
  // 判定日：窗口内的每一根。仓位由**该根收盘**算出、从**下一根**的收益开始生效。
  // 段前历史照喂（用来预热 20 日波动），只是不在那段上计净值 —— 与 calibrate 的
  // warmupForSplit 同一条纪律：不喂段前历史会让 W2 的头 20 根凭空少掉。
  const px = bars.map((b) => b.closeAdj ?? b.close)
  const rets: (number | null)[] = bars.map((_, i) => {
    const now = px[i]
    const prev = px[i - 1]
    if (i === 0 || now === undefined || prev === undefined || prev <= 0) return null
    return now / prev - 1
  })

  const inWindow: number[] = []
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]?.date
    if (d !== undefined && d >= window.from && d <= window.to) inWindow.push(i)
  }
  const start = inWindow[0]
  const end = inWindow[inWindow.length - 1]
  if (start === undefined || end === undefined) throw new Error(`${window.name} 窗口内没有 K 线`)

  const windowReturns: number[] = []
  const volWeights: number[] = []
  const passiveWeights: number[] = []
  let current = 0
  let sinceRebalance = REBALANCE_EVERY // 第一根就调一次仓，两条腿同时建仓
  for (const i of inWindow) {
    const r = rets[i]
    if (r === null || r === undefined) continue
    // 仓位来自**上一根收盘**的已实现波动：窗口是 rets[i-VOL_WINDOW .. i-1]，不含今天
    const sample: number[] = []
    for (let k = i - VOL_WINDOW; k <= i - 1; k++) {
      const v = rets[k]
      if (v !== null && v !== undefined) sample.push(v)
    }
    if (sinceRebalance >= REBALANCE_EVERY && sample.length === VOL_WINDOW) {
      const sigma = sampleStdev(sample) * Math.sqrt(BARS_PER_YEAR)
      current = sigma <= 0 ? 1 : Math.min(1, SIGMA_TARGET / sigma)
      sinceRebalance = 0
    }
    sinceRebalance++
    windowReturns.push(r)
    volWeights.push(current)
    passiveWeights.push(1)
  }

  return {
    window,
    first: bars[start]?.date ?? '',
    last: bars[end]?.date ?? '',
    vol: simulate(windowReturns, volWeights, costs),
    passive: simulate(windowReturns, passiveWeights, costs),
  }
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(2)}%`
}

function num(v: number | null, digits = 3): string {
  return v === null ? '—' : v.toFixed(digits)
}

function render(results: readonly WindowResult[]): string {
  const L: string[] = []
  L.push('波动率目标化 vs 常年满仓（配置形态 · 第一个可证伪实验）')
  L.push('='.repeat(96))
  L.push(
    `规则 w = min(1, ${SIGMA_TARGET * 100}% / σ)，σ = 过去 ${VOL_WINDOW} 日已实现波动（年化）· ` +
      `每 ${REBALANCE_EVERY} 个交易日调一次 · 无方向判断、无 regime、无指标`
  )
  L.push(
    `成本：佣金 ${DEFAULT_COSTS.commissionRate * 10000} 万 + 滑点 ${
      DEFAULT_COSTS.slippage * 100
    }%（ETF 载体，免印花税与过户费）· 现金不计息`
  )
  L.push('**预注册**：σ_target 只取一个值，不搜索；报告一次；两个窗口算一次；不碰 2024 年之后')
  L.push('')

  for (const r of results) {
    L.push(`【${r.window.name}】${r.first} → ${r.last}（${r.window.note}）`)
    L.push(
      '  ' +
        '腿'.padEnd(12) +
        '总收益'.padStart(11) +
        '年化'.padStart(10) +
        '最大回撤'.padStart(11) +
        '夏普'.padStart(9) +
        'Calmar'.padStart(9) +
        '平均暴露'.padStart(11) +
        '调仓'.padStart(7) +
        '成本'.padStart(9)
    )
    for (const [name, arm] of [
      ['波动率目标化', r.vol],
      ['常年满仓', r.passive],
    ] as const) {
      L.push(
        '  ' +
          name.padEnd(12) +
          pct(arm.totalReturn).padStart(11) +
          pct(arm.annualized).padStart(10) +
          pct(arm.maxDrawdown).padStart(11) +
          num(arm.sharpe).padStart(9) +
          num(arm.calmar).padStart(9) +
          pct(arm.exposure).padStart(11) +
          String(arm.rebalances).padStart(7) +
          pct(arm.costPaid).padStart(9)
      )
    }
    const dSharpe = (r.vol.sharpe ?? 0) - (r.passive.sharpe ?? 0)
    const dCalmar = (r.vol.calmar ?? 0) - (r.passive.calmar ?? 0)
    L.push(
      `  Δ 夏普 ${dSharpe >= 0 ? '+' : ''}${dSharpe.toFixed(3)} · ` +
        `Δ Calmar ${dCalmar >= 0 ? '+' : ''}${dCalmar.toFixed(3)} · ` +
        `回撤 ${pct(r.vol.maxDrawdown - r.passive.maxDrawdown)} · ` +
        `收益占被动 ${
          r.passive.totalReturn === 0
            ? '—'
            : `${((r.vol.totalReturn / r.passive.totalReturn) * 100).toFixed(1)}%`
        }`
    )
    L.push('')
  }

  // 主判据：Calmar 与 Sharpe **同时**改善，且**两个窗口同向**
  const improved = results.map(
    (r) => (r.vol.sharpe ?? -Infinity) > (r.passive.sharpe ?? -Infinity) &&
      (r.vol.calmar ?? -Infinity) > (r.passive.calmar ?? -Infinity)
  )
  const allImproved = improved.every(Boolean)
  const anyImproved = improved.some(Boolean)
  L.push('─'.repeat(96))
  L.push(
    `主判据（Calmar 与 Sharpe 同时改善 且 两窗口同向）：**${
      allImproved ? '通过' : anyImproved ? '不通过 —— 两个窗口方向相反' : '不通过 —— 两个窗口都没改善'
    }**`
  )
  for (const [i, r] of results.entries()) {
    L.push(`  ${r.window.name}：${improved[i] ? '两项都改善' : '未同时改善'}`)
  }
  const secondary = results.map((r) => ({
    name: r.window.name,
    dd: r.vol.maxDrawdown < r.passive.maxDrawdown,
    ret:
      r.passive.totalReturn <= 0
        ? null
        : r.vol.totalReturn >= r.passive.totalReturn * 0.8,
  }))
  L.push(
    '次判据（回撤下降 · 收益不低于被动的 80%）：' +
      secondary
        .map(
          (s) =>
            `${s.name} 回撤${s.dd ? '↓' : '↑'} / 收益${
              s.ret === null ? '（被动为负，该条不适用）' : s.ret ? '达标' : '未达标'
            }`
        )
        .join(' · ')
  )
  L.push('')
  L.push(
    '⚠ 读数纪律：**平均暴露**那一列必须一起读 —— w ≤ 1 让这条腿天然低于满仓，' +
      '收益低一截可能只是仓位低而不是择时差（§5.13 同一个坑）。'
  )
  L.push(
    '⚠ 本实验**不涉及引擎、不改任何参数**，它只回答「不预测方向的纯波动率目标化值不值钱」。' +
      '不通过 ⇒ 配置形态那条路不用再走（论证 §5 的第 ③ 条理由）。'
  )
  return L.join('\n')
}

export async function run(argv: readonly string[]): Promise<number> {
  let fixtures = './data/history'
  let code = 'SH000300'
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--fixtures') fixtures = argv[++i] ?? fixtures
    else if (key === '--code') code = argv[++i] ?? code
    else if (key === '--help' || key === '-h') {
      process.stdout.write(
        '用法：pnpm exp:vol-target -- [--fixtures ./data/history] [--code SH000300]\n'
      )
      return 0
    }
  }
  const bars = loadBars(fixtures, code)
  const results = WINDOWS.map((w) => runWindow(bars, w, DEFAULT_COSTS))
  process.stdout.write(`${render(results)}\n`)
  return 0
}

const invoked = process.argv[1] ?? ''
if (invoked.includes('vol-target')) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
