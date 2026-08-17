#!/usr/bin/env node
/**
 * 迭代看板：**当前系统演进到哪一步**，以及**今天该做什么**。
 *
 * ```bash
 * pnpm iterate            # 打印看板
 * pnpm iterate -- --write # 同时刷新 docs/iteration/看板.md（进 git 的快照）
 * ```
 *
 * ## 为什么需要它
 *
 * 每次新会话都要重建上下文 —— 读 M2 偏差报告二十几节、docs/09、计划文档、
 * CLAUDE.md 那一长串坑，才知道「哪些路走过、哪些结论已经推翻、测试集还剩几次」。
 * 这个脚本把那件事从两小时压到一条命令。
 *
 * **它是「状态层」**：约束层是 CLAUDE.md + ADR + docs（很少变），
 * 流程层是 docs/07 §3.6 的门槛与清单 4.9 的归档流程（怎么做），
 * 中间缺的就是「现在到哪了、下一步是什么」。
 *
 * ## 三条纪律
 *
 * 1. **只报事实与门槛，不提策略候选。** 授权边界（2026-08-15 拍板）：
 *    看板告诉你「下一轮改动的前置条件达成了没」，**候选由人提或在会话里讨论**。
 *    理由：每天的信息增量只有 0.048%（261 只新增 1 根 ÷ 54.5 万根），
 *    一个每天产出「改进建议」的东西必然是在同一份数据上反复搜索 —— 那是过拟合的定义。
 * 2. **规则驱动，不猜。** 任务由「门槛达成情况」推导，输出可验证（数字对不对）。
 *    该说「今天没事，跑着」的时候就真的这么说 —— 那本身是有价值的信息，
 *    它防止「总觉得得每天改点什么」。
 * 3. **读不到的东西要说「读不到」，不许默认成 0。** `reports/` 是 gitignored 的、
 *    `market.db` 可能不存在。把「没测过」显示成「0 次」是这个项目一直在防的
 *    「用假值冒充」（约束 4 的同一条精神）。
 * 4. **诊断类任务要分清「工程缺口」与「还没到观察窗口」**（2026-08-16 加）。
 *    存量为零有两种成因：修复没生效（该查），和**修复之后一场都没开过盘**（查不出东西）。
 *    只看存量会把后者报成「现在就能做」—— 那次会话里人去查库、翻 git log、
 *    读 settle.ts，才发现最后一个交易日是上周五。**看板的价值就是免掉这些**，
 *    报错桶等于把它要省的成本又加回去。判据是 `./session.ts` 的 `sinceFixLanded`，
 *    分桶只认它（硬事实），交易日历只用来补一句「下一个观察窗口在哪」。
 *
 *    ⚠ 这条规则有一个**必须一起满足**的反向要求：它得能重新报警。
 *    一个只会说「等着」的规则比原来的误报更糟 —— 误报浪费一次排查，
 *    永久静默让真的复发再也不报。`tests/unit/tools/iterate-session.test.ts` 两条钉着。
 *
 * ## 一个必须解决的问题：关键指标存在会消失的地方
 *
 * 基线绩效与 alpha 配对胜率都躺在 `reports/calib/*.json` 里，而 `reports/` **不进版本控制**
 * —— 换台机器、清一次盘就没了，那时「系统优化到什么地步」这个问题再也答不了。
 * 所以 `--write` 会把快照落进 `docs/iteration/看板.md`（**进 git**）。
 * 原始产物继续 gitignore，快照进库 —— 这是计划文档 §4.2 那个「实验可追溯性」缺口的最小修法。
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { ENGINE_VERSION } from '@core/params'
import type { TradeDate } from '@core/types'
import { countByStatus, paramRows } from '@main/settings/params-view'
import { createTradingCalendar, parseHolidayTable, type TradingCalendar } from '@main/scheduler/calendar'
import { SHANGHAI_OFFSET_MS } from '@shared/time'
import { dataFreshness, sinceFixLanded, type Freshness } from './session'

const ROOT = process.cwd()
const REPORTS = join(ROOT, 'reports', 'calib')
const BOARD = join(ROOT, 'docs', 'iteration', '看板.md')
const HOLIDAYS = join(ROOT, 'resources', 'data', 'holidays.json')

/** 读不到就是读不到 —— 不许退化成 0（见文件头纪律 3） */
type Maybe<T> = { known: true; value: T } | { known: false; why: string }

