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

/**
 * 分时的一个点。**纯展示素材**，引擎、回测、指标一个字都不读它
 * （与 quote_tick 同一条纪律，见 004_quote_tick.sql）。
 */
export interface MinutePoint {
  /** 墙上时刻（ms）。接口给的是北京时间钟点，按本机时区构造 —— 全应用同一条假设 */
  ts: number
  last: number
  /** 当日均价（成交额/成交量）。源没给时为 null，**不要填 0**（约束 4） */
  avg: number | null
}

/**
 * 一整段当日分时。
 *
 * ⚠ `tradeDate` **可能不是今天**：休市日请求这类接口，返回的是**上一个交易日**的那条曲线。
 * 调用方必须按它决定 x 轴与文案，默认当成今天画会让周末打开面板的人看到一条
 * 日期错位的假曲线（而图上完全看不出来）。
 */
export interface MinuteSeries {
  tradeDate: TradeDate
  /** 昨收，画基准线用。源没给时为 null —— 不许拿当日首个价顶替 */
  preClose: number | null
  /** 按 ts 升序。午休那段本来就没有点，调用方不许直连（见 IntradayChart） */
  points: MinutePoint[]
}

export interface QuoteProvider {
  readonly id: ProviderId
  readonly capabilities: ProviderCapabilities

  fetchDaily(code: SecCode, from: TradeDate, to: TradeDate, adjust: AdjustMode): Promise<Candle[]>

  /** 必须支持批量 —— 单只轮询会瞬间打满自我限制的并发额度（见 docs/03 §2.4） */
  fetchSnapshots(codes: SecCode[]): Promise<Snapshot[]>

  fetchProfile(code: SecCode): Promise<SecProfile>

  fetchCalendar?(year: number): Promise<{ date: TradeDate; isOpen: boolean }[]>

  /**
   * 当日分时（docs/03 §4「分时图」）。**只由用户打开抽屉「行情」页时触发**，
   * 一次一只票、上层带 30s 缓存 —— 绝不进 tick 轮询，那份请求预算不给它。
   */
  fetchMinutes?(code: SecCode): Promise<MinuteSeries>
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
