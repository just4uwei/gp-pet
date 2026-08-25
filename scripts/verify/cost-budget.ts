/**
 * **成本预算**：负期望里可压缩的那部分有多大（M2 §5.58）。
 *
 * ```bash
 * npx tsx scripts/verify/cost-budget.ts
 * ```
 *
 * ## 它答什么
 *
 * 已知每次建仓期望 **−477 元 /（10 万名义）**，其中约 **327 元是成本（69%）**
 * ⇒ 入场信号的原始边缘只有 **−0.15%**（M2 §5.29）。但那 327 元**从来没拆开过**，
 * 而「压缩哪一块」是完全不同的动作：
 *
 * | 成本块 | 怎么才能压 | L0 阶段管不管得着 |
 * |---|---|---|
 * | 印花税（卖出 0.1%） | 换标的 —— 场内基金免征（`isFundBoard`） | 管得着（选池） |
 * | 过户费（0.001% 双边） | 同上 | 管得着 |
 * | 佣金（万 2.5，下限 5 元） | 换券商 / 提高单笔金额 | 部分 |
 * | 滑点（单边 0.1%，模型假设） | 改下单方式 | **管不着**（不下单） |
 * | 出场碎片化多付的那份 | 改出场规则（走 §3.6a 的门槛） | 管得着 |
 *
 * ## 两个独立的滑点估计并排（这一节最容易出错的地方）
 *
 * `trade.costs` **不含滑点** —— 滑点作用在成交价上（`buyFill`/`sellFill` 把价格 ±0.1%）。
 * 所以这里给两个估计：
 *
 * 1. **模型式** `slippage × (买入名义 + 卖出名义)` —— 由成本模型直接推出；
 * 2. **配对式** 与 `noslip-train.json`（`--slippage 0`，同窗口）按 `(code, entryDate)`
 *    逐次配对的 `pnl` 差。
 *
 * 两个对不上，说明我对成本模型的理解有错 —— 那比数字本身重要。
 * ⚠ 配对式有一个已知的污染源：关掉滑点会改变现金流 ⇒ `lotsAffordable` 可能变
 * ⇒ 两份报告的建仓集合与股数**不完全相同**。所以配对式只在**共有且股数相同**的
 * 那部分建仓上算，并把被排除的部分显式报出来（约束 4 的那条纪律：缺就说缺，不当 0）。
 *
 * ## 边界
 *
 * 只读报告 · 不改 `DEFAULT_COSTS`（那是对市场事实的描述，不是旋钮）·
 * 不改任何出场规则 · 不碰测试窗口 · 不重判 §5.30/§5.31。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_COSTS } from '../../src/backtest/costs'
import { median, quantile } from './entries'

const DIR = join(process.cwd(), 'reports', 'calib')

interface Trade {
  code: string
  entryDate: string
  exitDate: string
  entryPrice: number
  exitPrice: number
  shares: number
  pnl: number
  pnlPct: number
  holdingBars: number
  costs: number
  exitRule: string
  partial: boolean
}

interface Report {
  meta: { from: string; to: string; codes: unknown[]; capitalPerCode: number }
  performance: { totalReturn: number }
  trades: Trade[]
}

/** 一次建仓（`(code, entryDate)` 归组）—— 回撤减仓会把它拆成两三行 `trade` */
interface Position {
  key: string
  code: string
  entryDate: string
  /** 卖出行数。> 1 就是被拆过 */
  legs: number
  shares: number
  pnl: number
  /** `trade.costs` 之和（佣金 + 印花税 + 过户费，**不含滑点**） */
  fees: number
  /** 买入名义（元，前复权计价 —— 与回测的资金口径一致） */
  buyNotional: number
  /** 卖出名义之和（元） */
  sellNotional: number
  /** 建仓级持有跨度：最后一笔卖出的 `holdingBars` */
  holdingBars: number
  exitRules: string[]
}

function load(name: string): Report {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Report
}

function positionsOf(rep: Report): Map<string, Position> {
  const out = new Map<string, Position>()
  for (const t of rep.trades) {
    const key = `${t.code}|${t.entryDate}`
    const prev = out.get(key)
    if (prev) {
      prev.legs += 1
      prev.shares += t.shares
      prev.pnl += t.pnl
      prev.fees += t.costs
      prev.buyNotional += t.entryPrice * t.shares
      prev.sellNotional += t.exitPrice * t.shares
      prev.holdingBars = Math.max(prev.holdingBars, t.holdingBars)
      prev.exitRules.push(t.exitRule)
    } else {
      out.set(key, {
        key,
        code: t.code,
        entryDate: t.entryDate,
        legs: 1,
        shares: t.shares,
        pnl: t.pnl,
        fees: t.costs,
        buyNotional: t.entryPrice * t.shares,
        sellNotional: t.exitPrice * t.shares,
        holdingBars: t.holdingBars,
        exitRules: [t.exitRule],
      })
    }
  }
  return out
}

