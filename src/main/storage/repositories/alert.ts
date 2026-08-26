/**
 * 提醒记录（`alert_log` 表，docs/03 §4.2、docs/05 §6）。
 *
 * 这张表回答的是一个问题：**「它是不是漏提醒了？」**
 * 所以它记的不是「发出去的提醒」，而是**分发器对每一条候选做出的裁决** ——
 * 发出去的、被冷却挡掉的、被免打扰降级的，一条不落（docs/05 §4「不制造信息黑洞」）。
 *
 * 两条与 001_init.sql 的既有列有关的说明：
 *
 * 1. **`channel` 存的是逗号分隔的渠道列表**（如 `PET,BUBBLE`），不是单个值。
 *    列注释写的是 `PET | BUBBLE | TRAY | OS_NOTIFY`，那是设计早期「一条提醒一个渠道」
 *    的设想；实际一条提醒会同时走多个渠道，拆成多行会让「今天提醒了几条」这个最基本的
 *    计数变成需要去重的查询。被丢弃的候选存 `NONE`（列是 NOT NULL，不能存空）。
 *
 *    **`TRAY` 与 `OS_NOTIFY` 已于 2026-08-13 移除**（托盘角标、图标闪烁、系统通知一并删掉），
 *    但历史行里还带着它们。`parseChannels` 因此**不做白名单过滤**：提醒日志只用
 *    `channels.length` 判「发没发出去」，把旧值滤掉反而会让当时明明弹过的行看起来像被静默了。
 *
 * 2. **`level` 存的是最终生效的级别**。被丢弃时存候选原本的级别并在 `suppressed_reason`
 *    里写明原因 —— 「本来想发 L3，被当日冷却挡了」比「level 为空」有用得多。
 *    是否真的发出去，看 `channel` 是不是 `NONE`。
 *
 * 只新增迁移不改旧文件（001_init.sql 开头的规矩），所以这里不动 schema。
 */

import type { AlertLevel, GatedDirection, Regime, SecCode, SignalStage } from '@core/types'
import type { AlertGate } from '../../alerts/dispatcher'
import type { Database } from '../db'

/** 分发渠道。与 `src/main/alerts/dispatcher.ts` 的 `AlertChannel` 同一集合 */
export type AlertChannelName = 'PET' | 'BUBBLE'

/** 被丢弃的候选在 `channel` 列里的取值。列是 NOT NULL，不能用空串（空串与「没解析出来」分不开） */
const NO_CHANNEL = 'NONE'

export interface AlertRow {
  id: string
  signalId: string
  /** 最终生效的级别；被丢弃时是**候选原本的**级别 */
  level: AlertLevel
  channels: readonly AlertChannelName[]
  /** 非空 = 被丢弃或被降级及原因。**给人读的，不要拿去分组**（见 011 迁移） */
  suppressedReason: string | null
  /** 实际拦下它的第一道闸门。历史行为 null（改动前没有这一列，**不回填**） */
  suppressedGate?: AlertGate | null
  /** 假设前置闸门放行，哪几道各自也会拦。历史行为 null */
  wouldBlock?: readonly AlertGate[] | null
  readAt: number | null
  createdAt: number
  /**
   * 同一条裁决重复了几轮（006_alert_repeat.sql）。插入时恒为 1，之后靠 `bumpRepeat` 递增。
   * 读出来是给日志显示的，写入路径不接受它 —— 计数只能一次 +1，不能被调用方设成任意值
   */
  repeatCount?: number
  /** 最后一次重复的时刻。null = 只发生过一次 */
  lastAt?: number | null
}

/** alert_log 与 signal 的联表结果 —— 提醒日志视图要的「时间/标的/方向/得分/结果」都在这 */
export interface AlertJoinedRow extends AlertRow {
  code: SecCode
  direction: GatedDirection
  score: number
  regime: Regime
  stage: SignalStage
  headline: string
  /**
   * 引擎判定那一刻真正看到的价 —— **implementation shortfall 的「决策价」**（M2 §5.53）。
   *
   * 一起 SELECT 出来是为了让「这笔是照哪条提醒做的」那个下拉只查一次库：
   * 另起一条查询按 `signalId` 去补这一个数，等于把同一个 join 写第二遍。
   * ⚠ 它**不是**信号日的收盘价 —— 两个口径能让 IS 的符号相反，§5.53 已判后者为错。
   */
  priceAt: number
}

