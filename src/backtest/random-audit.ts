#!/usr/bin/env node
/**
 * 随机入场基准（零假设分布）。
 *
 * ```bash
 * pnpm audit:random -- --baseline reports/calib/baseline-261.json --fixtures ./data/history --trials 200
 * ```
 *
 * **为什么需要这个工具**：回测报出「TREND_UP 建仓 396 次 / 仓位加权 −1.01%」，
 * 但这个数**缺一个零点**。唯一的基准是沪深300，而它是满仓的、我们平均资金占用只有 3.69%
 * —— 报告里「超额 −15.04%」那一行离开占用率就会被读反（§5.13）。
 * 于是分不开两件事：
 *
 * | | 含义 | 对策完全不同 |
 * |---|---|---|
 * | A 策略没信息 | 同池同期随机买入也是 −1% | 问题是「该不该在 TREND_UP 里买」，不是判定逻辑写错了 |
 * | B 策略有信息但符号反了 | 随机明显好于 −1% | 「得分越高越糟」就不是噪音，深挖判定逻辑值得做 |
 *
 * **配对随机化**：对每一次真实建仓，在**同一只票**上随机挑一个入场日，
 * 持有**同样的根数**，走**同一套成本模型**。于是标的构成、持仓时长分布、
 * 投入资金、费率滑点全部对齐，**唯一变化的是「什么时候进」** —— 那正是被检验的东西。
 *
 * 两种口径，回答两个不同的问题：
 *
 * - **无条件**（默认）：随机日可以是任何一天 ⇒ 答「这套规则挑的点比随便挑好吗」
 * - **同 regime**（`--match-regime`）：随机日限定在与真实建仓相同的市场状态里
 *   ⇒ 答「除掉 regime 过滤之后，子信号与得分还有没有增量」。
 *   这一档才分得开 A 与 B：若真实 ≈ 同 regime 随机，则亏的是 TREND_UP 这个状态本身，
 *   而不是状态内的挑选。
 *
 * **四条纪律**：
 * 1. **只统计，不改参数**。与 `audit:regime` / `audit:subsignals` 同类。
 * 2. **成本模型复用 `costs.ts`**，不在这里重写一份 —— 两边数字对不上的时候
 *    「是策略差异还是口径差异」会变成一个查不清的问题（CLAUDE.md 那条横向边）。
 * 3. **成交口径与 `simulate.ts` 逐条对齐**：次日开盘成交（`entryDate` 就是成交那根）、
 *    涨停开盘买不到、跌停开盘顺延最多 5 根、`hasGap` 那根不成交、手数向下取整。
 *    差一条，比的就不是同一件事。
 * 4. **RNG 必须可复现**：种子由 `--seed` 给，默认 1。用 `Math.random()` 会让
 *    同一份数据两次跑出不同的结论，而这个工具的产出是要写进偏差报告的。
 *
 * **一处必须声明的偏倚**：`holdingBars` 是**内生**的 —— 真实建仓里跌得快的被止损在 8 根，
 * 涨上去的被移动止损拖到 15 根。配对时照抄这个分布，等于让随机组也按同样的
 * 「短持有 / 长持有」比例去抽。这是刻意的（否则比的是两种持有策略），
 * 但它意味着本工具回答的是「**在同样的持有时长安排下，入场时点选得好不好**」，
 * 不是「这套策略整体比随机好不好」。后者要连离场规则一起随机化，是另一个实验。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeCode, priceLimits } from '../core/code'
import { toEpochDay } from '../core/date'
import { computeIndicators } from '../core/indicators'
import { classifyRegimes } from '../core/regime'
import { DEFAULT_PARAMS, type EngineParams } from '../core/params'
import type { Regime, SecCode, TradeDate } from '../core/types'
import {
  DEFAULT_COSTS,
  buyFees,
  buyFill,
  lotsAffordable,
  sellFees,
  sellFill,
  type CostModel,
} from './costs'
import { openFixtureSource, openSqliteSource, type DataSource, type LoadedSeries } from './data'
import { auditKnobs } from './report'

/** 与 simulate.ts 的 MAX_DEFER_BARS 同源：连续跌停超过这个天数就当作卖不掉 */
const MAX_DEFER_BARS = 5

/**
 * 在**升序**的 `pool` 里找离 `target` 最近、且不等于 `exclude` 的元素（块位移的「吸附」）。
 *
 * `exclude` 是真实成交那一根：小 |δ| 会让吸附把随机样本吸回真实入场本身，
 * 那次抽样就退化成「真实」，会把分位往 50% 拽（与排除 δ = 0 同一条理由）。
 *
 * ⚠ **必须按「值的距离」比，不能按「池下标的距离」外扩。**
 * `pool` 是稀疏且不等距的（`--match-regime` 下它只含同状态的那些天），
 * 左边一格可能跳 40 根、右边一格只跳 1 根 —— 按下标交替外扩会系统性偏向某一侧，
 * 那是给零分布加了一个方向偏置，而零分布的中立性是这个工具全部可信度的来源。
 * 第一版就是那么写的，这条注释是它的墓碑。
 */
export function nearestInPool(
  pool: readonly number[],
  target: number,
  exclude: number
): number | null {
  let lo = 0
  let hi = pool.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((pool[mid] ?? 0) < target) lo = mid + 1
    else hi = mid
  }
  // 从二分落点向两侧走，每一步都取「离 target 更近的那一侧」。
  // **等距时按 target 的奇偶决定先看哪边**：固定偏向一侧会让所有平局都朝同一个方向落，
  // 累积起来就是零分布的一个系统性时间偏移。按奇偶分是确定性的（可复现）且两侧各半。
  const preferRight = target % 2 === 0
  let right = lo
  let left = lo - 1
  while (right < pool.length || left >= 0) {
    const a = right < pool.length ? pool[right] : undefined
    const b = left >= 0 ? pool[left] : undefined
    const da = a === undefined ? Infinity : Math.abs(a - target)
    const db = b === undefined ? Infinity : Math.abs(b - target)
    if (da === Infinity && db === Infinity) return null
    if (da < db || (da === db && preferRight)) {
      if (a !== undefined && a !== exclude) return a
      right++
    } else {
      if (b !== undefined && b !== exclude) return b
      left--
    }
  }
  return null
}

const REGIMES: readonly Regime[] = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'TRANSITION']

// ── 报告读取 ─────────────────────────────────────────────────────────────

interface ReportTrade {
  code: SecCode
  entryDate: TradeDate
  exitDate: TradeDate
  entryPrice: number
  exitPrice: number
  shares: number
  pnl: number
  holdingBars: number
  regimeAtEntry: Regime
  /** regime 已连续持续的判定根数。011 之前的基线报告没有这一列 ⇒ undefined */
  barsInRegimeAtEntry?: number
  entryScore: number
  entrySignals: string[]
  exitRule: string
  partial: boolean
}

interface BaselineReport {
  meta: {
    engineVersion: string
    paramsFingerprint: string
    codes: SecCode[]
    from: TradeDate
    to: TradeDate
    capitalPerCode: number
    /** 老基线报告（2026-08-20 之前）没有这一列 ⇒ `undefined` = **未记录**，不是「等于出厂」 */
    costs?: CostModel | undefined
  }
  trades: ReportTrade[]
}

/**
 * 建仓级归并：一行 `trade` 是一次**卖出**，回撤减仓会把一次建仓拆成两三行。
 * 逐笔胜率 28.45% 与建仓级胜率 44.85% 是同一份数据（§5.18），混用就会读错。
 * 这里一律按 `code@entryDate` 归并到建仓级。
 */
interface Position {
  code: SecCode
  entryDate: TradeDate
  /** 最后一笔卖出的日期 —— 建仓级的持有跨度按它算 */
  exitDate: TradeDate
  regimeAtEntry: Regime
  /** regime 已连续持续的判定根数；旧基线报告里没有这一列 */
  barsInRegime: number | null
  entryScore: number
  entrySignals: string[]
  /** 入场投入的本金（前复权口径）= 入场价 × 总股数 */
  deployed: number
  /** 该次建仓的全部盈亏之和（已扣费） */
  pnl: number
}

function groupPositions(trades: readonly ReportTrade[]): Position[] {
  const map = new Map<string, Position>()
  for (const t of trades) {
    const key = `${t.code}@${t.entryDate}`
    const found = map.get(key)
    if (found) {
      found.pnl += t.pnl
      found.deployed += t.entryPrice * t.shares
      if (t.exitDate > found.exitDate) found.exitDate = t.exitDate
    } else {
      map.set(key, {
        code: t.code,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        regimeAtEntry: t.regimeAtEntry,
        barsInRegime: t.barsInRegimeAtEntry ?? null,
        entryScore: t.entryScore,
        entrySignals: t.entrySignals,
        deployed: t.entryPrice * t.shares,
        pnl: t.pnl,
      })
    }
  }
  return [...map.values()]
}

// ── 历史公告（--announcements，只分层不改交易）───────────────────────────

/**
 * 公告的方向标签。**由标题关键词判定，没有正文** —— 精度未经核对，见下。
 *
 * `NEU` 含两类：程序性公告（股东大会 / 募集资金 / 定期报告 / 关联交易 / 担保…，
 * 占语料的大多数）与**标题里看不出方向**的（如「2024年度业绩预告」不写预增预减）。
 */
type Tone = 'POS' | 'NEG' | 'NEU'

/**
 * 标题关键词分类表。**这张表在看到任何 alpha 结果之前就定死了**，并且只跑一次
 * —— 反复调关键词直到某一档好看，等于把这次测量变成一次过拟合搜索
 * （与「每个候选机制只报一次分位」同一条纪律）。
 *
 * 设计取向是**高精度、低召回**：只收方向明确的类别，其余一律 `NEU`。
 * 宁可让 POS/NEG 两桶小一点，也不要往里掺方向不明的东西 ——
 * 掺进去的结果是两个桶互相抵消，而那正是这次要排除的解释。
 *
 * **四条刻意排除**（都是「看着有方向、其实没有」）：
 * - `业绩预告`：标题多数不写预增/预减，只有显式写了的才算；
 * - `异常波动`：它是**价格已经动过**的结果而不是原因，收进来等于用结果解释结果；
 * - `停牌`：可能是重组（好）也可能是风险（坏）；
 * - `解除质押`：与 `质押` 相反，必须先排除，否则会被当成利空。
 */
const TONE_NEG = [
  '减持',
  '冻结',
  '拍卖',
  '立案',
  '处罚',
  '警示函',
  '问询函',
  '关注函',
  '监管措施',
  '违规',
  '业绩预减',
  '业绩预亏',
  '退市风险',
  '其他风险警示',
  '风险提示',
] as const
const TONE_POS = [
  '增持',
  '回购',
  '业绩预增',
  '扭亏',
  '中标',
  '重大合同',
  '框架协议',
  '战略合作',
  '利润分配',
  '权益分派',
  '分红',
] as const

export function toneOf(title: string): Tone {
  // 质押是利空，但「解除质押」是相反的事 —— 必须先减掉再判
  const t = title.replace(/解除质押/g, '')
  if (t.includes('质押')) return 'NEG'
  for (const k of TONE_NEG) if (t.includes(k)) return 'NEG'
  for (const k of TONE_POS) if (t.includes(k)) return 'POS'
  return 'NEU'
}

/**
 * code → 公告日 → 当天的合并方向。
 *
 * 一天平均 3.23 条公告，方向可能混杂。合并规则：
 * **有利空记利空 → 否则有利好记利好 → 否则中性**。风险优先是刻意的，
 * 而且这条规则同样是事前定的，不许事后换。
 */
type AnnouncementDays = Map<string, Map<number, Tone>>

/**
 * 载入 `fetch-announcements.mjs` 的产物。
 *
 * **读不到就抛错，不静默退化成「都没有公告」** —— 那会让整张表的「公告 无」层
 * 吃下全部建仓，而读表的人完全看不出数据根本没加载。
 */
export function loadAnnouncements(dir: string): AnnouncementDays {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  if (files.length === 0) throw new Error(`${dir} 里没有公告文件，先跑 pnpm fetch:announcements`)
  const out: AnnouncementDays = new Map()
  let total = 0
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as {
      code?: string
      items?: { date?: string; title?: string }[]
    }
    if (!raw.code) continue
    const byDay = new Map<number, Tone>()
    for (const item of raw.items ?? []) {
      const day = item.date === undefined ? null : toEpochDay(item.date as TradeDate)
      if (day === null) continue
      const tone = toneOf(item.title ?? '')
      const prev = byDay.get(day)
      // 合并：NEG > POS > NEU
      if (prev === 'NEG') continue
      if (tone === 'NEG' || prev === undefined || (prev === 'NEU' && tone === 'POS')) byDay.set(day, tone)
    }
    total += byDay.size
    out.set(raw.code, byDay)
  }
  process.stderr.write(`公告：${out.size} 只 · 合计 ${total} 个公告日
`)
  return out
}

/**
 * 信号那根 K 线的前 `days` 个自然日内有没有公告（含当天）。
 *
 * **挂在信号日而不是成交日**：回测在 D 收盘判定、D+1 开盘成交，
 * 而「公告选股」这套设想是在 D 收盘时已经知道当天的公告。
 * 用成交日去比会整体错开一天，把真正的当日公告算成「前一天的」。
 *
 * ⚠ **这只票根本没抓到公告文件时返回 `null`，不是 `false`。**
 * 抓取是分批、可中断的（261 只要半小时），把「没抓到」和「确认没有公告」
 * 混成同一个值，会让一次跑到一半的抓取悄悄把大批建仓塞进「公告 无」那一层 ——
 * 而表上完全看不出来，读数会全错。null 的建仓**整个退出公告这两层**，
 * 并在日志里报出条数。
 */
