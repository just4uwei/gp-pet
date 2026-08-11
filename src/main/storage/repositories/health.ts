/**
 * 数据源健康度（docs/03 §2.2、docs/02 §7「不静默失败」）。
 *
 * 每次请求成功/失败都留一条。面板能查、用户能看见降级发生过 ——
 * 「悄悄换了个源」和「悄悄不更新了」在用户眼里长得一样，必须区分开。
 */

import type { Database } from '../db'
import type { HealthRecord, ProviderId } from '../../providers/types'

export interface HealthStats {
  provider: ProviderId
  total: number
  okCount: number
  successRate: number
  p95LatencyMs: number
  lastError?: string
}

export class ProviderHealthRepo {
  constructor(private readonly db: Database) {}

  record(entry: HealthRecord): void {
    this.db
      .prepare(`INSERT INTO provider_health (provider, at, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.provider, entry.at, entry.ok ? 1 : 0, entry.latencyMs ?? null, entry.error ?? null)
  }

  /** since 之后的滑动窗口统计。p95 只统计成功请求的延迟 —— 失败的耗时是超时值，混进来会污染分位 */
  stats(since: number): HealthStats[] {
    const rows = this.db
      .prepare(
        `SELECT provider, ok, latency_ms FROM provider_health WHERE at >= ? ORDER BY provider ASC`
      )
      .all<{ provider: string; ok: number; latency_ms: number | null }>(since)

    const byProvider = new Map<string, { total: number; okCount: number; latencies: number[] }>()
    for (const row of rows) {
      const bucket = byProvider.get(row.provider) ?? { total: 0, okCount: 0, latencies: [] }
      bucket.total += 1
      if (row.ok === 1) {
        bucket.okCount += 1
        if (row.latency_ms !== null) bucket.latencies.push(row.latency_ms)
      }
      byProvider.set(row.provider, bucket)
    }

    return [...byProvider.entries()].map(([provider, bucket]) => {
      const stats: HealthStats = {
        provider: provider as ProviderId,
        total: bucket.total,
        okCount: bucket.okCount,
        successRate: bucket.total === 0 ? 0 : bucket.okCount / bucket.total,
        p95LatencyMs: percentile(bucket.latencies, 0.95),
      }
      const lastError = this.lastError(provider, since)
      if (lastError) stats.lastError = lastError
      return stats
    })
  }

  lastError(provider: string, since: number): string | null {
    return (
      this.db
        .prepare(
          `SELECT error FROM provider_health
           WHERE provider = ? AND ok = 0 AND error IS NOT NULL AND at >= ?
           ORDER BY at DESC LIMIT 1`
        )
        .get<{ error: string }>(provider, since)?.error ?? null
    )
  }

  /**
   * 一致性告警：请求成功（ok = 1）但数据可疑的记录。
   * 见 providers/registry.ts crossCheck —— 偏差不算失败，否则会同时降级两个源。
   */
  alarms(since: number, limit = 50): { provider: ProviderId; at: number; error: string }[] {
    return this.db
      .prepare(
        `SELECT provider, at, error FROM provider_health
         WHERE ok = 1 AND error IS NOT NULL AND at >= ?
         ORDER BY at DESC LIMIT ?`
      )
      .all<{ provider: string; at: number; error: string }>(since, limit)
      .map((row) => ({ provider: row.provider as ProviderId, at: row.at, error: row.error }))
  }

  /** 保留 30 天（docs/03 §4.3） */
  prune(before: number): number {
    return this.db.prepare(`DELETE FROM provider_health WHERE at < ?`).run(before).changes
  }

  count(): number {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM provider_health`).get<{ n: number }>()?.n ?? 0
  }
}

/** 最近秩插值法。样本少时退化为最大值，不假装有分位精度 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index] ?? 0
}