interface RawRow {
  id: string
  signal_id: string
  level: string
  channel: string
  suppressed_reason: string | null
  read_at: number | null
  created_at: number
  repeat_count: number
  last_at: number | null
  /** `undefined` = 该查询没 SELECT 这一列；`null` = 早于 011 迁移的历史行 */
  suppressed_gate?: string | null
  would_block?: string | null
}

interface RawJoinedRow extends RawRow {
  code: string
  direction: string
  score: number
  regime: string
  stage: string
  evidence: string
  price_at: number
}

const COLUMNS = `id, signal_id, level, channel, suppressed_reason, read_at, created_at,
                 repeat_count, last_at, suppressed_gate, would_block`
/** 插入时用的列（不含 repeat_count / last_at —— 那两列由 bumpRepeat 维护） */
const INSERT_COLUMNS = `id, signal_id, level, channel, suppressed_reason, read_at, created_at,
                        suppressed_gate, would_block`

function parseChannels(raw: string): AlertChannelName[] {
  if (raw === NO_CHANNEL || raw === '') return []
  return raw.split(',').filter((part): part is AlertChannelName => part !== '')
}

function parseGates(raw: string | null | undefined): AlertGate[] | null {
  if (raw === undefined || raw === null) return null
  if (raw === '') return []
  return raw.split(',').filter((part): part is AlertGate => part !== '')
}

function toRow(raw: RawRow): AlertRow {
  return {
    id: raw.id,
    signalId: raw.signal_id,
    level: raw.level as AlertLevel,
    channels: parseChannels(raw.channel),
    suppressedReason: raw.suppressed_reason,
    suppressedGate: (raw.suppressed_gate as AlertGate | null | undefined) ?? null,
    // 三种取值要分清：
    //   undefined = 这次查询压根没 SELECT 这一列（多个查询点，漏一个就炸）
    //   null      = 这一行早于 011 迁移，没有结构化记录
    //   ''        = 记录了，而且四道闸门一道都不会拦 ← **不能滤成 null**，
    //               那会让「全放行」看起来像「没记录」
    wouldBlock: parseGates(raw.would_block),
    readAt: raw.read_at,
    repeatCount: raw.repeat_count,
    lastAt: raw.last_at,
    createdAt: raw.created_at,
  }
}

/** evidence 是整块 JSON，这里只取一个 headline 用于列表展示 —— 解析失败不该让整行消失 */
function headlineOf(evidence: string): string {
  try {
    const parsed = JSON.parse(evidence) as { headline?: unknown }
    return typeof parsed.headline === 'string' ? parsed.headline : ''
  } catch {
    return ''
  }
}

function toJoinedRow(raw: RawJoinedRow): AlertJoinedRow {
  return {
    ...toRow(raw),
    code: raw.code,
    direction: raw.direction as GatedDirection,
    score: raw.score,
    regime: raw.regime as Regime,
    stage: raw.stage as SignalStage,
    headline: headlineOf(raw.evidence),
    priceAt: raw.price_at,
  }
}

export interface AlertQuery {
  code?: SecCode
  from?: number
  to?: number
  limit?: number
}

export class AlertRepo {
  constructor(private readonly db: Database) {}