function toneAt(
  days: AnnouncementDays,
  code: string,
  signalDate: TradeDate,
  window: number
): Tone | 'NONE' | null {
  const byDay = days.get(code)
  if (!byDay) return null
  const end = toEpochDay(signalDate)
  if (end === null) return null
  let seen: Tone | null = null
  for (let d = end - (window - 1); d <= end; d++) {
    const tone = byDay.get(d)
    if (tone === undefined) continue
    // 窗口内跨多天时同样是 NEG > POS > NEU
    if (tone === 'NEG') return 'NEG'
    if (seen === null || (seen === 'NEU' && tone === 'POS')) seen = tone
  }
  return seen ?? 'NONE'
}

// ── 分层键 ───────────────────────────────────────────────────────────────

/**
 * 得分分档。边界照 §5.20 ⑧ 那张表切（0.75–0.8 打平、≥0.8 是 −1.39%），
 * 换一套边界会让两处数字对不上号。出厂 `scoreThreshold = 0.6`，所以 0.6 以下不该有建仓。
 */
function scoreBand(score: number): string {
  if (score < 0.65) return '0.60-0.65'
  if (score < 0.7) return '0.65-0.70'
  if (score < 0.75) return '0.70-0.75'
  if (score < 0.8) return '0.75-0.80'
  return '≥0.80'
}

/**
 * 子信号组合键：取每个 ID 的首段（`T3_BREAKOUT` → `T3`）、排序、`+` 连接。
 * 与 §5.20 ⑧ 的写法（`T2+T3+T4`）一致 —— 那一节的读数要能直接对上。
 */
function signalKey(ids: readonly string[]): string {
  const shorts = [...new Set(ids.map((id) => id.split('_')[0] ?? id))].sort()
  return shorts.length > 0 ? shorts.join('+') : '(空)'
}

/**
 * regime 持续时长分档 —— 「刚进入」与「走了一段」的分界。
 *
 * 边界取 `1-3 / 4-10 / 11-30 / >30`：`regime.hysteresisDays = 2` 决定了 1–3 根几乎就是
 * 「刚翻转过来」，而 10 根以上已经是一段成形的趋势。
 * 这一档是 §5.20 ⑧ 没量过的**时间维度** —— 子信号组合与得分档都答不了「是不是追高」。
 */
function heldBand(bars: number | null): string | null {
  if (bars === null) return null
  if (bars <= 3) return '1-3 根（刚进入）'
  if (bars <= 10) return '4-10 根'
  if (bars <= 30) return '11-30 根'
  return '>30 根（走了很久）'
}

/** 无论多薄都要打印的层：总体与四个市场状态是全局读数，不受 --min-count 过滤 */
const ALWAYS_SHOWN = new Set<string>(['ALL', ...REGIMES])

/**
 * 一次建仓同时进多个层。交叉层只对 TREND_UP 展开 ——
 * 它是 §5.21 定位到的负 alpha 集中处，其余状态展开只会把表撑大而没有读数。
 */
const TONE_LABEL: Record<Tone | 'NONE', string> = {
  POS: '公告 利好',
  NEG: '公告 利空',
  NEU: '公告 中性',
  NONE: '公告 无',
}

/*
  ── 已知暴露的横截面分位（M2 §5.45，只分层不改交易）─────────────────────

  问的是「我们那点 alpha 是不是某个已知暴露的影子」。两个维度：
  **入场前涨幅**（短期反转 vs 动量）与**流通市值**（小市值/壳价值溢价）。

  三条口径，都是刻意的：

  1. **分位是当日横截面的，不是全样本的。** 绝对市值随大盘漂移八年、绝对涨幅随市况漂移，
     拿全样本分位会把「2018 年的大票」和「2025 年的小票」排到一起。
  2. **在信号那根（`entryIdx − 1`）上算**，与 regime 读取同一根 —— 成交那根的信息
     在决策时还看不到。
  3. **五等分写死**（§5.45 判据 3）。换分桶数重报就是调到好看为止。
*/

/** `Map<key, T[]>` 的 append —— 三个横截面表共用 */
function push<T>(map: Map<TradeDate, T[]>, key: TradeDate, value: T): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** 五等分标签。`rank` 从 0 计，`n` 是当天有数据的标的数 */
function quintile(rank: number, n: number): string | null {
  if (n < 5) return null
  const q = Math.min(4, Math.floor((rank / n) * 5))
  return `Q${q + 1}`
}

/** 逐日横截面排名 → 该标的的五等分档；值缺失的标的整体退出这一维度 */
function crossSectionQuintiles(
  byDate: Map<TradeDate, { code: SecCode; value: number }[]>
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [date, rows] of byDate) {
    const sorted = [...rows].sort((a, b) => a.value - b.value)
    sorted.forEach((row, i) => {
      const q = quintile(i, sorted.length)
      if (q !== null) out.set(`${row.code}@${date}`, q)
    })
  }
  return out
}

function stratumKeysOf(
  p: Position,
  announced: Tone | 'NONE' | null,
  freq: { bucket: string; timeHalf: string; codeHalf: string } | null,
  /** 已知暴露的分位档（§5.45）。每一项为 null = 该建仓在这一维度上没有数据，**退出该维度** */
  exposure: { prior5: string | null; prior20: string | null; floatCap: string | null }
): string[] {
  const band = scoreBand(p.entryScore)
  const sig = signalKey(p.entrySignals)
  const keys = [
    'ALL',
    p.regimeAtEntry,
    `得分 ${band}`,
    `信号 ${sig}`,
  ]
  const held = heldBand(p.barsInRegime)
  if (held !== null) keys.push(`持续 ${held}`)
  if (p.regimeAtEntry === 'TREND_UP') {
    keys.push(`TREND_UP · 得分 ${band}`, `TREND_UP · 信号 ${sig}`)
    if (held !== null) keys.push(`TREND_UP · 持续 ${held}`)
  }
  // 公告维度（仅 --announcements 时）。与 regime 交叉是这次要看的主判据：
  // 「公告筛出来的池子会不会富集在引擎最差的那个状态上」
  if (announced !== null) {
    const tag = TONE_LABEL[announced]
    keys.push(tag, `${p.regimeAtEntry} · ${tag}`)
    // 「有」那一层保留：方向分完之后每桶都很薄，聚合口径仍要能读
    if (announced !== 'NONE') keys.push('公告 有')
  }
  // 股票层面的公告频率（--announce-freq）。四个独立切法是 CLAUDE.md 对
  // 「砍掉一批」类结论的硬要求：砍掉一批已知负 alpha 的交易必然提升剩余部分的 alpha，
  // 那是算术不是发现 —— 只有四个切法都同向才分得开「找对机制」与「删掉任何一批差交易」
  if (freq !== null) {
    keys.push(
      `频率 ${freq.bucket}`,
      `频率 ${freq.bucket} · ${freq.timeHalf}`,
      `频率 ${freq.bucket} · ${freq.codeHalf}`
    )
  }
  // 已知暴露（§5.45）：只加**单维**分层。与 regime 交叉会让每桶掉到 30 笔以下，
  // 而 minCount 会把它们全部滤掉 —— 那不是「没暴露」，是「没样本」，两者不能混
  if (exposure.prior5 !== null) keys.push(`前5日涨幅 ${exposure.prior5}`)
  if (exposure.prior20 !== null) keys.push(`前20日涨幅 ${exposure.prior20}`)
  if (exposure.floatCap !== null) keys.push(`流通市值 ${exposure.floatCap}`)
  return keys
}

// ── 可复现 RNG（mulberry32）──────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── 单次成交模拟（口径与 simulate.ts 逐条对齐）───────────────────────────

interface FillResult {
  deployed: number
  pnl: number
}

/**
 * 在 `entryIdx` 这根的开盘买入、持有 `span` 根后在开盘卖出。
 *
 * `entryIdx` 是**成交**那一根（`simulate.ts` 里 `entryDate = bar.date`，成交价是该根开盘），
 * 所以判定发生在 `entryIdx - 1`。涨跌停的判据也因此拿 `entryIdx - 1` 的收盘算，与 simulate 一致。
 */
function fillTrade(
  series: LoadedSeries,
  entryIdx: number,
  span: number,
  capital: number,
  costs: CostModel
): FillResult | null {
  const candles = series.candles
  const entry = candles[entryIdx]
  const prevClose = candles[entryIdx - 1]?.close
  if (!entry || prevClose === undefined) return null
  if (entry.hasGap === true) return null

  const entryLimits = priceLimits(prevClose, series.profile.board, series.profile.isST)
  // 涨停开盘买不到 —— 不排除的话随机组会白捡一批强势日的入场
  if (entryLimits !== null && entry.open >= entryLimits.limitUp - 0.001) return null

  const fillAdj = buyFill(entry.openAdj, costs)
  const shares = lotsAffordable(capital, fillAdj, costs, series.profile.board)
  if (shares <= 0) return null
  const deployed = shares * fillAdj
  const entryFees = buyFees(deployed, costs, series.profile.board)

  // 卖出：跌停开盘顺延最多 MAX_DEFER_BARS 根，与 simulate.ts 同
  let exitIdx = entryIdx + span
  for (let deferred = 0; deferred <= MAX_DEFER_BARS; deferred++) {
    const bar = candles[exitIdx]
    const before = candles[exitIdx - 1]?.close
    if (!bar || before === undefined) return null
    if (bar.hasGap === true) {
      exitIdx++
      continue
    }
    const limits = priceLimits(before, series.profile.board, series.profile.isST)
    const limitedDown = limits !== null && bar.open <= limits.limitDown + 0.001
    if (!limitedDown) {
      const exitAdj = sellFill(bar.openAdj, costs)
      const amount = shares * exitAdj
      const exitFees = sellFees(amount, costs, series.profile.board)
      return { deployed, pnl: (exitAdj - fillAdj) * shares - entryFees - exitFees }
    }
    exitIdx++
  }
  return null // 连续跌停卖不掉，这次抽样作废
}

// ── 汇总口径 ─────────────────────────────────────────────────────────────

interface Summary {
  count: number
  /** 建仓胜率：pnl > 0 的占比 */
  winRate: number
  /** 仓位加权收益 = Σpnl / Σ本金 —— 与 §5.20 ⑧ 那张表同口径 */
  weightedPnlPct: number
  /**
   * 逐次建仓收益率的**中位数**。
   *
   * 加权收益会被单次极端行情整段带走：实测 `T1+T2+T3+T4` 那 78 次建仓里，
   * SZ002969 一笔 **+325.8%**（2025-12-03 → 2026-01-14，不复权 +375.6%，数据无误），
   * 最赚的 3 笔占总盈亏 **235%** —— 去掉它们加权收益从 +1.90% 翻成 **−2.56%**。
   * 细分层只有几十次建仓，**不给中位数就会把一次妖股读成一个机制**。
   */
  medianPnlPct: number
  netPnl: number
}

