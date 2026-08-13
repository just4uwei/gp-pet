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
  /** 非空 = 被丢弃或被降级及原因 */
  suppressedReason: string | null
  readAt: number | null
  createdAt: number
}

/** alert_log 与 signal 的联表结果 —— 提醒日志视图要的「时间/标的/方向/得分/结果」都在这 */
export interface AlertJoinedRow extends AlertRow {
  code: SecCode
  direction: GatedDirection
  score: number
  regime: Regime
  stage: SignalStage
  headline: string
}

interface RawRow {
  id: string
  signal_id: string
  level: string
  channel: string
  suppressed_reason: string | null
  read_at: number | null
  created_at: number
}

interface RawJoinedRow extends RawRow {
  code: string
  direction: string
  score: number
  regime: string
  stage: string
  evidence: string
}

const COLUMNS = `id, signal_id, level, channel, suppressed_reason, read_at, created_at`

function parseChannels(raw: string): AlertChannelName[] {
  if (raw === NO_CHANNEL || raw === '') return []
  return raw.split(',').filter((part): part is AlertChannelName => part !== '')
}

function toRow(raw: RawRow): AlertRow {
  return {
    id: raw.id,
    signalId: raw.signal_id,
    level: raw.level as AlertLevel,
    channels: parseChannels(raw.channel),
    suppressedReason: raw.suppressed_reason,
    readAt: raw.read_at,
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
      .prepare(`INSERT INTO alert_log (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row.id,
        row.signalId,
        row.level,
        row.channels.length > 0 ? row.channels.join(',') : NO_CHANNEL,
        row.suppressedReason,
        row.readAt,
        row.createdAt
      )
  }

  /** 一轮 tick 会产出几十条裁决，逐条 INSERT 会开几十个事务 */
  insertMany(rows: readonly AlertRow[]): void {
    if (rows.length === 0) return
    this.db.transaction(() => {
      for (const row of rows) this.insert(row)
    })
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
                s.code, s.direction, s.score, s.regime, s.stage, s.evidence
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
}
