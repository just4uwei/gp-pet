#!/usr/bin/env node
/**
 * **rank IC**：组合得分对未来收益有没有**横截面排序能力**（M2 §5.46 的预注册）。
 *
 * ```bash
 * pnpm audit:ic -- --codes "$(cat reports/calib/_codes252.txt)" \
 *   --fixtures ./data/history --from 2018-01-01 --to 2026-06-30 \
 *   --out reports/calib/ic-261.json
 * ```
 *
 * ## 它为什么存在：一个**不需要零分布**的第二判据
 *
 * [§5.43](../../docs/notes/M2-偏差报告.md) 量出配对胜率的绝对水平有 **20–30pp** 的口径自由度
 * （零点定义），[§5.45](../../docs/notes/M2-偏差报告.md) 又量出它在加权/中位两个口径间能差 **28pp**。
 * ⇒ 我们唯一可信的判据自己有两个控制不住的自由度。
 *
 * rank IC 的性质恰好补这个洞：它是**描述性统计**（逐日横截面的 Spearman 秩相关），
 * **不构造零分布、不做配对、不做随机化** ⇒ 那两个自由度都不适用于它。
 *
 * ## 四条口径纪律
 *
 * 1. **判定根集合与 `simulate.ts` / `crosssec-audit.ts` 逐条对齐**：`i >= warmup`、
 *    `i < len - 1`、`hasGap` 那根跳过。差一条，占比就与既有报告对不上号。
 * 2. **得分取 `combine.breakdown.BUY.final`，每个判定根都取，不管有没有触发。**
 *    只取触发的那些会把样本条件在「引擎出手了」上 —— 那是 §5.45 问的问题，不是这里的。
 *    （§5.46 的修正 1：原预注册写「只取买入方向」，而 §5.33 实测同日买入信号中位数只有 1 只
 *    ⇒ 逐日横截面根本凑不出来。改在动手前、看结果前。）
 * 3. **前瞻收益是收盘到收盘**（`closeAdj[i+h]/closeAdj[i] − 1`），不模拟次日开盘成交、不扣成本。
 *    IC 问的是排序能力，不是可实现收益；把成交与成本混进来会让它变成一个小号回测。
 * 4. **并列必须报出来。** 大量判定根的买入得分是 0（一个子信号都没触发），Spearman 在并列上
 *    取平均秩 ⇒ IC 会被并列稀释。所以两档都给：**全体**与**得分 > 0 的子集**，
 *    并打印并列比例。两档在预注册里写死，不是看到结果再挑。
 *
 * ## 它**不**回答什么
 *
 * IC 测的是得分的排序能力，**不是「这套系统赚不赚钱」**。IC ≈ 0 不否定风控层的价值
 * （回撤 2.96% vs 基准 45%+），也不否定 ETF 那条前向记录；反过来 IC 好也不等于能赚钱
 * （还要过成本）。**只回答排序能力那一个问题。**
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode } from '../core/code'
import { evaluate } from '../core/engine'
import { aggregateWeekly } from '../core/indicators/weekly'
import {
  DEFAULT_PARAMS,
  engineVersionOf,
  paramsFingerprint,
  withParams,
  type EngineParams,
  type ParamOverrides,
} from '../core/params'
import { CONTINUOUS_MINUTES } from '../core/session'
import type { EngineContext, SecCode, TradeDate } from '../core/types'
import { USAGE, parseArgs, type CliOptions } from './args'
import {
  loadLiquidity,
  openFixtureSource,
  openSqliteSource,
  sentimentSeries,
  type LoadedSeries,
} from './data'
import { bartlettLongRunCovariance } from './metrics'

/** 与 cli.ts / crosssec-audit.ts 同一份实现（那两处也各有一份，改动要一起改） */
function defaultDbPath(): string {
  const appData =
    process.env['APPDATA'] ??
    (process.env['HOME'] !== undefined ? join(process.env['HOME'], '.config') : process.cwd())
  return join(appData, 'gp-pet', 'market.db')
}

function resolveParams(options: CliOptions): EngineParams {
  if (!options.params) return DEFAULT_PARAMS
  const parsed: unknown = JSON.parse(readFileSync(options.params, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`--params 文件不是 JSON 对象：${options.params}`)
  }
  return withParams(parsed as ParamOverrides, DEFAULT_PARAMS)
}

/**
 * 只把这个日期之后的判定根计入横截面（`--eval-from`）。指标与预热照常用更早的数据。
 *
 * **为什么必须有它**：300 根预热会把短窗口吃光 —— 实测直接 `--from 2024-01-01` 跑验证窗口
 * 只剩 **54** 个有效交易日，测试窗口（2025H2 起）剩 **0** 个。
 * 这与 CLAUDE.md 那条「跑验证窗口必须带段前历史」是同一个坑，只是换了个工具。
 */
function evalFromOf(argv: readonly string[]): string | null {
  const i = argv.indexOf('--eval-from')
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

/** `--industry <file>`：申万行业变迁史（`pnpm fetch:industry` 的产物）。不给就不做中性化。 */
function industryFileOf(argv: readonly string[]): string | null {
  const i = argv.indexOf('--industry')
  return i >= 0 ? (argv[i + 1] ?? null) : null
}

/**
 * 预注册写死的两个动量回看期（M2 §5.70）。
 * **5 是 §5.45 已识别的那个暴露，20 是通行的月度动量。不扫 N。**
 */
const MOMENTUM_LAGS = [5, 20] as const

/**
 * 预注册写死的三个**收益形态**因子（M2 §5.83），来源是竞品 `tickflow-stock-panel`
 * 的因子目录里那一组「A 股实证维度」（[§5.82](../../docs/notes/M2-偏差报告.md) ⑧.1）。
 *
 * **它们在这里而不是在 `scripts/verify/factor-ic.ts` 里，理由只有一条**：
 * 预注册要求样本与 [§5.46](../../docs/notes/M2-偏差报告.md) **逐条对齐**
 * （`i >= warmup` · `i < len−1` · `hasGap` 跳过 · `sufficiency.usable`），
 * 而那个样本只有 `collect()` 这条路造得出来 —— 接在这里是**构造上相同**，
 * 而在别处重建一遍只能做到「看起来相同」。那个财务脚本的样本口径**确实不同**
 * （它没有 300 根预热也不跑 `evaluate()`），所以两边的 IC **不可以并排比**。
 *
 * ⚠ **三个都写死，不许加、不许换、不许只报好看的那个** —— 预注册锁的就是这个。
 * ⚠ 全部在**后复权**日收益上算（除权不该被算成一次暴涨/暴跌），窗口 20 根含当根。
 * ⚠ **它们不是指标**（约束 5）：只读、不进 `params.ts`、不进引擎、不进 `indicator-catalog`。
 */
const PRICE_FACTORS = [
  { key: 'max_ret_20d', label: '20 日最大单日涨幅（彩票效应 / MAX effect）' },
  { key: 'ret_skew_20d', label: '20 日收益偏度' },
  { key: 'up_days_20d', label: '20 日上涨天数占比' },
] as const
type PriceFactorKey = (typeof PRICE_FACTORS)[number]['key']

/** 收益形态因子的回看窗口（根，含当根）。**预注册写死 20，不扫它** */
const PRICE_FACTOR_WINDOW = 20

/**
 * 三个收益形态因子的值。窗口内任一根算不出日收益就返回空 Map ——
 * **不用 0 补**（约束 4）：`max_ret = 0` 会被读成「这 20 天一天都没涨」。
 *
 * 偏度用**除 n** 的样本矩（`m₃ / m₂^{3/2}`），与布林带除 n 同一条口径纪律；
 * `m₂ = 0`（20 天逐日收益完全相同，停牌段）时偏度为 null，不是 0。
 */
export function priceFactorsAt(
  closeAdj: readonly (number | null | undefined)[],
  index: number
): Map<PriceFactorKey, number> {
  const out = new Map<PriceFactorKey, number>()
  const rets: number[] = []
  for (let k = index - PRICE_FACTOR_WINDOW + 1; k <= index; k++) {
    const prev = k - 1 >= 0 ? closeAdj[k - 1] : undefined
    const cur = closeAdj[k]
    if (prev === null || prev === undefined || prev <= 0) return out
    if (cur === null || cur === undefined || cur <= 0) return out
    rets.push(cur / prev - 1)
  }
  if (rets.length < PRICE_FACTOR_WINDOW) return out

  out.set('max_ret_20d', Math.max(...rets))
  out.set('up_days_20d', rets.filter((r) => r > 0).length / rets.length)

  const n = rets.length
  const mean = rets.reduce((s, v) => s + v, 0) / n
  let m2 = 0
  let m3 = 0
  for (const r of rets) {
    const d = r - mean
    m2 += d * d
    m3 += d * d * d
  }
  m2 /= n
  m3 /= n
  if (m2 > 0) out.set('ret_skew_20d', m3 / m2 ** 1.5)
  return out
}

/**
 * 把本文件自己处理的旗标从 argv 里摘掉再交给 `parseArgs`。
 *
 * ⚠ **必须连值一起摘**：只摘旗标名会让下一个词（路径/日期）被当成位置参数。
 */
function stripLocalFlags(argv: readonly string[]): string[] {
  /** 带值的：摘掉旗标**和它的值** */
  const WITH_VALUE = new Set(['--eval-from', '--industry'])
  /** 布尔的：只摘旗标本身。**混进上面那组会把下一个参数吃掉** */
  const BOOLEAN = new Set(['--risk-factors', '--price-factors'])
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === undefined) continue
    if (WITH_VALUE.has(a)) {
      i += 1
      continue
    }
    if (BOOLEAN.has(a)) continue
    out.push(a)
  }
  return out
}

