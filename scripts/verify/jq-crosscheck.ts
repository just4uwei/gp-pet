/**
 * 口径的第三方交叉验证：把 `src/core` 的指标值与**聚宽公开数据字典里的示例值**逐位比对。
 *
 * ```bash
 * pnpm fetch:history -- --codes SZ000001,SZ000002,SH601211 --from 2015-06-01 --to 2018-06-30 --out ./data/verify-jq
 * npx tsx scripts/verify/jq-crosscheck.ts            # 默认查 2017-01-26，见下
 * npx tsx scripts/verify/jq-crosscheck.ts 2017-01-04 # 文档上写的那个日期（对不上，见下）
 * ```
 *
 * ## 为什么要它（M2 §6 的开放缺口：算法一致性已验证，口径一致性未验证）
 *
 * `scripts/verify/reference.mjs` 是**我们自己写的**独立参照实现 —— 它能抓算法笔误，
 * 抓不到「整个项目对某个指标的理解就是错的」：两份实现照着同一份 docs/04 写，会一起错。
 * 第三方参照才问得出「我们的 MACD 柱与国内平台显示的是不是同一个数」。
 *
 * 参照值取自聚宽**公开数据字典页**（`help/api/help?name=technicalanalysis`）里每个函数的
 * 返回值示例。用它有三个好处：公开可复核、不需要账号、**不触碰 JQData 用户协议**
 * （那三条管的是 JQData 拉下来的数据，见 docs/notes/信源台账.md §7）。
 * 他们对这几个指标的备注都是「计算方式与通达信、东方财富和同花顺相同」，
 * 所以这实际上是与三家国内平台的一次对照。
 *
 * ## ⚠ 示例里写的 `check_date='2017-01-04'` 与打印出来的数字**不是同一天**
 *
 * 2026-08-19 实测：按 2017-01-04 比，**一项都对不上**（连 BOLL 中轨这种「20 个收盘价求平均」
 * 都差 0.8%）。按 MA20 与 20 日标准差反查日期，落在 **2017-01-26** —— 那一天
 * BOLL 三根线相对差 1e-14、RSI(6) 1e-9。**别把文档上的日期当事实**，这是这次最花时间的一步。
 * DMI 那一组又是另一天（约 2016-05-04），聚宽的示例字典是各函数分别生成的。
 *
 * ## 结论：两项逐位一致，两项口径不同（详见 M2 §5.38）
 *
 * | 指标 | 结果 |
 * |---|---|
 * | **BOLL** | ✅ **逐位一致**（1e-14）⇒ 标准差**除 n** 的选择被外部证实。除 n−1 的变体相对差 3e-4~7e-4，是可分辨的 |
 * | **RSI** | ✅ **逐位一致**（1e-9）⇒ Wilder 平滑口径相同 |
 * | **MACD 柱** | ✅ `柱 = 2×(DIF−DEA)` 由他们自己的三组数字**代数确认**（与日期无关） |
 * | **ATR** | ⚠ **口径不同**：他们 = `MA(TR,14)` 简单算术平均（残差 0），我们 = `Wilder(TR)/14` |
 * | **ADX/DMI** | ⚠ **口径不同**：他们 = 通达信 `EXPMEMA`（α=2/15）平滑 DI + **ADX 用 MM=6**，我们 = Wilder(1/14) + ADX Wilder(14) |
 *
 * 后两项**不是 bug**（docs/04 §1.5 写的就是 Wilder），但它意味着 `params.ts` 里那些从国内平台
 * 语境转述来的 ADX 阈值**与我们算出来的量不是同一个量纲**（约束 2 的又一个实例）。
 *
 * ## 三条读法（不写清楚就会把结果读错）
 *
 * 1. **价格用不复权**（`close` 而不是 `closeAdj`）：示例里 BOLL 中轨 9.1745 / 20.7955 与
 *    2017 年初的真实价位一致 ⇒ 他们那两条是真实价口径。用后复权比会差一个常数倍。
 *    **SH601211 那一组是前复权**（三根线整体差 2.2%、比例一致）⇒ 它只能比形状不能比价位。
 * 2. **参数按示例给，不按 `params.ts` 给**：MACD 用 (12,26,9) 而不是出厂的 (12,17,9) ——
 *    这里验的是**口径**（同样输入下算出的数一不一样），不是「出厂参数好不好」。
 * 3. **递归型指标要给足历史**：本脚本喂 ~750 根，26 日 EMA 的种子影响衰减到 e^-30 量级
 *    ⇒ 差异不可能来自预热长度（聚宽那篇《动态复权与技术指标》第 3 条说的正是这件事）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { boll } from '../../src/core/indicators/boll'
import { dmi } from '../../src/core/indicators/dmi'
import { macd } from '../../src/core/indicators/macd'
import { rsi } from '../../src/core/indicators/rsi'
import { populationStdev, sma } from '../../src/core/indicators/series'

const FIXTURES = join('data', 'verify-jq')
/** 反查出来的真实日期，不是文档上写的 2017-01-04 —— 见头注释 */
const CHECK_DATE = process.argv[2] ?? '2017-01-26'

