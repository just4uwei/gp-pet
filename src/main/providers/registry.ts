/**
 * 多源编排（docs/03 §2.2）：优先级、降级、熔断冷却、健康度记录、一致性抽检。
 *
 * 三条设计要点：
 *
 * 1. **重试不在这一层。** 单次请求的超时与重试是 HttpClient 的职责
 *    （见 net/http.ts）。registry 只做「换一个源再试」。两层各自重试会让
 *    最坏耗时变成乘积 —— 3s × 2 次 × 3 个源 = 18s，一个 30s 的 tick 就废了。
 *
 * 2. **降级必须留痕。** 每次尝试都写一条 provider_health，成功也写。
 *    「悄悄换了个源」和「悄悄不更新了」在用户眼里长得一样（docs/02 §7）。
 *
 * 3. **全部不可用时抛错，不返回空数组。** 空数组会被上层当成「今天没有数据」，
 *    进而写出一条「无信号」的结论。调用方必须显式接住 AllProvidersUnavailableError
 *    并走缓存 + stale=true 的路径。
 */

import type { AdjustMode, Candle, SecCode, SecProfile, Snapshot, TradeDate } from '@core/types'
import type {
  Announcement,
  HealthRecord,
  MinuteSeries,
  ProviderCapabilities,
  ProviderId,
  ProviderRegistryOptions,
  ProviderStatus,
  QuoteProvider,
} from './types'

export type Capability = keyof ProviderCapabilities

export interface CalendarDay {
  date: TradeDate
  isOpen: boolean
}

/** 健康度落库口。ProviderHealthRepo 结构上就满足它，registry 因此不 import storage */
export interface HealthSink {
  record(entry: HealthRecord): void
}

export const DEFAULT_REGISTRY_OPTIONS: ProviderRegistryOptions = {
  /**
   * 与 settings/schema.ts 的 DEFAULT_SETTINGS.providerPriority 保持一致（运行时以设置为准）。
   * 腾讯排第二不是因为它更快，而是因为它同时覆盖日线与快照 —— 主源挂掉时靠它一个源
   * 就能撑住全部能力；新浪只做快照，作为最后兜底。缺少对应 capability 的源会被自动跳过。
   */
  priority: ['eastmoney', 'tencent', 'sina'],
  timeoutMs: 3000,
  retries: 1,
  failureThreshold: 3,
  cooldownMs: 5 * 60_000,
  globalConcurrency: 4,
  perProviderConcurrency: 2,
  attemptDeadlineMs: 20_000,
}

/** 两源最新价偏差超过这个比例就记一条一致性告警（docs/03 §2.2） */
export const CROSS_CHECK_TOLERANCE = 0.01

export class AllProvidersUnavailableError extends Error {
  constructor(
    readonly capability: Capability,
    readonly attempts: readonly AttemptOutcome[]
  ) {
    const detail = attempts.map((a) => `${a.provider}: ${a.error ?? 'ok'}`).join('; ')
    super(`没有可用的数据源（${capability}）${detail ? ` —— ${detail}` : ''}`)
    this.name = 'AllProvidersUnavailableError'
  }
}

export class ProviderTimeoutError extends Error {
  constructor(provider: ProviderId, ms: number) {
    super(`${provider} 取数超过 ${ms}ms 未返回`)
    this.name = 'ProviderTimeoutError'
  }
}

export interface AttemptOutcome {
  provider: ProviderId
  ok: boolean
  latencyMs: number
  error?: string
}

export interface RegistryResult<T> {
  value: T
  provider: ProviderId
  /**
   * 值**不是**来自优先级最高的那个源 —— UI 该提示「已切换数据源」。
   *
   * ⚠ 含**主源在冷却里、这一轮根本没被试**那一种（那时 `attempts` 只有一条且是成功的）。
   * 要区分「试过并失败」与「压根没试」请自己数 `attempts`，别拿这个字段代替 ——
   * 理由与真机证据见 `run()` 的头注释。
   */
  degraded: boolean
  attempts: AttemptOutcome[]
}

export interface ProviderState {
  provider: ProviderId
  status: ProviderStatus
  consecutiveFailures: number
  /** 冷却结束的时间戳；<= now 表示可以试探性再用一次 */
  cooldownUntil: number
  lastError?: string
  lastOkAt?: number
}

export interface CrossCheckAlarm {
  code: SecCode
  a: { provider: ProviderId; last: number }
  b: { provider: ProviderId; last: number }
  deviation: number
}

export interface RunOptions<T> {
  /** 写健康度时的动作名，出问题时能看出是哪一类请求在失败 */
  label?: string
  /**
   * 判定「拿到了但是空的」。返回 true 时视为失败并继续降级。
   * 快照必须传（一次 tick 拿回 0 条 = 这个源当前不可用），日线不传
   * （区间内真的可能没有交易日，把它当失败会白打三个源）。
   */
  emptyIsFailure?: (value: T) => boolean
}

