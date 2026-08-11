/**
 * 行情数据源适配契约（见 docs/03 §2、ADR-0002）。
 *
 * 各源的 URL 与字段映射封闭在各自模块内，上层只认这个接口。
 * 设计文档刻意不写具体 URL 与字段 —— 非官方接口会变，文档会腐化，
 * 而 tests/fixtures/providers 里的响应快照会让测试直接失败并指出变更位置。
 *
 * 骨架阶段：仅契约，无实现。
 */

import type { AdjustMode, Candle, SecCode, SecProfile, Snapshot, TradeDate } from '@core/types'

export type ProviderId = 'eastmoney' | 'sina' | 'tencent'

export interface ProviderCapabilities {
  daily: boolean
  snapshot: boolean
  minute: boolean
  profile: boolean
  calendar: boolean
}

export interface QuoteProvider {
  readonly id: ProviderId
  readonly capabilities: ProviderCapabilities

  fetchDaily(code: SecCode, from: TradeDate, to: TradeDate, adjust: AdjustMode): Promise<Candle[]>

  /** 必须支持批量 —— 单只轮询会瞬间打满自我限制的并发额度（见 docs/03 §2.4） */
  fetchSnapshots(codes: SecCode[]): Promise<Snapshot[]>

  fetchProfile(code: SecCode): Promise<SecProfile>

  fetchCalendar?(year: number): Promise<{ date: TradeDate; isOpen: boolean }[]>
}

export type ProviderStatus = 'OK' | 'DEGRADED' | 'DOWN'

export interface ProviderRegistryOptions {
  priority: ProviderId[]
  /** 单次 HTTP 请求的超时与重试 —— 由 HttpClient 执行，registry 只负责透传给装配层 */
  timeoutMs: number
  retries: number
  /** 连续失败达此次数即标记 DEGRADED 并冷却 */
  failureThreshold: number
  cooldownMs: number
  globalConcurrency: number
  perProviderConcurrency: number
  /**
   * 单个 provider 一次「取数动作」的总上限。一次动作可能含多个请求
   * （日线要拉原价 + 复权两趟、快照要分片），所以它必须大于 timeoutMs×(retries+1)。
   * 作用是防止某个源连接挂住时把整个 tick 拖死。
   */
  attemptDeadlineMs: number
}

export interface HealthRecord {
  provider: ProviderId
  at: number
  ok: boolean
  latencyMs?: number
  error?: string
}