/** 预注册写死的三个持有期（交易日）。它们不是三次尝试，是同一问题的三个时间尺度 */
export const HORIZONS = [5, 10, 20] as const

/** 逐日横截面至少要这么多个有效标的才算一天 —— 少于它的日子 IC 没有意义 */
export const MIN_CROSS_SECTION = 10

/**
 * 横截面表的一行。**导出是为了让别的因子共用 `icOf`** ——
 * `scripts/verify/factor-ic.ts`（财务因子，M2 §5.62）就是这么接的。
 * 各写一份 IC 实现的症状是「引擎得分的 IC 与财务因子的 IC 不是同一个口径」，
 * 而两个数会被并排放进同一张表里比。
 */
export interface Row {
  code: SecCode
  /** 被检验的那个横截面量。对引擎是买入得分，对因子脚本是因子值 */
  score: number
  /** 持有期 → 前瞻收益；数据不够时缺项 */
  fwd: Map<number, number>
}

export interface IcResult {
  /** 有效交易日数（该持有期上横截面 ≥ MIN_CROSS_SECTION 的天数） */
  days: number
  meanIc: number
  sdIc: number
  /**
   * **朴素 t** `mean / (sd / √days)`，把每个交易日当独立样本。
   * **这是上界，不许引用**（§5.46 限制 1）—— 留着是为了与调整后的并排看。
   * 样本不足或零方差时 null，不用 0 冒充。
   */
  t: number | null
  /**
   * **Newey-West 调整后的 t**，滞后阶 `L = horizon − 1`（主口径，见 §5.47）。
   * 前瞻收益是**重叠**的（每天都算一次 h 日收益）⇒ IC 序列在结构上带 MA(h−1)，
   * 这个滞后阶不是估出来的、是**机械已知**的。
   */
  tNw: number | null
  /** 主口径实际用的滞后阶 */
  lagNw: number
  /**
   * 第二个**预承诺**滞后阶下的 t：`L = ⌊4(T/100)^(2/9)⌋`（Andrews 1991 的经验规则）。
   * 报它是为了让「滞后阶怎么选」这件事**可见** —— 调滞后阶到显著为止是文献里
   * 有记录的 p-hacking 通道，所以两档都在看结果之前写死（§5.47）。
   */
  tNwAndrews: number | null
  lagAndrews: number
  /**
   * 五等分（按当日得分排名）各组前瞻收益的**中位数**。
   *
   * ⚠ **两条读法，缺一条就会读出一个假结论**：
   * ① 水平里含**当日市场共同项**，只能看**组间差**（§5.46 限制 ②）；
   * ② **中性化过的臂（`industryNeutral*` / `riskNeutral` / `priceFactorArms[].momNeutral`）
   *    这一列是「残差秩」不是收益** —— 实测能打出 `+649%` / `−1067%` 这种数
   *    （§5.84 那一轮），看起来像收益但不是。**那些臂只读 `meanIc` 与 `tNw`。**
   *    打印函数刻意都不印它，但 JSON 里在，读 JSON 的人会撞上。
   */
  quintileMedians: (number | null)[]
  /**
   * **逐日 IC 序列**（2026-08-22 加）。此前只落聚合量，而 §5.51 六处假设里
   * **唯一没测到的恰好是唯一承重主判据的那一处** -- rank IC 的 NW `t` 的平稳性
   * 测不了，因为归档数据上做不了分段矩与 CUSUMSQ。
   * ⚠ **落盘之后不要顺手重算 §5.47 的 `t`** -- 那是移动球门；新序列的用途是
   * **下一次预注册**里测它的平稳性（M2 §5.51 判 3）。
   */
  dailyIc: { date: TradeDate; ic: number }[]
}

/**
 * Bartlett 核的 Newey-West 长期方差（作用在**均值**上）：
 *
 * ```
 * Var(x̄) = (1/T) · ( γ₀ + 2 · Σ_{k=1..L} (1 − k/(L+1)) · γₖ )
 * ```
 *
 * `γₖ` 是滞后 k 的样本自协方差。三角权重 `1 − k/(L+1)` 是 Newey & West (1987) 的选择，
 * 它保证估计出来的方差**非负**（早期 HAC 估计量会给出负方差）。
 *
 * ⚠ **两条容易读错的**：
 * ① `L` 是**滞后截断阶**，不是「带宽」—— 两者按核函数换算，文献里同一个数两种叫法都有；
 * ② `L = ⌊4(T/100)^(2/9)⌋` 那个经验规则应归 **Andrews (1991)**，
 *    不是 Newey-West (1987)（后者把权重选择留开了）。
 *
 * 序列**必须按时间排好**再传进来：自协方差按相邻位置算，顺序错了这个数就没有意义。
 * 返回 null 的两种情形：样本不足，或方差非正（全部并列会走到）。
 *
 * ⚠ **只是一层薄封装**（2026-08-21 起）：自协方差循环住在
 * `metrics.ts` 的 `bartlettLongRunCovariance`，那边还要给 Lo (2002) 的夏普方差
 * 算 2×2 的协方差矩阵（M2 §5.50）。**别在这里照抄回来** —— 两份实现漂移的症状是
 * 「IC 的 t 与夏普的标准误各自都说得通、但不是同一个 HAC 口径」，事后分不清哪个对。
 */
export function neweyWestVariance(series: readonly number[], lag: number): number | null {
  const T = series.length
  if (T < 2) return null
  const lrv = bartlettLongRunCovariance(series, series, lag)
  if (lrv === null || !(lrv > 0)) return null
  return lrv / T
}

/** Andrews (1991) 的经验滞后阶 `⌊4(T/100)^(2/9)⌋` */
export const andrewsLag = (T: number): number => (T < 2 ? 0 : Math.floor(4 * (T / 100) ** (2 / 9)))

