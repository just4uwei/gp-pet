/**
 * 信号落库与查询（`signal` 表，docs/03 §4.2）。
 *
 * 两条与 schema 有关的说明：
 *
 * 1. **`direction` 列存的是风控之后的方向**（BUY / SELL / REDUCE / NEXT_DAY_WATCH / NONE）。
 *    001_init.sql 的注释写的是 `HOLD_WARN`，那是设计早期的命名，实际契约见
 *    `GatedDirection`（src/core/types.ts）。列类型是 TEXT，不需要迁移。
 *
 * 2. **提醒级别、文案与风控裁决存在 `evidence` JSON 里**，没有单独开列。
 *    为一个 M2 才用上的字段改已发布用户的库不值得（001_init.sql 开头的规矩：
 *    只新增迁移不改旧文件），而这些字段除了展示没有查询需求。
 *
 * **被抑制的信号也要入库**（docs/05 §4）：面板要能回答「今日被静默了几条、为什么」，
 * 不制造信息黑洞。
 */

import type { AlertLevel, GatedDirection, Regime, SecCode, SignalStage, TradeDate } from '@core/types'
import type { Database } from '../db'

/** 存进 evidence 列的 JSON 形状。字段名与 core 的类型对齐，便于直接喂给 UI */
export interface SignalEvidencePayload {
  level: AlertLevel
  headline: string
  reasons: string[]
  suppressed: boolean
  suppressedReason?: string
  subSignals: {
    id: string
    strategy: string
    direction: string
    score: number
    weight: number
    evidence: Record<string, unknown>
  }[]
  adjustments: { id: string; direction: string; delta: number }[]
  verdicts: { rule: string; action: string; reason: string }[]
  scoreByDirection: Record<string, number>
  indicatorsAt: Record<string, number | null>
  regimeEvidence: Record<string, unknown>
  sufficiency: { bars: number; limited: boolean; penalty: number; note: string | null }
}

export interface SignalRow {
  id: string
  code: SecCode
  createdAt: number
  tradeDate: TradeDate
  direction: GatedDirection
  score: number
  votes: number
  regime: Regime
  stage: SignalStage
  priceAt: number
  engineVersion: string
  evidence: SignalEvidencePayload
}

interface RawRow {
  id: string
  code: string
  created_at: number
  trade_date: string
  direction: string
  score: number
  votes: number
  regime: string
  stage: string
  price_at: number
  evidence: string
  engine_version: string
}

const COLUMNS = `id, code, created_at, trade_date, direction, score, votes, regime, stage,
  price_at, evidence, engine_version`

function toRow(raw: RawRow): SignalRow {
  let evidence: SignalEvidencePayload
  try {
    evidence = JSON.parse(raw.evidence) as SignalEvidencePayload
  } catch {
    // 解析不了也要把这一行显示出来（时间、方向、得分都在列里），
    // 只是展开依据时看到一个空壳 —— 比整个列表因为一行坏数据而报错好
    evidence = {
      level: 'L1',
      headline: '（依据解析失败）',
      reasons: [],
      suppressed: false,
      subSignals: [],
      adjustments: [],
      verdicts: [],
      scoreByDirection: {},
      indicatorsAt: {},
      regimeEvidence: {},
      sufficiency: { bars: 0, limited: true, penalty: 1, note: null },
    }
  }
  return {
    id: raw.id,
    code: raw.code,
    createdAt: raw.created_at,
    tradeDate: raw.trade_date,
    direction: raw.direction as GatedDirection,
    score: raw.score,
    votes: raw.votes,
    regime: raw.regime as Regime,
    stage: raw.stage as SignalStage,
    priceAt: raw.price_at,
    engineVersion: raw.engine_version,
    evidence,
  }
}

export interface SignalQuery {
  code?: SecCode
  from?: number
  to?: number
  limit?: number
}

export class SignalRepo {
  constructor(private readonly db: Database) {}

  insert(row: SignalRow): void {
    this.db
      .prepare(
        `INSERT INTO signal (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           direction = excluded.direction, score = excluded.score, votes = excluded.votes,
           regime = excluded.regime, stage = excluded.stage, price_at = excluded.price_at,
           evidence = excluded.evidence, engine_version = excluded.engine_version`
      )
      .run(
        row.id,
        row.code,
        row.createdAt,
        row.tradeDate,
        row.direction,
        row.score,
        Math.round(row.votes),
        row.regime,
        row.stage,
        row.priceAt,
        JSON.stringify(row.evidence),
        row.engineVersion
      )
  }

  /** 阶段推进（PROVISIONAL → CONFIRMED / INVALIDATED，docs/04 §6）。M3 的确认轮会用到 */
  updateStage(id: string, stage: SignalStage): boolean {
    return this.db.prepare(`UPDATE signal SET stage = ? WHERE id = ?`).run(stage, id).changes > 0
  }

  get(id: string): SignalRow | null {
    const raw = this.db.prepare(`SELECT ${COLUMNS} FROM signal WHERE id = ?`).get<RawRow>(id)
    return raw ? toRow(raw) : null
  }

  query(query: SignalQuery = {}): SignalRow[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.code !== undefined) {
      clauses.push('code = ?')
      params.push(query.code)
    }
    if (query.from !== undefined) {
      clauses.push('created_at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      clauses.push('created_at <= ?')
      params.push(query.to)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(query.limit ?? 200)))
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM signal ${where} ORDER BY created_at DESC LIMIT ?`)
      .all<RawRow>(...params, limit)
      .map(toRow)
  }

  /** 某个交易日某只标的的最后一条 —— 确认轮与去重都要拿它比对 */
  latestOfDay(code: SecCode, tradeDate: TradeDate): SignalRow | null {
    const raw = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM signal WHERE code = ? AND trade_date = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get<RawRow>(code, tradeDate)
    return raw ? toRow(raw) : null
  }

  countOfDay(tradeDate: TradeDate): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM signal WHERE trade_date = ?`)
        .get<{ n: number }>(tradeDate)?.n ?? 0
    )
  }
}
