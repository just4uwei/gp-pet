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
 * ## 2026-08-25：**逐次建仓配对 Δ 的聚类标准误已算**（第 6 节）
 *
 * 上面那一轮的产出是「②③ 对**出场类改动**结构上不设约束」⇒
 * [docs/07 §3.6a](../../docs/07-回测与验证方案.md) 把这一类的主判据换成了
 * **逐次建仓的配对 Δ**。理由是个前提检查：§3.6 把配对 Δ 排除掉是因为
 * 「逻辑改动会改变交易的集合」，而出场类改动**恰好不改变它**（实测共有建仓 97.99–99.27%）
 * ⇒ 那个前提成立，于是可以按 `(code, entryDate)` 逐次配 `pnl`。
 *
 * **聚类单位是时间，不是建仓。** `stdev(Δ)/√n` 的 `√n` 只在配对相互独立时成立，
 * 而同一段行情里的建仓成批发生、共享市场 beta（与折间那件事同源，
 * 见 `src/backtest/calibrate.ts` 的 `clusteredStderrOf` 头注释）。
 * 本节复用**同一个** CR1 实现，报两档聚类：
 *
 * * **建仓月**（G ≈ 窗口月数）—— 与 `audit:random` 的块位移同一个时间单位（§5.36）；
 * * **时间片**（G = 3，窗口等分三段）—— 与 §3.1 折单元的时间片同一个单位，**最保守**。
 *
 * 朴素 `t` 照印但标着**未调整上界**（同 `PairedDelta.t` 的纪律），门槛沿用 `|Δ|/stderr ≥ 2`。
 *
 * ⚠ **三处别读错**：① 配对 Δ 是**条件在共有集合上**的量 —— 新增/消失的建仓不进分子也不进分母，
 * 所以必须并排看第 3 节那两个数（集合变了多少）；② **它不是 alpha** ——
 * 测的是「同一批建仓换一个出场规则」，一个字都不含「入场值不值得」；
 * ③ Δ 的单位是**元/建仓**（`capitalPerCode` 固定 10 万），正号 = 候选更好。
 *
 * ## 边界
 *
 * **只读已有报告**，不跑模拟、不改引擎、不改门槛。窗口不同的报告不参与比较
 * （`abl-valid-*` 一律排除：`--from 2024-01-01` 无段前历史，只剩 34 次建仓）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { pairedDelta } from '../../src/backtest/calibrate'

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

