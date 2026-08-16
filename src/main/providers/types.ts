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
  /** 个股公告（docs/11 N2）。与行情无关，只有实现了的源才为 true */
  announcement: boolean
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

  /**
   * 个股公告（[docs/11](../../../docs/11-盘外消息面简报功能需求.md) N2）。
   *
   * **必须支持批量**：实测 `stock_list` 塞 200 只仍无混入，100 只自选 = 一次请求。
   * 单只轮询会把「几次/天」变成「100 次/天」，那份预算不给它。
   *
   * `sinceMs` 是**发布时刻**下界（含）。实现要自己翻页直到早于它 ——
   * 接口返回的是全局按发布时刻倒序的扁平流，只取第一页会在活跃日漏掉冷门票的公告
   * （实测 100 条一页时，请求 40 只只覆盖到 32 只）。
   */
  fetchAnnouncements?(codes: SecCode[], sinceMs: number): Promise<Announcement[]>
}

/**
 * 一条公告。**只有标题与分类，没有正文** —— 本功能不下载解析 PDF（docs/11 §9）。
 *
 * 三条与「防幻觉」直接相关的字段约束：
 *
 * 1. **`url` 必填。** 拿不到原文链接的条目在解析处就丢弃（docs/11 N2-d）——
 *    「每条都能点回原文」是结构性保证，比提示词硬。
 * 2. **`category` 拿不到时是 null，不是空串、更不是「其他」。** 猜一个分类出来，
 *    下游的「建议先看」白名单就会命中一个并不存在的类型。
 * 3. **`publishedAt` 与 `noticeDate` 是两个东西，不许合并。** 实测
 *    `display_time = 2026-08-14 17:30` 对应 `notice_date = 2026-08-15` ——
 *    前者是真实发布时刻（切「昨收盘之后」这个窗口用它），后者是归属的公告日（展示用它）。
 *    只留一个的症状是：盘前简报要么漏掉昨晚 17:30 发的公告，要么把它标成今天发的。
 */
export interface Announcement {
  /**
   * 数据源给的条目 ID，**去重键**。
   * 不用「标题 + 日期」拼 —— 同一天同名公告（多份半年度报告附件）是常见的。
   */
  id: string
  code: SecCode
  /** 数据源给的简称。**不覆盖本地 watchlist 的名字**，只作为落库留痕 */
  name: string
  title: string
  /** 数据源自己的分类，如「业绩快报」「关联交易」。拿不到时 null（见上） */
  category: string | null
  /** 真实发布时刻（epoch ms） */
  publishedAt: number
  /** 归属的公告日（北京时间 YYYY-MM-DD） */
  noticeDate: TradeDate
  /** 原文链接。拿不到的条目不会走到这里 */
  url: string
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