function summarize(items: readonly FillResult[]): Summary {
  if (items.length === 0)
    return { count: 0, winRate: 0, weightedPnlPct: 0, medianPnlPct: 0, netPnl: 0 }
  let wins = 0
  let pnl = 0
  let deployed = 0
  const each: number[] = []
  for (const it of items) {
    if (it.pnl > 0) wins++
    pnl += it.pnl
    deployed += it.deployed
    each.push(it.deployed > 0 ? it.pnl / it.deployed : 0)
  }
  each.sort((a, b) => a - b)
  return {
    count: items.length,
    winRate: wins / items.length,
    weightedPnlPct: deployed > 0 ? pnl / deployed : 0,
    medianPnlPct: quantile(each, 0.5),
    netPnl: pnl,
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = sorted[lo]
  const b = sorted[hi]
  if (a === undefined || b === undefined) return NaN
  return a + (b - a) * (pos - lo)
}

/** 真实值在随机分布里的百分位（0..1）。越小说明真实值越差 */
function percentileOf(sorted: readonly number[], value: number): number {
  if (sorted.length === 0) return NaN
  let below = 0
  for (const v of sorted) if (v < value) below++
  return below / sorted.length
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

export interface StratumResult {
  label: string
  real: Summary
  /** 真实入场日 + 被动持有同 span（与随机组结构一致） */
  passive: Summary
  trials: number
  /** 每次试验的仓位加权收益 */
  randomWeighted: number[]
  randomMedian: number[]
  randomWinRate: number[]
  /** 打散跨度模式下「真实入场·被动」的分布（未开启时为空） */
  shufPassiveWeighted: number[]
  shufPassiveMedian: number[]
  /** 每次试验里成功抽到的样本数（涨停/跌停/边界会作废一部分） */
  randomCounts: number[]
}

/**
 * 择时零分布的时间结构（§4.6 / §5.42）。**读任何一个分位之前先看它是哪一档**：
 *
 * | 值 | 含义 | 分位可信度 |
 * |---|---|---|
 * | `INDEPENDENT` | 逐次独立抽日（2026-08-19 之前的唯一口径） | **未调整上界**，偏向显著 |
 * | `BLOCK` | 按建仓月整块位移。**无条件口径下精确**（候选池含每一天 ⇒ 吸附恒 0） | 已做时间聚集调整 |
 * | `REGIME_BLOCK` | 块 = (标的, 一段连续同状态行情)，整段刚性平移到同状态的另一段 —— `--match-regime` 下用它，**吸附恒 0 是结构保证** | 已调整，但要看块覆盖率 |
 *
 * 三档不是「越新越好」而是各管一种候选池：`BLOCK` 在同 regime 下会退化成吸附（§5.36 实测
 * 按分层引入偏置），`REGIME_BLOCK` 在无条件下没有意义（整条序列就是一段）。
 */
export type TimingNull = 'BLOCK' | 'INDEPENDENT' | 'REGIME_BLOCK'

export interface StratumRow {
  label: string
  realCount: number
  realWeightedPnlPct: number
  realWinRate: number
  realNetPnl: number
  /** 真实入场 + 被动持有：入场质量的干净判据（结构与随机组一致） */
  passiveCount: number
  passiveWeightedPnlPct: number
  passiveWinRate: number
  passivePercentile: number
  passiveWinRatePercentile: number
  /** 抗离群：逐次建仓收益率中位数，及其在随机中位数分布里的分位 */
  passiveMedianPnlPct: number
  randomMedianMean: number
  passiveMedianPercentile: number
  /**
   * 打散跨度下的配对读数（未开启 --shuffle-spans 时为 null）。
   * `pairedWinFraction` = 有多少比例的试验里「真实入场」赢过「随机入场」——
   * 同一次试验里两组用**同一个 span 置换**，所以这是一个逐试验配对的直接检验。
   */
  shuffled: {
    passiveWeightedMean: number
    randomWeightedMean: number
    passiveMedianMean: number
    randomMedianMean: number
    /** **加权口径**的配对胜率。窄分层上它会被单笔妖股支配，见下面那条 */
    pairedWinFraction: number
    /**
     * **中位口径**的配对胜率（2026-08-20 加，M2 §5.45）。
     *
     * ⚠ **窄分层上必须两个一起读，背离时以中位为准**（CLAUDE.md 读数纪律 2）。
     * 实测：`流通市值 Q2`（368 次建仓）加权口径 84.5%，而中位口径下两组几乎相同
     * （真实 −0.545% vs 随机 −0.532%）—— 那 84.5% 是一两笔极值撑起来的。
     * 分层越窄，`weightedPnlPct` 越容易被单笔支配（先例：SZ002969 一笔 +325.8%
     * 翻转过整组的符号，§5.21）。
     */
    pairedMedianWinFraction: number
  } | null
  randomWeightedMean: number
  randomWeightedSd: number
  randomWeightedP05: number
  randomWeightedP50: number
  randomWeightedP95: number
  /** 真实值在随机分布里的百分位 0..1。越接近 0 说明真实越差 */
  realPercentile: number
  randomWinRateMean: number
  randomWinRateP05: number
  randomWinRateP95: number
  realWinRatePercentile: number
  randomSampleMean: number
}

export interface RandomAuditPayload {
  meta: {
    baseline: string
    engineVersion: string
    paramsFingerprint: string
    codes: number
    from: TradeDate
    to: TradeDate
    /**
     * **继承基线口径**（2026-08-25 加，计划 §4.9）：每标的资金与成本模型照抄
     * `--baseline` 那份报告的 `meta`，并当场跑一次 `auditKnobs()`。
     *
     * 修的是什么：此前这份 payload 只记 `baseline` 路径 ⇒ 拿一份**非出厂口径**的报告
     * 跑出来的 alpha 报告，在归档里**结构上认不出来**（看板已经因为同一个形状把一份
     * 5× 资金的实验跑当成基线显示了一整天，见 `report.ts` 的 `auditKnobs` 头注释）。
     * **而 alpha 是主判据，错得比基线错更贵。**
     *
     * ⚠ `costs` 为 `undefined` 是「**未记录**」那一档（老基线没有这一列），
     * 不是「等于出厂」—— 判据交给 `auditKnobs`，这里不猜。
     */
    capitalPerCode: number
    costs: CostModel | null
    /** `auditKnobs()` 的结论，随报告一起存档 ⇒ 事后不必再去找那份基线 */
    knobs: { deviations: string[]; unverifiable: string[] }
    trials: number
    seed: number
    matchRegime: boolean
    /** 随机的是**标的**而不是日期（`--cross-code`）。两种口径的零点不同，读报告前先看这一行 */
    crossCode: boolean
    /**
     * 跨票候选池收窄到「当天也有买入方向信号的票」（`--cross-pool <crosssec.json>`）。
     *
     * 它排除的是 §5.27 留下的那个替代解释：跨票随机会抽到当天毫无异动的票，
     * 于是 74.5% 可能只反映「引擎选了活跃的票」而不是「选了会涨的票」。
     * null = 不收窄（口径与 §5.27 逐位相同）。
     */
    crossPool: string | null
    /**
     * 择时零分布的时间结构（2026-08-19，§4.6）。读任何一个**分位**之前先看这一行：
     * `INDEPENDENT` 的分位是**未调整上界**（偏向显著），`BLOCK` 才是调整过的。
     * 跨票口径下恒为 null —— 它固定日期，本来就没有这个病。
     */
    timingNull: TimingNull | null
    /** 为什么是这个结构。降级或换块定义时这里是唯一说得清「为什么」的地方 */
    timingNullReason: string | null
    /** 块数（`BLOCK` 是建仓月 · `REGIME_BLOCK` 是「标的 × 同状态段」）与退回独立抽样的建仓数。退化必须可见 */
    blocks: number | null
    blockFallback: number | null
    /**
     * `REGIME_BLOCK` 的落点权重（§5.43）：`runs` = 先均匀选一段再在段内选（默认，
     * 与「整段交换」的语义一致）· `positions` = 所有落点摊平后均匀选（长段被加权）。
     * **两档不是同一个零点**，跨档比较无效。
     */
    blockWeight: 'runs' | 'positions' | null
    /**
     * 块覆盖率 0..1 = 真的被块结构盖住的建仓占比。
     * **低于 §5.42 预注册的 0.8 时，这一档的分位要按「未调整上界」读** —— 一个只盖住
     * 一半建仓的调整与没调整的差别，读的人必须看得见。
     */
    blockCoverage: number | null
    /**
     * 逐 regime 的覆盖率（只有 `REGIME_BLOCK` 有）。分层报是必须的：块的定义就是状态段，
     * 而不同状态的段长天生不同 ⇒ **某一层覆盖不足时只有那一层要按未调整看待**，
     * 给一个总数会让人把整份报告一起打折或一起采信。
     */
    blockCoverageByRegime: readonly { regime: string; covered: number; total: number }[] | null
    /**
     * 吸附距离（交易根）的中位数与 90 分位。
     *
     * **这是「时间聚集保住了多少」的唯一可检验的量**：块内共用位移 δ，但每个成员要吸附到
     * 自己 `pool` 里最近的合法日。距离小 ⇒ 大家真的落在同一段行情里；
     * 距离大到几十根 ⇒ 这个「块」只剩名义，读分位时要按未调整看待。
     */
    snapMedian: number | null
    snapP90: number | null
    /** 有流通市值数据、因而进了市值分层的建仓数 / 总数（§5.45）。覆盖不全必须可见 */
    capCovered: number | null
    warmup: number
    minCount: number
    positionsTotal: number
    positionsPaired: number
    skipped: number
    regimeSelfCheck: { total: number; hit: number } | null
  }
  strata: StratumRow[]
}

// ── regime 序列（--match-regime 用）──────────────────────────────────────

/**
 * 整条序列一次算完，而不是像 simulate 那样每根切 320 根窗口。
 *
 * 两者对判定根是**等价**的：BBW 分位的 `bbwLookback = 250` 在 320 根窗口里
 * 与整条序列取的是同一段尾随窗口；ADX 是 Wilder 递推，300 根预热之后初值影响已经收敛。
 * 但「等价」是推理不是事实 —— 所以 `--match-regime` 会拿真实建仓的
 * `regimeAtEntry` 做一次自检，对不上就报错退出（与 `audit:subsignals` 同一条纪律）。
 */
function regimeSeries(series: LoadedSeries, params: EngineParams, sentiment: number): Regime[] {
  // 情绪只影响 RSI 阈值、不影响 regime 判定，但 computeIndicators 要它，所以照实给中性值
  const indicators = computeIndicators(series.candles, params, { sentiment, intradayProgress: 1 })
  const classified = classifyRegimes(series.candles, indicators, params)
  return classified.map((r) => r.regime)
}

// ── regime 段块（`REGIME_BLOCK`，§5.42）────────────────────────────────────

/**
 * 块覆盖率的门槛。**预注册在 §5.42 里，不是事后挑的**：覆盖率低于这个数时，
 * 报告要把这一档说成「未调整上界」而不是「已调整」—— 一个只盖住一半建仓的调整
 * 与没调整的差别，读的人必须看得见。
 */
const REGIME_BLOCK_MIN_COVERAGE = 0.8

interface RegimeBlock {
  /** `标的#段号`，只用于报告 */
  key: string
  /** task 下标，按 `entryIdx` 升序 */
  members: number[]
  /** 各成员相对首成员的间距（交易根），与 `members` 同序。**这就是被保留的时间结构** */
  rel: number[]
  /**
   * 合法落点，**按段分组**（一段一个数组）。抽样权重见 `findBases` 头注释与 §5.43：
   * `runs` = 先均匀选一段再在段内选（默认）· `positions` = 摊平后均匀选。
   */
  basesByRun: number[][]
}

/** 极大同状态段（按**成交**下标给闭区间：`regimeAt(i) = seq[i-1]`，判定在成交那根的前一根） */
export interface RegimeRun {
  start: number
  end: number
  regime: Regime
}

/** 把一条 regime 序列切成极大同状态段。`seq` 的下标是判定根 ⇒ 成交下标要 +1 */
export function regimeRuns(seq: readonly Regime[]): RegimeRun[] {
  const runs: RegimeRun[] = []
  for (let i = 0; i < seq.length; i++) {
    const r = seq[i]
    if (r === undefined) continue
    const execIdx = i + 1
    const last = runs[runs.length - 1]
    if (last && last.regime === r && last.end === execIdx - 1) last.end = execIdx
    else runs.push({ start: execIdx, end: execIdx, regime: r })
  }
  return runs
}

/**
 * 找到每个块的合法落点：**整块刚性平移到同一状态的另一段里**。
 *
 * 判据只有一条：候选落点必须让**每个成员都落在它自己的 `pool` 里**（`pool` 已经编码了
 * regime、预热与「跨度 + 顺延不能越过序列末尾」）。于是：
 *
 * - **吸附距离恒 0** —— 不再需要 `nearestInPool`，也就没有 §5.36 那个「吸附方向依赖于
 *   该状态在这只票上的分布 ⇒ 按分层引入偏置」的病；
 * - **块内间距逐位保留** —— 平移是刚性的；
 * - **目标段必须是另一段**（`run !== source`），否则平移量可能小到把成员落回自己身边，
 *   等于什么都没随机。
 *
 * **返回值按段分组**（`number[][]`，一段一个数组）—— 这样抽样时才分得清两种权重：
 * **按段均匀**（先均匀选一段、再在段内选落点，`--block-weight runs`，**默认**）与
 * **按位置均匀**（把所有落点摊平，`positions`，§5.42 那一版的行为）。
 * 两者不是同一个零点：按位置均匀等于用段长给段加权 ⇒ 随机组被推向长段，
 * 而长段的日子平均更赚（RANGE 每次 +0.19pp，§5.42 诊断）。
 * **默认取 `runs` 是语义判据**：block permutation 的语义是**交换块**，
 * 一次抽样 = 「这一簇建仓若发生在**另一段**同状态行情里」，那是按段的一次抽取。
 * 详见 §5.43 的预注册（判据 3：默认口径由语义定，不由分位高低定）。
 *
 * ⚠ **它保住的与放弃的**：保住「同一段行情内部的聚集」，**放弃「跨票同月的同步」**
 * （建仓月块保的是后者）。这是被迫的取舍 —— 同 regime 下每只票有自己的状态时间线，
 * 一个跨票共用的位移根本落不下去（§5.36 实测 85% 的块交集为空）。
 * 所以 `REGIME_BLOCK` 的分位仍然只是「比独立抽日更诚实」，不是「完全正确」。
 */
export function findBases(
  members: readonly number[],
  rel: readonly number[],
  poolSets: readonly Set<number>[],
  runs: readonly RegimeRun[],
  source: RegimeRun
): number[][] {
  const clusterSpan = rel[rel.length - 1] ?? 0
  const byRun: number[][] = []
  for (const run of runs) {
    if (run === source) continue
    if (run.regime !== source.regime) continue
    const bases: number[] = []
    for (let base = run.start; base + clusterSpan <= run.end; base++) {
      let ok = true
      for (let j = 0; j < members.length; j++) {
        const set = poolSets[j]
        if (!set || !set.has(base + (rel[j] ?? 0))) {
          ok = false
          break
        }
      }
      if (ok) bases.push(base)
    }
    if (bases.length > 0) byRun.push(bases)
  }
  return byRun
}

// ── 主流程 ───────────────────────────────────────────────────────────────

interface Options {
  baseline: string
  fixtures?: string
  db?: string
  trials: number
  seed: number
  matchRegime: boolean
  /**
   * 打散跨度：每次试验把 span 在全部建仓之间随机置换，**真实组与随机组用同一个置换**。
   *
   * 为什么需要它：`holdingBars` 是内生的 —— 跌得快的被止损在 8 根、涨上去的被拖到 15 根。
   * 于是「真实入场 + 原 span」这一列里，短 span 天然配着下跌，而随机组的短 span 配的是
   * 随机结果。**这会凭空放大真实组的负 alpha**，中位数口径上尤其严重。
   * 打散之后 span 与结果解耦，两组的 span 分布仍然一致，剩下的差异才是入场质量。
   */
  shuffleSpans: boolean
  /**
   * **跨票随机**：固定入场日期，随机换一只**别的票**（默认是反过来 —— 固定票、随机换日子）。
   *
   * ## 为什么需要它：默认口径有一个测不到的维度
   *
   * 默认的随机基准在**同一只票内**抽日子，于是**这只票本身的涨跌在两组之间被抵消掉了**。
   * 它回答的是「同样这批票，点选得好不好」（择时），**答不了「该不该选这批票」**（选股）。
   *
   * 这个盲区是实测撞出来的（[M2 §5.26 ⑥](../../docs/notes/M2-偏差报告.md)）：
   * 补进 19 只退市股之后**绝对绩效变差**（−0.13pp）而默认口径的配对胜率反而**上升 8pp**，
   * 两个种子一致。原因就是「选到一只烂票」这件事默认口径根本看不见 ——
   * 在一只跌到退市的票上随机入场几乎必亏，引擎至少挑得出几个反弹点，于是相对优势反而变大。
   *
   * 跨票口径把这个维度换过来：**日期对齐（市场 beta 对齐），变的是选了哪只票**。
   * 两个口径合起来才拆得开「择时」与「选股」。
   *
   * ## 三条实现纪律
   *
   * 1. **排除同一只票**，否则那次抽样退化成「真实入场」本身，会把分位往 50% 拽。
   * 2. **候选是那一天有 K 线的票**（停牌、尚未上市、已退市的当天没有行，自然出局）——
   *    不需要额外过滤，`date → idx` 查不到就换一只。
   * 3. **与 `--match-regime` 互斥**：那一档限定「同状态的日子」，而这里日期是固定的，
   *    两者的零点定义不同，混在一起会产出一个说不清是什么的数。
   */
  crossCode: boolean
  crossPool: string | null
  /**
   * 择时零分布的**时间结构**（2026-08-19，迭代计划 §4.6）。
   *
   * ## 为什么默认不再是 INDEPENDENT
   *
   * 旧口径给每一次真实建仓**独立**抽一个随机日。但真实建仓**不是独立发生的** ——
   * 引擎在同一段行情里成批出手（同一个月里几十次建仓共享那段市场涨跌）。
   * 独立抽日把这种聚集打散了，于是随机组每一次试验的组合收益是几百个近似独立样本的平均，
   * **零分布的方差被系统性压小** ⇒ 真实值落在尾部的机会被高估 ⇒ **分位偏向显著**。
   *
   * ## BLOCK 怎么修
   *
   * 按**建仓月**分块，每块**共用一个位移 δ**（单位：交易根）。同一个月里的那几十次建仓
   * 于是整体被平移到另一段行情里，**块内的时间聚集原样保留**。
   * δ 从「块内每一次建仓都合法」的位移集合里抽 —— 因此 `--match-regime` 仍然成立
   * （`pool` 已经编码了状态过滤，取交集即可）。
   *
   * 交集为空的块**退回独立抽样**并计数报出（`blockFallback`）：静默退化会让
   * 「已调整」这句话变成假话，而那正是这次要修的病。
   *
   * ## 一处仍然近似
   *
   * δ 是**交易根**位移，而不同标的的停牌日不同 ⇒ 同一个 δ 在两只票上对应的日历日
   * 可能差几天。这个偏差远小于「把聚集整个打散」，但它在，别写成「完全保留」。
   *
   * ⚠ 跨票口径（`--cross-code`）**不需要这个修**：它固定日期只换标的，
   * 真实建仓的时间结构原样在那儿 —— §4.6 里那处「歪打正着躲过了」说的就是它。
   */
  timingNull: 'BLOCK' | 'INDEPENDENT'
  /**
   * `REGIME_BLOCK` 下落点的抽样权重（§5.43）。`runs`（默认）= 先均匀选一段再在段内选，
   * 与「整段交换」的语义一致；`positions` = 所有落点摊平后均匀选（§5.42 那一版），
   * 它用段长给段加权 ⇒ 随机组被推向长段。**两档不是同一个零点。**
   */
  blockWeight: 'runs' | 'positions'
  warmup: number
  minCount: number
  /**
   * 历史公告目录（`scripts/fetch-announcements.mjs` 的产物）。给了它就多出
   * 「公告 有/无」以及它与四个 regime 的交叉层。
   *
   * **这是一次只读的分层，不改变任何一笔交易** —— 两组从同一次模拟里切出来，
   * 各自配自己的随机基准，所以「公告日建仓」与「非公告日建仓」直接可比。
   */
  announcements?: string
  /**
   * 公告窗口（自然日，默认 1 = 只看信号那一天）。
   *
   * 判据挂在**信号那根 K 线的日期**上，不是成交日 —— 成交在次日开盘，
   * 拿成交日去比公告日会把「公告发布后次日才成交」这件事算错一天。
   */
  announceDays: number
  /**
   * 流通市值目录（`fetch-liquidity.mjs` 的产物，`data/liquidity-em/`）。给了它就多出
   * 「流通市值 Q1–Q5」这一维分层（§5.45）。**只分层，不改交易**。
   *
   * ⚠ 那份数据的 `floatShares` 是**逐月采样**反推的（东财 `f61` 换手率），
   * 日度市值 = 该月股本 × 当日不复权价 ⇒ 月内粒度粗；但它**不是**「今日股本回推历史」
   * 那个已被否的未来函数（信源台账 §2）。覆盖不到的建仓会被计数报出来。
   */
  liquidity?: string
  /**
   * 按**股票层面**的公告年频率分四桶（Q1 最少 … Q4 最多），并交叉时间/代码前后半。
   *
   * ⚠ 与 `--announcements` 的分层**问的不是同一个问题**：那个是「这次建仓前有没有公告」
   * （时点属性），这个是「这只票爱不爱发公告」（股票属性）。混着读会把两者当成一回事。
   *
   * 频率口径是**公告日数 ÷ 该股自己的 K 线年数**，不是除以固定年限 ——
   * 晚上市的票分子天然小，除固定年限会同时压低它的频率与建仓数，制造出虚假相关。
   */
  announceFreq: boolean
  out?: string
  json: boolean
}

const USAGE = `用法：
  pnpm audit:random -- --baseline <report.json> --fixtures ./data/history [选项]

必需：
  --baseline <file>      真实回测报告（含 trades），随机组按它逐次配对

数据来源（二选一）：
  --fixtures <dir>       从 <dir>/<CODE>.json 读日线
  --db <file>            market.db 路径

选项：
  --trials <n>           随机试验次数，默认 200
  --seed <n>             RNG 种子，默认 1（可复现是硬要求）
  --match-regime         随机入场日限定在与真实建仓相同的市场状态里
                         （慢很多：要为每只票重算一遍 regime 序列）
  --shuffle-spans        每次试验把持仓跨度在建仓之间随机置换（两组用同一置换）。
                         用来剥掉 holdingBars 的内生性 —— 不加这个开关，
                         真实组的负 alpha 会被「短跨度天然配着下跌」放大
  --cross-code           **跨票随机**：固定入场日期，随机换一只别的票（默认是固定票、换日子）。
                         默认口径在同一只票内抽样 ⇒ 票本身的涨跌被抵消 ⇒ 测的是「择时」；
                         这一档日期对齐、变的是标的 ⇒ 测的是「选股」。两个口径合起来才拆得开。
                         与 --match-regime 互斥（零点定义不同）
  --independent-days     择时零分布退回**逐次独立抽日**（2026-08-19 之前的口径）。
                         默认是**按建仓月整块位移**（block permutation）：真实建仓成批发生，
                         独立抽日会打散这种时间聚集 ⇒ 零分布方差偏小 ⇒ 分位偏向显著。
                         ⚠ **与 --match-regime 同用时换成 regime 段块**（§5.42）：块 = (标的,
                         一段连续同状态行情)，整段刚性平移到同状态的另一段 ⇒ 吸附恒 0。
                         2026-08-19 之前那一档是「降级回独立抽日」，理由是建仓月块在同 regime 下
                         只能靠吸附落地（中位 11 / P90 116 根）、按分层引入偏置。
                         报告头会印块数、**覆盖率**与逐层覆盖率；覆盖率低于 80%（预注册门槛）
                         时那一档仍按「未调整上界」读
  --cross-pool <file>    **收窄跨票候选池**到「当天也有买入方向信号的票」
                         （pnpm audit:crosssec --out 的产物）。只与 --cross-code 同用。
                         排除「抽到当天毫无异动的票」这个替代解释（M2 §5.27 读法 2）。
                         同时**只保留当天确有其他候选的建仓** —— 否则两组比的不是同一批
  --block-weight <档>    regime 段块的落点权重（只在 --match-regime 下有意义，§5.43）：
                         runs（默认）先均匀选一段同状态行情、再在段内选落点，与「整段交换」
                         的语义一致；positions 把所有合法落点摊平后均匀选 —— 那等于用段长
                         给段加权，随机组会被推向长段（实测长段的日子平均更赚）。
                         **两档不是同一个零点，数字不可互相替代**
  --warmup <根>          随机入场日的最早位置，默认 300（= params.data.fullBars）
  --min-count <n>        细分层的最小建仓数，低于它不打印，默认 30
  --announcements <dir>  历史公告目录（fetch-announcements.mjs 的产物）。给了它就多出
                         「公告 有/无」及其与四个 regime 的交叉层。**只分层，不改交易**
  --liquidity <dir>      流通市值目录（fetch-liquidity.mjs 的产物）。给了它就多出
                         「流通市值 Q1–Q5」一维分层（当日横截面五等分，§5.45）。
                         **只分层，不改交易**；覆盖不到的建仓会被计数报出来
  --announce-days <n>    公告窗口（自然日，含信号当天），默认 1
  --announce-freq        按**股票层面**公告年频率分四桶（控制上市时长），并交叉时间/代码前后半。
                         与 --announce-days 问的不是同一个问题：那个是时点，这个是股票属性
                         （总体与四个市场状态不受此过滤）
  --out <file>           JSON 落盘
  --json                 只输出 JSON
`

function parse(argv: readonly string[]): Options | 'help' {
  const o: Options = {
    baseline: '',
    trials: 200,
    seed: 1,
    matchRegime: false,
    shuffleSpans: false,
    crossCode: false,
    crossPool: null,
    timingNull: 'BLOCK',
    blockWeight: 'runs',
    warmup: 300,
    minCount: 30,
    announceDays: 1,
    announceFreq: false,
    json: false,
  }
  const flags = new Set([
    '--match-regime',
    '--shuffle-spans',
    '--cross-code',
    '--independent-days',
    '--announce-freq',
    '--json',
    '--help',
    '-h',
  ])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === undefined || key === '--') continue
    const next = flags.has(key) ? undefined : argv[i + 1]
    if (!flags.has(key)) i++
    const need = (): string => {
      if (next === undefined) throw new Error(`${key} 缺少取值`)
      return next
    }
    switch (key) {
      case '--help':
      case '-h':
        return 'help'
      case '--baseline':
        o.baseline = need()
        break
      case '--fixtures':
        o.fixtures = need()
        break
      case '--db':
        o.db = need()
        break
      case '--trials':
        o.trials = Number(need())
        break
      case '--seed':
        o.seed = Number(need())
        break
      case '--warmup':
        o.warmup = Number(need())
        break
      case '--min-count':
        o.minCount = Number(need())
        break
      case '--announcements':
        o.announcements = need()
        break
      case '--liquidity':
        o.liquidity = need()
        break
      case '--announce-days':
        o.announceDays = Number(need())
        break
      case '--announce-freq':
        o.announceFreq = true
        break
      case '--match-regime':
        o.matchRegime = true
        break
      case '--shuffle-spans':
        o.shuffleSpans = true
        break
      case '--cross-pool':
        o.crossPool = need()
        break
      case '--cross-code':
        o.crossCode = true
        break
      case '--block-weight': {
        const v = need()
        if (v !== 'runs' && v !== 'positions') {
          throw new Error(`--block-weight 只能是 runs 或 positions，收到 ${v}`)
        }
        o.blockWeight = v
        break
      }
      case '--independent-days':
        o.timingNull = 'INDEPENDENT'
        break
      case '--out':
        o.out = need()
        break
      case '--json':
        o.json = true
        break
      default:
        throw new Error(`无法识别的参数：${key}`)
    }
  }
  if (!o.baseline) throw new Error('必须用 --baseline 指定真实回测报告')
  if (!o.fixtures && !o.db) throw new Error('必须给 --fixtures 或 --db')
  if (!Number.isInteger(o.trials) || o.trials < 1) throw new Error('--trials 必须是 ≥ 1 的整数')
  // 互斥而不是「后者覆盖前者」：两档的零点定义不同（一个换日子、一个换标的），
  // 静默取其一会产出一份看不出是哪种口径的报告，而报告是要写进偏差报告的
  if (o.crossPool !== null && !o.crossCode) {
    throw new Error('--cross-pool 只在 --cross-code 下有意义：它收窄的是「换哪只标的」的候选池')
  }
  if (o.crossCode && o.matchRegime) {
    throw new Error(
      '--cross-code 与 --match-regime 互斥：前者固定日期换标的，后者固定标的换日期（且限定同状态），零点不是同一个'
    )
  }
  return o
}

