/**
 * **成交量硬上限 vs 凸成本模型**：外部平台的形态能不能替代（M2 §5.55）。
 *
 * ```bash
 * npx tsx scripts/verify/volume-cap.ts
 * ```
 *
 * ## 它填的是哪个洞
 *
 * [§5.54](../../docs/notes/M2-偏差报告.md) 的结论是「放大资金前**必须先换**凸成本模型」，
 * 但**换成什么形态**它没有答案；而它自己查出失效有**两条方向相反的路径**
 * （高波动·低参与率 / 低波动·高参与率）⇒ 单维度分档会漏掉一条。
 *
 * 外部答案（聚宽 API 文档，2026-08-24 一手原文，与 08-19 的副本逐字节相同）：
 * **他们根本没有凸成本模型。** 三种滑点 `FixedSlippage` / `PriceRelatedSlippage` /
 * `StepRelatedSlippage` **全部与成交量无关**（原文写明「我们认为您的落单的多少**并不会影响**
 * 您最后的成交价格」），大单靠 **`set_option('order_volume_ratio', value)`** 这个
 * **成交量硬上限**兜 —— 而它**默认 1.0 = 不设限**。
 *
 * ## ⚠ 四处易读错
 *
 * 1. **硬上限与凸成本改的不是同一个量。** 凸成本让大单**能成交但每股更贵**；
 *    硬上限让大单**成交不了那么多**（量被截断、单价不变）。
 *    净值上一个表现为**成本升高**，另一个表现为**仓位建不满**。
 * 2. **「有这个选项」不等于「默认受保护」** —— `ratio` 默认 1.0，聚宽的出厂配置
 *    在大资金上与我们一样是无保护的。
 * 3. **它是「每单」约束不是「每日」约束**（原文自己说多次下单可以绕过）。
 *    我们的回测一次建仓就是一笔，不吃这个漏洞；影子运行/实盘日后按分批建仓写就会。
 * 4. **「超过全市场成交量就取全市场成交量」是兜底但不报警的失败方式** ——
 *    与本项目「silent cap 必须进计数器」的纪律相反。抄形态时别把这条一起抄。
 *
 * ## 关键推导：重合度是个结构常数
 *
 * 平方根律下冲击 `= √m · (Y·σ√p)`，资金倍数 `m` 是**全局标量**
 * ⇒ 「谁最先失效」的排序**与 `m` 无关**；硬上限的排序（按 `p`）同样与 `m` 无关。
 * ⇒ **两个名单的重合度不随资金规模变化**，这里算出来的数对任何资金规模都成立。
 *
 * ## 边界
 *
 * - **只读**既有报告与 fixture，**不跑任何模拟** ⇒ `--touch-test` 不变。
 * - **不改 `DEFAULT_COSTS`、不改 `simulate.ts`**。本轮只判形态能不能替代，不落地任何上限。
 * - **不重判任何已报绩效。**
 * - 建仓样本与 §5.54 **共用** [`entries.ts`](./entries.ts) —— 两个名单只要样本集合差一次建仓，
 *   重合度就不是同一个东西了。
 */
import { join } from 'node:path'

import { bps, loadEntries, median, pct, quantile, type Entry } from './entries'

const CALIB_DIR = join(process.cwd(), 'reports', 'calib')
const HISTORY_DIR = join(process.cwd(), 'data', 'history')

/** 名单重合度要比的 top-N（预注册写死两档，不许换到好看为止） */
const TOP_NS = [50, 100] as const

/**
 * 要检验的成交量上限档位。
 * - `1.0` 聚宽默认（= 不设限）
 * - `0.25` 聚宽文档示例值
 * - `0.10` 业界常用的单日参与率上限
 */
const RATIOS = [1.0, 0.25, 0.1] as const

/** 排序用的冲击（`Y` 与 `exp` 只影响水平不影响排序，取 §5.54 的主口径） */
const impactOf = (e: Entry): number => 1 * e.sigma * (e.qNominal / e.adv) ** 0.5

const keyOf = (e: Entry): string => `${e.code}:${e.date}`

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? Number.NaN : inter / union
}

function topSet(entries: readonly Entry[], score: (e: Entry) => number, n: number): Entry[] {
  return [...entries].sort((x, y) => score(y) - score(x)).slice(0, n)
}

