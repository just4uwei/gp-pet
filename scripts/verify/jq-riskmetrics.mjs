#!/usr/bin/env node
/**
 * 用**组合层**口径重读一份已有的回测报告：beta / alpha / 除法版超额 / 日胜率。
 *
 * ```bash
 * node scripts/verify/jq-riskmetrics.mjs reports/calib/t3fix.json reports/calib/liq-base.json
 * ```
 *
 * ## 它是什么，不是什么
 *
 * **是**：一个只读的口径换算器。输入是 `pnpm backtest --json` 已经产出的报告（要含 `equity`
 * 那条带基准列的净值曲线），输出是几个**我们的报告里没有、而外部平台普遍会给**的量。
 * 定义抄自聚宽 API 文档「风险指标」一节（信源台账 §7 第四轮）：
 * `beta = Cov(Dp,Dm)/Var(Dm)`、`alpha = Rp − [Rf + β(Rm − Rf)]`、
 * 超额收益取**除法版** `(1+Rp)/(1+Rm) − 1`、`日胜率 = 当日策略收益跑赢基准的天数占比`。
 *
 * **不是**：判据的变更。这里算出来的数**一个都不进门槛**（标定排名口径仍是验证集 Calmar，
 * 写回门槛仍是配对 Δ），也**不许拿去回头重读已经报过的实验**（那是移动球门）。
 *
 * ## ⚠ 2026-08-19 之后它的用途窄了一半：四个量里两个已经进报告
 *
 * 用户当天拍板「允许调整」⇒ **beta** 与**除法版超额**已经是 `PerformanceBlock` 的字段、
 * 报告直接打印（CHANGELOG 那条）。所以跑这个脚本的理由只剩两个：
 * ① 读 **2026-08-19 之前**产出的老 JSON（那些文件里没有这两个字段）；
 * ② 看**那两个被否掉的量** —— `alpha` 的 Rf 敏感性与 `日胜率` 的机械偏置，
 *    它们刻意不进报告，理由在 `src/backtest/metrics.ts` 的 `betaOf` 头注释。
 *
 * ## 三条读它的时候必须一起读的话（M2 §5.41 实测）
 *
 * 1. **`alpha` 对 `Rf` 极度敏感，而我们没有本地依据去定 `Rf`。** 低暴露策略几乎全程持现，
 *    `α ≈ Rp − Rf(1−β) − βRm`，于是 `Rf` 那一项直接支配结果：主池全期基线（`t3fix`）在 rf=0 下
 *    是 −0.04%/年，在他们默认的 rf=4% 下是 −3.96%/年；单指数择时那份连**符号都翻**
 *    （rf=0 → +1.29%，rf=4% → −2.57%）。⇒ **只报 rf=0 那一栏当结论**，
 *    rf=4% 那栏只用来展示这个敏感性（它等于「持现也该有 4% 收益」这个假设的代价）。
 * 2. **`日胜率` 对低暴露策略毫无信息量。** 一个 96% 时间空仓的策略，只要基准跌它就「赢」——
 *    实测主池基线 49.9%，而同期基准下跌天数占比 49.7%，两个数几乎相等。
 *    ⇒ 这个指标只在暴露接近满仓时才有意义（配置形态可用，择时形态不可用）。
 * 3. **`beta` 是净值层面的暴露度量，与 `performance.exposure`（持仓市值口径）互为交叉验证。**
 *    两者对不上时先怀疑口径，别急着当发现：exposure 按建仓价近似、beta 由日收益回归得到。
 */

import { readFileSync } from 'node:fs'

const BARS_PER_YEAR = 243

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (files.length === 0) {
  process.stdout.write(
    [
      '用法：node scripts/verify/jq-riskmetrics.mjs <报告.json> [更多报告.json ...]',
      '',
      '报告需含 equity 数组（date/equity/benchmark）—— 即跑回测时带了 --benchmark 与 --json。',
      '',
    ].join('\n')
  )
  process.exit(0)
}

/** 逐期简单收益率；与 metrics.ts 的 returnsOf 同口径（跳过缺失与非正值） */
function returnsOf(points, key) {
  const out = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]?.[key]
    const now = points[i]?.[key]
    if (prev === null || prev === undefined || now === null || now === undefined || prev <= 0) {
      continue
    }
    out.push(now / prev - 1)
  }
  return out
}

const mean = (v) => (v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length)

/** 样本协方差（除 n−1），与 metrics.ts 的 sampleStdev 同口径 */
function cov(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 2) return 0
  const ma = mean(a.slice(0, n))
  const mb = mean(b.slice(0, n))
  let s = 0
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb)
  return s / (n - 1)
}

function annualized(totalReturn, bars) {
  const years = bars / BARS_PER_YEAR
  if (years <= 0) return null
  const growth = 1 + totalReturn
  if (growth <= 0) return -1
  return growth ** (1 / years) - 1
}

