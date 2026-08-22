/**
 * **执行滑移**：Perold (1988) 的 implementation shortfall，落到真机数据上（M2 §5.53）。
 *
 * ```bash
 * npx tsx scripts/verify/impl-shortfall.ts
 * ```
 *
 * ## 它填的是哪个洞
 *
 * [差距文档 §7 第 5 项](../../docs/notes/与机构量化系统的差距.md)「执行滑移指标
 * （ledger × 影子组合）」，也是**迭代阶梯 L1 的进入条件**
 * （「有真实成交记录；`ledger × 影子组合` 的差值能出数」）。
 *
 * ## 口径与归属
 *
 * **Perold, A.** (1988), *The Implementation Shortfall: Paper vs. Reality*,
 * **JPM 14(3) 4–9**。`IS` = 纸面组合（全按**决策价**成交）− 真实组合（实际价、实际股数）：
 *
 * ```
 * IS = C_d + C_i + C_e + C_o
 * C_d 延迟 = (下单时价 − 决策价) × 已成交
 * C_i 冲击 = (成交均价 − 下单时价) × 已成交
 * C_e 显性 = 手续费税费 × 已成交
 * C_o 机会 = (期末价 − 决策价) × **未成交**
 * IS(bps) = IS($) / (**期望**总股数 × 决策价)    ← 分母用想要的股数
 * ```
 *
 * **正 = 执行侵蚀了收益。** ⚠ 文献自带的警告：**持续为负要当心** ——
 * 那可能只是决策后价格恰好朝有利方向走，不是执行能力。
 *
 * ## ⚠ 四处易读错
 *
 * 1. **「滑移」≠ IS。** 滑移只是 `C_i`（成交价 vs 期望价这一个事件），
 *    IS 是「从决策到最终结果」的整个差距、**含未成交部分**。
 *    ⇒ 我们的 `--slippage 0.001` 只是 `C_i`、`trade.costs` 只是 `C_e`
 *    ⇒ **`C_d` 与 `C_o` 从来没量过**。
 * 2. **`C_o` 才是对 L0 系统最要紧的一项**：「想买但没买」也是成本 ——
 *    对「提醒 → 人决策」的形态，它对应**用户没有照提醒执行的那些信号**。
 * 3. **决策价 vs 到达价**常被混用。本脚本**写死用「信号那根 K 线的收盘价」**当决策价。
 * 4. **市场调整版 IS**（剥掉 beta）才是执行能力，未调整版混着大盘涨跌。
 *
 * ## ⚠ 一个先于数据的结论：§7 第 5 项的提法本身是错的
 *
 * 「`ledger × 影子` 的差 = 执行滑移」把一个**刻意的设计决定**记成了执行质量：
 * 影子**只吃 CONFIRMED**（收盘后才有）且**次日开盘成交**，而人看到的是**盘中**信号、
 * 当天就能动手 ⇒ 两者的价差主项是 **`C_d`（延迟）且符号是反的**（人比纸面组合**早**）。
 * 这不是缺陷、是纪律的代价，但必须先分出来，剩下的才是执行。
 *
 * ## 边界
 *
 * 真机库**只读**打开。不写任何东西。`n` 极小 ⇒ 只证明机器跑得通，**bps 数字不许引用**。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const DB = join(
  process.env['APPDATA'] ?? process.cwd(),
  'gp-pet',
  'market.db'
)

/** 出厂滑点（`params`/CLI 默认）—— 用来验影子的成交口径没和回测分叉 */
const SLIPPAGE = 0.001

interface TradeRow {
  code: string
  side: string
  shares: number
  price: number
  traded_at: number
}

interface JournalRow {
  trade_date: string
  kind: string
  code: string
  action: string | null
  shares: number | null
  price: number | null
  rule: string | null
  score: number | null
}

