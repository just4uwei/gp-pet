/**
 * **财务因子的横截面 rank IC** —— 「换维度」这条路有没有燃料（预注册见 M2 §5.62）。
 *
 * ```bash
 * node scripts/fetch-financials.mjs --codes params/universe-broad.json --out data/financials
 * npx tsx scripts/verify/factor-ic.ts --fixtures ./data/history --financials ./data/financials
 * ```
 *
 * ## 它在回答什么
 *
 * 08-19 用户拍板停止在「个股 · 日线 · 择时」上找边缘。之后问「重开有没有新变化能让它成功」，
 * 盘点的答案是：**只有新数据维度可能抬天花板**，而财务 08-25 刚探到有源（带 PIT 公告日）。
 * ⇒ **先量再决定**：这个池子上财务因子有没有信息，是一个能在半天内答完的问题。
 *
 * ## 五条口径（改之前先读预注册）
 *
 * 1. **`icOf` 从 `ic-audit.ts` 引，不许另写一份** —— 否则「引擎得分的 IC」与
 *    「财务因子的 IC」不是同一个口径，而两个数会被并排放进同一张表里比。
 * 2. **PIT 是这一轮唯一不能出错的地方**：每个交易日只用 `noticeDate <= 该日` 的最新一期。
 *    用 `reportDate` 切就是未来函数 —— 2023 年报的数据在 2023-12-31 那天**并不存在**
 *    （实测 `600000` 的 2023-12-31 那期 `noticeDate = 2024-04-30`，差 **4 个月**），
 *    而这种错**不会报错、只会让 IC 变好看**。
 * 3. **五个因子写死在 `FACTORS` 里，不许加也不许换**（预注册锁的就是这个）。
 *    价值 / 质量 / 成长各一类。不扫那 37 个字段 —— 那是 DSR 在量的那件事。
 * 4. **前瞻收益用后复权** `closeAdj`（除权不该被算成一次下跌），
 *    而 `B/P` `E/P` 的分母用**不复权** `close`（`BPS` / `EPS` 是不复权口径的每股量）。
 *    两条轨在这里必须分开用，混一条就会把高分红股的估值算错一个量级。
 * 5. **非 A 股行剔掉**（台账限制 2：那个端点里混着别的证券类型）。
 *
 * ## ⚠ 一个**先于结果**就知道的限制
 *
 * 财务因子一个季度才变一次 ⇒ 逐日 IC 序列的自相关远超 `h−1` 那个滞后阶
 * ⇒ **NW 在这里仍然低估方差，`|t|` 是上界**。有效独立样本数接近**报告期数**（约 24 期），
 * 不是 1400 多个交易日。⇒ 过了 `|t| ≥ 2` 也只能当「值得再看」，不能当「显著」。
 *
 * ## 边界
 *
 * **只读**：不改引擎、不进 `params.ts`、不新增指标（约束 5）。**不碰测试窗口**
 * （上界卡 2025-06-30）。幸存者偏差那一支（233 只退市股的财务）**未做** ——
 * 方向是**高估**，若结果为正必须补做才算数。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { icOf, type Row } from '../../src/backtest/ic-audit'
import { loadBars } from '../../src/backtest/vol-target'
import type { SecCode, TradeDate } from '../../src/core/types'

/** 预注册锁定的五个因子。**不许加、不许换、不许只报好看的那个** */
const FACTORS = [
  { key: 'B/P', label: '账面市值比（BPS ÷ 收盘）', kind: '价值' },
  { key: 'E/P', label: '盈利价格比（近四季 EPS ÷ 收盘）', kind: '价值' },
  { key: 'ROE', label: '加权净资产收益率', kind: '质量' },
  { key: 'RevYoY', label: '营业收入同比', kind: '成长' },
  { key: 'ProfitYoY', label: '净利润同比', kind: '成长' },
] as const
type FactorKey = (typeof FACTORS)[number]['key']

/** 预注册的持有期。**20 日是主判据**，5/10 并排报但不承重（财务是慢变量） */
const HORIZONS = [5, 10, 20] as const
const PRIMARY = 20