  insert(row: AlertRow): void {
    this.db
      .prepare(`INSERT INTO alert_log (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id,
        row.signalId,
        row.level,
        row.channels.length > 0 ? row.channels.join(',') : NO_CHANNEL,
        row.suppressedReason,
        row.readAt,
        row.createdAt,
        row.suppressedGate ?? null,
        row.wouldBlock === undefined || row.wouldBlock === null ? null : row.wouldBlock.join(',')
      )
  }

  /** 一轮 tick 会产出几十条裁决，逐条 INSERT 会开几十个事务 */
  insertMany(rows: readonly AlertRow[]): void {
    if (rows.length === 0) return
    this.db.transaction(() => {
      for (const row of rows) this.insert(row)
    })
  }

  /**
   * 同一条裁决又发生了一次：计数 +1、记下最后时刻，**不新增行**（006_alert_repeat.sql）。
   *
   * **刻意不动 `read_at`。** 已读的行不该因为这个状态还在持续就变回未读 ——
   * 未读数答的是「有几件新事」，不是「有几件事还在」。
   *
   * 返回 false = 那一行已经不在了（被裁剪掉，或库被换过）。调用方据此退回「插新行」，
   * 而不是把这一轮的裁决静默丢掉。
   */
  bumpRepeat(id: string, at: number): boolean {
    return (
      this.db
        .prepare(`UPDATE alert_log SET repeat_count = repeat_count + 1, last_at = ? WHERE id = ?`)
        .run(at, id).changes > 0
    )
  }

  /** 提醒日志视图（docs/05 §6）：联表取信号的方向与得分 */
  query(query: AlertQuery = {}): AlertJoinedRow[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.code !== undefined) {
      clauses.push('s.code = ?')
      params.push(query.code)
    }
    if (query.from !== undefined) {
      clauses.push('a.created_at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      clauses.push('a.created_at <= ?')
      params.push(query.to)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(query.limit ?? 200)))
    return this.db
      .prepare(
        `SELECT a.id, a.signal_id, a.level, a.channel, a.suppressed_reason, a.read_at, a.created_at,
                a.repeat_count, a.last_at, a.suppressed_gate, a.would_block,
                s.code, s.direction, s.score, s.regime, s.stage, s.evidence, s.price_at
         FROM alert_log a JOIN signal s ON s.id = a.signal_id
         ${where} ORDER BY a.created_at DESC LIMIT ?`
      )
      .all<RawJoinedRow>(...params, limit)
      .map(toJoinedRow)
  }

  get(id: string): AlertRow | null {
    const raw = this.db.prepare(`SELECT ${COLUMNS} FROM alert_log WHERE id = ?`).get<RawRow>(id)
    return raw ? toRow(raw) : null
  }

  /**
   * 标记已读。
   *
   * 只有**实际发出**的（channel ≠ NONE）才算未读 —— 被冷却挡掉的那条从来没打扰过用户，
   * 把它算进未读数只会让它变成「今天发生过的事情数」，那不是同一个概念。
   */
  markRead(ids: readonly string[], at: number): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    return this.db
      .prepare(`UPDATE alert_log SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`)
      .run(at, ...ids).changes
  }

  markAllRead(at: number): number {
    return this.db
      .prepare(`UPDATE alert_log SET read_at = ? WHERE read_at IS NULL AND channel != ?`)
      .run(at, NO_CHANNEL).changes
  }

  /** 未读数：实际发出过、且还没被看过的条数（面板的提醒日志用它） */
  unreadCount(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM alert_log WHERE read_at IS NULL AND channel != ?`)
        .get<{ n: number }>(NO_CHANNEL)?.n ?? 0
    )
  }

  countSince(from: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM alert_log WHERE created_at >= ?`)
        .get<{ n: number }>(from)?.n ?? 0
    )
  }

  /**
   * 闸门漏斗：一段时间里，信号从「引擎判了」走到「真的弹出来」的每一步各掉了多少。
   *
   * ## 两个陷阱，两个都在这里处理掉
   *
   * **① 分母不在 alert_log 里。** 风控硬抑制的信号**根本不进这张表**
   * （它带着原因留在 `signal` 表里，CLAUDE.md「两张表两件事」那条）。
   * 只查 alert_log 算出来的分母已经是过滤后的流量 ⇒ 系统性低估整条链路。
   * 所以 `signals` / `notDispatched` 两个数来自 `signal` 表，
   * 而 `candidates` 才是进了闸门的那一批。
   *
   * **② 短路顺序。** `suppressed_gate` 记的是**第一个**拦下它的闸门，
   * 被防抖挡下的候选根本走不到冷却 ⇒ 靠后的闸门看起来永远很松。
   * 所以 `blockedBy`（实际拦截，四项互斥、加起来 = 被拦总数）与
   * `wouldBlock`（独立判定，四项**会重叠**、加起来可以超过总数）分开给。
   * **判断「某道闸门是不是形同虚设」只能看 `wouldBlock`。**
   *
   * `legacy` 是 011 迁移之前落的行（有文案、没有结构化闸门）。
   * 单列一档而不是算进任何一格 —— 让「这段时间没有结构化记录」看得见，而不是变成 0。
   */
  gateFunnel(from: number, to: number): AlertGateFunnel {
    const zero = (): Record<AlertGate, number> => ({
      DEBOUNCE: 0,
      COOLDOWN: 0,
      // 2026-08-26 从 COOLDOWN 分出来的**强制类台阶**（见 `AlertGate` 头注释）。
      // ⚠ 历史行不回填 ⇒ 08-26 之前的台阶仍然计在 COOLDOWN 那一格里
      STEP: 0,
      CAP: 0,
      QUIET: 0,
    })

    // ① 分母：这段时间引擎判出的信号，以及其中**压根没走到闸门**的。
    //
    // 用 LEFT JOIN 数「没有对应 alert_log 行」，而不是去 evidence JSON 里读 `suppressed` ——
    // 后者只覆盖风控硬抑制，而「没进闸门」还有别的成因（方向不可执行的 HOLD_WARN 等）。
    // 漏斗要的是「掉在这一步的总量」，不是「掉的理由」。
    const sig = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN a.signal_id IS NULL THEN 1 ELSE 0 END) AS orphan
           FROM signal s LEFT JOIN (SELECT DISTINCT signal_id FROM alert_log) a
             ON a.signal_id = s.id
          WHERE s.created_at >= ? AND s.created_at < ?`
      )
      .get<{ total: number; orphan: number | null }>(from, to)

    const rows = this.db
      .prepare(
        `SELECT suppressed_gate, would_block, channel, suppressed_reason
           FROM alert_log WHERE created_at >= ? AND created_at < ?`
      )
      .all<{
        suppressed_gate: string | null
        would_block: string | null
        channel: string
        suppressed_reason: string | null
      }>(from, to)

    const blockedBy = zero()
    const wouldBlock = zero()
    let delivered = 0
    let legacy = 0
    for (const row of rows) {
      if (row.channel !== NO_CHANNEL && row.suppressed_reason === null) delivered++
      if (row.suppressed_gate === null && row.would_block === null) {
        if (row.suppressed_reason !== null) legacy++
        continue
      }
      const gate = row.suppressed_gate as AlertGate | null
      if (gate !== null && gate in blockedBy) blockedBy[gate]++
      for (const g of row.would_block === null || row.would_block === '' ? [] : row.would_block.split(',')) {
        if (g in wouldBlock) wouldBlock[g as AlertGate]++
      }
    }

    return {
      from,
      to,
      signals: sig?.total ?? 0,
      notDispatched: sig?.orphan ?? 0,
      candidates: rows.length,
      delivered,
      blockedBy,
      wouldBlock,
      legacy,
    }
  }
}

export interface AlertGateFunnel {
  from: number
  to: number
  /** 引擎判出的信号总数（`signal` 表，闸门的真正分母） */
  signals: number
  /**
   * 其中**根本没走到闸门**的条数（没有任何 alert_log 行）。
   *
   * 主要是风控硬抑制（它带着原因留在 signal 表里，不进 alert_log），
   * 也包含方向不可执行等其它「产不出候选」的成因 —— 所以名字是 `notDispatched`
   * 而不是 `riskSuppressed`：这一格量的是**掉在这一步的总量**，不是掉的理由。
   */
  notDispatched: number
  /** 进了闸门的候选数（= alert_log 行数） */
  candidates: number
  /** 一路通过、真的发出去的条数 */
  delivered: number
  /** 实际拦截：四项**互斥**，和 = 被拦总数 */
  blockedBy: Record<AlertGate, number>
  /** 独立判定：四项**会重叠**，和可以超过候选数。判断「闸门是否形同虚设」只能看这个 */
  wouldBlock: Record<AlertGate, number>
  /** 011 迁移之前落的行（有文案、没有结构化闸门）。单列一档，不并进上面任何一格 */
  legacy: number
}
