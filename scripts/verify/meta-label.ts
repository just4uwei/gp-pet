/**
 * **Meta-labeling 的 precision/recall 口径**落到 `docs/07 §3.6` 的四条门槛上（M2 §5.57）。
 *
 * ```bash
 * npx tsx scripts/verify/meta-label.ts
 * ```
 *
 * ## 口径与归属
 *
 * **López de Prado, M.** (2018), *Advances in Financial Machine Learning*, Wiley，
 * **第 3 章「Labeling」**（下注规模在第 10 章）：**主模型定方向、副模型只定「要不要下注」**。
 * 主模型调成高召回、副模型把假阳性滤掉提高精度，目标是 `F1 = 2PR/(P+R)`。
 *
 * 映射到本项目（**正类 = 一次建仓**，**TP = 该次建仓最终盈利**，`groupPositions()` 口径）：
 *
 * ```
 * precision = P            ← 就是门槛③（建仓级胜率不降）
 * 保留率     = N₁/N₀       ← 就是门槛②（≥ 0.85）
 * recall     = TP₁/TP₀     ← §3.6 里没有直接对应的门槛
 * ```
 *
 * **纯过滤**（候选建仓集合 ⊆ 基线、保留者盈亏不变）下有恒等式
 * `recall = (P₁/P₀) × (N₁/N₀)`，于是：
 *
 * * `②+③ ⇒ recall ≥ 0.85`（那道召回门槛一直隐含着，不是缺的）；
 * * `recall ≤ 1 ⇒ P₁ ≤ P₀/0.85`，**单次改动的胜率倍率上限 ×1.176**
 *   （⚠ 是**速率**上限不是墙 —— 每次改动都重定基线）。
 *
 * ## ⚠ 四处容易读错
 *
 * 1. **副模型救不了方向**，只能选择不下注。「主模型胜率低于 50% 时副模型能做的很有限」
 *    —— 本项目基线建仓级胜率 **43.21%**。
 * 2. **`F1` 内嵌 1:1 的错误代价、且完全不看真阴** ⇒ 它**不是经济目标**。
 * 3. 二手源常把 `F1` 与夏普当同向的 —— 那是两个目标。
 * 4. 本项目的「副模型」是**一条规则**不是模型（1675 次建仓训练分类器是过拟合机器）。
 *
 * ## 边界
 *
 * **只读已有报告**，不跑模拟、不改引擎、不改门槛。窗口不同的报告不参与比较
 * （`abl-valid-*` 一律排除：`--from 2024-01-01` 无段前历史，只剩 34 次建仓）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'reports', 'calib')

interface Trade {
  code: string
  entryDate: string
  pnl: number
}

interface Report {
  meta: { engineVersion: string; from: string; to: string; codes: number; capitalPerCode?: number }
  performance: { totalReturn: number; positions?: number; trades?: number }
  trades: Trade[]
}

/** 一次**建仓** = (code, entryDate) → 组内 `pnl` 之和（回撤减仓会把一次建仓拆成两三行） */
function positionsOf(rep: Report): Map<string, number> {
  const byKey = new Map<string, number>()
  for (const t of rep.trades) {
    const key = `${t.code}|${t.entryDate}`
    byKey.set(key, (byKey.get(key) ?? 0) + t.pnl)
  }
  return byKey
}

function load(name: string): Report | null {
  try {
    return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Report
  } catch {
    return null
  }
}

const pct = (x: number): string => `${(100 * x).toFixed(2)}%`
const f1 = (p: number, r: number): number => (p + r === 0 ? 0 : (2 * p * r) / (p + r))

interface Row {
  name: string
  n: number
  wins: number
  precision: number
  keep: number
  recallTrue: number
  recallImplied: number
  f1: number
  added: number
  kept: number
  pnlChanged: number
}