export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv)
  if (parsed === 'help') {
    process.stdout.write(USAGE)
    return 0
  }
  const opts = parsed
  const report = JSON.parse(readFileSync(opts.baseline, 'utf8')) as BaselineReport
  const positions = groupPositions(report.trades)
  // 只读分层的输入。未给 --announcements 时为 null ⇒ 公告那两层根本不出现，
  // 而不是「全部落进『公告 无』」（后者会让读表的人以为数据加载了但一条都没命中）
  const announceDays = opts.announcements === undefined ? null : loadAnnouncements(opts.announcements)
  const capital = report.meta.capitalPerCode
  /*
    **成本模型继承基线**（2026-08-25，计划 §4.9）。以前这里写死 `DEFAULT_COSTS`，
    而真实那一臂的 `pnl` 是**基线报告按它自己的成本模型**算出来的 ⇒ 拿一份
    `--slippage 0` 的基线跑 alpha，真实臂不付滑点、随机臂付 10 bp，
    **差价被算进了 alpha**（方向固定：让真实组看起来更好）。滑点占负期望 69%（§5.29），
    所以这不是一个小口子。

    基线没记 `costs`（2026-08-20 之前的报告）时只能退回出厂值 —— 但那一档由
    `auditKnobs` 报成「**无法核对**」并打进 payload，不许静默当成「等于出厂」。
  */
  const baselineKnobs = auditKnobs({
    capitalPerCode: report.meta.capitalPerCode,
    paramsFingerprint: report.meta.paramsFingerprint,
    costs: report.meta.costs,
  })
  const costs: CostModel = report.meta.costs ?? DEFAULT_COSTS

  const source: DataSource = opts.fixtures
    ? openFixtureSource(opts.fixtures, { from: report.meta.from, to: report.meta.to })
    : await openSqliteSource(opts.db ?? '', { from: report.meta.from, to: report.meta.to })

  // ① 载入所有涉及的标的，并建立「日期 → 下标」索引
  //
  // 默认口径只需要「建过仓的票」（随机在同一只票内换日子）。
  // **跨票口径必须把整个标的池都载进来**：候选若只有建过仓的那些，
  // 随机组就只能从「引擎至少看上过一次的票」里挑 —— 那已经被引擎筛过一轮，
  // 拿它当零点会系统性**低估**选股 alpha。基线报告的 `meta.codes` 才是完整的池。
  const codes = [
    ...new Set([...positions.map((p) => p.code), ...(opts.crossCode ? report.meta.codes : [])]),
  ].map((c) => normalizeCode(c))
  const loaded = new Map<SecCode, { series: LoadedSeries; index: Map<TradeDate, number> }>()
  for (const code of codes) {
    const series = source.load(code)
    if (!series) continue
    const index = new Map<TradeDate, number>()
    series.candles.forEach((c, i) => index.set(c.date, i))
    loaded.set(code, { series, index })
  }
  source.close()

  // 随机基准对着出厂参数的那次基线跑，不接受参数覆盖 —— 换参数就该重出基线报告
  const params: EngineParams = DEFAULT_PARAMS

  // ② regime 序列（仅 --match-regime）+ 自检
  const regimes = new Map<SecCode, Regime[]>()
  let checkTotal = 0
  let checkHit = 0
  if (opts.matchRegime) {
    process.stderr.write(`计算 regime 序列（${loaded.size} 只）…\n`)
    for (const [code, entry] of loaded) {
      regimes.set(code, regimeSeries(entry.series, params, 0.5))
    }
    for (const p of positions) {
      const code = normalizeCode(p.code)
      const entry = loaded.get(code)
      const seq = regimes.get(code)
      if (!entry || !seq) continue
      const idx = entry.index.get(p.entryDate)
      if (idx === undefined || idx < 1) continue
      // 判定发生在成交那根的**前**一根
      const got = seq[idx - 1]
      if (got === undefined) continue
      checkTotal++
      if (got === p.regimeAtEntry) checkHit++
    }
    const rate = checkTotal > 0 ? checkHit / checkTotal : 0
    process.stderr.write(
      `regime 自检：${checkHit}/${checkTotal} = ${(rate * 100).toFixed(2)}% 与报告一致\n`
    )
    if (rate < 0.95) {
      process.stderr.write(
        `❌ 自检未过（< 95%）。整条序列算出来的 regime 与 simulate 的 320 根窗口口径不等价，\n` +
          `   同 regime 抽样会抽错状态 —— 拒绝出数，先查口径。\n`
      )
      return 3
    }
  }

  // ③ 逐建仓准备候选入场日
  interface Task {
    position: Position
    code: SecCode
    span: number
    /** 真实成交那一根的下标 —— 打散跨度模式要用它重算被动持有 */
    entryIdx: number
    /** 合格的随机入场下标 */
    pool: number[]
    real: FillResult
    /**
     * 真实入场日 + **被动持有**同样根数（不走任何风控离场）。
     *
     * 这一档才是入场质量的干净判据：它与随机组**结构完全一致**（一买一卖、同 span、
     * 同成本模型），唯一差别就是入场日选自信号还是选自骰子。
     * 而 `real` 那一档混着风控离场（回撤减仓把一次建仓拆成两三笔），
     * 拿它直接和随机比，会分不清「点选得差」还是「离场规则差」。
     */
    passive: FillResult | null
    /**
     * 信号那根 K 线上的公告方向。`NONE` = 当天没有公告；
     * `null` = 这只票没有公告数据（**退出该维度**，不是「没有公告」）。
     */
    announced: Tone | 'NONE' | null
    /** 股票层面的公告频率桶（'Q1'..'Q4'）。未开 --announce-freq 时为 null */
    freqBucket: string | null
    /** 时间前/后半（按建仓日在全部建仓里的中位数切）与代码前/后半 —— 稳定性检验用 */
    timeHalf: string | null
    codeHalf: string | null
  }
  /*
    股票层面的公告年频率（--announce-freq）。
    **口径是「公告日数 ÷ 该股自己的 K 线年数」**，不是除以固定年限 ——
    晚上市的票分子天然小，除固定年限会同时压低它的频率与建仓数，制造出虚假正相关。
  */
  const freqOf = new Map<string, string>()
  const timeHalfOf = new Map<string, string>()
  const codeHalfOf = new Map<string, string>()
  if (opts.announceFreq) {
    if (announceDays === null) throw new Error('--announce-freq 需要同时给 --announcements')
    const rows: { code: string; freq: number }[] = []
    for (const p of positions) {
      if (freqOf.has(p.code)) continue
      const byDay = announceDays.get(p.code)
      const entry = loaded.get(normalizeCode(p.code))
      if (!byDay || !entry) continue
      const years = entry.series.candles.length / 242
      if (years <= 0) continue
      freqOf.set(p.code, '')
      rows.push({ code: p.code, freq: byDay.size / years })
    }
    rows.sort((a, b) => a.freq - b.freq)
    const q = Math.max(1, Math.floor(rows.length / 4))
    rows.forEach((r, i) => freqOf.set(r.code, `Q${Math.min(4, Math.floor(i / q) + 1)}`))
    // 代码前/后半：按代码字典序切，与频率无关的一刀
    const codesSorted = rows.map((r) => r.code).sort()
    codesSorted.forEach((c, i) =>
      codeHalfOf.set(c, i < codesSorted.length / 2 ? '代码前半' : '代码后半')
    )
    // 时间前/后半：按建仓日的中位数切
    const dates = positions.map((p) => p.entryDate).sort()
    const mid = dates[Math.floor(dates.length / 2)] ?? ''
    for (const p of positions) timeHalfOf.set(`${p.code}@${p.entryDate}`, p.entryDate < mid ? '时间前半' : '时间后半')
    process.stderr.write(
      `公告频率分桶：${rows.length} 只 · Q1 ${rows[0]?.freq.toFixed(1)} ~ Q4 ${rows[rows.length - 1]?.freq.toFixed(1)} 公告日/年
`
    )
  }

  const tasks: Task[] = []
  const skipped: string[] = []
  /** 没有公告文件、因而退出公告分层的建仓数。必须报出来，见 hasAnnouncement */
  let missingAnnouncements = 0
  for (const p of positions) {
    const code = normalizeCode(p.code)
    const entry = loaded.get(code)
    if (!entry) {
      skipped.push(`${p.code}: 无日线`)
      continue
    }
    const entryIdx = entry.index.get(p.entryDate)
    const exitIdx = entry.index.get(p.exitDate)
    if (entryIdx === undefined || exitIdx === undefined) {
      skipped.push(`${p.code}@${p.entryDate}: 日期不在序列里`)
      continue
    }
    const span = exitIdx - entryIdx
    if (span < 1) {
      skipped.push(`${p.code}@${p.entryDate}: 跨度 < 1`)
      continue
    }
    const n = entry.series.candles.length
    const wantRegime = opts.matchRegime ? p.regimeAtEntry : null
    const seq = regimes.get(code)
    const pool: number[] = []
    for (let i = Math.max(1, opts.warmup); i + span + MAX_DEFER_BARS < n; i++) {
      if (wantRegime !== null) {
        const r = seq?.[i - 1]
        if (r !== wantRegime) continue
      }
      pool.push(i)
    }
    if (pool.length === 0) {
      skipped.push(`${p.code}@${p.entryDate}: 无合格随机入场日`)
      continue
    }
    // 信号那根 = 成交那根的前一根（次日开盘成交）。第 0 根没有前一根，按「无公告」处理
    const signalBar = entry.series.candles[entryIdx - 1]
    const announced =
      announceDays === null || signalBar === undefined
        ? null
        : toneAt(announceDays, p.code, signalBar.date as TradeDate, opts.announceDays)
    if (announceDays !== null && announced === null) missingAnnouncements++

    tasks.push({
      position: p,
      code,
      span,
      entryIdx,
      pool,
      real: { deployed: p.deployed, pnl: p.pnl },
      passive: fillTrade(entry.series, entryIdx, span, capital, costs),
      announced,
      freqBucket: freqOf.get(p.code) ?? null,
      timeHalf: timeHalfOf.get(`${p.code}@${p.entryDate}`) ?? null,
      codeHalf: codeHalfOf.get(p.code) ?? null,
    })
  }

  if (announceDays !== null) {
    const covered = tasks.filter((t) => t.announced !== null).length
    const n = (tone: Tone | 'NONE'): number => tasks.filter((t) => t.announced === tone).length
    process.stderr.write(
      `公告分层：${covered}/${tasks.length} 次建仓有公告数据 · ` +
        `利好 ${n('POS')} · 利空 ${n('NEG')} · 中性 ${n('NEU')} · 无 ${n('NONE')}` +
        (missingAnnouncements > 0 ? ` · ⚠ ${missingAnnouncements} 次因缺公告文件退出该分层` : '') +
        `
`
    )
  }

  // 跨票模式的候选池。「日期 → 下标」直接用 `loaded` 里已经建好的 `index`，不另造一份 ——
  // 两份索引迟早会分叉，而分叉之后「随机组抽到的是哪一根」就再也说不清了
  const crossPool: SecCode[] = opts.crossCode ? [...loaded.keys()] : []
  if (opts.crossCode) {
    process.stderr.write(
      `跨票随机：候选标的 ${crossPool.length} 只（固定入场日期，随机换标的；含从未建仓的票）\n`
    )
  }

  /*
    `--cross-pool`：把跨票候选池按**执行日**收窄到「上一根给出买入方向信号」的票。

    索引按**每只票自己的序列**推执行日（`signalIdx + 1`），不按市场日历 ——
    停牌会让同一个信号日对应到不同的执行日，用统一日历会把那些票错配进别的一天。
    这与 `simulate.ts` 的「D 收盘判定、D+1 开盘成交」逐条对齐。

    ⚠ 同时**只保留当天确有其他候选的建仓**（下面 `tasks` 的过滤）：
    单信号日上随机组抽不出对手，若真实组还留着，两侧比的就不是同一批建仓 ——
    而「配对」是这个工具全部可信度的来源。
  */
  const poolByExecDate = new Map<TradeDate, SecCode[]>()
  if (opts.crossPool !== null) {
    const parsedPool: unknown = JSON.parse(readFileSync(opts.crossPool, 'utf8'))
    const byDate = (parsedPool as { byDate?: Record<string, { signaled?: string[] }> }).byDate
    if (!byDate) throw new Error(`--cross-pool 文件里没有 byDate：${opts.crossPool}`)
    let placed = 0
    for (const [signalDate, entry] of Object.entries(byDate)) {
      for (const raw of entry.signaled ?? []) {
        const code = normalizeCode(raw)
        const series = loaded.get(code)
        if (!series) continue
        const idx = series.index.get(signalDate as TradeDate)
        if (idx === undefined) continue
        const execDate = series.series.candles[idx + 1]?.date
        if (execDate === undefined) continue
        const bucket = poolByExecDate.get(execDate) ?? []
        bucket.push(code)
        poolByExecDate.set(execDate, bucket)
        placed++
      }
    }
    process.stderr.write(
      `候选池已收窄：${poolByExecDate.size} 个执行日、${placed} 个「当天也有买入信号」的候选`.concat('\n')
    )

    /*
      单信号日的建仓要整条摘掉 —— 那天随机组抽不出对手（池里只有自己），
      若真实组还留着，两侧就不是同一批建仓，而「配对」是这个工具全部可信度的来源。
      摘掉多少必须报出来：它本身就是一个结论（有多少次建仓当时根本没有横截面选择）。
    */
    const before = tasks.length
    const usable = tasks.filter((t) =>
      (poolByExecDate.get(t.position.entryDate) ?? []).some((code) => code !== t.code)
    )
    tasks.length = 0
    tasks.push(...usable)
    process.stderr.write(
      `单信号日摘除：${before - tasks.length} / ${before} 次建仓当天没有其他候选，余 ${tasks.length} 次进配对`.concat(
        '\n'
      )
    )
  }

  /*
    ③b 择时零分布的**块**（迭代计划 §4.6）。

    块 = 建仓月。同一块里的所有建仓共用一个位移 δ（交易根），于是那一批建仓被整体
    平移到另一段行情里、**块内的时间聚集原样保留** —— 而独立抽日会把它打散，
    让零分布的方差偏小、分位偏向显著。

    δ 的候选是「块内每一次建仓都合法」的位移，也就是各成员 `pool` 位移集合的**交集**。
    `pool` 里已经编码了 `--match-regime` 与边界约束，所以取交集这一步同时把两者带上了。
    交集为空 ⇒ 该块退回独立抽样，并计数报出（静默退化会让「已调整」变成假话）。
  */
  interface Block {
    key: string
    members: number[]
    offsets: number[]
  }
  const blocks: Block[] = []
  /** task 下标 → 它所属块在 `blocks` 里的下标 */
  const blockOfTask = new Map<number, number>()
  let blockFallback = 0
  /*
    ⚠ **`--match-regime` 下自动降级回独立抽样**（2026-08-19 实测后加的硬规则）。

    块位移只在「每只票每天都是合法候选」时才是精确的：那时块内共用的 δ 对每个成员都成立，
    吸附距离恒为 0。`--match-regime` 把 `pool` 收窄成「同状态的那些天」之后池变得稀疏，
    共用 δ 要靠吸附才落得下去 —— 实测吸附距离**中位 11 根 / P90 116 根**，
    块内的同步性已经名存实亡，而吸附方向依赖于该状态在这只票上的分布 ⇒ **按分层引入偏置**。

    三种子实测（同一份基线、同样 200 次试验、配对胜率）：

    | 口径 | 独立抽日 | 块位移 |
    |---|---|---|
    | 无 regime 匹配（吸附恒 0，块位移**精确**） | ALL 46.5 · TREND_UP 36.7 · RANGE 76.0 · TRANSITION 24.7 | ALL 55.5 · TREND_UP 43.2 · RANGE 73.2 · TRANSITION 38.5 |
    | 同 regime（吸附 中位 11 / P90 116） | ALL 46.7 · TREND_UP 69.2 · RANGE 62.8 · TRANSITION 22.3 | ALL 42.8 · **TREND_UP 90.8** · **RANGE 22.3** · TRANSITION 39.0 |

    精确那一行的改动是 +7 ~ +14pp、方向一致（都朝 50% 走 = 旧零分布太紧）；
    吸附那一行是 +22 / **−40**、方向相反 —— 两者唯一的结构差别就是吸附。
    ⇒ 那些摆动是**吸附的假象**，不是「块结构揭示了真实的小样本」。

    所以这里不硬撑：降级，并把「同 regime 的分位仍是未调整上界」写进报告。
    **假装调整过比不调整更坏** —— 后者至少是可见的。
  */
  let timingNullReason: string | null = null
  let effectiveTimingNull: TimingNull = opts.timingNull
  if (!opts.crossCode && opts.timingNull === 'BLOCK' && opts.matchRegime) {
    /*
      2026-08-19 第二版（M2 §5.42 的预注册）：**不再降级回独立抽日，改用 regime 段块**。

      上面那段说清了为什么「建仓月 + 吸附」在这一档不成立。修法不是把吸附调松，
      而是换块的定义：块 = **(标的, 一段连续同状态行情)**，整块刚性平移到**同一状态的另一段**里。
      于是 regime 约束由「目标段本身就是那个状态」保证 ⇒ **吸附距离恒 0 是结构性的**，
      不再是一个需要实测的量。代价见 `buildRegimeBlocks` 头注释（放弃跨票同月的同步）。
    */
    effectiveTimingNull = 'REGIME_BLOCK'
    timingNullReason =
      '--match-regime 下改用 regime 段块（块 = 一段连续同状态行情，整段刚性平移，吸附恒 0，§5.42）'
  }
  if (!opts.crossCode && effectiveTimingNull === 'BLOCK') {
    const byMonth = new Map<string, number[]>()
    tasks.forEach((t, i) => {
      const key = t.position.entryDate.slice(0, 7)
      const list = byMonth.get(key)
      if (list) list.push(i)
      else byMonth.set(key, [i])
    })
    for (const [key, members] of [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      /*
        δ 的候选取成员位移集合的**并集**，不是交集。

        交集试过一次，是**退化的**：`--match-regime` 下每只票的 `pool` 只含它自己的
        同状态日，一个月里几十只票要凑出一个人人合法的位移几乎不可能 ——
        实测 1675 次建仓里 **1426 次（85%）** 的块交集为空、只好退回独立抽样，
        等于这个修根本没生效，而报告还会写着「已调整」。
        并集 + 逐成员**吸附到最近的合法日**能永远成立：块内共用同一个 δ ⇒ 大家朝同一个
        方向平移 ⇒ 时间聚集保住；吸附只在各自的 `pool` 内部找，所以 regime 过滤与边界
        约束一条都没松。代价是吸附距离，那个距离下面会逐轮统计并报出来。
      */
      const union = new Set<number>()
      for (const i of members) {
        const t = tasks[i]
        if (!t) continue
        for (const idx of t.pool) union.add(idx - t.entryIdx)
      }
      // δ = 0 是真实入场本身，留着等于把「真实」当成随机样本，会把分位往 50% 拽
      union.delete(0)
      if (union.size === 0) {
        blockFallback += members.length
        continue
      }
      const b = blocks.length
      blocks.push({ key, members, offsets: [...union].sort((a, b) => a - b) })
      for (const i of members) blockOfTask.set(i, b)
    }
    process.stderr.write(
      `择时零分布：按建仓月整块位移 · ${blocks.length} 块 · ` +
        `覆盖 ${tasks.length - blockFallback}/${tasks.length} 次建仓` +
        (blockFallback > 0 ? `（⚠ ${blockFallback} 次无可用位移，退回独立抽样）` : '') +
        '\n'
    )
  }

  /*
    ③c `REGIME_BLOCK`：块 = (标的, 一段连续同状态行情)，整段刚性平移到同状态的另一段。
    做法与取舍在 `findBases` 头注释里，判据与预测在 M2 §5.42（**写在跑之前**）。
  */
  const regimeBlocks: RegimeBlock[] = []
  /** task 下标 → [块下标, 在块内的相对位移] */
  const regimeBlockOfTask = new Map<number, { block: number; rel: number }>()
  /** 逐层覆盖率：某一层覆盖不足时**只有那一层**要按未调整看待，所以要分层数 */
  const regimeBlockCoverByStratum = new Map<string, { covered: number; total: number }>()
  if (effectiveTimingNull === 'REGIME_BLOCK') {
    const runsByCode = new Map<SecCode, RegimeRun[]>()
    for (const [code, seq] of regimes) runsByCode.set(code, regimeRuns(seq))
    /** `标的#段号` → task 下标 */
    const byRun = new Map<string, number[]>()
    const runIndexOf = new Map<number, number>()
    tasks.forEach((t, i) => {
      const runs = runsByCode.get(t.code)
      if (!runs) return
      const idx = runs.findIndex((r) => t.entryIdx >= r.start && t.entryIdx <= r.end)
      if (idx < 0) return
      runIndexOf.set(i, idx)
      const key = `${t.code}#${idx}`
      const list = byRun.get(key)
      if (list) list.push(i)
      else byRun.set(key, [i])
    })
    for (const [key, rawMembers] of byRun) {
      const members = [...rawMembers].sort((a, b) => (tasks[a]?.entryIdx ?? 0) - (tasks[b]?.entryIdx ?? 0))
      const head = tasks[members[0] ?? -1]
      const runs = head ? runsByCode.get(head.code) : undefined
      const runIdx = members[0] === undefined ? undefined : runIndexOf.get(members[0])
      const source = runs && runIdx !== undefined ? runs[runIdx] : undefined
      if (!head || !runs || !source) {
        blockFallback += members.length
        continue
      }
      const rel = members.map((i) => (tasks[i]?.entryIdx ?? 0) - head.entryIdx)
      const poolSets = members.map((i) => new Set(tasks[i]?.pool ?? []))
      const basesByRun = findBases(members, rel, poolSets, runs, source)
      if (basesByRun.length === 0) {
        // 同一只票上没有第二段够长的同状态行情 ⇒ 这一块退回独立抽样，且必须被数出来
        blockFallback += members.length
        continue
      }
      const b = regimeBlocks.length
      regimeBlocks.push({ key, members, rel, basesByRun })
      members.forEach((i, j) => regimeBlockOfTask.set(i, { block: b, rel: rel[j] ?? 0 }))
    }
    // 逐层覆盖率：按 regimeAtEntry 分（那是这一档唯一有意义的切法 —— 块的定义就是状态段）
    tasks.forEach((t, i) => {
      const key = t.position.regimeAtEntry
      const acc = regimeBlockCoverByStratum.get(key) ?? { covered: 0, total: 0 }
      acc.total++
      if (regimeBlockOfTask.has(i)) acc.covered++
      regimeBlockCoverByStratum.set(key, acc)
    })
    const covered = tasks.length - blockFallback
    const coverage = tasks.length === 0 ? 0 : covered / tasks.length
    const perStratum = [...regimeBlockCoverByStratum.entries()]
      .map(([k, v]) => `${k} ${((v.covered / Math.max(1, v.total)) * 100).toFixed(1)}%`)
      .join(' · ')
    process.stderr.write(
      `择时零分布：regime 段整段平移 · ${regimeBlocks.length} 块 · ` +
        `覆盖 ${covered}/${tasks.length} = ${(coverage * 100).toFixed(1)}%` +
        (coverage < REGIME_BLOCK_MIN_COVERAGE
          ? `（⚠ 低于预注册门槛 ${(REGIME_BLOCK_MIN_COVERAGE * 100).toFixed(0)}% ⇒ 按未调整上界读）`
          : '') +
        ` · 吸附恒 0（结构保证）· 逐层：${perStratum}\n`
    )
  }

  /** 吸附距离（交易根）逐次记下来 —— 它是「时间聚集到底保住了多少」的唯一可检验的量 */
  const snapDistances: number[] = []

  // ④ 跑 N 次随机试验
  const rng = makeRng(opts.seed)
  // 分层键是**逐建仓**算出来的，一次建仓同时进多个层（总体 / 状态 / 得分档 / 子信号组合 / 交叉）。
  // 随机组按同一批建仓配对，所以每一层的随机基准都是「这一层里的那些票、那些持有跨度」——
  // 换句话说层与层之间的零点不同，**不同层的分位可以横比，绝对收益不可以**。
  /*
    ── 已知暴露的分位（§5.45）─────────────────────────────────────────────

    池 = 这次加载的全部标的（`loaded`），也就是基线报告里那些票。分位在**当日横截面**上算，
    只用**信号那根**（`entryIdx − 1`）及其之前的数据。

    ⚠ 只对「真的有建仓的那些日期」建横截面 —— 全历史逐日排一遍是白算的（8 年 × 261 只），
    而分位只在建仓那天被查。
  */
  const entryDates = new Set<TradeDate>()
  for (const t of tasks) {
    const bar = loaded.get(t.code)?.series.candles[t.entryIdx - 1]
    if (bar) entryDates.add(bar.date)
  }
  const priorRows = new Map<TradeDate, { code: SecCode; value: number }[]>()
  const prior20Rows = new Map<TradeDate, { code: SecCode; value: number }[]>()
  const capRows = new Map<TradeDate, { code: SecCode; value: number }[]>()
  /** 缺流动性文件、因而退出市值分层的建仓数。必须报出来（与 missingAnnouncements 同一处置） */
  let missingCap = 0
  const capByCode = new Map<SecCode, Map<TradeDate, number>>()
  if (opts.liquidity !== undefined) {
    for (const code of loaded.keys()) {
      const file = join(opts.liquidity, `${code}.json`)
      if (!existsSync(file)) continue
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
          rows?: { date?: string; floatCap?: number | null }[]
        }
        const byDate = new Map<TradeDate, number>()
        for (const row of parsed.rows ?? []) {
          if (typeof row.date === 'string' && typeof row.floatCap === 'number' && row.floatCap > 0) {
            byDate.set(row.date as TradeDate, row.floatCap)
          }
        }
        if (byDate.size > 0) capByCode.set(code, byDate)
      } catch {
        // 坏文件当没有 —— 缺失会被计数报出来，不静默当成「小市值」
      }
    }
    process.stderr.write(`市值分层：${capByCode.size}/${loaded.size} 只有流通市值数据
`)
  }
  const priorReturn = (code: SecCode, idx: number, back: number): number | null => {
    const candles = loaded.get(code)?.series.candles
    const now = candles?.[idx]?.closeAdj
    const then = candles?.[idx - back]?.closeAdj
    if (now === undefined || then === undefined || then <= 0) return null
    return now / then - 1
  }
  for (const [code, entry] of loaded) {
    entry.series.candles.forEach((candle, i) => {
      if (!entryDates.has(candle.date)) return
      const p5 = priorReturn(code, i, 5)
      if (p5 !== null) push(priorRows, candle.date, { code, value: p5 })
      const p20 = priorReturn(code, i, 20)
      if (p20 !== null) push(prior20Rows, candle.date, { code, value: p20 })
      const cap = capByCode.get(code)?.get(candle.date)
      if (cap !== undefined) push(capRows, candle.date, { code, value: cap })
    })
  }
  const prior5Q = crossSectionQuintiles(priorRows)
  const prior20Q = crossSectionQuintiles(prior20Rows)
  const capQ = crossSectionQuintiles(capRows)

  const keysOf = new Map<Position, string[]>()
  for (const t of tasks) {
    const freq =
      t.freqBucket === null || t.timeHalf === null || t.codeHalf === null
        ? null
        : { bucket: t.freqBucket, timeHalf: t.timeHalf, codeHalf: t.codeHalf }
    const signalDate = loaded.get(t.code)?.series.candles[t.entryIdx - 1]?.date
    const at = signalDate === undefined ? null : `${t.code}@${signalDate}`
    const exposure = {
      prior5: at === null ? null : prior5Q.get(at) ?? null,
      prior20: at === null ? null : prior20Q.get(at) ?? null,
      floatCap: at === null ? null : capQ.get(at) ?? null,
    }
    if (opts.liquidity !== undefined && exposure.floatCap === null) missingCap++
    keysOf.set(t.position, stratumKeysOf(t.position, t.announced, freq, exposure))
  }
  if (opts.liquidity !== undefined) {
    // 覆盖不全必须可见（§5.45 口径边界 ②）：静默漏掉会让市值分层看起来是全样本的
    process.stderr.write(
      `市值分层覆盖：${tasks.length - missingCap}/${tasks.length} 次建仓` +
        (missingCap > 0 ? `（⚠ ${missingCap} 次无市值数据，退出该维度）` : '') +
        '\n'
    )
  }

  const strata: string[] = []
  const seenKey = new Set<string>()
  for (const t of tasks) {
    for (const k of keysOf.get(t.position) ?? []) {
      if (!seenKey.has(k)) {
        seenKey.add(k)
        strata.push(k)
      }
    }
  }

  const realByStratum = new Map<string, FillResult[]>()
  const passiveByStratum = new Map<string, FillResult[]>()
  const randByStratum = new Map<
    string,
    { weighted: number[]; median: number[]; win: number[]; counts: number[] }
  >()
  for (const s of strata) {
    realByStratum.set(s, [])
    passiveByStratum.set(s, [])
    randByStratum.set(s, { weighted: [], median: [], win: [], counts: [] })
  }
  for (const t of tasks) {
    for (const k of keysOf.get(t.position) ?? []) {
      realByStratum.get(k)?.push(t.real)
      if (t.passive) passiveByStratum.get(k)?.push(t.passive)
    }
  }

  // 打散跨度模式下「真实入场·被动」也随试验变，所以它同样是一条分布
  const shufPassiveByStratum = new Map<string, { weighted: number[]; median: number[] }>()
  for (const s of strata) shufPassiveByStratum.set(s, { weighted: [], median: [] })

  process.stderr.write(
    `配对 ${tasks.length} 次建仓 × ${opts.trials} 次试验 · ${strata.length} 个分层` +
      `${opts.shuffleSpans ? ' · 打散跨度' : ''}…\n`
  )
  const spans = tasks.map((t) => t.span)
  for (let trial = 0; trial < opts.trials; trial++) {
    // Fisher-Yates：真实组与随机组共用同一个置换，两边的 span 分布逐位相同
    const perm = spans.slice()
    if (opts.shuffleSpans) {
      for (let i = perm.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        const a = perm[i]
        const b = perm[j]
        if (a === undefined || b === undefined) continue
        perm[i] = b
        perm[j] = a
      }
    }
    // 每块抽一个位移，块内所有建仓共用它 —— 这就是「保留时间聚集」的全部实现
    const shiftOfBlock = blocks.map((b) => b.offsets[Math.floor(rng() * b.offsets.length)] ?? 0)
    // regime 段块：抽的是**首成员的落点**，成员各自加自己的 rel ⇒ 间距逐位保留、无需吸附
    /*
      落点权重（§5.43）：`runs` 先均匀选一段、再在段内均匀选落点；`positions` 把所有落点
      摊平后均匀选（= §5.42 那一版）。两次 `rng()` 与一次的差别会改变随机序列，
      所以两档的数字不能互相替代 —— 报告里印的是用了哪一档。
    */
    const baseOfRegimeBlock = regimeBlocks.map((b) => {
      if (opts.blockWeight === 'positions') {
        const flat = b.basesByRun.flat()
        return flat[Math.floor(rng() * flat.length)] ?? 0
      }
      const run = b.basesByRun[Math.floor(rng() * b.basesByRun.length)] ?? []
      return run[Math.floor(rng() * run.length)] ?? 0
    })
    const bucket = new Map<string, FillResult[]>()
    const passiveBucket = new Map<string, FillResult[]>()
    for (const s of strata) {
      bucket.set(s, [])
      passiveBucket.set(s, [])
    }
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i]
      if (!t) continue
      const entry = loaded.get(t.code)
      if (!entry) continue
      const span = opts.shuffleSpans ? (perm[i] ?? t.span) : t.span
      // 一次抽样可能因涨跌停/边界作废，重抽几次再放弃。
      // 跨票模式给更多次数：它的候选没有预过滤（`pool` 是预先筛过的），
      // 抽到当天停牌/未上市/已退市的票要当场换一只
      const maxAttempts = opts.crossCode ? 16 : 8
      let fill: FillResult | null = null
      for (let attempt = 0; attempt < maxAttempts && fill === null; attempt++) {
        if (opts.crossCode) {
          // 收窄模式：只从「当天也有买入信号」的那几只里抽（排除自己在下面那行）
          const pool =
            opts.crossPool === null ? crossPool : (poolByExecDate.get(t.position.entryDate) ?? [])
          if (pool.length === 0) break
          const other = pool[Math.floor(rng() * pool.length)]
          // 排除同一只票：抽到自己等于把「真实入场」本身当成随机样本，会把分位往 50% 拽
          if (other === undefined || other === t.code) continue
          const otherEntry = loaded.get(other)
          // 那天没有 K 线（停牌 / 尚未上市 / 已退市）⇒ 换一只。
          // 这就是全部的过滤 —— 不需要额外的上市日/退市日判断，缺行本身已经说明了
          const otherIdx = otherEntry?.index.get(t.position.entryDate)
          if (!otherEntry || otherIdx === undefined) continue
          fill = fillTrade(otherEntry.series, otherIdx, span, capital, costs)
        } else {
          // 块位移优先：同一个月的建仓整体平移，各自吸附到最近的合法日。
          // **只在第一次尝试用它** —— 重抽时换一个块位移会让同块成员各走各的，
          // 等于把刚保住的聚集又打散了，所以后续尝试退回独立抽样
          //（那只发生在涨跌停作废的少数样本上）
          const blockIdx = blockOfTask.get(i)
          const shift = attempt === 0 && blockIdx !== undefined ? shiftOfBlock[blockIdx] : undefined
          // regime 段块与建仓月块互斥（前者只在 --match-regime 下建），所以这里不会两条都命中
          const rb = attempt === 0 ? regimeBlockOfTask.get(i) : undefined
          let pick: number | undefined
          if (rb !== undefined) {
            const base = baseOfRegimeBlock[rb.block]
            // 落点由 `findBases` 保证在 pool 里 ⇒ 吸附距离恒 0，如实记 0（别不记：
            // 报告里那行「吸附 中位/P90」是两档口径共用的，不记会显示成「—」= 看不出有没有调整）
            if (base !== undefined) {
              pick = base + rb.rel
              snapDistances.push(0)
            }
          } else if (shift === undefined) {
            pick = t.pool[Math.floor(rng() * t.pool.length)]
          } else {
            const target = t.entryIdx + shift
            const snapped = nearestInPool(t.pool, target, t.entryIdx)
            if (snapped !== null) {
              snapDistances.push(Math.abs(snapped - target))
              pick = snapped
            }
          }
          if (pick === undefined) break
          fill = fillTrade(entry.series, pick, span, capital, costs)
        }
      }
      // 打散模式下真实入场那一侧也要按新 span 重算，否则两组的 span 不是同一批
      const passiveFill = opts.shuffleSpans
        ? fillTrade(entry.series, t.entryIdx, span, capital, costs)
        : null
      const keys = keysOf.get(t.position) ?? []
      if (fill) for (const k of keys) bucket.get(k)?.push(fill)
      if (passiveFill) for (const k of keys) passiveBucket.get(k)?.push(passiveFill)
    }
    for (const s of strata) {
      const sum = summarize(bucket.get(s) ?? [])
      const acc = randByStratum.get(s)
      if (acc) {
        acc.weighted.push(sum.weightedPnlPct)
        acc.median.push(sum.medianPnlPct)
        acc.win.push(sum.winRate)
        acc.counts.push(sum.count)
      }
      if (opts.shuffleSpans) {
        const ps = summarize(passiveBucket.get(s) ?? [])
        const pacc = shufPassiveByStratum.get(s)
        if (pacc && ps.count > 0) {
          pacc.weighted.push(ps.weightedPnlPct)
          pacc.median.push(ps.medianPnlPct)
        }
      }
    }
  }

  // ⑤ 汇总输出
  const results: StratumResult[] = []
  for (const s of strata) {
    const real = summarize(realByStratum.get(s) ?? [])
    if (real.count === 0) continue
    // 细分层薄到几十次建仓时，单次试验的随机均值本身就抖得厉害，分位读不出意义
    if (!ALWAYS_SHOWN.has(s) && real.count < opts.minCount) continue
    const acc = randByStratum.get(s)
    if (!acc) continue
    results.push({
      label: s,
      real,
      passive: summarize(passiveByStratum.get(s) ?? []),
      trials: opts.trials,
      randomWeighted: acc.weighted,
      randomMedian: acc.median,
      randomWinRate: acc.win,
      shufPassiveWeighted: shufPassiveByStratum.get(s)?.weighted ?? [],
      shufPassiveMedian: shufPassiveByStratum.get(s)?.median ?? [],
      randomCounts: acc.counts,
    })
  }

  const payload: RandomAuditPayload = {
    meta: {
      baseline: opts.baseline,
      engineVersion: report.meta.engineVersion,
      paramsFingerprint: report.meta.paramsFingerprint,
      codes: report.meta.codes.length,
      from: report.meta.from,
      to: report.meta.to,
      capitalPerCode: report.meta.capitalPerCode,
      costs: report.meta.costs ?? null,
      knobs: {
        deviations: baselineKnobs.deviations.map((d) => d.detail),
        unverifiable: [...baselineKnobs.unverifiable],
      },
      trials: opts.trials,
      seed: opts.seed,
      matchRegime: opts.matchRegime,
      crossCode: opts.crossCode,
      crossPool: opts.crossPool,
      timingNull: opts.crossCode ? null : effectiveTimingNull,
      timingNullReason,
      blocks:
        opts.crossCode || effectiveTimingNull === 'INDEPENDENT'
          ? null
          : effectiveTimingNull === 'REGIME_BLOCK'
            ? regimeBlocks.length
            : blocks.length,
      blockFallback: opts.crossCode || effectiveTimingNull === 'INDEPENDENT' ? null : blockFallback,
      blockWeight: effectiveTimingNull === 'REGIME_BLOCK' ? opts.blockWeight : null,
      blockCoverage:
        opts.crossCode || effectiveTimingNull === 'INDEPENDENT' || tasks.length === 0
          ? null
          : (tasks.length - blockFallback) / tasks.length,
      blockCoverageByRegime:
        effectiveTimingNull !== 'REGIME_BLOCK'
          ? null
          : [...regimeBlockCoverByStratum.entries()]
              .map(([regime, v]) => ({ regime, covered: v.covered, total: v.total }))
              .sort((a, b) => (a.regime < b.regime ? -1 : 1)),
      snapMedian: snapDistances.length === 0 ? null : quantile([...snapDistances].sort((a, b) => a - b), 0.5),
      snapP90: snapDistances.length === 0 ? null : quantile([...snapDistances].sort((a, b) => a - b), 0.9),
      capCovered: opts.liquidity === undefined ? null : tasks.length - missingCap,
      warmup: opts.warmup,
      minCount: opts.minCount,
      positionsTotal: positions.length,
      positionsPaired: tasks.length,
      skipped: skipped.length,
      regimeSelfCheck: opts.matchRegime ? { total: checkTotal, hit: checkHit } : null,
    },
    strata: results.map((r) => {
      const w = [...r.randomWeighted].sort((a, b) => a - b)
      const med = [...r.randomMedian].sort((a, b) => a - b)
      const win = [...r.randomWinRate].sort((a, b) => a - b)
      return {
        label: r.label,
        realCount: r.real.count,
        realWeightedPnlPct: r.real.weightedPnlPct,
        realWinRate: r.real.winRate,
        realNetPnl: r.real.netPnl,
        passiveCount: r.passive.count,
        passiveWeightedPnlPct: r.passive.weightedPnlPct,
        passiveWinRate: r.passive.winRate,
        passivePercentile: percentileOf(w, r.passive.weightedPnlPct),
        passiveWinRatePercentile: percentileOf(win, r.passive.winRate),
        passiveMedianPnlPct: r.passive.medianPnlPct,
        randomMedianMean: mean(r.randomMedian),
        passiveMedianPercentile: percentileOf(med, r.passive.medianPnlPct),
        shuffled:
          r.shufPassiveWeighted.length > 0
            ? {
                passiveWeightedMean: mean(r.shufPassiveWeighted),
                randomWeightedMean: mean(r.randomWeighted),
                passiveMedianMean: mean(r.shufPassiveMedian),
                randomMedianMean: mean(r.randomMedian),
                pairedWinFraction:
                  r.shufPassiveWeighted.filter((v, i) => v > (r.randomWeighted[i] ?? Infinity))
                    .length / r.shufPassiveWeighted.length,
                // 中位口径的同一个配对检验：抗单笔极值，窄分层上它才是可读的那个
                pairedMedianWinFraction:
                  r.shufPassiveMedian.length === 0
                    ? 0
                    : r.shufPassiveMedian.filter((v, i) => v > (r.randomMedian[i] ?? Infinity))
                        .length / r.shufPassiveMedian.length,
              }
            : null,
        randomWeightedMean: mean(r.randomWeighted),
        randomWeightedSd: stdev(r.randomWeighted),
        randomWeightedP05: quantile(w, 0.05),
        randomWeightedP50: quantile(w, 0.5),
        randomWeightedP95: quantile(w, 0.95),
        realPercentile: percentileOf(w, r.real.weightedPnlPct),
        randomWinRateMean: mean(r.randomWinRate),
        randomWinRateP05: quantile(win, 0.05),
        randomWinRateP95: quantile(win, 0.95),
        realWinRatePercentile: percentileOf(win, r.real.winRate),
        randomSampleMean: mean(r.randomCounts),
      }
    }),
  }

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true })
    writeFileSync(opts.out, JSON.stringify(payload, null, 2), 'utf8')
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    return 0
  }
  process.stdout.write(renderText(payload))
  return 0
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—'
}