const WINDOWS = [
  { name: '训练', from: '2018-01-01', to: '2023-12-31', primary: true },
  { name: '验证', from: '2024-01-01', to: '2025-06-30', primary: false },
] as const

/**
 * 池子。**两个池刻意不合并** —— 合成一个，「含退市 vs 不含退市」这个对照就再也做不出来
 * （与 `universe-broad` / `universe-delisted` 两份清单不合并是同一条纪律）。
 *
 * ⚠ 预注册（§5.62 边界 2）写着：**结果为正必须补做退市那一支才算数**，
 * 因为幸存者偏差对财务因子的方向是**高估** —— 高 `B/P` 往往就是「便宜得有理由」，
 * 而那些真的退了市的票**根本不在存活池里**。
 */
const POOLS = [
  { name: '存活池', file: 'params/universe-broad.json' },
  { name: '含退市', file: 'both' },
] as const

interface Period {
  reportDate: string
  noticeDate: string | null
  basicEps: number | null
  bps: number | null
  roe: number | null
  revYoy: number | null
  profitYoy: number | null
  securityType: string | null
}

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback
}

const num = (v: number | null, d = 3): string =>
  v === null || !Number.isFinite(v) ? '—' : v.toFixed(d)
const pct = (v: number | null, d = 2): string =>
  v === null || !Number.isFinite(v) ? '—' : `${(100 * v).toFixed(d)}%`

/**
 * **PIT 取值**：给定交易日，取 `noticeDate <= date` 的**最新一期**。
 *
 * 两条：① `noticeDate` 为 null 的期直接跳过（不知道什么时候公布的，就不能用）；
 * ② 「最新」按 `reportDate` 比，不按 `noticeDate` —— 同一天可能补披露好几期旧报表，
 * 那时该用的是**报告期最新**的那一份。
 */
function pitPeriod(periods: readonly Period[], date: string): Period | null {
  let best: Period | null = null
  for (const p of periods) {
    if (p.noticeDate === null || p.noticeDate > date) continue
    if (best === null || p.reportDate > best.reportDate) best = p
  }
  return best
}

/** 近四季 EPS：单季不可加（`BASIC_EPS` 是**年初至今累计**），所以直接用最近一期的累计值 × 年化 */
function ttmEps(at: Period): number | null {
  if (at.basicEps === null) return null
  // `REPORTDATE` 的月份决定累计了几个季度：03/06/09/12 → 1/2/3/4 季
  const month = Number(at.reportDate.slice(5, 7))
  const quarters = month === 3 ? 1 : month === 6 ? 2 : month === 9 ? 3 : 4
  return (at.basicEps / quarters) * 4
}

function factorValue(key: FactorKey, p: Period, close: number): number | null {
  switch (key) {
    case 'B/P':
      return p.bps === null || close <= 0 ? null : p.bps / close
    case 'E/P': {
      const eps = ttmEps(p)
      return eps === null || close <= 0 ? null : eps / close
    }
    case 'ROE':
      return p.roe
    case 'RevYoY':
      return p.revYoy
    case 'ProfitYoY':
      return p.profitYoy
  }
}