export interface RegistryOptions {
  providers: Partial<Record<ProviderId, QuoteProvider>>
  health?: HealthSink
  options?: Partial<ProviderRegistryOptions>
  now?: () => number
}

export interface ProviderRegistry {
  readonly options: ProviderRegistryOptions

  run<T>(
    capability: Capability,
    task: (provider: QuoteProvider) => Promise<T>,
    options?: RunOptions<T>
  ): Promise<RegistryResult<T>>

  fetchDaily(
    code: SecCode,
    from: TradeDate,
    to: TradeDate,
    adjust: AdjustMode
  ): Promise<RegistryResult<Candle[]>>
  fetchSnapshots(codes: SecCode[]): Promise<RegistryResult<Snapshot[]>>
  fetchProfile(code: SecCode): Promise<RegistryResult<SecProfile>>
  fetchCalendar(year: number): Promise<RegistryResult<CalendarDay[]>>
  /** 当日分时（用户打开抽屉时才调，见 types.ts fetchMinutes） */
  fetchMinutes(code: SecCode): Promise<RegistryResult<MinuteSeries>>
  /** 个股公告（docs/11 N2）。一天几次，与行情共用限流器是对的 */
  fetchAnnouncements(codes: SecCode[], sinceMs: number): Promise<RegistryResult<Announcement[]>>
  /** 当前有没有源能给分时 —— 没有时上层直接走本机留痕，不必白发一轮 */
  supports(capability: Capability): boolean

  /** 两个快照源交叉抽检最新价，偏差过大记告警。返回越界的那些 */
  crossCheck(codes: SecCode[]): Promise<CrossCheckAlarm[]>

  /**
   * 改优先级（用户在设置里调整了 providerPriority）。
   * 原地改而不是重建 registry —— 重建会丢掉熔断状态，
   * 结果是「刚调过设置的那几分钟，已经确认挂掉的源又会被重试一遍」。
   */
  setPriority(order: readonly ProviderId[]): void

  /** 按优先级列出当前状态，供面板展示 */
  states(): ProviderState[]
  statusOf(provider: ProviderId): ProviderStatus
  /** 用户手动「立即重试」时清空熔断 */
  reset(provider?: ProviderId): void
}

interface Circuit {
  status: ProviderStatus
  consecutiveFailures: number
  cooldownUntil: number
  /** 连续进入冷却的次数。第二次即判 DOWN —— 冷却完还是不行，说明不是抖动 */
  degradedRounds: number
  lastError?: string
  lastOkAt?: number
}

function newCircuit(): Circuit {
  return { status: 'OK', consecutiveFailures: 0, cooldownUntil: 0, degradedRounds: 0 }
}