export function renderText(p: RandomAuditPayload): string {
  const m = p.meta
  const lines: string[] = []
  lines.push('随机入场基准（零假设分布）')
  lines.push('='.repeat(78))
  lines.push(`基线报告   ${m.baseline}`)
  lines.push(`引擎版本   ${m.engineVersion}（指纹 ${m.paramsFingerprint}）`)
  lines.push(`标的 / 区间 ${m.codes} 只 · ${m.from} → ${m.to}`)
  /*
    口径行**每次都印**（2026-08-25，计划 §4.9）。与零分布结构那一行同一个理由：
    有条件地印，等于让「没印」重新变成一种可能，而这份报告答的是主判据。
  */
  lines.push(
    `口径       每标的资金 ${m.capitalPerCode} · 成本 ${
      m.costs === null ? '**基线未记录 ⇒ 随机臂按出厂值定价**' : '继承基线'
    }`
  )
  if (m.knobs.deviations.length > 0) {
    lines.push(
      `⚠ 非出厂口径   ${m.knobs.deviations.join(' · ')}` +
        ' ⇒ 这份 alpha 不可与出厂口径的运行横向比较，也不可当基线引用'
    )
  }
  if (m.knobs.unverifiable.length > 0) {
    lines.push(`⚠ 无法核对   ${m.knobs.unverifiable.join(' · ')}（「未记录」≠「等于出厂」）`)
  }
  lines.push(
    `配对       ${m.positionsPaired}/${m.positionsTotal} 次建仓（跳过 ${m.skipped}）· ` +
      `${m.trials} 次试验 · seed=${m.seed}`
  )
  lines.push(
    `抽样口径   ${
      m.crossCode
        ? '**跨票**（固定入场日期，随机换标的）⇒ 测的是「选股」'
        : `${m.matchRegime ? '同 regime（限定相同市场状态）' : '无条件（任意交易日）'}，同票内换日期 ⇒ 测的是「择时」`
    }`
  )
  /*
    收窄口径必须打印在报告头上，与「择时/选股」那一行同一个理由（M2 §5.27 的处置）：
    收窄前后两份报告长得几乎一样，不标注的话事后没有任何办法分辨 ——
    而它们答的是两个不同的问题（「比随便一只票好吗」vs「比同样有信号的票好吗」）。
  */
  if (m.crossPool !== null) {
    lines.push(`候选池收窄 ${m.crossPool}（只抽「当天也有买入方向信号」的票；单信号日的建仓已摘除）`)
  }
  /*
    零分布的时间结构**每次都打印**（2026-08-19，§4.6）。这条与 t 那条同一个理由：
    报告以前没有任何一行说「这个分位是把非独立的建仓当成独立样本算出来的」，
    于是读的人无从判断它可不可信。有条件地印等于让「没印」重新变成一种可能。
  */
  if (m.timingNull === 'BLOCK') {
    lines.push(
      `零分布结构 按建仓月整块位移（block permutation，§4.6）· ${m.blocks} 块` +
        (m.blockFallback && m.blockFallback > 0
          ? ` · ⚠ ${m.blockFallback} 次退回独立抽样`
          : ' · 无退化') +
        ` · 吸附距离 中位 ${m.snapMedian ?? '—'} / P90 ${m.snapP90 ?? '—'} 根` +
        ' ⇒ 分位**已做时间聚集调整**（块内残余自相关仍在，仍略偏乐观；吸附距离越大调整越名义）'
    )
  } else if (m.timingNull === 'REGIME_BLOCK') {
    const cov = m.blockCoverage
    const enough = cov !== null && cov >= REGIME_BLOCK_MIN_COVERAGE
    lines.push(
      `零分布结构 regime 段整段平移（块 = 标的 × 一段连续同状态行情，§5.42）· ${m.blocks} 块` +
        ` · 落点权重 ${m.blockWeight === 'positions' ? '按位置（长段加权，§5.43）' : '按段均匀（§5.43 默认）'}` +
        ` · 覆盖 ${cov === null ? '—' : `${(cov * 100).toFixed(1)}%`}` +
        (m.blockFallback && m.blockFallback > 0 ? `（${m.blockFallback} 次无第二段同状态行情，退回独立抽样）` : '') +
        ` · 吸附距离 中位 ${m.snapMedian ?? '—'} / P90 ${m.snapP90 ?? '—'} 根（结构上恒 0）` +
        (enough
          ? ' ⇒ 分位**已做时间聚集调整**（段内残余自相关仍在，仍略偏乐观）'
          : ` ⇒ ⚠ **覆盖率低于预注册门槛 ${(REGIME_BLOCK_MIN_COVERAGE * 100).toFixed(0)}%，下面的分位仍按未调整上界读**`)
    )
    if (m.blockCoverageByRegime !== null) {
      lines.push(
        '           逐层覆盖 ' +
          m.blockCoverageByRegime
            .map((r) => {
              const pct = (r.covered / Math.max(1, r.total)) * 100
              const flag = pct / 100 < REGIME_BLOCK_MIN_COVERAGE ? ' ⚠' : ''
              return `${r.regime} ${pct.toFixed(1)}%（${r.covered}/${r.total}）${flag}`
            })
            .join(' · ') +
          '  ← 带 ⚠ 的那一层按未调整上界读'
      )
    }
  } else if (m.timingNull === 'INDEPENDENT') {
    lines.push(
      '零分布结构 逐次独立抽日 ⇒ **零分布方差偏小，下面所有分位都是未调整上界、偏向显著**（§4.6）'
    )
    if (m.timingNullReason !== null) lines.push(`           自动降级原因：${m.timingNullReason}`)
  } else {
    lines.push('零分布结构 跨票口径固定日期 ⇒ 真实建仓的时间聚集原样保留，无需调整（§4.6 的例外）')
  }
  if (m.regimeSelfCheck) {
    const c = m.regimeSelfCheck
    lines.push(
      `regime 自检 ${c.hit}/${c.total} = ${((c.hit / Math.max(1, c.total)) * 100).toFixed(2)}% 与报告一致`
    )
  }
  lines.push(`细分层门槛 建仓数 ≥ ${m.minCount}（总体与四个市场状态不受此过滤）`)

  // 分层按类别切成几段打印。一张 30 行的平表读不动，而这个工具的产出就是给人读的
  const sections: { title: string; pick: (label: string) => boolean }[] = [
    { title: '总体与市场状态', pick: (l) => ALWAYS_SHOWN.has(l) },
    { title: '按入场得分档（全池）', pick: (l) => l.startsWith('得分 ') },
    { title: '按入场得分档（TREND_UP）', pick: (l) => l.startsWith('TREND_UP · 得分 ') },
    { title: '按入场子信号组合（全池）', pick: (l) => l.startsWith('信号 ') },
    { title: '按入场子信号组合（TREND_UP）', pick: (l) => l.startsWith('TREND_UP · 信号 ') },
    { title: '按 regime 已持续根数（全池）', pick: (l) => l.startsWith('持续 ') },
    { title: '按 regime 已持续根数（TREND_UP）', pick: (l) => l.startsWith('TREND_UP · 持续 ') },
    // 公告分层（仅 --announcements）。放最后：它是一次性的只读验证，不是常规读数
    { title: '按信号日公告方向（全池）', pick: (l) => /^公告 (有|无|利好|利空|中性)$/.test(l) },
    {
      title: '按信号日公告方向 × 市场状态',
      pick: (l) => /^(TREND_UP|TREND_DOWN|RANGE|TRANSITION) · 公告 /.test(l),
    },
    { title: '按股票公告年频率（四分位）', pick: (l) => /^频率 Q\d$/.test(l) },
    { title: '按股票公告年频率 × 四个独立切法', pick: (l) => /^频率 Q\d · /.test(l) },
  ]

  const W = 30
  for (const section of sections) {
    const rows = p.strata.filter((s) => section.pick(s.label))
    if (rows.length === 0) continue
    // 负 alpha 排前面：这张表是用来找「谁在拖后腿」的
    rows.sort((a, b) => a.passivePercentile - b.passivePercentile)
    lines.push('')
    lines.push(`【${section.title}】仓位加权收益 / 建仓胜率`)
    lines.push('-'.repeat(W + 84))
    lines.push(
      ['分层', '建仓', '真实(含风控)', '被动·加权', '随机·加权', '加权分位', '被动·中位', '随机·中位', '中位分位']
        .map((h, i) => (i === 0 ? h.padEnd(W) : h.padStart(13)))
        .join('')
    )
    for (const s of rows) {
      lines.push(
        [
          s.label.padEnd(W),
          String(s.realCount).padStart(13),
          pct(s.realWeightedPnlPct).padStart(13),
          pct(s.passiveWeightedPnlPct).padStart(13),
          pct(s.randomWeightedMean).padStart(13),
          pct(s.passivePercentile).padStart(13),
          pct(s.passiveMedianPnlPct).padStart(13),
          pct(s.randomMedianMean).padStart(13),
          pct(s.passiveMedianPercentile).padStart(13),
        ].join('')
      )
    }
  }
  lines.push('')
  const shuffled = p.strata.filter((s) => s.shuffled !== null)
  if (shuffled.length > 0) {
    lines.push('')
    lines.push('【打散跨度】剥掉 holdingBars 内生性之后的配对检验')
    lines.push('-'.repeat(W + 84))
    lines.push(
      [
        '分层',
        '建仓',
        '真实入场·加权',
        '随机入场·加权',
        '真实入场·中位',
        '随机入场·中位',
        '**效应量 μ**',
        '配对胜率·加权',
        '配对胜率·中位',
      ]
        .map((h, i) => (i === 0 ? h.padEnd(W) : h.padStart(16)))
        .join('')
    )
    shuffled.sort((a, b) => (a.shuffled?.pairedWinFraction ?? 0) - (b.shuffled?.pairedWinFraction ?? 0))
    for (const s of shuffled) {
      const sh = s.shuffled
      if (!sh) continue
      lines.push(
        [
          s.label.padEnd(W),
          String(s.realCount).padStart(16),
          pct(sh.passiveWeightedMean).padStart(16),
          pct(sh.randomWeightedMean).padStart(16),
          pct(sh.passiveMedianMean).padStart(16),
          pct(sh.randomMedianMean).padStart(16),
          // 效应量 μ = 真实中位 − 随机中位。**它才是"差多少"**，见下面那条纪律
          pct(sh.passiveMedianMean - sh.randomMedianMean).padStart(16),
          pct(sh.pairedWinFraction).padStart(16),
          pct(sh.pairedMedianWinFraction).padStart(16),
        ].join('')
      )
    }
    lines.push('')
    lines.push('  同一次试验里两组用**同一个 span 置换**，所以「配对胜率」是逐试验配对的')
    lines.push('  直接检验：50% ⇒ 入场与随机无异，接近 0% ⇒ 入场系统性更差。')
    lines.push('  ⚠ **两个口径要一起读，背离时以中位为准**（CLAUDE.md 读数纪律 2）：加权口径在窄分层上')
    lines.push('  会被单笔妖股支配 —— 实测「流通市值 Q2」加权 84.5%，而中位口径两组几乎相同（§5.45）。')
    lines.push('  ⚠ **配对胜率是效应量的饱和变换 ⇒ 跨层比它的差无效，要比就比 μ**（M2 §5.74）：')
    lines.push('    胜率 ≈ Φ(μ/σ_D)，灵敏度 φ(z)/σ_D 在 50% 处最大、往 0%/100% 两端塌缩。')
    lines.push('    实测 RANGE（基线 51.4%）的增益是 TRANSITION（0.9%）的 **24 倍** ——')
    lines.push('    于是 RANGE 的 μ 只动 +0.09pp 却让胜率动 12.7pp，而 TRANSITION 的 μ 动了')
    lines.push('    −0.34pp（**2.7 倍大**）胜率才动 0.6pp。**幅度不可跨层比。**')
    lines.push('  ⚠ **σ_D ∝ 1/√n ⇒ 层越大胜率越极端**：实测 33 层里按胜率排 vs 按 μ 排')
    lines.push('    Spearman 只有 0.865，最大错位 **11 位** —— `ALL`（n=1097）胜率排 30/33')
    lines.push('    而它的 μ 只排 19/33。**排序比的是信噪比，不是效应量。**')
    lines.push('  ✅ **不受影响的用法**：Φ 单调 ⇒ 「> 50%」这个阈值等价于「μ > 0」，')
    lines.push('    所以阈值型判据（含 L2 条件①）与符号/方向的读法**完全有效**。')
  }

  lines.push('')
  lines.push('读法')
  lines.push('-'.repeat(94))
  lines.push('· 三列的差别只有两处，别混：')
  lines.push('    真实(含风控)   = 信号选的入场日 + 风控离场（止损/回撤减仓/移动止损/盈利保护）')
  lines.push('    真实入场·被动  = 信号选的入场日 + 被动持有同样根数')
  lines.push('    随机·被动      = 骰子选的入场日 + 被动持有同样根数')
  lines.push('  「真实入场·被动」与「随机·被动」**结构完全一致**（一买一卖、同 span、同成本），')
  lines.push('  所以只有这两列之差才是**入场质量**；前两列之差是风控离场的作用。')
  lines.push('· 「被动分位」= 「真实入场·被动」落在随机分布的第几百分位。')
  lines.push('  接近 50% ⇒ 入场与随机无异；接近 0% ⇒ 入场**系统性更差**（在反向挑点）。')
  lines.push('· **各层的零点不同**（每层的随机基准只用该层那些票、那些持有跨度），')
  lines.push('  所以层与层之间**分位可以横比、绝对收益不可以**。')
  lines.push('· 细分层是事后切的，切法本身没有做多重比较校正 —— 一个 30 次建仓的层')
  lines.push('  落在 5% 分位并不稀奇。**只有跨得分档单调、或跨种子稳定的形状才算读数。**')
  lines.push('· **加权分位与中位分位背离时，以中位分位为准**：加权会被单次极端行情整段带走。')
  lines.push('  实测 T1+T2+T3+T4 那 78 次建仓的加权 +1.90% 里，最赚的 3 笔占总盈亏 235%，')
  lines.push('  去掉后翻成 −2.56%（SZ002969 一笔 +325.8%，数据无误，就是一次妖股行情）。')
  lines.push('· holdingBars 是内生的（跌得快的被止损在 8 根、涨上去的被拖到 15 根），')
  lines.push('  配对时照抄了这个分布 —— 这是刻意的，否则比的是两种持有策略。')
  lines.push('· 本工具只统计，不改参数。')
  return lines.join('\n') + '\n'
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('random-audit.ts') === true
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n\n${USAGE}`)
      process.exit(1)
    })
}