function main(): number {
  const { report, entries, total, missing, missingCodes } = loadEntries(
    join(CALIB_DIR, 'cap-100000.json'),
    HISTORY_DIR
  )

  console.log('# 成交量硬上限 vs 凸成本模型：外部形态能不能替代')
  console.log('')
  console.log(`来源报告 cap-100000.json（${report.meta.engineVersion} · ${report.meta.from} → ${report.meta.to}）`)
  console.log(`建仓（按 code+entryDate 归组）**${total}** 次 · 逐笔行 ${report.trades.length}`)
  console.log(`可算 **${entries.length}** 次（覆盖率 ${((entries.length / total) * 100).toFixed(1)}%）`)
  console.log(
    `missing：无 fixture ${missing.noFixture} · 无该日 K 线 ${missing.noBar} · 段前不足 21 根 ${missing.shortHistory} · 成交额缺口 ${missing.zeroAdv} · σ 无效 ${missing.zeroSigma}`
  )
  if (missingCodes.size > 0) console.log(`无 fixture 的标的：${[...missingCodes].join(' ')}`)
  console.log('')

  const partAdv = (e: Entry): number => e.qNominal / e.adv
  const partDay = (e: Entry): number => e.qNominal / e.advSameDay
  const sigmaAll = entries.map((e) => e.sigma)
  const sigmaMedian = median(sigmaAll)

  // ── ① 截断门槛 m*（算术推论，不计分）───────────────────────────────────
  console.log('## ① 截断门槛 `m*`（**算术推论，不计分** —— 它就是 `ratio ÷ 参与率`）')
  console.log('')
  console.log('`m*` = 使该次建仓开始被 `order_volume_ratio` 截断的资金倍数（出厂 = 每标的 10 万 = 1×）。')
  console.log('')
  console.log('| 上限 `ratio` | 分母 | 出厂资金下被截的次数 | `m*`·中位 | `m*`·最先被截的 5% |')
  console.log('|---|---|---|---|---|')
  for (const ratio of RATIOS) {
    for (const [label, part] of [
      ['ADV_20', partAdv],
      ['当日成交额（聚宽真口径）', partDay],
    ] as const) {
      const ps = entries.map(part).filter((p) => Number.isFinite(p) && p > 0)
      const ms = ps.map((p) => ratio / p)
      const hitNow = ps.filter((p) => p > ratio).length
      console.log(
        `| ${ratio.toFixed(2)}${ratio === 1 ? '（聚宽默认）' : ''} | ${label} | **${hitNow}** | ${median(ms).toFixed(0)}× | ${quantile(ms, 0.05).toFixed(1)}× |`
      )
    }
  }
  console.log('')

  // ── 归档：当日 vs ADV_20 口径之比（§5.54 算过没归档，本轮只归档不预测）──
  const ratioDayAdv = entries
    .map((e) => partDay(e) / partAdv(e))
    .filter((x) => Number.isFinite(x) && x > 0)
  console.log('### 归档｜当日口径 ÷ ADV_20 口径 的参与率之比')
  console.log('')
  console.log(
    `中位 **${median(ratioDayAdv).toFixed(3)}** · p10 ${quantile(ratioDayAdv, 0.1).toFixed(3)} · p90 ${quantile(ratioDayAdv, 0.9).toFixed(3)} · 覆盖 ${ratioDayAdv.length}/${entries.length}`
  )
  console.log('')
  console.log('> < 1 ⇒ 信号日成交额**高于**前 20 日中位（= 信号日放量）⇒ 用当日做分母会让参与率偏低。')
  console.log('> 这一行是 §5.54 预注册里那句机制假设的第一次量化，**本轮不当预测**（脚本早就算过、只是没归档）。')
  console.log('')

  // ── ② 两个名单的重合度 ─────────────────────────────────────────────
  console.log('## ② 两个名单的重合度（凸成本排序 vs 硬上限排序）')
  console.log('')
  console.log(`全样本 \`σ_20\` 中位 = **${(sigmaMedian * 100).toFixed(2)}%**`)
  console.log('')
  console.log('| top-N | Jaccard | 冲击名单 σ 中位 | 参与率名单 σ 中位 | 冲击名单里 σ > 全样本中位的占比 |')
  console.log('|---|---|---|---|---|')
  const jaccards: number[] = []
  for (const n of TOP_NS) {
    const byImpact = topSet(entries, impactOf, n)
    const byPart = topSet(entries, partAdv, n)
    const j = jaccard(new Set(byImpact.map(keyOf)), new Set(byPart.map(keyOf)))
    jaccards.push(j)
    const hiVolShare = byImpact.filter((e) => e.sigma > sigmaMedian).length / byImpact.length
    console.log(
      `| ${n} | **${j.toFixed(3)}** | ${(median(byImpact.map((e) => e.sigma)) * 100).toFixed(2)}% | ${(median(byPart.map((e) => e.sigma)) * 100).toFixed(2)}% | ${(hiVolShare * 100).toFixed(1)}% |`
    )
  }
  const [j50, j100] = jaccards
  console.log('')
  if (j50 !== undefined && j100 !== undefined) {
    console.log(`对 N 的敏感度：|J(50) − J(100)| = **${Math.abs(j50 - j100).toFixed(3)}**`)
    console.log('')
  }

  // ── ③ 硬上限抓不到谁：冲击 top-10 在参与率排序里的位次 ────────────────
  console.log('## ③ 硬上限抓不到谁（冲击 top-10 在**参与率**排序里的位次）')
  console.log('')
  const partSorted = [...entries].sort((a, b) => partAdv(b) - partAdv(a))
  const rankOf = new Map(partSorted.map((e, i) => [keyOf(e), i + 1]))
  console.log('| 标的 | 入场日 | σ_20 | 参与率 | 冲击 | 冲击排名 | **参与率排名** | 硬上限 top-50 抓得到？ |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const [i, e] of topSet(entries, impactOf, 10).entries()) {
    const r = rankOf.get(keyOf(e)) ?? Number.NaN
    console.log(
      `| ${e.code} | ${e.date} | ${(e.sigma * 100).toFixed(2)}% | ${pct(partAdv(e))} | ${bps(impactOf(e))} | ${i + 1} | **${r}** | ${r <= 50 ? '是' : '**否**'} |`
    )
  }
  console.log('')

  return 0
}

process.exitCode = main()