function withDeadline<T>(work: Promise<T>, ms: number, provider: ProviderId): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError(provider, ms)), ms)
  })
  return Promise.race([work, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  // 健康度表里塞一整段 HTML 错误页毫无用处，还会把库撑大
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
}

export function createProviderRegistry(config: RegistryOptions): ProviderRegistry {
  const { providers, health, now = () => Date.now() } = config
  const options: ProviderRegistryOptions = { ...DEFAULT_REGISTRY_OPTIONS, ...config.options }
  const circuits = new Map<ProviderId, Circuit>()

  function circuit(id: ProviderId): Circuit {
    const existing = circuits.get(id)
    if (existing) return existing
    const created = newCircuit()
    circuits.set(id, created)
    return created
  }

  /** 优先级顺序里、装配了实例、且声明了该能力的源 */
  function candidates(capability: Capability): QuoteProvider[] {
    const out: QuoteProvider[] = []
    for (const id of options.priority) {
      const provider = providers[id]
      if (!provider || !provider.capabilities[capability]) continue
      out.push(provider)
    }
    return out
  }

  /**
   * 冷却中的排到最后而不是被剔除：全部在冷却时也要有源可试探，
   * 否则一次全网抖动就会让软件在冷却窗口内彻底静默。
   */
  function ordered(capability: Capability): QuoteProvider[] {
    const at = now()
    const all = candidates(capability)
    const hot = all.filter((p) => circuit(p.id).cooldownUntil <= at)
    const cooling = all.filter((p) => circuit(p.id).cooldownUntil > at)
    return [...hot, ...cooling]
  }

  function onSuccess(id: ProviderId, latencyMs: number, at: number): void {
    const state = circuit(id)
    state.status = 'OK'
    state.consecutiveFailures = 0
    state.cooldownUntil = 0
    state.degradedRounds = 0
    delete state.lastError
    state.lastOkAt = at
    health?.record({ provider: id, at, ok: true, latencyMs })
  }

  function onFailure(id: ProviderId, latencyMs: number, at: number, error: string): void {
    const state = circuit(id)
    state.consecutiveFailures += 1
    state.lastError = error
    if (state.consecutiveFailures >= options.failureThreshold) {
      state.degradedRounds += 1
      // 冷却完再次连续失败 → 不是抖动，标 DOWN（面板显示区别于「已降级」）
      state.status = state.degradedRounds >= 2 ? 'DOWN' : 'DEGRADED'
      state.cooldownUntil = at + options.cooldownMs
      state.consecutiveFailures = 0
    }
    health?.record({ provider: id, at, ok: false, latencyMs, error })
  }

  /**
   * ## ⚠ `degraded` 判的是「值来不来自主源」，不是「这次试了几个源」（2026-08-30 改）
   *
   * 旧写法是 `attempts.length > 1`，它漏掉了**主源在冷却里、这一轮压根没被试**那一种：
   * `ordered()` 把冷却中的排到最后 ⇒ 备源第一个就成功 ⇒ `attempts.length === 1`
   * ⇒ 结果来自备源却报 `degraded === false`。
   *
   * 这不是理论问题。真机 2026-08-26 11:35:23（`provider_health` 逐条可查）：
   * eastmoney 连续三次失败（minute / calendar 2026 / calendar 2027）触发 5 分钟冷却，
   * 而每周一次的 `refreshProfiles()` 恰好在同一秒开跑 ⇒ 79 只全部由腾讯服务
   * （腾讯明写「industry 不提供」）⇒ `watchlist.industry` **79/79 全空**、
   * `industry_history`（014）**一行都没有** —— 而 08-22 加的那个「降级时按字段重试」
   * 因为 `degraded === false` **一次都没有触发过**。
   *
   * ⇒ 判据改成「值不是来自优先级最高的那个源」（含被冷却跳过的情形）。
   * `attempts.length > 1` 的信息没有丢，它就在 `attempts` 里 —— 要区分
   * 「试过并失败」与「压根没试」的调用方自己去数（`engine/watchlist.ts` 就要区分）。
   */
  async function run<T>(
    capability: Capability,
    task: (provider: QuoteProvider) => Promise<T>,
    runOptions: RunOptions<T> = {}
  ): Promise<RegistryResult<T>> {
    const primary = candidates(capability)[0]?.id
    const sequence = ordered(capability)
    const attempts: AttemptOutcome[] = []

    for (const provider of sequence) {
      const startedAt = now()
      try {
        const value = await withDeadline(
          task(provider),
          options.attemptDeadlineMs,
          provider.id
        )
        const latencyMs = now() - startedAt
        if (runOptions.emptyIsFailure?.(value)) {
          const error = `${runOptions.label ?? capability} 返回空结果`
          attempts.push({ provider: provider.id, ok: false, latencyMs, error })
          onFailure(provider.id, latencyMs, now(), error)
          continue
        }
        attempts.push({ provider: provider.id, ok: true, latencyMs })
        onSuccess(provider.id, latencyMs, now())
        return { value, provider: provider.id, degraded: provider.id !== primary, attempts }
      } catch (error) {
        const latencyMs = now() - startedAt
        const message = `${runOptions.label ?? capability}: ${messageOf(error)}`
        attempts.push({ provider: provider.id, ok: false, latencyMs, error: message })
        onFailure(provider.id, latencyMs, now(), message)
      }
    }

    throw new AllProvidersUnavailableError(capability, attempts)
  }

  const registry: ProviderRegistry = {
    options,
    run,

    fetchDaily(code, from, to, adjust) {
      return run('daily', (provider) => provider.fetchDaily(code, from, to, adjust), {
        label: `daily ${code} ${from}~${to} ${adjust}`,
      })
    },

    fetchSnapshots(codes) {
      if (codes.length === 0) {
        return Promise.resolve({
          value: [],
          provider: options.priority[0] ?? 'eastmoney',
          degraded: false,
          attempts: [],
        })
      }
      return run('snapshot', (provider) => provider.fetchSnapshots(codes), {
        label: `snapshot ×${codes.length}`,
        emptyIsFailure: (snapshots) => snapshots.length === 0,
      })
    },

    fetchProfile(code) {
      return run('profile', (provider) => provider.fetchProfile(code), { label: `profile ${code}` })
    },

    /**
     * 分时。**刻意不传 `emptyIsFailure`** —— 停牌股、开盘前请求都会合法地返回 0 个点，
     * 把它记成失败会一路降级三个源、跳熔断，进而拖累 tick 路径依赖的那几个源，
     * 还会污染 docs/08 M1 的「成功率 > 99%」出口指标。而它换来的只是一张图没画出来。
     */
    fetchMinutes(code) {
      return run(
        'minute',
        async (provider) => {
          if (!provider.fetchMinutes) throw new Error(`${provider.id} 声明了 minute 但未实现`)
          return provider.fetchMinutes(code)
        },
        { label: `minute ${code}` }
      )
    },

    /**
     * 公告。**刻意不传 `emptyIsFailure`** —— 与 `fetchMinutes` 同一条理由，
     * 而且更常发生：绝大多数票绝大多数天**就是没有公告**，返回 0 条是合法结果。
     * 记成失败会一路降级三个源、跳熔断，把 tick 路径一起拖下水，
     * 还会污染 docs/08 M1 的「成功率 > 99%」出口指标 —— 换来的只是一份清单没画出来。
     */
    fetchAnnouncements(codes, sinceMs) {
      return run(
        'announcement',
        async (provider) => {
          if (!provider.fetchAnnouncements) throw new Error(`${provider.id} 声明了 announcement 但未实现`)
          return provider.fetchAnnouncements(codes, sinceMs)
        },
        { label: `announcement ${codes.length} 只` }
      )
    },

    supports(capability) {
      return candidates(capability).length > 0
    },

    fetchCalendar(year) {
      return run(
        'calendar',
        async (provider) => {
          // capabilities.calendar 为 true 但没实现方法 —— 属于装配错误，直接暴露
          if (!provider.fetchCalendar) throw new Error(`${provider.id} 声明了 calendar 但未实现`)
          return provider.fetchCalendar(year)
        },
        {
          label: `calendar ${year}`,
          emptyIsFailure: (days) => days.length === 0,
        }
      )
    },

    /**
     * 一致性抽检。**故意不算作失败**：偏差只说明两源不一致，无法判定是哪一边错，
     * 把它记成 ok=false 会同时降级两个源，还会污染 docs/08 里「成功率 > 99%」的出口指标。
     * 因此记成 ok=true + error（请求确实成功了，只是数据可疑），由 ProviderHealthRepo.alarms 查询。
     */
    async crossCheck(codes) {
      if (codes.length === 0) return []
      const pair = ordered('snapshot').slice(0, 2)
      if (pair.length < 2) return []

      const [first, second] = pair as [QuoteProvider, QuoteProvider]
      const settled = await Promise.allSettled([
        withDeadline(first.fetchSnapshots(codes), options.attemptDeadlineMs, first.id),
        withDeadline(second.fetchSnapshots(codes), options.attemptDeadlineMs, second.id),
      ])
      // 抽检失败不影响主链路，也不写失败记录 —— 它不是一次业务取数
      if (settled[0].status !== 'fulfilled' || settled[1].status !== 'fulfilled') return []

      const byCode = new Map(settled[1].value.map((s) => [s.code, s]))
      const at = now()
      const alarms: CrossCheckAlarm[] = []

      for (const a of settled[0].value) {
        const b = byCode.get(a.code)
        if (!b || a.suspended || b.suspended) continue
        if (a.last <= 0 || b.last <= 0) continue
        const deviation = Math.abs(a.last - b.last) / b.last
        if (deviation <= CROSS_CHECK_TOLERANCE) continue

        const alarm: CrossCheckAlarm = {
          code: a.code,
          a: { provider: first.id, last: a.last },
          b: { provider: second.id, last: b.last },
          deviation,
        }
        alarms.push(alarm)
        const text =
          `一致性告警 ${a.code}：${first.id}=${a.last} vs ${second.id}=${b.last}` +
          `（偏差 ${(deviation * 100).toFixed(2)}%）`
        health?.record({ provider: first.id, at, ok: true, error: text })
        health?.record({ provider: second.id, at, ok: true, error: text })
      }
      return alarms
    },

    setPriority(order) {
      const next: ProviderId[] = []
      for (const id of order) {
        if (!next.includes(id)) next.push(id)
      }
      // 没被列出的源补在末尾：设置里少写一个不该等于「永久禁用」它
      for (const id of DEFAULT_REGISTRY_OPTIONS.priority) {
        if (!next.includes(id)) next.push(id)
      }
      options.priority = next
    },

    states() {
      return options.priority
        .filter((id) => providers[id] !== undefined)
        .map((id) => {
          const state = circuit(id)
          const out: ProviderState = {
            provider: id,
            status: state.status,
            consecutiveFailures: state.consecutiveFailures,
            cooldownUntil: state.cooldownUntil,
          }
          if (state.lastError !== undefined) out.lastError = state.lastError
          if (state.lastOkAt !== undefined) out.lastOkAt = state.lastOkAt
          return out
        })
    },

    statusOf(provider) {
      return circuit(provider).status
    },

    reset(provider) {
      if (provider) circuits.set(provider, newCircuit())
      else circuits.clear()
    },
  }

  return registry
}