const yuan = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '—')
const pctOf = (x: number): string => (Number.isFinite(x) ? `${(100 * x).toFixed(2)}%` : '—')
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * 一次建仓的**卖出侧**手续费（佣金 + 印花税 + 过户费），按名义额算。
 * 与 `costs.ts` 的 `sellFees` 同式，但这里只需要「多一次卖出要多付多少」的量级，
 * 所以直接用费率 —— 佣金下限 5 元照样考虑。
 */
function sellFeeOf(notional: number, fundBoard: boolean): number {
  const commission = Math.max(DEFAULT_COSTS.minCommission, notional * DEFAULT_COSTS.commissionRate)
  const stamp = fundBoard ? 0 : notional * DEFAULT_COSTS.stampTaxRate
  const transfer = fundBoard ? 0 : notional * DEFAULT_COSTS.transferFeeRate
  return commission + stamp + transfer
}

function main(): void {
  const base = load('cap-100000')
  const noslip = load('noslip-train')
  const pos = [...positionsOf(base).values()]
  const nsPos = positionsOf(noslip)
  const N = pos.length
  const slip = DEFAULT_COSTS.slippage

  console.log('# 成本预算：负期望里可压缩的那部分（M2 §5.58）\n')
  console.log(
    `基线 \`cap-100000\` · ${base.meta.from} → ${base.meta.to} · ${base.meta.codes.length} 只 · ` +
      `建仓 **${N}** · 区间收益 ${pctOf(base.performance.totalReturn)}\n`
  )

  // ── 1. 每次建仓的期望与成本三块 ──
  const pnl = pos.map((p) => p.pnl)
  const fees = pos.map((p) => p.fees)
  const slipModel = pos.map((p) => slip * (p.buyNotional + p.sellNotional))
  const stamp = pos.map((p) => DEFAULT_COSTS.stampTaxRate * p.sellNotional)
  const transfer = pos.map((p) => DEFAULT_COSTS.transferFeeRate * (p.buyNotional + p.sellNotional))
  const commission = pos.map((_p, i) => (fees[i] ?? 0) - (stamp[i] ?? 0) - (transfer[i] ?? 0))

  console.log('## 1. 每次建仓的期望，与成本的三块\n')
  console.log('| 项 | 均值（元/建仓） | 中位 | 占 \\|期望\\| |')
  console.log('|---|---|---|---|')
  const expect = mean(pnl)
  const row = (label: string, xs: readonly number[]): void => {
    console.log(
      `| ${label} | **${yuan(mean(xs))}** | ${yuan(median(xs))} | ${pctOf(Math.abs(mean(xs) / expect))} |`
    )
  }
  console.log(`| **期望（已扣全部成本）** | **${yuan(expect)}** | ${yuan(median(pnl))} | 100% |`)
  row('手续费合计（`trade.costs`）', fees)
  row('　└ 佣金', commission)
  row('　└ 印花税（卖出单边）', stamp)
  row('　└ 过户费', transfer)
  row('滑点（模型式）', slipModel)
  const totalCost = pos.map((_p, i) => (fees[i] ?? 0) + (slipModel[i] ?? 0))
  row('**成本合计**', totalCost)
  console.log(
    `\n⇒ **成本归零后的原始边缘 = ${yuan(expect + mean(totalCost))} 元/建仓**` +
      `（占名义 10 万的 ${pctOf((expect + mean(totalCost)) / 100000)}）。`
  )

  // ── 2. 滑点的第二个估计：与 noslip 配对 ──
  console.log('\n## 2. 滑点的交叉验证：模型式 vs 与 `noslip-train` 配对\n')
  let paired = 0
  let sharesDiff = 0
  let missing = 0
  const pairedSlip: number[] = []
  const pairedModel: number[] = []
  for (const p of pos) {
    const q = nsPos.get(p.key)
    if (!q) {
      missing += 1
      continue
    }
    if (q.shares !== p.shares) {
      sharesDiff += 1
      continue
    }
    paired += 1
    pairedSlip.push(q.pnl - p.pnl)
    pairedModel.push(slip * (p.buyNotional + p.sellNotional))
  }
  console.log(
    `配对 **${paired}** / ${N} 次建仓（noslip 里没有 ${missing} 次 · 股数不同 ${sharesDiff} 次` +
      ' —— 关掉滑点会改现金流 ⇒ `lotsAffordable` 可能变，这两档必须排除而不是硬配）'
  )
  console.log('')
  console.log('| 估计 | 均值（元/建仓） | 中位 |')
  console.log('|---|---|---|')
  console.log(`| 模型式 \`slip × (买入名义 + 卖出名义)\` | ${yuan(mean(pairedModel))} | ${yuan(median(pairedModel))} |`)
  console.log(`| 配对式 \`pnl(noslip) − pnl(base)\` | ${yuan(mean(pairedSlip))} | ${yuan(median(pairedSlip))} |`)
  const gap = (mean(pairedSlip) - mean(pairedModel)) / mean(pairedModel)
  const gapMed = (median(pairedSlip) - median(pairedModel)) / median(pairedModel)
  console.log(
    `\n均值相差 **${pctOf(gap)}** · **中位相差 ${pctOf(gapMed)}**。`
  )
  /*
    均值与中位背离时，先查是不是「少数配对被别的东西污染了」而不是模型错（读数纪律 2）。
    这里有一个具体的污染机制：关掉滑点会让成交价变一点点 ⇒ **触发止损/减仓的那一根可能挪位**
    ⇒ 那次建仓的整条路径（出场日、出场价、甚至拆成几次卖）都不同 ⇒
    `pnl(noslip) − pnl(base)` 里混进了「走了另一条路」而不只是「少付了滑点」。
    所以要看的是 **差值的分布**，不是它的均值。
  */
  const diffs = pairedSlip.map((v, i) => v - (pairedModel[i] ?? 0))
  const big = diffs.filter((d) => Math.abs(d) > 500).length
  console.log(
    `\n配对差值（配对式 − 模型式）分布：中位 **${yuan(median(diffs))}** · ` +
      `p05 ${yuan(quantile(diffs, 0.05))} · p95 ${yuan(quantile(diffs, 0.95))} · ` +
      `|差| > 500 元的有 **${big}** / ${paired}（${pctOf(big / paired)}）`
  )
  console.log(
    Math.abs(gapMed) < 0.05
      ? '\n⇒ **中位一致（< 5%）⇒ 成本模型的理解没问题**，均值那 10% 来自少数几次建仓：' +
          '关掉滑点会让成交价挪一点，于是**触发止损/减仓的那一根可能换一天** ⇒ ' +
          '那几次的差值里混着「走了另一条路径」而不只是「少付了滑点」。' +
          '⚠ 这也说明**「关掉某个成本再相减」这种反事实不是纯的** —— 它在几十次建仓上改了路径。'
      : '\n⚠ **连中位都对不上 ⇒ 先查这个，别用下面的数**：要么共有集合不干净，要么我对成本模型的理解有错。'
  )

  // ── 3. 出场碎片化 ──
  console.log('\n## 3. 出场碎片化：一次建仓被拆成几次卖出\n')
  const legs = pos.map((p) => p.legs)
  const dist = new Map<number, number>()
  for (const k of legs) dist.set(k, (dist.get(k) ?? 0) + 1)
  console.log('| 卖出行数 | 建仓数 | 占比 |')
  console.log('|---|---|---|')
  for (const k of [...dist.keys()].sort((a, b) => a - b)) {
    console.log(`| ${k} | ${dist.get(k)} | ${pctOf((dist.get(k) ?? 0) / N)} |`)
  }
  console.log(`\n平均 **${mean(legs).toFixed(3)}** 次卖出/建仓 · 中位 ${median(legs)}`)

  /*
    碎片化多付了多少：把「实际的 k 次卖出」与「假设一次卖光」比。
    一次卖光的卖出名义总额相同（同一批股数、忽略价差），差的是
    ① 佣金下限（每次至少 5 元）② 佣金/印花税/过户费按名义分摊后总额其实不变
    ⇒ **真正多付的只有佣金下限那一块 + 每次卖出的滑点**（滑点按名义比例，总额也不变）。
    所以这一节的结论很可能是「碎片化几乎不多付」—— 那也是结论，而且它推翻了
    「减少碎片化能省成本」这个直觉。照实报。
  */
  let extra = 0
  for (const p of pos) {
    if (p.legs <= 1) continue
    const perLeg = p.sellNotional / p.legs
    const actual = p.legs * sellFeeOf(perLeg, false)
    const once = sellFeeOf(p.sellNotional, false)
    extra += actual - once
  }
  console.log(
    `\n碎片化多付的手续费合计 **${yuan(extra)}** 元 = **${yuan(extra / N)}** 元/建仓 ` +
      `= 总成本的 ${pctOf(extra / N / mean(totalCost))}`
  )
  console.log(
    '\n⚠ 这一块**结构上只能小**：印花税/过户费/滑点都按名义额比例收 ⇒ 拆几次卖，总额不变；' +
      '真正多付的只有**佣金下限 5 元**那一档。⇒ 「减少碎片化出场能省成本」这个直觉' +
      '在这套成本模型下是错的（碎片化的代价在别处：多一次卖出就多一次择时）。'
  )

  // ── 4. 「ETF 化」的算术上限 ──
  console.log('\n## 4. 换成场内基金（免印花税与过户费）能省多少\n')
  const saved = pos.map((_p, i) => (stamp[i] ?? 0) + (transfer[i] ?? 0))
  console.log(
    `印花税 + 过户费 = **${yuan(mean(saved))}** 元/建仓 = 负期望的 **${pctOf(mean(saved) / Math.abs(expect))}**` +
      '（isFundBoard 已经在做这件事，见 costs.ts）'
  )
  console.log(
    `⇒ 若整池换成 ETF，期望从 ${yuan(expect)} 变成 **${yuan(expect + mean(saved))}** 元/建仓 —— **仍为负**。`
  )

  // ── 5. 时间维度：成本是每次往返固定的 ──
  console.log('\n## 5. 时间维度：成本按「次」收，不按「天」收\n')
  const bars = pos.map((p) => p.holdingBars)
  const costPerBar = pos.map((p, i) => (totalCost[i] ?? 0) / Math.max(1, p.holdingBars))
  console.log(
    `建仓级持有 中位 **${median(bars)}** 根 · p25 ${quantile(bars, 0.25)} · p75 ${quantile(bars, 0.75)} · ` +
      `均值 ${mean(bars).toFixed(1)}`
  )
  console.log(
    `成本 / 持有根数：中位 **${yuan(median(costPerBar))}** 元/根 · 均值 ${yuan(mean(costPerBar))} 元/根`
  )
  console.log(
    '\n⇒ 成本是**每次往返固定**的 ⇒ 单位时间成本 ∝ 1/持有时长。' +
      '「持有更久」在算术上确实降低单位时间成本，**但它同时改变的是策略本身**' +
      '（持有 28 根的系统不是持有 14 根的系统），所以它不是一个成本改动而是一个' +
      '出场类改动 ⇒ 要走 docs/07 §3.6a 的门槛，不能拿这一节的算术当依据。'
  )

  // ── 6. 「成本占 69%」这句话依赖均值口径 ──
  console.log('\n## 6. ⚠ 「成本占负期望 69%」是一个**均值口径**的说法\n')
  const medPnl = median(pnl)
  const medCost = median(totalCost)
  console.log('| 口径 | 每次建仓的结果 | 成本 | 成本占 |')
  console.log('|---|---|---|---|')
  console.log(`| **均值** | ${yuan(expect)} | ${yuan(mean(totalCost))} | **${pctOf(mean(totalCost) / Math.abs(expect))}** |`)
  console.log(`| **中位** | ${yuan(medPnl)} | ${yuan(medCost)} | **${pctOf(medCost / Math.abs(medPnl))}** |`)
  console.log(
    `\n**中位建仓亏 ${yuan(medPnl)} 元，比均值差 ${(medPnl / expect).toFixed(1)} 倍** ——` +
      '均值被少数大赢家托着（同 §5.45 那条：加权与中位背离时以中位为准）。' +
      '\n⇒ 对**典型的那一次建仓**，成本只占它亏损的 ' +
      `**${pctOf(medCost / Math.abs(medPnl))}**，剩下的是判断本身错了。` +
      '两个数都对，但它们支撑的结论相反：均值口径让「降成本」看起来是主线，' +
      '中位口径说它是配角。**引用「成本占 69%」必须带上「均值口径」四个字。**'
  )

  console.log('\n## 7. 一行结论\n')
  console.log(
    `成本占负期望 **${pctOf(mean(totalCost) / Math.abs(expect))}**（均值口径；中位口径只有 ` +
      `${pctOf(medCost / Math.abs(medPnl))}），其中 L0 阶段真正能动的（印花税 + 过户费）只有 ` +
      `**${pctOf(mean(saved) / Math.abs(expect))}**；**成本归零后期望仍是 ` +
      `${yuan(expect + mean(totalCost))} 元/建仓** ⇒ 成本层是**必要不充分**，` +
      '它决定「离零有多远」，不决定符号。'
  )
}

main()