/** 平均秩（并列取平均）—— Spearman 的前置 */
export function ranksOf(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1]?.v === order[i]?.v) j++
    // [i..j] 是一段并列 ⇒ 全部取这段的平均秩
    const avg = (i + j) / 2
    for (let k = i; k <= j; k++) {
      const idx = order[k]?.i
      if (idx !== undefined) ranks[idx] = avg
    }
    i = j + 1
  }
  return ranks
}

/** 皮尔逊相关（作用在秩上就是 Spearman）。零方差时 null —— 并列到底会走这条 */
export function correlation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - ma
    const db = (b[i] ?? 0) - mb
    sab += da * db
    saa += da * da
    sbb += db * db
  }
  if (saa <= 0 || sbb <= 0) return null
  return sab / Math.sqrt(saa * sbb)
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

/**
 * 一个持有期上的 IC 与分位单调性。
 *
 * 分位组按**当日**得分排名切（不是全样本），与 §5.45 同一条理由：绝对得分随市况漂移，
 * 拿全样本分位会把不同年份的日子排到一起。
 */
export function icOf(byDate: Map<TradeDate, Row[]>, horizon: number): IcResult {
  const ics: number[] = []
  const dailyIc: { date: TradeDate; ic: number }[] = []
  const quintiles: number[][] = [[], [], [], [], []]
  /*
    **必须按日期排序再算**（2026-08-20 加）。`byDate` 的插入顺序由 `collect` 的扫描
    决定 —— 第一只票按它自己的日期顺序插，之后的票只补它没有的日子 ⇒ 一只**起始更早**
    的票会把它的早期日子**追加到尾部**。Newey-West 按相邻位置算自协方差，
    顺序错了那个数就没有意义，**而且不会报错**。IC 的均值与五等分不受顺序影响，
    所以这个坑在加 NW 之前是隐性的。
  */
  const byDateSorted = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [date, rows] of byDateSorted) {
    const usable = rows.filter((r) => r.fwd.has(horizon))
    if (usable.length < MIN_CROSS_SECTION) continue
    const scores = usable.map((r) => r.score)
    const fwds = usable.map((r) => r.fwd.get(horizon) ?? 0)
    const ic = correlation(ranksOf(scores), ranksOf(fwds))
    if (ic !== null) {
      ics.push(ic)
      dailyIc.push({ date, ic })
    }
    // 五等分：按得分的平均秩切。并列多的时候各桶大小会不均，那是事实不是 bug
    const ranks = ranksOf(scores)
    ranks.forEach((rank, i) => {
      const q = Math.min(4, Math.floor((rank / usable.length) * 5))
      quintiles[q]?.push(fwds[i] ?? 0)
    })
  }
  const days = ics.length
  const mean = days === 0 ? 0 : ics.reduce((s, v) => s + v, 0) / days
  const sd =
    days < 2 ? 0 : Math.sqrt(ics.reduce((s, v) => s + (v - mean) ** 2, 0) / (days - 1))
  // 主口径滞后阶 = h−1：重叠窗口带来的 MA(h−1) 是**机械已知**的，不用估
  const lagNw = Math.max(0, horizon - 1)
  const lagAndrewsL = andrewsLag(days)
  const tOf = (lag: number): number | null => {
    const v = neweyWestVariance(ics, lag)
    return v === null ? null : mean / Math.sqrt(v)
  }
  return {
    days,
    meanIc: mean,
    sdIc: sd,
    t: days < 2 || sd === 0 ? null : mean / (sd / Math.sqrt(days)),
    tNw: tOf(lagNw),
    lagNw,
    tNwAndrews: tOf(lagAndrewsL),
    lagAndrews: lagAndrewsL,
    quintileMedians: quintiles.map((q) => median(q)),
    dailyIc,
  }
}

// ────────────────────── 行业中性化（预注册见 M2 §5.68） ──────────────────────

/**
 * 申万行业变迁史 → `(code, date) → 一级行业码`，**按时点取**。
 *
 * ⚠ **PIT 是这一层唯一不能出错的地方**：取 `startDate <= 该日` 的**最后一条**。
 * 拿今天的归属去回标 2018 年是未来函数 —— 而这份数据存在的全部理由就是避免它
 * （东财 `f127` 只给当前归属，那条路做不了这件事）。错了不会报错，只会让 IC 变好看。
 */
export function loadIndustryAsOf(
  file: string
): (code: SecCode, date: TradeDate) => string | null {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    rows?: { code: string; l1: string; startDate: string }[]
  }
  const rows = parsed.rows ?? []
  if (rows.length === 0) {
    throw new Error(`${file} 里没有 rows —— 先跑 pnpm fetch:industry`)
  }
  const byCode = new Map<string, { l1: string; startDate: string }[]>()
  for (const r of rows) {
    const list = byCode.get(r.code)
    if (list) list.push(r)
    else byCode.set(r.code, [r])
  }
  for (const list of byCode.values()) list.sort((a, b) => a.startDate.localeCompare(b.startDate))
  return (code, date) => {
    // 我们的代码是 `SH600000`，申万表里是六位
    const list = byCode.get(code.slice(2))
    if (!list) return null
    let hit: string | null = null
    for (const r of list) {
      if (r.startDate <= date) hit = r.l1
      else break
    }
    return hit
  }
}

export interface NeutralizeStats {
  horizon: number
  /** 该持有期上原本可用的观测数（与 `icOf` 的 `usable` 同一口径） */
  rowsIn: number
  rowsOut: number
  droppedNoIndustry: number
  droppedSmallGroup: number
  daysIn: number
  /**
   * 组规模的中位数（丢弃前），用来判「中性化吃掉了多少自由度」。
   * **一组都没有时是 `null` 不是 0**（约束 4）—— 0 会被读成「组里一只票都没有」。
   */
  medianGroupSize: number | null
}

/**
 * **行业中性化**：逐日、组内、对秩去均值。返回可直接喂给 `icOf` 的新 `byDate`。
 *
 * 口径（预注册 §5.68，事后不许改）：
 * 1. **先在当日全横截面算秩**（`score` 与该持有期的 `fwd` 各一次），**再**在行业组内减组均值；
 * 2. 组规模 < `minGroup` 的整组丢弃 —— 组内只有 1 只时两侧残差**恒为 0**，
 *    不携带任何组内排序信息，留着只是往 Spearman 里注入一大块 0 的并列；
 * 3. 拿不到行业的行丢弃并计数（**不许当成一个「其它」组** —— 那会把一批互不相关的票
 *    绑成一个伪行业，而它的组均值没有任何含义）。
 *
 * **为什么能干净地复用 `icOf`**：Spearman 对单调变换不变 ⇒ `icOf` 把残差再排一次秩
 * 不改变相关系数。所以原始那一臂与中性那一臂走的是**同一个** IC 实现。
 *
 * ⚠ 它**减掉**了行业那一层，**不是测量**了它 —— 答不了「行业轮动有没有 alpha」。
 */