const unknown = (why: string): Maybe<never> => ({ known: false, why })
const known = <T>(value: T): Maybe<T> => ({ known: true, value })

/**
 * `YYYY-MM-DD HH:mm`，**北京时间**。
 *
 * 看板上的时刻与日期一律走这里，别用 `toISOString()`：那给的是 UTC，
 * 而打出来的字看起来像本地钟。两处都踩过 —— 头部「刷新于」在 UTC+7 的机器上
 * 把北京 15:11 打成 07:11；报告日期按 UTC 切会让北京 00:00–08:00 生成的报告显示成前一天。
 */
function shanghaiStamp(epochMs: number): string {
  return new Date(epochMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
}

// ── ① 参数归档状态（唯一有测试钉着的事实来源）─────────────────────────

function paramState(): { engineVersion: string; counts: Record<string, number>; leaves: number } {
  const rows = paramRows()
  return { engineVersion: ENGINE_VERSION, counts: countByStatus(rows), leaves: rows.length }
}

// ── ② 基线绩效与 alpha（来自 reports/，可能不存在）───────────────────

interface BaselineSnapshot {
  file: string
  at: string
  engineVersion: string
  codes: number
  positions: number
  trades: number
  totalReturn: number
  winRate: number
  maxDrawdown: number
  sharpe: number
  exposure: number
}

function latestBaseline(): Maybe<BaselineSnapshot> {
  if (!existsSync(REPORTS)) return unknown('reports/calib/ 不存在（gitignored，换机器后需重跑回测）')
  // 取最新的、带 trades 且标的数 ≥ 200 的那份 —— 小池的报告不是「当前基线」
  const candidates = readdirSync(REPORTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(REPORTS, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  for (const { f } of candidates) {
    try {
      const j = JSON.parse(readFileSync(join(REPORTS, f), 'utf8')) as {
        meta?: { engineVersion?: string; codes?: unknown[]; generatedAt?: number }
        performance?: Record<string, number>
        trades?: { code: string; entryDate: string; pnl: number }[]
      }
      const codes = j.meta?.codes?.length ?? 0
      if (!j.performance || !j.trades || codes < 200) continue
      // 建仓级归并：一行 trade 是一次卖出，回撤减仓会把一次建仓拆成两三行（§5.18）
      const byEntry = new Map<string, number>()
      for (const t of j.trades) {
        const k = `${t.code}@${t.entryDate}`
        byEntry.set(k, (byEntry.get(k) ?? 0) + t.pnl)
      }
      const wins = [...byEntry.values()].filter((p) => p > 0).length
      return known({
        file: f,
        at: j.meta?.generatedAt === undefined ? '—' : shanghaiStamp(j.meta.generatedAt).slice(0, 10),
        engineVersion: j.meta?.engineVersion ?? '—',
        codes,
        positions: byEntry.size,
        trades: j.trades.length,
        totalReturn: j.performance.totalReturn ?? 0,
        winRate: byEntry.size > 0 ? wins / byEntry.size : 0,
        maxDrawdown: j.performance.maxDrawdown ?? 0,
        sharpe: j.performance.sharpe ?? 0,
        exposure: j.performance.exposure ?? 0,
      })
    } catch {
      continue
    }
  }
  return unknown('reports/calib/ 里没有标的数 ≥ 200 且含 trades 的报告')
}

interface AlphaSnapshot {
  file: string
  engineVersion: string
  matchRegime: boolean
  shuffleSpans: boolean
  seed: number
  byStratum: { label: string; count: number; paired: number | null; percentile: number }[]
}

function latestAlpha(): Maybe<AlphaSnapshot> {
  if (!existsSync(REPORTS)) return unknown('reports/calib/ 不存在')
  const files = readdirSync(REPORTS)
    .filter((f) => f.startsWith('random') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(REPORTS, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { f } of files) {
    try {
      const j = JSON.parse(readFileSync(join(REPORTS, f), 'utf8')) as {
        meta?: { engineVersion?: string; matchRegime?: boolean; seed?: number }
        strata?: {
          label: string
          realCount: number
          passivePercentile: number
          shuffled: { pairedWinFraction: number } | null
        }[]
      }
      if (!j.strata) continue
      const core = ['ALL', 'TREND_UP', 'RANGE', 'TRANSITION']
      return known({
        file: f,
        engineVersion: j.meta?.engineVersion ?? '—',
        matchRegime: j.meta?.matchRegime === true,
        shuffleSpans: j.strata.some((s) => s.shuffled !== null),
        seed: j.meta?.seed ?? 0,
        byStratum: j.strata
          .filter((s) => core.includes(s.label))
          .map((s) => ({
            label: s.label,
            count: s.realCount,
            paired: s.shuffled?.pairedWinFraction ?? null,
            percentile: s.passivePercentile,
          })),
      })
    } catch {
      continue
    }
  }
  return unknown('reports/calib/ 里没有 random-*.json（跑一次 pnpm audit:random）')
}

// ── ③ 测试集预算（唯一来源是 docs/07 §3 ④ 的那行计数）────────────────

function testBudget(): Maybe<number> {
  const file = join(ROOT, 'docs', '07-回测与验证方案.md')
  if (!existsSync(file)) return unknown('docs/07 不存在')
  const m = /累计触碰次数[：:]\s*\*{0,2}(\d+)\s*次/.exec(readFileSync(file, 'utf8'))
  // 解析不到时报「读不到」而不是 0 —— 0 会被读成「一次都没碰过」，正好反了
  return m?.[1] === undefined ? unknown('docs/07 §3 里没找到「累计触碰次数」那一行') : known(Number(m[1]))
}

// ── ④ 真机运行数据（market.db，很可能不存在）──────────────────────────

interface RuntimeSnapshot {
  dbPath: string
  signals: number
  confirmed: number
  tradeDays: number
  alerts: number
  alertsWithGate: number
  shadowPoints: number
  /** 库里最新一行 signal / alert_log 的北京时间日子，null = 一行都没有 */
  latestSignalDate: TradeDate | null
  latestAlertDate: TradeDate | null
  /** 这两张表相对「最后一个已收盘交易日」跟上了没（见 ./session.ts） */
  signalFreshness: Freshness
  alertFreshness: Freshness
}

/** `node:sqlite` 是实验特性，这里只用到 `prepare`，不引它的整套类型 */
type SqliteDb = { prepare(sql: string): { get(...params: unknown[]): unknown } }

/**
 * 用**只读**的用户库当交易日历的第一级判据（`scheduler/calendar.ts` 的 `db` 那一级）。
 *
 * `upsertMany` 直接抛：`resolve()` 不会调它，而看板**绝不能动用户的库** ——
 * 悄悄退化成 no-op 的话，哪天有人给日历加了自动回写，这里就变成一次静默的写入。
 */
function readOnlyCalendar(db: SqliteDb): TradingCalendar {
  const raw = existsSync(HOLIDAYS) ? parseHolidayTable(JSON.parse(readFileSync(HOLIDAYS, 'utf8'))) : null
  return createTradingCalendar({
    holidays: raw ?? undefined,
    store: {
      isOpen(date) {
        try {
          const row = db.prepare('SELECT is_open FROM trade_calendar WHERE trade_date = ?').get(date) as
            | { is_open: number }
            | undefined
          if (row !== undefined) return row.is_open === 1
          /*
            trade_calendar 每周才刷一次，最近几天常常是空的（实测用户库停在 08-12，
            而最后一个交易日是 08-14）—— 于是判据掉到 builtin 那一级，
            2026 不在 `verifiedYears` 里 ⇒ uncertain ⇒ 整个诊断降不了级。

            但库里有更硬的东西：**那天真的落下了日线**。这与应用自己的
            `markObserved(date, true)` 是同一条依据（「实际观测到行情」），所以按 db 级算。

            ⚠ 反过来不成立，**缺行一律返回 null**：应用没开机那天同样没有日线，
            把「没数据」读成「休市」正是 calendar.ts 头注释里那条硬规则要防的事
            —— 判错成休市会让结论彻底反向，而判错成「不知道」只是不下结论。
          */
          const seen = db.prepare('SELECT 1 FROM kline_daily WHERE trade_date = ? LIMIT 1').get(date)
          return seen === undefined ? null : true
        } catch {
          return null
        }
      },
      coverageEnd() {
        try {
          const row = db.prepare('SELECT MAX(trade_date) AS d FROM trade_calendar').get() as
            | { d: string | null }
            | undefined
          return (row?.d ?? null) as TradeDate | null
        } catch {
          return null
        }
      },
      upsertMany() {
        throw new Error('看板只读用户的库，不写 trade_calendar')
      },
    },
  })
}

async function runtimeState(): Promise<Maybe<RuntimeSnapshot>> {
  const appData = process.env.APPDATA
  const dbPath = appData === undefined ? null : join(appData, 'gp-pet', 'market.db')
  if (dbPath === null || !existsSync(dbPath)) {
    return unknown(`未找到 market.db（${dbPath ?? '无 APPDATA'}）—— 应用还没在这台机器上跑过`)
  }
  try {
    const { DatabaseSync } = await import('node:sqlite')
    // 只读打开：这个脚本绝不能动用户的库
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const one = (sql: string): number => {
      try {
        const r = db.prepare(sql).get() as Record<string, unknown> | undefined
        const v = r === undefined ? 0 : Object.values(r)[0]
        return typeof v === 'number' ? v : 0
      } catch {
        return 0
      }
    }
    const day = (sql: string): TradeDate | null => {
      try {
        const r = db.prepare(sql).get() as Record<string, unknown> | undefined
        const v = r === undefined ? null : Object.values(r)[0]
        return typeof v === 'string' && v.length >= 10 ? (v.slice(0, 10) as TradeDate) : null
      } catch {
        return null
      }
    }
    const calendar = readOnlyCalendar(db)
    const now = Date.now()
    // alert_log 没有 trade_date 列，只有 created_at ——「今天」一律按北京时间切
    // （CLAUDE.md：不要写 setHours(0,0,0,0)，UTC−5 上会把日界挪到北京 13:00）
    const latestSignalDate = day('SELECT MAX(trade_date) AS d FROM signal')
    const latestAlertDate = day(
      `SELECT date(MAX(created_at) / 1000, 'unixepoch', '+8 hours') AS d FROM alert_log`
    )
    const snap: RuntimeSnapshot = {
      dbPath,
      signals: one('SELECT COUNT(*) FROM signal'),
      confirmed: one(`SELECT COUNT(*) FROM signal WHERE stage = 'CONFIRMED'`),
      tradeDays: one('SELECT COUNT(DISTINCT trade_date) FROM signal'),
      alerts: one('SELECT COUNT(*) FROM alert_log'),
      alertsWithGate: one('SELECT COUNT(*) FROM alert_log WHERE would_block IS NOT NULL'),
      shadowPoints: one('SELECT COUNT(*) FROM shadow_equity'),
      latestSignalDate,
      latestAlertDate,
      signalFreshness: dataFreshness({ now, latest: latestSignalDate, calendar }),
      alertFreshness: dataFreshness({ now, latest: latestAlertDate, calendar }),
    }
    db.close()
    return known(snap)
  } catch (err) {
    return unknown(`打不开 market.db：${(err as Error).message}`)
  }
}

// ── ⑤ 规则驱动的任务清单 ─────────────────────────────────────────────

type Bucket = '只能靠时间' | '现在就能做' | '等你拍板' | '明确不做'

interface Task {
  bucket: Bucket
  title: string
  why: string
}

/**
 * 两项真机诊断的「修复落地日」。**DB 里查不到，只能写成常量** —— 它是 git 事实。
 *
 * 落地日当天及以前的数据本来就不该有那个东西，报成「现在就能做」是误报；
 * 严格晚于它的数据仍是零才是复发（判据见 ./session.ts 的 `sinceFixLanded`）。
 *
 * ⚠ **这两个日期不会自己更新。** 哪天这两处又改了实现，要连同这里一起改 ——
 * 忘了改的后果是偏向误报（多查一次），不是漏报，方向是安全的那边。
 */
const FIX_LANDED = {
  /** `engine/settle.ts` 次日盘前补跑，commit 19f542f */
  settle: '2026-08-14' as TradeDate,
  /** `011_alert_gate.sql` 加 would_block / suppressed_gate，commit 4836665 */
  alertGate: '2026-08-15' as TradeDate,
} as const

/** `sessionGated` 的两份文案。`%LATEST%` / `%LANDED%` / `%NEXT%` 会被替换 */
interface GatedCopy {
  notYet: { title: string; why: string }
  observed: { title: string; why: string }
}

/**
 * 把「修复落地之后有没有产生过新数据」翻成一个 Task。
 *
 * **分桶只看 `sinceFixLanded`（硬事实），不看交易日历** —— 日历只用来补一句
 * 「下一个观察窗口在哪」。这个分工是刻意的：日历有 uncertain 的时候，
 * 分桶不该跟着一起变得不确定（见 ./session.ts 两段头注释）。
 */
function sessionGated(input: {
  latest: TradeDate | null
  landedOn: TradeDate
  freshness: Freshness
  fallback: Task
  copy: GatedCopy
}): Task {
  const state = sinceFixLanded({ latest: input.latest, landedOn: input.landedOn })
  if (state === 'NO_DATA') return input.fallback

  const f = input.freshness
  const next =
    f.kind === 'CAUGHT_UP'
      ? `下一个交易日（\`${f.session.date}\` 之后那一场）`
      : f.kind === 'STALE'
        ? `已经过去 ${f.sessionsBehind} 场（最后一场 \`${f.session.date}\`）`
        : '下一个交易日'
  const fill = (s: string): string =>
    s
      .replace(/%LATEST%/g, input.latest ?? '?')
      .replace(/%LANDED%/g, input.landedOn)
      .replace(/%NEXT%/g, next)

  const copy = state === 'NOT_YET' ? input.copy.notYet : input.copy.observed
  return {
    bucket: state === 'NOT_YET' ? '只能靠时间' : '现在就能做',
    title: fill(copy.title),
    why: fill(copy.why),
  }
}

/**
 * 任务由**门槛达成情况**推导，不猜。
 *
 * 「今天没事」是一个合法且常见的输出 —— 每天的信息增量只有 0.048%，
 * 大多数天的正确答案就是「跑着，等数据」。
 */
function tasks(input: {
  params: ReturnType<typeof paramState>
  baseline: Maybe<BaselineSnapshot>
  alpha: Maybe<AlphaSnapshot>
  budget: Maybe<number>
  runtime: Maybe<RuntimeSnapshot>
}): Task[] {
  const out: Task[] = []
  const rt = input.runtime

  // ── 只能靠时间：真机那条线 ──
  if (!rt.known) {
    out.push({
      bucket: '只能靠时间',
      title: 'M1 跑满一个交易日（联网守一天，健康度 > 99%）',
      why: `${rt.why}。M1/M3 出口条件、4 个 UNTESTABLE 参数的依据、影子净值、闸门漏斗**全都在等这一件事**`,
    })
  } else {
    const r = rt.value
    if (r.tradeDays === 0) {
      out.push({ bucket: '只能靠时间', title: 'M1 跑满一个交易日', why: 'signal 表里一个交易日都没有' })
    } else if (r.tradeDays < 5) {
      out.push({
        bucket: '只能靠时间',
        title: `M3 自用一周（已跑 ${r.tradeDays} 个交易日）`,
        why: '判据是提醒日志不是「用着感觉还行」',
      })
    }
    if (r.confirmed === 0 && r.signals > 0) {
      out.push(
        sessionGated({
          latest: r.latestSignalDate,
          landedOn: FIX_LANDED.settle,
          freshness: r.signalFreshness,
          fallback: { bucket: '只能靠时间', title: '收盘确认轮还没有可判的数据', why: 'signal 表里读不到日期' },
          copy: {
            notYet: {
              title: '收盘确认轮要等下一个交易日盘前才有结论（CONFIRMED 仍为 0）',
              why:
                'engine/settle.ts 设计上**只在次日盘前那一跳**补跑，它 %LANDED% 才落地，' +
                '而 signal 最新只到 %LATEST% —— 全部数据都不晚于落地日，现在查不出任何东西。' +
                '观察窗口是 %NEXT% 的盘前，那时应用要开着；**跨过那一场之后仍为 0 才是复发**',
            },
            observed: {
              title: '收盘确认轮：修复已落地且此后有新数据，CONFIRMED 仍为 0 ⇒ 复发',
              why:
                'engine/settle.ts %LANDED% 落地，而 signal 最新已到 %LATEST% —— ' +
                '「数据早于那次修复」这条解释不成立了。立刻查：这个症状会让影子运行、' +
                '指标缓存、carryover 全部为空而界面不报错',
            },
          },
        })
      )
    }
    if (r.alerts > 0 && r.alertsWithGate === 0) {
      out.push(
        sessionGated({
          latest: r.latestAlertDate,
          landedOn: FIX_LANDED.alertGate,
          freshness: r.alertFreshness,
          fallback: { bucket: '只能靠时间', title: '闸门量表还没有可判的数据', why: 'alert_log 里读不到日期' },
          copy: {
            notYet: {
              title: '闸门量表要等下一个交易日才有第一行（would_block 仍为 0）',
              why:
                '011 迁移 %LANDED% 落地，只让**此后新写入**的行带 would_block；' +
                'alert_log 最新只到 %LATEST%，存量行不会被回填，也不该被回填。观察窗口是 %NEXT%',
            },
            observed: {
              title: '闸门量表：011 落地之后写过新行，仍无 would_block ⇒ 分发路径没写',
              why:
                '011 %LANDED% 落地，alert_log 最新已到 %LATEST% —— 期间写入的行本该带上这一列。' +
                '先确认迁移真的跑过（meta.schema_version ≥ 11），再查分发路径',
            },
          },
        })
      )
    }
    if (r.shadowPoints === 0) {
      out.push({
        bucket: '只能靠时间',
        title: '影子运行还没有第一个净值点',
        why: '它以 CONFIRMED 为前提，而且参数一变就停止累积 —— 改引擎之前先确认这里攒没攒东西',
      })
    }
  }

  // ── 参数归档 ──
  const c = input.params.counts
  const open = (c.GUESS ?? 0) + (c.BLOCKED ?? 0)
  if (open > 0) {
    out.push({
      bucket: '明确不做',
      title: `不要为清 BLOCKED 跑 OFAT 网格（当前 GUESS ${c.GUESS} · BLOCKED ${c.BLOCKED}）`,
      why: '出厂值被「训练集 Calmar ≤ 0」淘汰 ⇒ 裁决必为 INCONCLUSIVE ⇒ 产出零证据。要先让基线转正',
    })
  }

  // ── 测试集预算 ──
  if (input.budget.known) {
    out.push({
      bucket: '等你拍板',
      title: `测试集累计已触碰 ${input.budget.value} 次 —— 读之前先想清楚值不值`,
      why: '它是消耗品，每读一次就少一分「没被看过的窗口」的价值（docs/07 §3 ④）',
    })
  }

  // ── 下一轮判定逻辑改动的前置条件 ──
  const alphaOk = input.alpha.known && input.alpha.value.shuffleSpans
  out.push({
    bucket: '等你拍板',
    title: '下一轮判定逻辑改动的前置条件',
    why:
      `① 论证先于代码（docs/07 §3.6 门槛①）· ② 建仓数降幅 ≤ 15% · ③ 建仓级胜率不降 · ` +
      `④ alpha 上移且四个子集稳定。` +
      (alphaOk ? '当前 alpha 基线可用，条件齐备' : '⚠ 缺一次 `--shuffle-spans` 的 alpha 基线'),
  })

  // ── 引擎版本与基线是否同步 ──
  if (input.baseline.known && !sameEngine(input.baseline.value.engineVersion, input.params.engineVersion)) {
    out.push({
      bucket: '现在就能做',
      title: `基线报告是 ${input.baseline.value.engineVersion}，当前引擎是 ${input.params.engineVersion} —— 重跑基线`,
      why: '引擎版本不一致时，看板上的绩效与 alpha 描述的不是当前这套代码',
    })
  }

  if (input.alpha.known && !sameEngine(input.alpha.value.engineVersion, input.params.engineVersion)) {
    out.push({
      bucket: '现在就能做',
      title: `alpha 基线是 ${input.alpha.value.engineVersion}，当前引擎是 ${input.params.engineVersion} —— 补一次 audit:random --out`,
      why: 'alpha 是主判据。跑过但没落盘等于没跑 —— reports/ 不进版本控制，看板只能读到磁盘上有的那份',
    })
  }

  out.push({
    bucket: '明确不做',
    title: '不要每天改策略',
    why: '每天信息增量 0.048%（261 只新增 1 根 ÷ 54.5 万根）。一次合格的判定逻辑改动实测要一整天，节奏是每月 1–2 次',
  })

  return out
}

// ── ⑥ 渲染 ───────────────────────────────────────────────────────────

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`

/**
 * 报告里的 `engineVersion` 带参数指纹后缀（`0.2.8-unvalidated+c38e329b`），
 * 而 `ENGINE_VERSION` 常量不带。直接比会永远不相等 —— 第一次跑就误报了一次。
 *
 * **指纹刻意不参与比较**：换灵敏度档会改指纹但不改引擎版本，那种情况下报告仍然描述当前代码。
 */
const sameEngine = (a: string, b: string): boolean => a.split('+')[0] === b.split('+')[0]

function render(input: {
  params: ReturnType<typeof paramState>
  baseline: Maybe<BaselineSnapshot>
  alpha: Maybe<AlphaSnapshot>
  budget: Maybe<number>
  runtime: Maybe<RuntimeSnapshot>
  taskList: Task[]
  at: string
}): string {
  const L: string[] = []
  const { params, baseline, alpha, budget, runtime } = input

  L.push('# 迭代看板')
  L.push('')
  L.push('> **自动生成，不要手改** —— `pnpm iterate -- --write` 会整份覆盖。')
  L.push('> 决策与候选记在 [下一阶段取舍与迭代计划](../notes/下一阶段取舍与迭代计划.md)，')
  L.push('> 实验过程记在 [M2 偏差报告](../notes/M2-偏差报告.md)。**一件事只有一个出处。**')
  L.push('>')
  L.push(`> 刷新于 ${input.at}`)
  L.push('')

  L.push('## 引擎与参数')
  L.push('')
  L.push(`- \`ENGINE_VERSION\` **${params.engineVersion}**`)
  const c = params.counts
  L.push(
    `- ${params.leaves} 个叶子参数：CALIBRATED **${c.CALIBRATED}** · KEPT ${c.KEPT} · ` +
      `INERT ${c.INERT} · UNTESTABLE ${c.UNTESTABLE} · **BLOCKED ${c.BLOCKED}** · GUESS ${c.GUESS}`
  )
  const open = (c.GUESS ?? 0) + (c.BLOCKED ?? 0)
  L.push(
    open > 0
      ? `- 摘 \`-unvalidated\` 还差 **${open} 项**（GUESS + BLOCKED 两档都要清零）`
      : '- ✅ GUESS 与 BLOCKED 都已清零 —— 可以考虑摘 `-unvalidated`'
  )
  L.push('')

  L.push('## 策略质量')
  L.push('')
  L.push('**判据是 alpha 配对胜率，不是绩效** —— 绝对收益会把 beta 与「少做」记成策略的功劳。')
  L.push('')
  if (alpha.known) {
    const a = alpha.value
    L.push(
      `来源 \`${a.file}\`（${a.engineVersion} · seed ${a.seed} · ` +
        `${a.matchRegime ? '同 regime' : '无条件'}${a.shuffleSpans ? ' · 打散跨度' : ' · ⚠ 未打散跨度'}）`
    )
    L.push('')
    L.push('| 分层 | 建仓 | 配对胜率 | 被动分位 |')
    L.push('|---|---|---|---|')
    for (const s of a.byStratum) {
      L.push(
        `| ${s.label} | ${s.count} | ${s.paired === null ? '—' : pct(s.paired)} | ${pct(s.percentile)} |`
      )
    }
    L.push('')
    L.push('> 50% = 与随机无异 · 接近 0% = 入场系统性更差 · 高于 50% = 有正 alpha。')
    if (!a.shuffleSpans) {
      L.push('> ⚠ 这份没开 `--shuffle-spans`，数值被 `holdingBars` 内生性系统性压低，只能当下界。')
    }
    if (!sameEngine(a.engineVersion, params.engineVersion)) {
      L.push(
        `> ⚠ **这份 alpha 是 ${a.engineVersion} 的，当前引擎是 ${params.engineVersion}** —— ` +
          '它描述的不是当前代码。alpha 是主判据，版本错了比基线版本错更糟。'
      )
    }
  } else {
    L.push(`⚠ **读不到**：${alpha.why}`)
  }
  L.push('')

  L.push('## 回测基线')
  L.push('')
  if (baseline.known) {
    const b = baseline.value
    L.push(`来源 \`${b.file}\`（${b.engineVersion} · ${b.at} · ${b.codes} 只）`)
    L.push('')
    L.push('| 全期收益 | 建仓 | 逐笔 | 建仓级胜率 | 最大回撤 | 夏普 | 平均占用 |')
    L.push('|---|---|---|---|---|---|---|')
    L.push(
      `| **${pct(b.totalReturn)}** | ${b.positions} | ${b.trades} | ${pct(b.winRate)} | ` +
        `${pct(b.maxDrawdown)} | ${b.sharpe.toFixed(3)} | ${pct(b.exposure)} |`
    )
    L.push('')
    L.push('> 「超额收益」离开平均资金占用就会被读反（基准是满仓的，§5.13）。')
    if (!sameEngine(b.engineVersion, params.engineVersion)) {
      L.push(`> ⚠ **基线是 ${b.engineVersion}，当前引擎是 ${params.engineVersion}** —— 这张表描述的不是当前代码。`)
    }
  } else {
    L.push(`⚠ **读不到**：${baseline.why}`)
  }
  L.push('')

  L.push('## 真机运行')
  L.push('')
  if (runtime.known) {
    const r = runtime.value
    L.push('| 交易日 | signal | 其中 CONFIRMED | alert_log | 带闸门列 | 影子净值点 |')
    L.push('|---|---|---|---|---|---|')
    L.push(
      `| ${r.tradeDays} | ${r.signals} | ${r.confirmed} | ${r.alerts} | ${r.alertsWithGate} | ${r.shadowPoints} |`
    )
    L.push('')
    L.push(`数据最新到：signal \`${r.latestSignalDate ?? '—'}\` · alert_log \`${r.latestAlertDate ?? '—'}\``)
    const f = r.signalFreshness
    if (f.kind === 'CAUGHT_UP') {
      L.push(
        `最后一个**已收盘**交易日是 \`${f.session.date}\`（日历来源 ${f.session.source}）—— ` +
          '此后一场都没收过盘，**存量诊断这会儿查不出东西**。'
      )
    } else if (f.kind === 'STALE') {
      L.push(
        `⚠ 最后一个已收盘交易日是 \`${f.session.date}\`，数据落后 **${f.sessionsBehind} 场** —— ` +
          '「等下一个交易日」这条解释不成立了。'
      )
    } else {
      L.push(`⚠ 判不了「有没有跨过新交易日」：${f.why}`)
    }
  } else {
    L.push(`⚠ **${runtime.why}**`)
    L.push('')
    L.push('这一格是空的，就意味着：M1/M3 出口条件、4 个 `UNTESTABLE` 参数的依据、')
    L.push('影子运行的第一个净值点、刚装好的闸门拦截率量表 —— **全都在等同一件事**。')
  }
  L.push('')

  L.push('## 测试集预算')
  L.push('')
  L.push(
    budget.known
      ? `累计触碰 **${budget.value} 次**（红线是「只跑一次」，docs/07 §3 ④）。它是消耗品。`
      : `⚠ 读不到：${budget.why}`
  )
  L.push('')

  L.push('## 今天该做什么')
  L.push('')
  const order: Bucket[] = ['只能靠时间', '现在就能做', '等你拍板', '明确不做']
  for (const bucket of order) {
    const items = input.taskList.filter((t) => t.bucket === bucket)
    if (items.length === 0) continue
    L.push(`### ${bucket}`)
    L.push('')
    for (const t of items) {
      L.push(`- **${t.title}**`)
      L.push(`  - ${t.why}`)
    }
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('## 这份看板不做什么')
  L.push('')
  L.push('- **不提策略候选。** 授权边界（2026-08-15 拍板）：只报门槛达成情况，候选由人提。')
  L.push('- **不自动改代码。** 判定逻辑改动要走 docs/07 §3.6 的四条门槛，最后一步是人点头。')
  L.push('- **不记决策。** 那是计划文档 §1.1 的事 —— 一件事只有一个出处，两处会漂移。')
  L.push('')
  return L.join('\n')
}

// ── 入口 ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const write = process.argv.includes('--write')
  const params = paramState()
  const baseline = latestBaseline()
  const alpha = latestAlpha()
  const budget = testBudget()
  const runtime = await runtimeState()
  const taskList = tasks({ params, baseline, alpha, budget, runtime })
  // 一律北京时间：`toISOString()` 给的是 UTC，而看板上那行看起来像本地钟 ——
  // 2026-08-17 15:11（北京）打成了「07:11」，那正是本项目一直在防的时区混读
  const at = shanghaiStamp(Date.now())
  const text = render({ params, baseline, alpha, budget, runtime, taskList, at })

  process.stdout.write(text)
  if (write) {
    mkdirSync(dirname(BOARD), { recursive: true })
    writeFileSync(BOARD, text, 'utf8')
    process.stderr.write(`\n已写入 ${BOARD}\n`)
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1)
  })