const pct = (v, digits = 2) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`)

/**
 * 凯利仓位（[配置形态论证 §10](../../docs/notes/配置形态-论证.md)）—— **参考量，不是判据**。
 *
 * 两个都算，因为它们回答的不是同一个问题：
 * - `binary`：`f* = p − q/b`，`p`/`b` 取报告的**建仓级**胜率与盈亏比。它假设赔付固定，我们不是。
 * - `empirical`：把 `trades` 按 `code+entryDate` 归并成建仓级收益率，在 `f ∈ [0,3]` 上
 *   直接最大化 `E[log(1+f·r)]`。这是不假设分布的那个版本，也是该引用的那个。
 *
 * ⚠ **`f* ≤ 0` 时它说的是「不下注」，不是「调小一点」。** 而 `f*` 对 `p` 的导数 ≈ 1+1/b ≈ 2
 * ⇒ 小样本上 `f*` 的一个标准误可能比点估计本身还大（ETF 那份 59 次建仓：±13pp vs +8.21%）。
 */
function kellyOf(report) {
  const ps = report.performance?.positions
  const p = ps?.winRate ?? null
  const b = ps?.payoffRatio ?? null
  const binary = p === null || b === null || b <= 0 ? null : p - (1 - p) / b

  const trades = Array.isArray(report.trades) ? report.trades : []
  const byPosition = new Map()
  for (const t of trades) {
    const key = `${t.code}|${t.entryDate}`
    const acc = byPosition.get(key) ?? { pnl: 0, cost: 0 }
    acc.pnl += t.pnl ?? 0
    acc.cost += (t.entryPrice ?? 0) * (t.shares ?? 0)
    byPosition.set(key, acc)
  }
  const returns = [...byPosition.values()].filter((o) => o.cost > 0).map((o) => o.pnl / o.cost)
  let empirical = null
  if (returns.length >= 2) {
    let best = { f: 0, u: 0 }
    // f = 0 的效用恰好是 0（log 1）⇒ 扫不到更好的就是「不下注」，这正是我们要看的答案
    for (let f = 0.02; f <= 3.0001; f += 0.02) {
      let sum = 0
      let ok = true
      for (const r of returns) {
        const growth = 1 + f * r
        if (growth <= 0) {
          ok = false
          break
        }
        sum += Math.log(growth)
      }
      if (!ok) break
      const u = sum / returns.length
      if (u > best.u) best = { f, u }
    }
    empirical = { f: best.f, positions: returns.length, mean: mean(returns) }
  }
  return { p, b, binary, empirical }
}

for (const file of files) {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const equity = report.equity
  const perf = report.performance
  if (!Array.isArray(equity) || equity.length < 3 || !perf) {
    process.stdout.write(`\n${file}\n  ⚠ 没有可用的 equity/performance，跳过（跑回测时要带 --json）\n`)
    continue
  }
  if (perf.benchmarkReturn === null || perf.benchmarkReturn === undefined) {
    process.stdout.write(`\n${file}\n  ⚠ 报告里没有基准列，beta/alpha/超额一律算不出（要带 --benchmark）\n`)
    continue
  }

  const dp = returnsOf(equity, 'equity')
  const dm = returnsOf(equity, 'benchmark')
  const n = Math.min(dp.length, dm.length)
  const P = dp.slice(0, n)
  const M = dm.slice(0, n)

  const varM = cov(M, M)
  const varP = cov(P, P)
  const beta = varM === 0 ? null : cov(P, M) / varM
  // 一笔交易都没有的报告（净值恒定）方差为 0 ⇒ 相关系数无定义。给 null 而不是 NaN/0：
  // 0 会被读成「与大盘无关」，而事实是「这条曲线什么都没发生」
  const corr = varM === 0 || varP === 0 ? null : cov(P, M) / Math.sqrt(varP * varM)

  const bars = perf.bars ?? equity.length
  const Rp = annualized(perf.totalReturn, bars)
  const Rm = annualized(perf.benchmarkReturn, bars)
  const alphaAt = (rf) => (Rp === null || Rm === null || beta === null ? null : Rp - (rf + beta * (Rm - rf)))

  const kelly = kellyOf(report)
  const divExcess = (1 + perf.totalReturn) / (1 + perf.benchmarkReturn) - 1
  let wins = 0
  let benchDown = 0
  for (let i = 0; i < n; i++) {
    if (P[i] > M[i]) wins++
    if (M[i] < 0) benchDown++
  }

  process.stdout.write(
    [
      '',
      `${file}`,
      `  引擎 ${report.meta?.engineVersion ?? '?'} · 标的 ${(report.meta?.codes ?? []).length} 只 · ` +
        `${report.meta?.from ?? '?'} → ${report.meta?.to ?? '?'} · ${n} 个日收益`,
      `  年化：策略 ${pct(Rp)}   基准 ${pct(Rm)}`,
      `  beta ${beta === null ? '—' : beta.toFixed(4)}   相关系数 ${corr === null ? '—' : corr.toFixed(4)}   ` +
        `平均资金占用 ${pct(perf.exposure)}  ← 这两个是同一件事的两种量法`,
      `  alpha(rf=0) ${pct(alphaAt(0))}   alpha(rf=4%) ${pct(alphaAt(0.04))}  ← 后者只展示 Rf 敏感性，不作结论`,
      `  超额：减法 ${pct(perf.excessReturn)}（老口径）  除法 ${pct(divExcess)}（引用用这个；两者现在报告里都有）`,
      `  日胜率 ${pct(wins / n, 1)}   基准下跌天数占比 ${pct(benchDown / n, 1)}  ← 两者接近 ⇒ 日胜率没有信息量`,
      `  年化波动：策略 ${pct(Math.sqrt(varP * BARS_PER_YEAR))}   基准 ${pct(Math.sqrt(varM * BARS_PER_YEAR))}`,
      `  凯利（参考量，不是判据）：建仓级 p ${pct(kelly.p)} · b ${kelly.b === null ? '—' : kelly.b.toFixed(3)}` +
        ` ⇒ 二元 f* ${pct(kelly.binary)}` +
        (kelly.empirical === null
          ? ''
          : ` · 经验分布 f* ${kelly.empirical.f.toFixed(2)}（${kelly.empirical.positions} 次建仓，` +
            `平均 ${pct(kelly.empirical.mean, 3)}）`),
      '  ↑ f* ≤ 0 的含义是「不下注」而不是「调小」；小样本上它的标准误可能比点估计还大（§10.2）',
      '',
    ].join('\n')
  )
}