export function neutralizeByIndustry(
  byDate: Map<TradeDate, Row[]>,
  industryOf: (code: SecCode, date: TradeDate) => string | null,
  horizon: number,
  minGroup = 2
): { byDate: Map<TradeDate, Row[]>; stats: NeutralizeStats } {
  const out = new Map<TradeDate, Row[]>()
  const stats: NeutralizeStats = {
    horizon,
    rowsIn: 0,
    rowsOut: 0,
    droppedNoIndustry: 0,
    droppedSmallGroup: 0,
    daysIn: 0,
    medianGroupSize: null,
  }
  const groupSizes: number[] = []

  for (const [date, rows] of byDate) {
    const usable = rows.filter((r) => r.fwd.has(horizon))
    if (usable.length === 0) continue
    stats.daysIn += 1
    stats.rowsIn += usable.length

    // ① 全横截面的秩（在丢弃之前算 —— 预注册第 1 条）
    const scoreRanks = ranksOf(usable.map((r) => r.score))
    const fwdRanks = ranksOf(usable.map((r) => r.fwd.get(horizon) ?? 0))

    // ② 按行业分组
    const groups = new Map<string, number[]>()
    usable.forEach((r, i) => {
      const ind = industryOf(r.code, date)
      if (ind === null) {
        stats.droppedNoIndustry += 1
        return
      }
      const list = groups.get(ind)
      if (list) list.push(i)
      else groups.set(ind, [i])
    })

    // ③ 组内对秩去均值，小组整组丢弃
    const kept: Row[] = []
    for (const idx of groups.values()) {
      groupSizes.push(idx.length)
      if (idx.length < minGroup) {
        stats.droppedSmallGroup += idx.length
        continue
      }
      let ms = 0
      let mf = 0
      for (const i of idx) {
        ms += scoreRanks[i] ?? 0
        mf += fwdRanks[i] ?? 0
      }
      ms /= idx.length
      mf /= idx.length
      for (const i of idx) {
        const row = usable[i]
        if (!row) continue
        kept.push({
          code: row.code,
          score: (scoreRanks[i] ?? 0) - ms,
          fwd: new Map([[horizon, (fwdRanks[i] ?? 0) - mf]]),
        })
      }
    }
    if (kept.length > 0) {
      out.set(date, kept)
      stats.rowsOut += kept.length
    }
  }
  stats.medianGroupSize = median(groupSizes)
  return { byDate: out, stats }
}

// ────────────── 风险因子中性化：秩上的横截面回归（预注册见 M2 §5.70） ──────────────

/**
 * 一个控制变量。**连续量只吃 1 个自由度，类别量吃「类别数 − 1」个** ——
 * 这就是 §5.70 从「分组去均值」换成回归的理由（§5.69 实测组规模中位只有 2）。
 */
export type Control =
  | {
      kind: 'continuous'
      name: string
      /** null = 缺数 ⇒ 该行整行丢弃（约束 4：不许拿 0 冒充） */
      valueOf: (code: SecCode, date: TradeDate) => number | null
    }
  | {
      kind: 'categorical'
      name: string
      groupOf: (code: SecCode, date: TradeDate) => string | null
    }

export interface RegressStats {
  horizon: number
  controls: string[]
  rowsIn: number
  rowsOut: number
  /** 因某个控制变量缺数而丢弃的行 */
  droppedMissing: number
  daysIn: number
  /** 设计矩阵实际用到的列数（含截距）—— 它就是「吃掉了多少自由度」 */
  medianColumns: number | null
  /** 残差自由度 `n − 列数` 的中位数。太小的话点估计不可承重（§5.70 限制 1） */
  medianResidualDf: number | null
  /** 因秩亏被丢掉的列数（合计）—— 类别量在小横截面上常出现空类别 */
  droppedColumns: number
}

/**
 * 最小二乘残差：解 `min ‖y − Xb‖`，返回 `y − Xb`。
 *
 * 用**带列主元的高斯消元**解正规方程 `XᵀX b = Xᵀy`，并把主元过小的列**整列丢掉**
 * （秩亏 ⇒ 那一列被别的列线性表示，硬解会得到一个爆炸的系数）。
 * 规模很小（列数 ≤ 30 上下），不值得引第三方线代库。
 *
 * ⚠ **丢列必须计数**：静默丢列 = 悄悄换了一个模型（no silent caps）。
 */
function olsResiduals(
  X: readonly number[][],
  ys: readonly number[][]
): { residuals: number[][]; used: number; dropped: number } | null {
  const n = X.length
  const p = X[0]?.length ?? 0
  if (n === 0 || p === 0 || n <= p) return null

  // 正规方程
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  const B: number[][] = ys.map(() => new Array<number>(p).fill(0))
  for (let i = 0; i < n; i += 1) {
    const row = X[i]
    if (!row) continue
    for (let a = 0; a < p; a += 1) {
      const xa = row[a] ?? 0
      for (let b = a; b < p; b += 1) {
        const v = xa * (row[b] ?? 0)
        ;(A[a] as number[])[b] = ((A[a] as number[])[b] ?? 0) + v
        if (b !== a) (A[b] as number[])[a] = ((A[b] as number[])[a] ?? 0) + v
      }
      ys.forEach((y, k) => {
        ;(B[k] as number[])[a] = ((B[k] as number[])[a] ?? 0) + xa * (y[i] ?? 0)
      })
    }
  }

  // 高斯-约当消元，主元过小即弃列
  const scale = Math.max(1, n)
  const TOL = 1e-9 * scale
  const alive = new Array<boolean>(p).fill(true)
  const coef: number[][] = ys.map(() => new Array<number>(p).fill(0))
  const order: number[] = []
  for (let step = 0; step < p; step += 1) {
    let pivot = -1
    let best = 0
    for (let c = 0; c < p; c += 1) {
      if (!alive[c] || order.includes(c)) continue
      const v = Math.abs((A[c] as number[])[c] ?? 0)
      if (v > best) {
        best = v
        pivot = c
      }
    }
    if (pivot < 0 || best < TOL) break
    order.push(pivot)
    const prow = A[pivot] as number[]
    const pv = prow[pivot] ?? 1
    for (let c = 0; c < p; c += 1) prow[c] = (prow[c] ?? 0) / pv
    B.forEach((b) => {
      ;(b as number[])[pivot] = ((b as number[])[pivot] ?? 0) / pv
    })
    for (let r = 0; r < p; r += 1) {
      if (r === pivot) continue
      const f = (A[r] as number[])[pivot] ?? 0
      if (f === 0) continue
      for (let c = 0; c < p; c += 1) {
        ;(A[r] as number[])[c] = ((A[r] as number[])[c] ?? 0) - f * (prow[c] ?? 0)
      }
      B.forEach((b) => {
        ;(b as number[])[r] = ((b as number[])[r] ?? 0) - f * ((b as number[])[pivot] ?? 0)
      })
    }
  }
  for (let c = 0; c < p; c += 1) if (!order.includes(c)) alive[c] = false
  ys.forEach((_y, k) => {
    for (const c of order) (coef[k] as number[])[c] = (B[k] as number[])[c] ?? 0
  })

  const residuals = ys.map((y, k) => {
    const out = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i += 1) {
      let fit = 0
      const row = X[i]
      for (const c of order) fit += (row?.[c] ?? 0) * ((coef[k] as number[])[c] ?? 0)
      out[i] = (y[i] ?? 0) - fit
    }
    return out
  })
  return { residuals, used: order.length, dropped: p - order.length }
}

/**
 * **风险因子中性化**：逐日把 `rank(score)` 与 `rank(fwd)` 对控制变量回归，残差进 `icOf`。
 *
 * 口径（预注册 §5.70，事后不许改）：
 * 1. **所有秩都在「保留子集」上算** —— 保留 = 每个控制变量都非空的行。
 *    这与 §5.69（先在全横截面算秩、再丢小组）**不同**，因为设计矩阵要求参与回归的是同一批行。
 *    两节的可比性由「只放行业哑变量」那一臂验证（P2）。
 * 2. **类别量丢掉第一个类别当参照**，否则与截距共线。
 * 3. 任一控制变量缺数 ⇒ **整行丢弃并计数**。
 *
 * **为什么能复用 `icOf`**：Spearman 只看秩，而 `icOf` 会把残差再排一次秩
 * ⇒ 与「直接在残差上算 Spearman」等价。
 *
 * ⚠ 它**减掉**了这些暴露，**不是测量**了它们 ⇒ 答不了「动量因子本身有没有 alpha」。
 */
