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

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
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

/** 与 simulate.ts 的 MAX_DEFER_BARS 同源：连续跌停超过这个天数就当作卖不掉 */
const MAX_DEFER_BARS = 5

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

function stratumKeysOf(
  p: Position,
  announced: Tone | 'NONE' | null,
  freq: { bucket: string; timeHalf: string; codeHalf: string } | null
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
  const shares = lotsAffordable(capital, fillAdj, costs)
  if (shares <= 0) return null
  const deployed = shares * fillAdj
  const entryFees = buyFees(deployed, costs)

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
      const exitFees = sellFees(amount, costs)
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
    pairedWinFraction: number
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
    trials: number
    seed: number
    matchRegime: boolean
    /** 随机的是**标的**而不是日期（`--cross-code`）。两种口径的零点不同，读报告前先看这一行 */
    crossCode: boolean
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
  --warmup <根>          随机入场日的最早位置，默认 300（= params.data.fullBars）
  --min-count <n>        细分层的最小建仓数，低于它不打印，默认 30
  --announcements <dir>  历史公告目录（fetch-announcements.mjs 的产物）。给了它就多出
                         「公告 有/无」及其与四个 regime 的交叉层。**只分层，不改交易**
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
      case '--cross-code':
        o.crossCode = true
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
  const costs: CostModel = DEFAULT_COSTS

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

  // ④ 跑 N 次随机试验
  const rng = makeRng(opts.seed)
  // 分层键是**逐建仓**算出来的，一次建仓同时进多个层（总体 / 状态 / 得分档 / 子信号组合 / 交叉）。
  // 随机组按同一批建仓配对，所以每一层的随机基准都是「这一层里的那些票、那些持有跨度」——
  // 换句话说层与层之间的零点不同，**不同层的分位可以横比，绝对收益不可以**。
  const keysOf = new Map<Position, string[]>()
  for (const t of tasks) {
    const freq =
      t.freqBucket === null || t.timeHalf === null || t.codeHalf === null
        ? null
        : { bucket: t.freqBucket, timeHalf: t.timeHalf, codeHalf: t.codeHalf }
    keysOf.set(t.position, stratumKeysOf(t.position, t.announced, freq))
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
          const other = crossPool[Math.floor(rng() * crossPool.length)]
          // 排除同一只票：抽到自己等于把「真实入场」本身当成随机样本，会把分位往 50% 拽
          if (other === undefined || other === t.code) continue
          const otherEntry = loaded.get(other)
          // 那天没有 K 线（停牌 / 尚未上市 / 已退市）⇒ 换一只。
          // 这就是全部的过滤 —— 不需要额外的上市日/退市日判断，缺行本身已经说明了
          const otherIdx = otherEntry?.index.get(t.position.entryDate)
          if (!otherEntry || otherIdx === undefined) continue
          fill = fillTrade(otherEntry.series, otherIdx, span, capital, costs)
        } else {
          const pick = t.pool[Math.floor(rng() * t.pool.length)]
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
      trials: opts.trials,
      seed: opts.seed,
      matchRegime: opts.matchRegime,
      crossCode: opts.crossCode,
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

function renderText(p: RandomAuditPayload): string {
  const m = p.meta
  const lines: string[] = []
  lines.push('随机入场基准（零假设分布）')
  lines.push('='.repeat(78))
  lines.push(`基线报告   ${m.baseline}`)
  lines.push(`引擎版本   ${m.engineVersion}（指纹 ${m.paramsFingerprint}）`)
  lines.push(`标的 / 区间 ${m.codes} 只 · ${m.from} → ${m.to}`)
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
      ['分层', '建仓', '真实入场·加权', '随机入场·加权', '真实入场·中位', '随机入场·中位', '真实赢的试验占比']
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
          pct(sh.pairedWinFraction).padStart(16),
        ].join('')
      )
    }
    lines.push('')
    lines.push('  同一次试验里两组用**同一个 span 置换**，所以「真实赢的试验占比」是逐试验配对的')
    lines.push('  直接检验：50% ⇒ 入场与随机无异，接近 0% ⇒ 入场系统性更差。')
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