interface Row {
  date: string
  open: number
  high: number
  low: number
  close: number
  /** 聚宽数据字典页不展示成交量，但 fixture 里有 -- DMI 不读它，PriceSeries 要这个键存在 */
  volume?: number
}

/** 聚宽数据字典页上的示例返回值 */
interface Expected {
  code: string
  name: string
  /** 那一组示例是不是前复权口径（是的话价位对不上是正常的，只能比形状） */
  adjusted?: boolean
  macd: [dif: number, dea: number, hist: number]
  boll: [ub: number, mb: number, lb: number]
  /** DMI 那一组来自另一天（约 2016-05-04），只用于说明口径差，不参与逐位比对 */
  dmi: [pdi: number, mdi: number, adx: number, adxr: number]
  atr: [mtr: number, atr: number]
  rsi6: number
}

const EXPECTED: Expected[] = [
  {
    code: 'SZ000001',
    name: '平安银行',
    macd: [0.024474457964069884, 0.031674925444633864, -0.014400934961127959],
    boll: [9.289994588616974, 9.174500000000004, 9.059005411383033],
    dmi: [25.6888305290806, 12.721819718749906, 25.604986954849515, 24.423375009809824],
    atr: [0.08000000000000007, 0.059999999999999866],
    rsi6: 86.69778494155213,
  },
  {
    code: 'SZ000002',
    name: '万科A',
    macd: [1.9534717416190936, 1.4784672678080988, 0.9500089476219897],
    boll: [21.378028110909778, 20.795500000000004, 20.21297188909023],
    dmi: [53.19815968968976, 4.361143500699556, 74.40571136263563, 68.67705569818605],
    atr: [0.16000000000000014, 0.5114285714285717],
    rsi6: 45.66983935308403,
  },
  {
    code: 'SH601211',
    name: '国泰君安',
    adjusted: true,
    macd: [-0.13735007291032986, -0.02049084487279272, -0.23371845607507427],
    boll: [18.846866409164456, 18.424, 18.001133590835543],
    dmi: [18.761296151049379, 25.554094733429896, 27.156295106705297, 30.275031367421029],
    atr: [0.19000000000000128, 0.2857142857142865],
    rsi6: 65.95253134460796,
  },
]

function load(code: string): Row[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES, `${code}.json`), 'utf8')) as { candles: Row[] }
  return raw.candles
}

function rel(ours: number | null, theirs: number): number | null {
  if (ours === null) return null
  if (theirs === 0) return ours === 0 ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(ours - theirs) / Math.abs(theirs)
}

function line(label: string, ours: number | null, theirs: number, note = ''): string {
  const diff = rel(ours, theirs)
  const ok = diff !== null && diff <= 1e-6
  const shown = ours === null ? 'null' : ours.toPrecision(12)
  return `  ${ok ? '✓' : '✗'} ${label.padEnd(9)} 我们 ${shown.padEnd(18)} 聚宽 ${theirs
    .toPrecision(12)
    .padEnd(18)} 相对差 ${diff === null ? '—' : diff.toExponential(1)}${note ? `  ${note}` : ''}`
}