export function neutralizeByRegression(
  byDate: Map<TradeDate, Row[]>,
  controls: readonly Control[],
  horizon: number
): { byDate: Map<TradeDate, Row[]>; stats: RegressStats } {
  const out = new Map<TradeDate, Row[]>()
  const stats: RegressStats = {
    horizon,
    controls: controls.map((c) => c.name),
    rowsIn: 0,
    rowsOut: 0,
    droppedMissing: 0,
    daysIn: 0,
    medianColumns: null,
    medianResidualDf: null,
    droppedColumns: 0,
  }
  const cols: number[] = []
  const dfs: number[] = []

  for (const [date, rows] of byDate) {
    const usable = rows.filter((r) => r.fwd.has(horizon))
    if (usable.length === 0) continue
    stats.daysIn += 1
    stats.rowsIn += usable.length

    // ① 逐行取控制变量；任一缺数即丢弃
    const kept: { row: Row; cont: number[]; cat: (string | null)[] }[] = []
    for (const row of usable) {
      const cont: number[] = []
      const cat: (string | null)[] = []
      let ok = true
      for (const c of controls) {
        if (c.kind === 'continuous') {
          const v = c.valueOf(row.code, date)
          if (v === null || !Number.isFinite(v)) {
            ok = false
            break
          }
          cont.push(v)
        } else {
          const g = c.groupOf(row.code, date)
          if (g === null) {
            ok = false
            break
          }
          cat.push(g)
        }
      }
      if (!ok) {
        stats.droppedMissing += 1
        continue
      }
      kept.push({ row, cont, cat })
    }
    if (kept.length === 0) continue

    // ② 秩（在保留子集上 —— 预注册第 1 条）
    const yScore = ranksOf(kept.map((k) => k.row.score))
    const yFwd = ranksOf(kept.map((k) => k.row.fwd.get(horizon) ?? 0))
    const contCount = controls.filter((c) => c.kind === 'continuous').length
    const contRanks: number[][] = []
    for (let j = 0; j < contCount; j += 1) {
      contRanks.push(ranksOf(kept.map((k) => k.cont[j] ?? 0)))
    }

    // ③ 设计矩阵：截距 + 连续量的秩 + 类别哑变量（丢第一个类别当参照）
    const catLevels: string[][] = []
    const catCount = controls.filter((c) => c.kind === 'categorical').length
    for (let j = 0; j < catCount; j += 1) {
      const levels = [...new Set(kept.map((k) => k.cat[j] ?? ''))].sort()
      catLevels.push(levels.slice(1))
    }
    const X = kept.map((k, i) => {
      const row = [1]
      for (let j = 0; j < contCount; j += 1) row.push(contRanks[j]?.[i] ?? 0)
      for (let j = 0; j < catCount; j += 1) {
        for (const lv of catLevels[j] ?? []) row.push(k.cat[j] === lv ? 1 : 0)
      }
      return row
    })

    const solved = olsResiduals(X, [yScore, yFwd])
    if (solved === null) continue // n <= p：这一天回归不出来，整天丢弃（不是「IC = 0」）
    stats.droppedColumns += solved.dropped
    cols.push(solved.used)
    dfs.push(kept.length - solved.used)

    const [rs, rf] = solved.residuals
    const emitted: Row[] = kept.map((k, i) => ({
      code: k.row.code,
      score: rs?.[i] ?? 0,
      fwd: new Map([[horizon, rf?.[i] ?? 0]]),
    }))
    out.set(date, emitted)
    stats.rowsOut += emitted.length
  }
  stats.medianColumns = median(cols)
  stats.medianResidualDf = median(dfs)
  return { byDate: out, stats }
}

/** 逐标的扫一遍判定根，把 (日期, 得分, 前瞻收益) 收进横截面表 */
export function collect(
  series: LoadedSeries,
  params: EngineParams,
  options: CliOptions,
  sentimentAt: (date: TradeDate) => number,
  byDate: Map<TradeDate, Row[]>,
  counters: { judged: number; unusable: number; zeroScore: number },
  /** 早于它的判定根不计入横截面（但照常参与预热与指标）；null = 全收 */
  evalFrom: string | null = null
): void {
  const candles = series.candles
  const warmup = options.warmup ?? params.data.fullBars

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    if (!bar) continue
    // 纪律 1：与 simulate.ts 逐条对齐
    if (i < warmup || i >= candles.length - 1) continue
    if (bar.hasGap === true) continue

    const from = Math.max(0, i - options.lookback + 1)
    const window = candles.slice(from, i + 1)
    const ctx: EngineContext = {
      profile: series.profile,
      candles: window,
      weekly: aggregateWeekly(window),
      marketSentiment: sentimentAt(bar.date),
      now: { date: bar.date, minutesSinceOpen: CONTINUOUS_MINUTES, session: 'SETTLE' },
      // 不传 position：问的是「引擎今天对这只票说了什么」，不是组合当时持不持有
    }
    // 预热与指标照常，但早于 evalFrom 的判定根不进横截面（见 evalFromOf 的注释）
    if (evalFrom !== null && bar.date < evalFrom) continue
    const evaluation = evaluate(ctx, params)
    if (!evaluation) continue
    counters.judged++
    if (!evaluation.sufficiency.usable) {
      counters.unusable++
      continue
    }

    // 纪律 2：买入方向的组合得分，不管触发没触发
    const score = evaluation.combine.breakdown.BUY.final
    if (score <= 0) counters.zeroScore++

    // 纪律 3：收盘到收盘，不模拟成交、不扣成本
    const base = bar.closeAdj
    const fwd = new Map<number, number>()
    if (base > 0) {
      for (const h of HORIZONS) {
        const later = candles[i + h]?.closeAdj
        if (later !== undefined && later > 0) fwd.set(h, later / base - 1)
      }
    }
    if (fwd.size === 0) continue

    const list = byDate.get(bar.date)
    const row: Row = { code: series.profile.code, score, fwd }
    if (list) list.push(row)
    else byDate.set(bar.date, [row])
  }
}

function pct(v: number | null, digits = 3): string {
  return v === null ? '—' : `${(v * 100).toFixed(digits)}%`
}

/**
 * 行业中性那一臂的打印。**单独一个函数**是因为 `render` 内部对每个持有期重算 `icOf`，
 * 而中性化后的 `byDate` **每个持有期一份**（组的可用集合随 `fwd.has(h)` 变）
 * ⇒ 不能传一个 map 进去。
 */
function renderNeutral(
  label: string,
  results: readonly (IcResult & { horizon: number; neutralize: NeutralizeStats })[]
): string[] {
  const lines = ['', `【${label}】`]
  lines.push(
    '  持有期  有效交易日   平均 IC      IC 标准差    t(NW,L=h−1)   组规模中位  丢弃(无行业/小组)   保留观测'
  )
  for (const r of results) {
    const num = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
    const s = r.neutralize
    const dropped = s.rowsIn === 0 ? 0 : (s.droppedNoIndustry + s.droppedSmallGroup) / s.rowsIn
    lines.push(
      `  ${String(r.horizon).padStart(4)} 日  ${String(r.days).padStart(10)}  ${pct(r.meanIc, 4).padStart(10)}  ` +
        `${pct(r.sdIc, 4).padStart(12)}  ${`${num(r.tNw)}(L=${r.lagNw})`.padStart(12)}  ` +
        `${(s.medianGroupSize === null ? '—' : s.medianGroupSize.toFixed(1)).padStart(9)}  ` +
        `${`${s.droppedNoIndustry}/${s.droppedSmallGroup} = ${(dropped * 100).toFixed(1)}%`.padStart(17)}  ` +
        `${String(s.rowsOut).padStart(9)}`
    )
  }
  return lines
}

/** §5.70 的臂：一行一个持有期，带自由度那一列（限制 1 的量） */
function renderRiskArm(
  label: string,
  subset: string,
  byHorizon: readonly (IcResult & { horizon: number; regress: RegressStats })[]
): string[] {
  const lines = ['', `【${label}】 子集 = ${subset}`]
  lines.push(
    '  持有期  有效交易日   平均 IC      t(NW,L=h−1)   设计矩阵列数  残差自由度中位  缺数丢弃  弃列'
  )
  for (const r of byHorizon) {
    const num = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
    const s = r.regress
    lines.push(
      `  ${String(r.horizon).padStart(4)} 日  ${String(r.days).padStart(10)}  ${pct(r.meanIc, 4).padStart(10)}  ` +
        `${`${num(r.tNw)}(L=${r.lagNw})`.padStart(12)}  ${String(s.medianColumns ?? '—').padStart(12)}  ` +
        `${String(s.medianResidualDf ?? '—').padStart(14)}  ${String(s.droppedMissing).padStart(8)}  ${String(s.droppedColumns).padStart(4)}`
    )
  }
  return lines
}