function main(): void {
  const db = new DatabaseSync(DB, { readOnly: true })

  console.log('# 执行滑移：Perold (1988) 落到真机数据（M2 §5.53）\n')

  // ---------- 1. 两边各有什么 ----------
  const trades = db.prepare('select code,side,shares,price,traded_at from trade_log order by traded_at').all() as unknown as TradeRow[]
  const journal = db
    .prepare('select trade_date,kind,code,action,shares,price,rule,score from shadow_journal order by trade_date,seq')
    .all() as unknown as JournalRow[]
  const fills = journal.filter((r) => r.kind.startsWith('FILLED'))

  // 08-13 那批 side='OPENING' 是**补录建仓**，不是照信号动手 ⇒ 不算决策
  const decisions = trades.filter((t) => t.side !== 'OPENING')

  console.log('## 1. 两边各有什么\n')
  console.log(
    `真实成交 ${trades.length} 行（其中 **${trades.length - decisions.length}** 行是 ` +
      `\`OPENING\` 补录建仓 ⇒ 不算照信号动手）⇒ **真实决策 ${decisions.length} 次**`
  )
  console.log(`影子成交 **${fills.length}** 笔（\`shadow_journal\` 的 FILLED_*）`)
  const realCodes = new Set(decisions.map((t) => t.code))
  const shadowCodes = new Set(fills.map((r) => r.code))
  const both = [...realCodes].filter((c) => shadowCodes.has(c))
  console.log(`重叠标的：**${both.join(' / ') || '（空）'}**（真实 ${realCodes.size} 只 · 影子 ${shadowCodes.size} 只）`)

  // ---------- 2. 影子成交口径自检（P1） ----------
  console.log('\n## 2. 自检：影子的成交价 = 次日开盘 × (1+滑点)？\n')
  console.log('| 标的 | 影子成交日 | 影子成交价 | 当日开盘(不复权) | 隐含滑点 | 与出厂 0.1% 差 |')
  console.log('|---|---|---|---|---|---|')
  const openOf = db.prepare('select open from kline_daily where code=? and trade_date=?')
  for (const f of fills) {
    const row = openOf.get(f.code, f.trade_date) as { open: number } | undefined
    if (row === undefined || f.price === null) {
      console.log(`| ${f.code} | ${f.trade_date} | ${f.price ?? '—'} | **库里没有这根** | — | — |`)
      continue
    }
    const implied = f.price / row.open - 1
    console.log(
      `| ${f.code} | ${f.trade_date} | ${f.price.toFixed(5)} | ${row.open.toFixed(4)} | ` +
        `${(implied * 100).toFixed(4)}% | ${((implied - SLIPPAGE) * 1e4).toFixed(2)} bp |`
    )
  }

  // ---------- 3. 决策价与两边的差（C_d 合并项 / C_i） ----------
  console.log('\n## 3. 重叠标的：决策价 → 两边成交价\n')
  console.log(
    '> ⚠ **决策价自己就有两个合法口径，所以并排报** —— 这是今天 §5.52 学到的那条教训\n' +
      '> （「发现某个量有两个合法口径，下一步就问它们能不能符号相反」）当场用在自己身上：\n' +
      '> ① **预注册写死的那个**：信号那根 K 线的**收盘价**；\n' +
      '> ② `signal.price_at`：**引擎判定那一刻真正看到的价**（盘中信号 ⇒ 它不是收盘价）。\n' +
      '> 真实那一侧 `C_d` 与 `C_i` **分不开**（缺成交时刻与 signal 关联，见 §5 那张清单）⇒ 合并成「决策→成交」。'
  )
  console.log(
    '\n| 标的 | 决策日 | 决策价①收盘 | 决策价②price_at | 真实成交/日 | **真实(①)** | **真实(②)** | 影子成交/日 | **影子(①)** | **影子(②)** |'
  )
  console.log('|---|---|---|---|---|---|---|---|---|---|')

  const lastSignalBefore = db.prepare(
    `select date(created_at/1000,'unixepoch','+8 hours') d, price_at
       from signal where code=? and created_at <= ? order by created_at desc limit 1`
  )
  const closeOf = db.prepare('select close from kline_daily where code=? and trade_date=?')

  for (const code of both) {
    const real = decisions.find((t) => t.code === code)
    const shadow = fills.find((r) => r.code === code)
    if (real === undefined || shadow === undefined || shadow.price === null) continue

    const sig = lastSignalBefore.get(code, real.traded_at) as
      | { d: string; price_at: number | null }
      | undefined
    const decisionDate = sig?.d ?? null
    const dRow =
      decisionDate === null ? undefined : (closeOf.get(code, decisionDate) as { close: number } | undefined)
    const pClose = dRow?.close ?? null
    const pAt = sig?.price_at ?? null

    const realDate = new Date(real.traded_at).toISOString().slice(0, 10)
    const fmt = (v: number | null): string => (v === null ? '—' : v.toFixed(4))
    const bp = (fill: number, ref: number | null): string =>
      ref === null || ref <= 0 ? '—' : `${((fill / ref - 1) * 1e4).toFixed(1)} bp`

    console.log(
      `| ${code} | ${decisionDate ?? '—'} | ${fmt(pClose)} | ${fmt(pAt)} | ` +
        `${real.price.toFixed(4)} / ${realDate} | **${bp(real.price, pClose)}** | **${bp(real.price, pAt)}** | ` +
        `${shadow.price.toFixed(4)} / ${shadow.trade_date} | **${bp(shadow.price, pClose)}** | **${bp(shadow.price, pAt)}** |`
    )
  }
  console.log(
    '\n⚠ **`n = 2`，上面每一个 bps 都不许被引用。** 这一节只证明「机器跑得通」（判据 3）。'
  )

  // 显性成本 C_e：trade_log 有 fee 列
  const feeRows = decisions.length
  const feeSum = db
    .prepare("select sum(fee) s, sum(price*shares) n from trade_log where side<>'OPENING'")
    .get() as { s: number | null; n: number | null }
  if (feeSum.s !== null && feeSum.n !== null && feeSum.n > 0) {
    console.log(
      `\n**\`C_e\`（显性成本）是唯一今天就完整的分量**：${feeRows} 次决策合计 **${feeSum.s.toFixed(2)} 元**` +
        ` / 名义 ${feeSum.n.toFixed(0)} 元 = **${((feeSum.s / feeSum.n) * 1e4).toFixed(1)} bp**（单边）。`
    )
  }

  // ---------- 4. 依从度（C_o 的计数版） ----------
  console.log('\n## 4. 依从度：引擎说了多少、人动了多少、影子动了多少\n')
  const confirmed = db
    .prepare(
      `select date(created_at/1000,'unixepoch','+8 hours') d, code, direction
         from signal where stage='CONFIRMED'`
    )
    .all() as unknown as Array<{ d: string; code: string; direction: string }>
  const actionable = confirmed.filter((r) => r.direction !== 'NONE' && r.direction !== 'HOLD')
  const actionableCodes = new Set(actionable.map((r) => r.code))

  console.log('| 口径 | 引擎(CONFIRMED 可动作) | 用户真实决策 | 影子成交 | 用户/引擎 |')
  console.log('|---|---|---|---|---|')
  console.log(
    `| 按**条/次** | ${actionable.length} | ${decisions.length} | ${fills.length} | ` +
      `**${((decisions.length / Math.max(actionable.length, 1)) * 100).toFixed(1)}%** |`
  )
  console.log(
    `| 按**标的**去重 | ${actionableCodes.size} | ${realCodes.size} | ${shadowCodes.size} | ` +
      `**${((realCodes.size / Math.max(actionableCodes.size, 1)) * 100).toFixed(1)}%** |`
  )
  const dirCount = new Map<string, number>()
  for (const r of confirmed) dirCount.set(r.direction, (dirCount.get(r.direction) ?? 0) + 1)
  console.log(
    `\nCONFIRMED 的方向分布：${[...dirCount.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`
  )
  console.log(
    '\n⚠ 这个比例**不是**「用户不听话」的度量：同一只票会连着几天出信号，' +
      '而用户买一次就够了 ⇒ **按标的去重那一行才是可读的那个**。'
  )

  // ---------- 5. 要算全 IS 还缺什么 ----------
  console.log('\n## 5. 要算全 `IS` 还缺什么（这一节是本轮的主要交付物）\n')
  const cols = (t: string): string[] =>
    (db.prepare(`select name from pragma_table_info('${t}')`).all() as unknown as Array<{ name: string }>).map(
      (r) => r.name
    )
  const tradeCols = cols('trade_log')
  console.log('| 分量 | 需要什么 | 有没有 |')
  console.log('|---|---|---|')
  console.log(
    `| \`C_d\` 延迟 | 决策时刻 + 下单时刻 | ⚠ **半个**：决策日可从 \`signal\` 推，但 ` +
      `\`trade_log.traded_at\` 存的是**本机 12:00**（不是真实成交时刻）⇒ 只能按**日**算 |`
  )
  console.log(
    `| \`C_i\` 冲击 | 下单时的市价 | ❌ **没有** ⇒ 与 \`C_d\` 分不开（第 3 节因此合并） |`
  )
  console.log(
    `| \`C_e\` 显性 | 手续费税费 | ✅ **有**（\`trades/ledger.ts\` 复用 \`backtest/costs.ts\`）${tradeCols.includes('fee') ? '，且落在 `trade_log.fee`' : '，但**没落进 `trade_log`**'} |`
  )
  console.log(
    `| \`C_o\` 机会 | 「想买但没买」的股数与期末价 | ❌ **口径未定** —— 用户没动手的信号算不算「想买」？那是产品判断 |`
  )
  console.log(
    `| 全部 | 成交与**哪一条信号**关联 | ❌ \`trade_log\` 无 \`signal_id\`（现有列：${tradeCols.join(', ')}） |`
  )

  db.close()
}

main()