/** 在一个池子上跑完整套并打印。返回过门槛的因子数 */
function runPool(
  poolName: string,
  codes: readonly string[],
  fixtures: string,
  financials: string
): number {
  /** 因子 × 窗口 → 横截面表 */
  const tables = new Map<string, Map<TradeDate, Row[]>>()
  const keyOf = (f: string, w: string): string => `${f}|${w}`
  for (const f of FACTORS) for (const w of WINDOWS) tables.set(keyOf(f.key, w.name), new Map())

  let usedCodes = 0
  let noFin = 0
  let notAShare = 0
  let pitHit = 0
  let pitMiss = 0

  for (const code of codes) {
    const finFile = join(financials, `${code}.json`)
    const barFile = join(fixtures, `${code}.json`)
    if (!existsSync(finFile) || !existsSync(barFile)) {
      noFin++
      continue
    }
    const periodsRaw = (JSON.parse(readFileSync(finFile, 'utf8')) as { periods: Period[] }).periods
    // 台账限制 2：端点里混着别的证券类型，不筛就会把它们算进横截面
    const periods = periodsRaw.filter((p) => p.securityType === null || p.securityType === 'A股')
    if (periods.length === 0) {
      notAShare++
      continue
    }
    const bars = loadBars(fixtures, code)
    if (bars.length === 0) continue
    usedCodes++

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i]
      if (!bar) continue
      const window = WINDOWS.find((w) => bar.date >= w.from && bar.date <= w.to)
      if (window === undefined) continue

      const p = pitPeriod(periods, bar.date)
      if (p === null) {
        pitMiss++
        continue
      }
      pitHit++

      // 前瞻收益走**后复权**（除权不该被算成一次下跌）
      const fwd = new Map<number, number>()
      const base = bar.closeAdj
      if (base === null || base <= 0) continue
      for (const h of HORIZONS) {
        const later = bars[i + h]
        if (later?.closeAdj === null || later?.closeAdj === undefined || later.closeAdj <= 0) continue
        fwd.set(h, later.closeAdj / base - 1)
      }
      if (fwd.size === 0) continue

      for (const f of FACTORS) {
        // 估值类的分母用**不复权**收盘（BPS/EPS 是不复权口径的每股量）
        const v = factorValue(f.key, p, bar.close)
        if (v === null || !Number.isFinite(v)) continue
        const table = tables.get(keyOf(f.key, window.name))
        if (table === undefined) continue
        const rows = table.get(bar.date as TradeDate) ?? []
        rows.push({ code: code as SecCode, score: v, fwd })
        table.set(bar.date as TradeDate, rows)
      }
    }
  }

  console.log(`\n---\n\n# 池：${poolName}\n`)
  console.log('## 覆盖\n')
  console.log(
    `标的：清单 ${codes.length} · **实际用上 ${usedCodes}** · ` +
      `缺财务或日线 ${noFin} · 非 A 股 ${notAShare}`
  )
  console.log(
    `PIT：命中 **${pitHit}** · 落空 ${pitMiss}（该日之前没有任何一期财报公布过）⇒ ` +
      `覆盖率 **${pct(pitHit / Math.max(1, pitHit + pitMiss))}**`
  )
  console.log('\n⚠ **横截面只有本池这些票，不是全市场** —— 窄横截面上的 IC 噪音大。')

  for (const w of WINDOWS) {
    console.log(`\n## ${w.name}窗口 ${w.from} → ${w.to}${w.primary ? '（**主判据**）' : ''}\n`)
    console.log('| 因子 | 类 | 持有期 | 有效日 | **rank IC** | NW `t`（滞后 h−1） | Andrews `t` | 五等分中位（Q1→Q5） |')
    console.log('|---|---|---|---|---|---|---|---|')
    for (const f of FACTORS) {
      const table = tables.get(keyOf(f.key, w.name))
      if (table === undefined) continue
      for (const h of HORIZONS) {
        const r = icOf(table, h)
        const star = h === PRIMARY ? '**' : ''
        console.log(
          `| ${star}${f.key}${star} | ${f.kind} | ${star}${h} 日${star} | ${r.days} | ` +
            `${star}${pct(r.meanIc)}${star} | ${num(r.tNw, 2)}（L=${r.lagNw}） | ${num(r.tNwAndrews, 2)}（L=${r.lagAndrews}） | ` +
            `${r.quintileMedians.map((q) => pct(q, 2)).join(' · ')} |`
        )
      }
    }
  }

  // ── 门槛判定（预注册：训练 |IC| ≥ 2% 且 NW |t| ≥ 2，且验证符号一致）──
  console.log('\n## 门槛判定（预注册 §5.62）\n')
  console.log('| 因子 | 训练 IC | 训练 NW `t` | 验证 IC | 符号一致 | **过门槛** |')
  console.log('|---|---|---|---|---|---|')
  let passed = 0
  for (const f of FACTORS) {
    const tr = icOf(tables.get(keyOf(f.key, '训练')) ?? new Map(), PRIMARY)
    const va = icOf(tables.get(keyOf(f.key, '验证')) ?? new Map(), PRIMARY)
    const sameSign = tr.meanIc !== 0 && va.meanIc !== 0 && Math.sign(tr.meanIc) === Math.sign(va.meanIc)
    const ok = Math.abs(tr.meanIc) >= 0.02 && tr.tNw !== null && Math.abs(tr.tNw) >= 2 && sameSign
    if (ok) passed++
    console.log(
      `| ${f.key} | ${pct(tr.meanIc)} | ${num(tr.tNw, 2)} | ${pct(va.meanIc)} | ` +
        `${sameSign ? '✅' : '❌'} | ${ok ? '**✅**' : '❌'} |`
    )
  }
  console.log(`\n⇒ **${poolName}上过门槛的因子：${passed} 个**（门槛：至少 1 个）`)
  return passed
}