/** 窗口等分三段中的哪一段（`时间片` 聚类用，与 §3.1 折单元的时间片同一个单位） */
function sliceOf(date: string, from: string, to: string): string {
  const a = Date.parse(from)
  const b = Date.parse(to)
  const x = Date.parse(date)
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(x) || b <= a) return 'T?'
  const k = Math.min(2, Math.max(0, Math.floor((3 * (x - a)) / (b - a))))
  return `T${k + 1}`
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

  // ---------- 6. 出场类改动的主判据：逐次建仓配对 Δ（docs/07 §3.6a） ----------
  console.log('\n## 6. 出场类改动的主判据：逐次建仓配对 Δ（docs/07 §3.6a）\n')

  console.log('### 6.1 先分类：这次改动是哪一类（判据是两个数，不是命名）\n')
  console.log('| 候选 | 集合变动 (新增+消失)/N₀ | 结局变动 pnl 变了/共有 | 形状（描述性，不是门槛） |')
  console.log('|---|---|---|---|')
  for (const r of rows) {
    const name = r.name.split(' — ')[0] as string
    const dropped = N0 - r.kept
    const setMoved = (r.added + dropped) / N0
    const fateMoved = r.pnlChanged / Math.max(1, r.kept)
    const shape =
      fateMoved >= 10 * setMoved ? '**出场型**' : setMoved >= fateMoved ? '**过滤型**' : '混合型'
    console.log(`| ${name} | ${pct(setMoved)} | ${pct(fateMoved)} | ${shape} |`)
  }
  console.log(
    '\n⇒ **出场型**（集合几乎不动、结局大量改变）才能用下面那个配对 Δ；' +
      '**过滤型**用 §3.6 的原四条。混合型按两套**取严**，不许自选一套。' +
      '\n⚠ 这三个标签是**描述性**的（比的是两个变动率的相对大小，没有绝对阈值）—— ' +
      '它替代不了论证，只是让「靠命名判断」这条路走不通。'
  )

  console.log('\n### 6.2 ③′ 每次建仓的期望：胜率与盈亏比必须并排看\n')
  console.log('| 候选 | 建仓 | 建仓级胜率 | 盈亏比 | **期望（元/建仓）** | 与基线比 |')
  console.log('|---|---|---|---|---|---|')
  const shapeOf = (pos: Map<string, number>): { p: number; ratio: number; mean: number } => {
    const vals = [...pos.values()]
    const wins = vals.filter((v) => v > 0)
    const losses = vals.filter((v) => v <= 0)
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0
    return {
      p: vals.length > 0 ? wins.length / vals.length : Number.NaN,
      ratio: avgLoss > 0 ? avgWin / avgLoss : Number.NaN,
      mean: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : Number.NaN,
    }
  }
  const baseShape = shapeOf(basePos)
  console.log(
    `| **基线** | ${N0} | ${pct(baseShape.p)} | ${baseShape.ratio.toFixed(3)} | ` +
      `**${baseShape.mean.toFixed(1)}** | — |`
  )
  for (const r of rows) {
    const name = r.name.split(' — ')[0] as string
    const rep = load(name)
    if (!rep) continue
    const s = shapeOf(positionsOf(rep))
    const d = s.mean - baseShape.mean
    console.log(
      `| ${name} | ${r.n} | ${pct(s.p)} | ${s.ratio.toFixed(3)} | **${s.mean.toFixed(1)}** | ` +
        `${d >= 0 ? '+' : ''}${d.toFixed(1)} |`
    )
  }
  console.log(
    '\n⇒ **③′ 卡的是最后那一列不降**（= 胜率 × 盈亏比的合成量）。' +
      '只看胜率会被「拿盈亏比换胜率」机械满足（§5.31：关回撤减仓胜率 +7.9pp、盈亏比 1.11→0.91）。' +
      '\n⚠ 期望是**全集**上的（含新增/消失的建仓），与下面那个**共有集合**上的配对 Δ 不是同一个数。'
  )

  console.log('\n### 6.3 配对 Δ 与聚类标准误（门槛 `|Δ|/stderr ≥ 2`）\n')
  console.log(
    '| 候选 | 配对数 | Δ 均值（元/建仓） | Δ>0 | 朴素 t（**未调整上界**） | ' +
      'CR1·建仓月 t（G） | CR1·时间片 t（G） | 过门槛？ |'
  )
  console.log('|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    const name = r.name.split(' — ')[0] as string
    const rep = load(name)
    if (!rep) continue
    const pos = positionsOf(rep)
    const keys = [...basePos.keys()].filter((k) => pos.has(k)).sort()
    const cand = keys.map((k) => pos.get(k) ?? null)
    const inc = keys.map((k) => basePos.get(k) ?? null)
    const entryDateOf = (k: string): string => k.split('|')[1] ?? ''
    const byMonth = pairedDelta(cand, inc, keys.map((k) => entryDateOf(k).slice(0, 7)))
    const bySlice = pairedDelta(
      cand,
      inc,
      keys.map((k) => sliceOf(entryDateOf(k), base.meta.from, base.meta.to))
    )
    if (!byMonth || !bySlice) {
      console.log(`| ${name} | 0 | — | — | — | — | — | ⚠ 配不上 |`)
      continue
    }
    const tm = byMonth.clusteredT
    const ts = bySlice.clusteredT
    // 门槛按**两档里 t 最小的那个**判（= 最保守），不许挑好看的那一个。
    //
    // ⚠ 2026-08-25 实测推翻了「G 越小越保守」这个直觉：G=3 那一档给出的 t **反而更大**
    // （4.68 vs 2.33）。CR1 的 meat 是**簇内残差和**的平方 —— 簇均值恰好都靠近总均值时
    // 它就比朴素式子还小，而 G=3 时这件事完全可能是巧合。少簇 CR1 本身也不可靠
    // （常见建议是把临界值从 1.96 换成 t_{G−1}，G=3 时约 4.30 ⇒ 那一档按 2 判是错的）。
    // ⇒ G=3 只当**诊断**用，门槛落在 min(两档)。
    const ts2 = tm === null || ts === null ? null : Math.min(tm, ts)
    const passes = ts2 !== null && ts2 >= 2
    console.log(
      `| ${name} | ${byMonth.cells} | ${byMonth.mean >= 0 ? '+' : ''}${byMonth.mean.toFixed(1)} | ` +
        `${byMonth.wins} | ${byMonth.t === null ? '—' : byMonth.t.toFixed(2)} | ` +
        `${tm === null ? '—' : tm.toFixed(2)}（${byMonth.clusters ?? '—'}） | ` +
        `${ts === null ? '—' : ts.toFixed(2)}（${bySlice.clusters ?? '—'}） | ` +
        `${passes ? `**过**（min ${ts2?.toFixed(2)}）` : `不过（min ${ts2 === null ? '—' : ts2.toFixed(2)}）`} |`
    )
  }
  console.log(
    '\n**门槛落在两档里 t 最小的那个**（= 最保守），不许挑好看的那一个 ——' +
      '两个聚类定义都站得住时挑一个等于给自己加一个自由度（同「零点定义」那族，docs/07 §3.6 ⑤）。' +
      '\n⚠ **「G 越小越保守」这个直觉是错的**（2026-08-25 实测）：G=3 那一档的 t 反而更大。' +
      'CR1 的 meat 是**簇内残差和**的平方，簇均值恰好都靠近总均值时它比朴素式子还小 ——' +
      '而 G=3 时这完全可能是巧合。少簇 CR1 的临界值也不是 2（常见建议是换成 `t_{G−1}`，' +
      'G=3 时约 4.30）⇒ **那一档只当诊断，主档是建仓月**。' +
      '\n⚠ **Δ 显著为正 ≠ 这个改动该采纳**：它只说「同一批建仓的结局真的变好了」，' +
      '而 Calmar 说的是路径。两者能反向 —— 关掉固定止损就是这个形状（期望 +111 元/建仓，' +
      '而 §5.30 判它没过红线）。出场类改动仍要过 ① 论证与红线，' +
      '**新门槛只作用于下一次改动**，回头重判已报实验就是移动球门。'
  )
}

main()