function render(
  label: string,
  byDate: Map<TradeDate, Row[]>,
  counters: { judged: number; unusable: number; zeroScore: number }
): string[] {
  const lines: string[] = []
  lines.push('')
  lines.push(`【${label}】`)
  const tieShare = counters.judged === 0 ? 0 : counters.zeroScore / counters.judged
  lines.push(
    `  判定根 ${counters.judged} · 数据不足 ${counters.unusable} · ` +
      `买入得分为 0 的占比 ${(tieShare * 100).toFixed(1)}%（并列会稀释 IC，纪律 4）`
  )
  // 三个 t 并排打印是刻意的：只印调整后的会让「调整了多少」看不见，
  // 而那个倍数（朴素/NW）恰恰是这一节要报的量（§5.47）
  lines.push(
    '  持有期    有效交易日   平均 IC      IC 标准差    t(朴素·上界)   t(NW,L=h−1)   t(NW,Andrews)      Q1→Q5 前瞻收益中位数'
  )
  for (const h of HORIZONS) {
    const r = icOf(byDate, h)
    const num = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
    lines.push(
      `  ${String(h).padStart(4)} 日  ${String(r.days).padStart(10)}  ${pct(r.meanIc, 4).padStart(10)}  ` +
        `${pct(r.sdIc, 4).padStart(12)}  ${num(r.t).padStart(12)}   ` +
        `${`${num(r.tNw)}(L=${r.lagNw})`.padStart(12)}  ${`${num(r.tNwAndrews)}(L=${r.lagAndrews})`.padStart(13)}   ` +
        r.quintileMedians.map((m) => pct(m, 2).padStart(8)).join(' ')
    )
  }
  return lines
}