function main(): void {
  const fixtures = argOf('--fixtures', './data/history')
  const financials = argOf('--financials', './data/financials')
  const alive = (
    JSON.parse(readFileSync('params/universe-broad.json', 'utf8')) as { codes: string[] }
  ).codes
  const delisted = (
    JSON.parse(readFileSync('params/universe-delisted-all.json', 'utf8')) as { codes: string[] }
  ).codes

  console.log('# 财务因子的横截面 rank IC（预注册 M2 §5.62）\n')
  console.log(
    '**两个池并排跑，刻意不合并** —— 合成一个，「含退市 vs 不含退市」这个对照就再也做不出来。\n' +
      '预注册边界 2 写着：**结果为正必须补做退市那一支才算数**，' +
      '因为幸存者偏差对财务因子的方向是**高估**（高 `B/P` 常常是「便宜得有理由」，' +
      '而真退了市的票根本不在存活池里）。'
  )

  const results = POOLS.map((pool) =>
    runPool(pool.name, pool.file === 'both' ? [...alive, ...delisted] : alive, fixtures, financials)
  )

  /*
    ⚠ **两个池实际用上的标的数一样 ⇒ 那个对照根本没做成**，而结论行会长得像做成了。
    实测就是这样：东财 `RPT_LICO_FN_CPD` 对 236 只退市股一律返回「返回数据为空」
    ⇒ **这个源自己就带幸存者偏差**，预注册边界 2 要求的那一支**用它做不了**。
    这一段必须打出来 —— 否则「含退市：过门槛 1 个」会被读成「去偏之后仍然成立」。
  */
  const finOf = (list: readonly string[]): number =>
    list.filter((c) => existsSync(join(financials, `${c}.json`))).length
  const delistedWithFin = finOf(delisted)
  console.log('\n---\n\n# 结论\n')
  if (delistedWithFin === 0) {
    console.log(
      `> 🛑 **「含退市」这个池没有做成**：${delisted.length} 只退市股里**一只都没有财务数据**。\n` +
        '> 实测东财 `RPT_LICO_FN_CPD` 对它们一律返回「返回数据为空」\n' +
        '> ⇒ **这个数据源自己就带幸存者偏差**，预注册边界 2 要求的那一支**用它做不了**。\n' +
        '> ⇒ 下面「含退市」那一行与「存活池」是**同一批标的**，不构成任何去偏证据。\n' +
        '> ⇒ 按预注册的字面（「结果为正必须补做才算数」），**正向结果目前不算数，只能当上界**。\n'
    )
  }
  POOLS.forEach((pool, i) => console.log(`- **${pool.name}**：过门槛 ${results[i]} 个`))
  console.log(
    '\n⚠ **三条读法，缺一条就会把这份结果读错**：\n' +
      '1. **即使过了也不是「显著」** —— 财务因子一个季度才变一次 ⇒ 逐日 IC 的自相关远超 ' +
      '`h−1` 那个滞后阶，**NW 仍然低估方差**，有效独立样本数接近**报告期数**（约 24 期）' +
      '而不是上千个交易日。这一条**事先**写在预注册里，不是看完结果补的。\n' +
      '2. **看五等分，不要只看 IC** —— IC 只说排序方向，`Q5` 的绝对收益才说「买它赚不赚」。' +
      '一个各分位全为负的因子，在这个**只能做多**的产品里挑出来的是「跌得少」，不是「涨」。\n' +
      '3. **本轮不许推出任何「该加什么因子」的结论** —— 那要走 docs/07 §3.6（论证先于代码），' +
      '而且横截面因子进一个**时序择时**系统是换产品形态（差距 §1.1），不是加一个数。'
  )
}

main()