function main(): void {
  const base = load('cap-100000')
  if (!base) throw new Error('读不到基线 cap-100000.json')

  const basePos = positionsOf(base)
  const baseWins = new Set([...basePos].filter(([, pnl]) => pnl > 0).map(([k]) => k))
  const N0 = basePos.size
  const TP0 = baseWins.size
  const P0 = TP0 / N0

  console.log('# Meta-labeling 的 precision/recall 落到 §3.6 门槛上（M2 §5.57）\n')
  console.log('## 1. 基线（出厂口径）\n')
  console.log(
    `\`cap-100000\` · ${base.meta.from} → ${base.meta.to} · ${base.meta.codes} 只 · ` +
      `建仓 **${N0}** · 赢家 **${TP0}** ⇒ **P₀ = ${pct(P0)}**（= precision，也就是门槛③ 的量）`
  )
  console.log(
    `\n**门槛② 的天花板**：\`P₁ ≤ P₀/0.85\` = **${pct(P0 / 0.85)}**（倍率 ×${(1 / 0.85).toFixed(3)}）` +
      ' —— 单次纯过滤改动哪怕剔掉每一个亏损建仓也到不了更高。⚠ 是**速率**上限，不是墙。'
  )

  // 候选族：已有报告里真实做过的改动。窗口必须与基线一致，否则不参与比较
  const candidates = [
    ['t3fix', 'T3 在 TREND_UP 不计票（§5.24，判定逻辑改动）'],
    ['abl-no-stop-loss-train', '关掉固定止损（§5.30）'],
    ['abl-no-trailing-stop-train', '关掉移动止损（§5.30）'],
    ['abl-no-profit-protect-train', '关掉盈利保护（§5.30）'],
    ['abl-no-drawdown-reduce-train', '关掉回撤减仓（§5.30）'],
    ['dd-010-train', 'drawdownReducePct = 0.10（§5.31）'],
    ['dd-014-train', 'drawdownReducePct = 0.14（§5.31）'],
  ] as const

  const rows: Row[] = []
  const skipped: string[] = []

  for (const [name, label] of candidates) {
    const rep = load(name)
    if (!rep) {
      skipped.push(`${name} — 读不到`)
      continue
    }
    if (rep.meta.from !== base.meta.from || rep.meta.to !== base.meta.to) {
      skipped.push(`${name} — 窗口不同（${rep.meta.from}→${rep.meta.to}）⇒ 不可比`)
      continue
    }
    const pos = positionsOf(rep)
    const n = pos.size
    const wins = [...pos].filter(([, pnl]) => pnl > 0).length
    const precision = wins / n
    const keep = n / N0
    // 真 recall：**保留下来的**赢家 ÷ 基线赢家。注意分子只数「在基线里也是赢家」的那些
    let retainedWinners = 0
    let added = 0
    let kept = 0
    let pnlChanged = 0
    for (const [key, pnl] of pos) {
      const basePnl = basePos.get(key)
      if (basePnl === undefined) {
        added += 1
        continue
      }
      kept += 1
      if (Math.abs(basePnl - pnl) > 1e-6) pnlChanged += 1
      if (baseWins.has(key) && pnl > 0) retainedWinners += 1
    }
    const recallTrue = retainedWinners / TP0
    const recallImplied = (precision / P0) * keep
    rows.push({
      name: `${name} — ${label}`,
      n,
      wins,
      precision,
      keep,
      recallTrue,
      recallImplied,
      f1: f1(precision, recallTrue),
      added,
      kept,
      pnlChanged,
    })
  }

  console.log('\n## 2. 候选族：precision / recall / F1\n')
  console.log('| 候选 | 建仓 | 保留率 (②) | precision (③) | 真 recall | 推导 recall | 差 | F1 |')
  console.log('|---|---|---|---|---|---|---|---|')
  console.log(
    `| **基线** | ${N0} | — | ${pct(P0)} | — | — | — | ${f1(P0, 1).toFixed(4)} |`
  )
  for (const r of rows) {
    const gap = r.recallImplied - r.recallTrue
    console.log(
      `| ${r.name} | ${r.n} | ${pct(r.keep)} | ${pct(r.precision)} | ${pct(r.recallTrue)} | ` +
        `${pct(r.recallImplied)} | **${gap >= 0 ? '+' : ''}${(100 * gap).toFixed(2)}pp** | ${r.f1.toFixed(4)} |`
    )
  }
  if (skipped.length > 0) {
    console.log('\n**跳过**（窗口不同或读不到，刻意不参与比较）：')
    for (const s of skipped) console.log(`- ${s}`)
  }

  console.log('\n## 3. 纯过滤假设直接验（不靠推断）\n')
  console.log('| 候选 | 与基线共有建仓 | 基线里没有的（新增） | 共有里 pnl 变了的 | 是纯过滤？ |')
  console.log('|---|---|---|---|---|')
  for (const r of rows) {
    const pure = r.added === 0 && r.pnlChanged === 0
    console.log(
      `| ${r.name.split(' — ')[0]} | ${r.kept} / ${r.n} | **${r.added}**（${pct(r.added / r.n)}） | ` +
        `**${r.pnlChanged}**（${pct(r.pnlChanged / Math.max(1, r.kept))}） | ${pure ? '✅ 是' : '❌ **不是**'} |`
    )
  }
  console.log(
    '\n⇒ 恒等式 `recall = (P₁/P₀)×(N₁/N₀)` **只在「是纯过滤」那一行上成立**。' +
      '不成立时「推导 recall」是一个**没有含义的数**，上面那一列的差就是它的量。'
  )

  console.log('\n## 4. 门槛②③ 的联合筛选：现有候选谁过得去\n')
  console.log('| 候选 | ② 保留率 ≥ 85% | ③ precision ≥ P₀ | 两条一起 | 胜率是否越过天花板 |')
  console.log('|---|---|---|---|---|')
  const ceiling = P0 / 0.85
  for (const r of rows) {
    const g2 = r.keep >= 0.85
    const g3 = r.precision >= P0
    console.log(
      `| ${r.name.split(' — ')[0]} | ${g2 ? '✅' : '❌'} | ${g3 ? '✅' : '❌'} | ` +
        `${g2 && g3 ? '**过**' : '不过'} | ${r.precision > ceiling ? `⚠ **越过**（${pct(r.precision)}）` : '否'} |`
    )
  }
  console.log(
    `\n天花板 = ${pct(ceiling)}。**越过它 + 保留率 ≥ 85% + 是纯过滤** 三者同时成立是算术上不可能的` +
      ' —— 若出现，说明那个候选不是纯过滤（去看第 3 节）。'
  )

  // ---------- 5. 过了②③ 的候选，绩效到底更好吗 ----------
  //
  // 这一节是闭环：门槛存在的目的是筛出更好的改动。若一个候选过了②③、F1 还更高，
  // 而它的绩效更差且**已经被判为负**，那说明这两条门槛对它这一类改动不设约束。
  console.log('\n## 5. 闭环：过了②③ 的候选，绩效更好吗\n')
  console.log('| 候选 | ②③ | F1 | 区间收益 | 与基线比 | 既有裁决 |')
  console.log('|---|---|---|---|---|---|')
  console.log(`| **基线** | — | ${f1(P0, 1).toFixed(4)} | ${pct(base.performance.totalReturn)} | — | 出厂 |`)
  for (const r of rows) {
    const name = r.name.split(' — ')[0] as string
    const rep = load(name)
    if (!rep) continue
    const g2 = r.keep >= 0.85
    const g3 = r.precision >= P0
    const delta = rep.performance.totalReturn - base.performance.totalReturn
    console.log(
      `| ${name} | ${g2 && g3 ? '**过**' : '不过'} | ${r.f1.toFixed(4)} | ` +
        `${pct(rep.performance.totalReturn)} | ${delta >= 0 ? '+' : ''}${(100 * delta).toFixed(2)}pp | ` +
        '§5.30/§5.31 判**没过红线** |'
    )
  }
  console.log(
    '\n⚠ **绩效那两列只用来看方向，不许单独引用** —— §5.30/§5.31 的判据是训练窗口 Calmar 与' +
      '验证窗口一致性，不是区间收益（「少做」会机械地改善绩效，这正是门槛② 要防的事）。'
  )
}

main()