export async function main(argv: readonly string[]): Promise<number> {
  const evalFrom = evalFromOf(argv)
  const industryFile = industryFileOf(argv)
  /** `--risk-factors`：打开 §5.70 那六条中性化臂。不给它时 payload 与旧报告逐字段相同。 */
  const riskFactors = argv.includes('--risk-factors')
  /**
   * `--price-factors`：打开 §5.83 那三个收益形态因子。不给它时 payload
   * 与旧报告逐字段相同 —— 既有的 `ic-*.json` 不会因此变得读不出来。
   */
  const priceFactors = argv.includes('--price-factors')
  const rest = stripLocalFlags(argv)
  let options: CliOptions | 'help'
  try {
    options = parseArgs(rest)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}

${USAGE}`)
    return 1
  }
  if (options === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  const range = { from: options.from, to: options.to }
  const params = resolveParams(options)
  const source = options.fixtures
    ? openFixtureSource(options.fixtures, range)
    : await openSqliteSource(options.db ?? defaultDbPath(), range)

  try {
    // 情绪序列与 crosssec-audit 逐条相同：基准的收盘序列 → 分位，缺值沿用上一个
    const benchmark = options.benchmark ? source.load(normalizeCode(options.benchmark)) : null
    const sentimentByDate = new Map<TradeDate, number>()
    if (benchmark) {
      const series = sentimentSeries(benchmark.candles.map((c) => c.closeAdj))
      let last = 0.5
      benchmark.candles.forEach((candle, i) => {
        const value = series[i]
        if (value !== null && value !== undefined) last = value
        sentimentByDate.set(candle.date, last)
      })
    }
    const sentimentAt = (date: TradeDate): number => sentimentByDate.get(date) ?? 0.5

    const all = new Map<TradeDate, Row[]>()
    const counters = { judged: 0, unusable: 0, zeroScore: 0 }
    const momentumOf = new Map<SecCode, Map<TradeDate, Map<number, number>>>()
    /** §5.83 的边侧表，与 `momentumOf` 同一形状、同一理由（不改 `Row` 也不改 `collect`） */
    const priceFactorOf = new Map<SecCode, Map<TradeDate, Map<PriceFactorKey, number>>>()
    let audited = 0
    for (const raw of options.codes) {
      const code = normalizeCode(raw)
      const loaded = source.load(code)
      if (!loaded) {
        if (!options.quiet && !options.json) process.stdout.write(`[warn] ${code} 无日线，已跳过
`)
        continue
      }
      collect(loaded, params, options, sentimentAt, all, counters, evalFrom)
      /*
        动量的边侧表（§5.70 的控制变量之一）。**在这里顺手算，不改 `Row` 也不改 `collect`**
        —— 那两个是 `factor-ic.ts` 也在用的共享结构，为一次归因实验加字段不值得。
        用 `closeAdj`（后复权）：除权不该被算成一次下跌。
      */
      // §5.84 起 priceFactors 也要 mom20 做控制变量 ⇒ 两个旗标任一打开都算这张边侧表
      if (riskFactors || priceFactors) {
        const perDate = new Map<TradeDate, Map<number, number>>()
        loaded.candles.forEach((bar, i) => {
          const byLag = new Map<number, number>()
          for (const lag of MOMENTUM_LAGS) {
            const base = loaded.candles[i - lag]?.closeAdj
            if (base !== undefined && base > 0 && bar.closeAdj > 0) {
              byLag.set(lag, bar.closeAdj / base - 1)
            }
          }
          if (byLag.size > 0) perDate.set(bar.date, byLag)
        })
        momentumOf.set(loaded.profile.code, perDate)
      }
      if (priceFactors) {
        const closes = loaded.candles.map((b) => b.closeAdj)
        const perDate = new Map<TradeDate, Map<PriceFactorKey, number>>()
        loaded.candles.forEach((bar, i) => {
          const values = priceFactorsAt(closes, i)
          if (values.size > 0) perDate.set(bar.date, values)
        })
        priceFactorOf.set(loaded.profile.code, perDate)
      }
      audited++
      if (!options.quiet && !options.json && audited % 20 === 0) {
        process.stdout.write(`[audit] ${audited} 只，累计判定根 ${counters.judged}
`)
      }
    }
    if (audited === 0) throw new Error('没有任何标的有可用日线')

    // 纪律 4 的第二档：得分 > 0 的子集（同一批数据的另一种切法，预注册里写死）
    const positive = new Map<TradeDate, Row[]>()
    for (const [date, rows] of all) {
      const kept = rows.filter((r) => r.score > 0)
      if (kept.length > 0) positive.set(date, kept)
    }

    /*
      行业中性化那一臂（预注册 §5.68）。**只在给了 `--industry` 时才算** ——
      不给时 payload 逐字段与旧报告相同，既有的 `ic-*.json` 不会因此变得读不出来。
      两个子集都做，因为预注册里主子集是 `positiveOnly`、`all` 并排报。
    */
    const industryOf = industryFile === null ? null : loadIndustryAsOf(industryFile)
    const neutral = industryOf === null ? null : {
      all: HORIZONS.map((h) => {
        const { byDate, stats } = neutralizeByIndustry(all, industryOf, h)
        return { horizon: h, ...icOf(byDate, h), neutralize: stats }
      }),
      positiveOnly: HORIZONS.map((h) => {
        const { byDate, stats } = neutralizeByIndustry(positive, industryOf, h)
        return { horizon: h, ...icOf(byDate, h), neutralize: stats }
      }),
    }

    /*
      §5.70 的六条臂。**臂的清单写死在这里，不是运行时挑的** ——
      预注册的全部意义就是「事后不许换臂」。缺输入的臂（市值要 `--liquidity`、
      行业要 `--industry`）**整条省略并在 meta 里说明**，不静默降级成别的控制组合。
    */
    const riskArms: {
      key: string
      label: string
      controls: Control[]
      subset: 'positiveOnly' | 'all'
    }[] = []
    if (riskFactors) {
      const capByCode = new Map<SecCode, Map<TradeDate, number>>()
      if (options.liquidity) {
        for (const one of loadLiquidity(options.liquidity, options.codes.map(normalizeCode))) {
          const perDate = new Map<TradeDate, number>()
          for (const row of one.rows) if (row.floatCap !== null) perDate.set(row.date, row.floatCap)
          capByCode.set(one.code, perDate)
        }
      }
      // 控制变量取**当日横截面的秩**（在 neutralizeByRegression 里做）⇒ 单调变换等价
      // ⇒ 取不取 log 不影响结果，省掉一个自由参数
      const cap: Control = {
        kind: 'continuous',
        name: 'floatCap',
        valueOf: (c, d) => capByCode.get(c)?.get(d) ?? null,
      }
      const mom = (lag: number): Control => ({
        kind: 'continuous',
        name: `mom${lag}`,
        valueOf: (c, d) => momentumOf.get(c)?.get(d)?.get(lag) ?? null,
      })
      const ind: Control | null =
        industryOf === null
          ? null
          : { kind: 'categorical', name: 'swL1', groupOf: (c, d) => industryOf(c, d) }
      const hasCap = capByCode.size > 0
      const push = (key: string, label: string, controls: (Control | null)[]): void => {
        if (controls.some((c) => c === null)) return
        riskArms.push({ key, label, controls: controls as Control[], subset: 'positiveOnly' })
      }
      if (hasCap) push('A1', 'A1 市值', [cap])
      push('A2', 'A2 动量5', [mom(5)])
      push('A3', 'A3 动量20', [mom(20)])
      if (hasCap) push('A4', 'A4 市值 + 动量20（**主判据**）', [cap, mom(20)])
      if (hasCap) push('A5', 'A5 市值 + 动量20 + 行业（自由度紧张，只当描述）', [cap, mom(20), ind])
      push('A6', 'A6 只放行业（与 §5.69 对齐用）', [ind])
      if (hasCap) {
        riskArms.push({
          key: 'A4-all',
          label: 'A4 同样的控制组、换成全体子集（稳健性）',
          controls: [cap, mom(20)],
          subset: 'all',
        })
      }
    }
    /*
      §5.83 的三条收益形态臂。

      **样本直接复用 `all`**（判定根全集）：只把每行的 `score` 换成因子值、
      算不出因子的行丢掉 ⇒ 与 §5.46 是**同一批判定根**，这是接在本文件里的全部理由。

      ⚠ **主子集取 `all` 而不是 `positiveOnly`，这是看结果之前定的**（理由写在这里，
      免得事后看起来像挑的）：「得分 > 0」是**我们自己那个得分**的性质，
      拿它去筛一个外部因子的样本，量出来的就不再是那个因子的排序能力，
      而是「在我们已经看上的票里它还能不能排序」—— 那是另一个问题（§5.45 问的那个）。
      两档都照样报，因为 `positiveOnly` 是 §5.46 的主口径，并排放着才好对照。

      ⚠ 顺带算 `Spearman(因子, 得分)` 的逐日均值。**它必须与 IC 并排读**：
      某个因子与得分秩相关很高时，它的 IC 不是新信息，而是 §5.46 的一次重复测量。
    */
    const priceResults = !priceFactors
      ? null
      : PRICE_FACTORS.map((factor) => {
          const swap = (src: Map<TradeDate, Row[]>): Map<TradeDate, Row[]> => {
            const out = new Map<TradeDate, Row[]>()
            for (const [date, rows] of src) {
              const kept: Row[] = []
              for (const row of rows) {
                const value = priceFactorOf.get(row.code)?.get(date)?.get(factor.key)
                if (value === undefined || !Number.isFinite(value)) continue
                kept.push({ code: row.code, score: value, fwd: row.fwd })
              }
              if (kept.length > 0) out.set(date, kept)
            }
            return out
          }
          const allSwapped = swap(all)
          /*
            §5.84 的两条中性化臂：控制 20 日 / 5 日动量。
            **复用 `neutralizeByRegression`，与 §5.70 的 A3/A2 逐字同一条路** —— 另写一份的症状是
            「得分的中性化 IC 与因子的中性化 IC 不是同一个口径」，而两个数要并排比。
            ⚠ 加控制**只可能让效应变小或不变** ⇒ 这是对候选不利的方向，不是移动球门。
          */
          const controlArm = (lag: number): { lag: number; byHorizon: (IcResult & { horizon: number })[] } => {
            const control: Control = {
              kind: 'continuous',
              name: `mom${lag}`,
              valueOf: (c, d) => momentumOf.get(c)?.get(d)?.get(lag) ?? null,
            }
            return {
              lag,
              byHorizon: HORIZONS.map((h) => {
                const { byDate } = neutralizeByRegression(allSwapped, [control], h)
                return { horizon: h, ...icOf(byDate, h) }
              }),
            }
          }
          // 与得分的横截面秩相关：逐日算再取均值（只在两边都有值的行上）
          const corrs: number[] = []
          let tiedDays = 0
          let totalDays = 0
          for (const [date, rows] of all) {
            const pairs: { f: number; s: number }[] = []
            for (const row of rows) {
              const value = priceFactorOf.get(row.code)?.get(date)?.get(factor.key)
              if (value === undefined || !Number.isFinite(value)) continue
              pairs.push({ f: value, s: row.score })
            }
            if (pairs.length < MIN_CROSS_SECTION) continue
            totalDays++
            const values = pairs.map((p) => p.f)
            // 并列比例：当日不同取值数 / 行数。`up_days_20d` 只有 21 个取值 ⇒ 这个数会很低
            if (new Set(values).size < values.length) tiedDays++
            const c = correlation(ranksOf(values), ranksOf(pairs.map((p) => p.s)))
            if (c !== null) corrs.push(c)
          }
          return {
            key: factor.key,
            label: factor.label,
            window: PRICE_FACTOR_WINDOW,
            all: HORIZONS.map((h) => ({ horizon: h, ...icOf(allSwapped, h) })),
            positiveOnly: HORIZONS.map((h) => ({ horizon: h, ...icOf(swap(positive), h) })),
            /** §5.84：两条臂写死（mom20 主判据 · mom5 对照），不加市值不加行业 */
            momNeutral: [controlArm(20), controlArm(5)],
            /** 与引擎买入得分的逐日横截面秩相关的均值 */
            corrWithScore: corrs.length === 0 ? null : corrs.reduce((s, v) => s + v, 0) / corrs.length,
            corrDays: corrs.length,
            /** 有并列的天数占比 —— 高并列会稀释 Spearman，是事实不是 bug */
            tiedDayFraction: totalDays === 0 ? null : tiedDays / totalDays,
          }
        })

    const riskResults = riskArms.map((arm) => ({
      key: arm.key,
      label: arm.label,
      subset: arm.subset,
      controls: arm.controls.map((c) => c.name),
      byHorizon: HORIZONS.map((h) => {
        const { byDate, stats } = neutralizeByRegression(
          arm.subset === 'all' ? all : positive,
          arm.controls,
          h
        )
        return { horizon: h, ...icOf(byDate, h), regress: stats }
      }),
    }))

    const payload = {
      meta: {
        engineVersion: engineVersionOf(params),
        paramsFingerprint: paramsFingerprint(params),
        codes: audited,
        from: options.from,
        to: options.to,
        horizons: HORIZONS,
        minCrossSection: MIN_CROSS_SECTION,
        evalFrom,
        industryFile,
        riskFactors,
        priceFactors,
        riskArms: riskArms.map((a) => ({ key: a.key, controls: a.controls.map((c) => c.name), subset: a.subset })),
        judged: counters.judged,
        unusable: counters.unusable,
        zeroScore: counters.zeroScore,
      },
      all: HORIZONS.map((h) => ({ horizon: h, ...icOf(all, h) })),
      positiveOnly: HORIZONS.map((h) => ({ horizon: h, ...icOf(positive, h) })),
      ...(neutral === null
        ? {}
        : { industryNeutralAll: neutral.all, industryNeutralPositiveOnly: neutral.positiveOnly }),
      ...(riskResults.length === 0 ? {} : { riskNeutral: riskResults }),
      ...(priceResults === null ? {} : { priceFactorArms: priceResults }),
    }

    if (options.out !== undefined) {
      mkdirSync(dirname(options.out), { recursive: true })
      writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}
`, 'utf8')
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload)}
`)
      return 0
    }
    const lines = [
      `[ic] ${audited} 只 · ${options.from} → ${options.to}` +
        (evalFrom === null ? '' : ` · 只统计 ${evalFrom} 之后的判定根（更早的只做预热）`) +
        ` · ${engineVersionOf(params)}`,
      ...render('全体（含买入得分为 0 的并列）', all, counters),
      ...render('得分 > 0 的子集', positive, counters),
      ...(neutral === null
        ? []
        : [
            ...renderNeutral('行业中性 · 全体（申万一级，组内对秩去均值）', neutral.all),
            ...renderNeutral(
              '行业中性 · 得分 > 0 的子集（**§5.68 的主判据**）',
              neutral.positiveOnly
            ),
            '',
            '  行业中性 = 逐日先算全横截面的秩，再在申万一级组内减组均值（组规模 < 2 整组丢弃，',
            '    拿不到行业的行丢弃、**不并成「其它」组**）。行业按**时点**取（`startDate <= 该日`）——',
            '    用今天的归属回标历史是未来函数，而那正是这份数据存在的理由。',
            '  ⚠ 它**减掉**了行业那一层，**不是测量**了它 ⇒ 答不了「行业轮动有没有 alpha」。',
            '  ⚠ 中性化吃自由度 ⇒ 就算点估计不动，`t` 也会变小（组规模中位那一列就是它的量）。',
          ]),
      ...(priceResults === null
        ? []
        : [
            ...priceResults.flatMap((arm) => [
              '',
              `  【收益形态因子】${arm.label}（窗口 ${arm.window} 根 · §5.83）`,
              `    与引擎买入得分的横截面秩相关均值 ${
                arm.corrWithScore === null ? '—' : arm.corrWithScore.toFixed(3)
              }（${arm.corrDays} 天）· 有并列的天数占比 ${pct(arm.tiedDayFraction, 1)}`,
              '    子集   持有期   有效日   meanIc     sd      t(NW)  滞后   t(朴素·不许引用)',
              ...(
                [
                  ['全体（**主口径**）', arm.all],
                  ['得分>0 子集', arm.positiveOnly],
                ] as const
              ).flatMap(([label, rows]) =>
                rows.map((r) => {
                  const n = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
                  return (
                    `    ${label.padEnd(18)} ${String(r.horizon).padStart(3)} 日` +
                    ` ${String(r.days).padStart(6)}  ${pct(r.meanIc).padStart(9)}` +
                    ` ${pct(r.sdIc).padStart(8)}  ${n(r.tNw).padStart(6)}   ${String(r.lagNw).padStart(2)}` +
                    `   ${n(r.t).padStart(6)}`
                  )
                })
              ),
              ...arm.momNeutral.flatMap((n) =>
                n.byHorizon.map((r) => {
                  const num = (v: number | null): string => (v === null ? '—' : v.toFixed(2))
                  const label = `控制 mom${n.lag}${n.lag === 20 ? '（**§5.84 主判据**）' : ''}`
                  return (
                    `    ${label.padEnd(18)} ${String(r.horizon).padStart(3)} 日` +
                    ` ${String(r.days).padStart(6)}  ${pct(r.meanIc).padStart(9)}` +
                    ` ${pct(r.sdIc).padStart(8)}  ${num(r.tNw).padStart(6)}   ${String(r.lagNw).padStart(2)}` +
                    `   ${num(r.t).padStart(6)}`
                  )
                })
              ),
            ]),
            '',
            '  ⚠ **控制 mom20 那两行是 §5.84 的主判据**：引擎得分自己的负 IC 在控制它之后',
            '    就掉到 |t| < 2（训练 −4.4% → −1.09%，验证翻正 —— `ic-train-risk.json` / §5.70），',
            '    ⇒ 若因子也这样，它就是**那个 20 日动量暴露的另一种测量**，不是新信息。',
            '  ⚠ 三个因子来自竞品 `tickflow-stock-panel` 的因子目录（§5.82 ⑧.1），',
            '    **每一个数字都是 `GUESS` 不是事实**（ADR-0003）：本轮只量 IC，不进引擎、不进 params.ts。',
            '  ⚠ **主口径是「全体」而不是「得分>0 子集」**，且这是看结果之前定的：',
            '    「得分 > 0」是我们自己那个得分的性质，拿它筛外部因子的样本会把问题换成',
            '    「在我们已经看上的票里它还能不能排序」—— 那是 §5.45 问的，不是这里问的。',
            '  ⚠ **`corrWithScore` 必须与 IC 并排读**：它高就说明这个因子不是新信息，',
            '    而是 §5.46 的一次重复测量。`up_days_20d` 只有 21 个取值 ⇒ 并列会稀释它的 IC。',
          ]),
      ...(riskResults.length === 0
        ? []
        : [
            ...riskResults.flatMap((a) => renderRiskArm(a.label, a.subset, a.byHorizon)),
            '',
            '  风险因子中性 = 逐日把 rank(得分) 与 rank(前瞻收益) 对「截距 + 控制变量」做横截面 OLS，',
            '    取残差再算 Spearman（M2 §5.70）。控制变量取**当日横截面的秩** ⇒ 取不取 log 等价。',
            '    连续量只吃 1 个自由度；类别量（行业）吃「类别数 − 1」个 —— 那就是 A5 自由度紧张的原因。',
            '  ⚠ **臂的清单在预注册里写死**，缺输入的臂整条省略（不静默降级成别的控制组合）。',
            '  ⚠ **动量与得分在构造上相关**（T3_BREAKOUT 就是「创新高 + 带宽扩张」）',
            '    ⇒ 「Δ 大」有两种读法：暴露解释了负 IC，**或者**我们把得分本身砍掉了一块。**本轮分不开**。',
            '  ⚠ 它**减掉**了这些暴露，**不是测量**了它们 ⇒ 答不了「动量因子本身有没有 alpha」。',
          ]),
      '',
      '  IC 是逐日横截面的 Spearman 秩相关（得分 vs 前瞻收益），**不构造零分布**（§5.46）。',
      '  t(朴素) = mean(IC)/(sd(IC)/√有效交易日) —— 把交易日当独立样本，**是上界，不许引用**。',
      '  t(NW) = Newey-West/Bartlett 长期方差下的 t。主口径 L = h−1（重叠窗口的 MA(h−1) 是机械已知的）；',
      '    Andrews(1991) 的 ⌊4(T/100)^(2/9)⌋ 并排报出，两档都在看结果之前写死 —— 调滞后阶到显著为止是',
      '    文献里有记录的 p-hacking 通道（§5.47）。两档给出相反判断时，结论是「不稳健」而不是挑一个。',
      '  判据：t(NW) ≥ 2 且五等分单调（端点差 ≥ 0.3pp）。',
      '  ⚠ IC 只回答「得分有没有横截面排序能力」，**不回答「这套系统赚不赚钱」**。',
      '',
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    source.close()
  }
}

if (process.argv[1] !== undefined && process.argv[1].includes('ic-audit')) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