/** 简单算术平均的 ATR（= 聚宽/通达信口径），只用于说明我们的 Wilder 与它差多少 */
function atrSimple(rows: readonly Row[], i: number, period: number): number | null {
  if (i < period) return null
  let sum = 0
  for (let k = i - period + 1; k <= i; k++) {
    const cur = rows[k]
    const prev = rows[k - 1]
    if (cur === undefined || prev === undefined) return null
    sum += Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    )
  }
  return sum / period
}

for (const exp of EXPECTED) {
  const rows = load(exp.code)
  const i = rows.findIndex((r) => r.date === CHECK_DATE)
  if (i < 0) {
    process.stdout.write(`\n${exp.code} ${exp.name}：fixture 里没有 ${CHECK_DATE}\n`)
    continue
  }

  const opens = rows.map((r) => r.open)
  const closes = rows.map((r) => r.close)
  const highs = rows.map((r) => r.high)
  const lows = rows.map((r) => r.low)
  const volumes = rows.map((r) => r.volume ?? 0)
  const tag = exp.adjusted ? '（聚宽那一组是前复权，价位对不上是正常的）' : ''

  process.stdout.write(
    `\n${exp.code} ${exp.name} · ${CHECK_DATE} · 喂 ${rows.length} 根不复权日线 ${tag}\n`
  )

  const b = boll(closes, { period: 20, k: 2, bbwLookback: 250 })
  process.stdout.write(line('BOLL 上轨', b.upper[i] ?? null, exp.boll[0]) + '\n')
  process.stdout.write(line('BOLL 中轨', b.mid[i] ?? null, exp.boll[1]) + '\n')
  process.stdout.write(line('BOLL 下轨', b.lower[i] ?? null, exp.boll[2]) + '\n')

  // 除 n 还是除 n-1：同一个窗口按样本标准差再算一次上轨，看差异是不是可分辨的
  const mid = sma(closes, 20)[i]
  if (mid !== null && mid !== undefined && i >= 19) {
    const stdN1 = populationStdev(closes.slice(i - 19, i + 1)) * Math.sqrt(20 / 19)
    const alt = mid + 2 * stdN1
    process.stdout.write(
      `    └ 若改成除 n−1，上轨会是 ${alt.toPrecision(12)}（相对差 ${rel(alt, exp.boll[0])?.toExponential(1)}）—— 可分辨\n`
    )
  }

  const r6 = rsi(closes, 6)
  process.stdout.write(line('RSI(6)', r6[i] ?? null, exp.rsi6) + '\n')

  const m = macd(closes, { fast: 12, slow: 26, signal: 9 })
  const difE = exp.macd[0]
  const deaE = exp.macd[1]
  process.stdout.write(line('MACD DIF', m.dif[i] ?? null, difE, '← 示例来自另一天，仅供参考') + '\n')
  process.stdout.write(line('MACD DEA', m.dea[i] ?? null, deaE, '← 同上') + '\n')
  process.stdout.write(
    `    └ 柱口径（与日期无关）：2×(DIF−DEA) = ${(2 * (difE - deaE)).toPrecision(12)}  vs 聚宽给的柱 ${exp.macd[2].toPrecision(12)} ⇒ ✓ 与我们一致\n`
  )

  const d = dmi({ open: opens, high: highs, low: lows, close: closes, volume: volumes }, 14)
  const simple = atrSimple(rows, i, 14)
  process.stdout.write(line('ATR', d.atr[i] ?? null, exp.atr[1], '← 我们是 Wilder(TR)/14') + '\n')
  process.stdout.write(
    `    └ 换成 MA(TR,14)（聚宽/通达信口径）= ${simple === null ? 'null' : simple.toPrecision(12)}（相对差 ${
      simple === null ? '—' : rel(simple, exp.atr[1])?.toExponential(1)
    }）\n`
  )
  process.stdout.write(
    `  · ADX ${d.adx[i]?.toPrecision(6) ?? 'null'}（Wilder）—— 聚宽示例 ${exp.dmi[2].toPrecision(
      6
    )} 来自另一天且是 EXPMEMA(6) 口径，不可直接比，见 M2 §5.38\n`
  )
}
