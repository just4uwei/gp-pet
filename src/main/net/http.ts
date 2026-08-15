/**
 * HTTP 取数（docs/03 §2.2、§2.4）。
 *
 * 三件事必须在这一层解决，不能散落到各 provider 里：
 *   - 超时（默认 3s）与重试（1 次，指数退避 300ms）
 *   - 并发闸门
 *   - **GBK 解码**：新浪与腾讯的返回是 GBK，直接按 UTF-8 读会把股票名读成乱码。
 *     这类错误不会抛异常，只会让面板显示「�ַ�����」—— 静默失真，必须在入口挡住。
 *
 * 传输层抽成 Transport 是为了可测：provider 与重试逻辑的测试不需要真发请求。
 */

import { chainLimiters, createLimiter, type Limiter } from './limiter'

/** 统一 UA。不伪造 Referer 之外的任何身份信息（docs/03 §2.4） */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export type Encoding = 'utf-8' | 'gbk'

export interface TransportResult {
  status: number
  bytes: Uint8Array
  /**
   * 响应 `Date` 头解析出的服务器时刻（epoch ms）。拿不到时省略。
   *
   * **可选是刻意的**：测试里的假 Transport 有十几个，加成必填会把它们全部推翻，
   * 而它们关心的从来不是校时。没有这个字段的传输层就是「不提供校时样本」。
   */
  serverDateMs?: number
}

export type Transport = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal }
) => Promise<TransportResult>

export interface GetOptions {
  headers?: Record<string, string>
  encoding?: Encoding
  timeoutMs?: number
  retries?: number
}

export interface HttpResponse {
  status: number
  body: string
  latencyMs: number
  /** 服务器时刻（epoch ms）。响应没带 `Date` 头时省略 */
  serverDateMs?: number
}

/**
 * 一次成功请求的计时，供时钟校准取样（`scheduler/clock-sync.ts`）。
 *
 * `sentAt` / `receivedAt` 用的是**本地**钟 —— 校准量正是拿它们与服务器时刻比出来的，
 * 喂校准钟进去会变成自己校自己。
 */
export interface HttpTiming {
  sentAt: number
  receivedAt: number
  serverDateMs: number
}

export interface HttpClient {
  get(url: string, options?: GetOptions): Promise<HttpResponse>
}

export interface HttpClientOptions {
  transport: Transport
  limiter?: Limiter
  timeoutMs?: number
  retries?: number
  backoffMs?: number
  /**
   * 由调用方注入，便于测试；生产传 Date.now。
   *
   * ⚠ **这里必须是本地钟，不能传校准钟。** 它只用来量 `latencyMs`：校准量一挪，
   * 正在计时的那次请求就会算出个偏了的（甚至负的）延迟，而延迟直接进 provider
   * 健康统计 —— 那是判断数据源好不好的唯一依据。
   */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 每次**成功且带 `Date` 头**的请求回调一次。抛错会被吞掉，校时不该拖垮取数 */
  onTiming?: (timing: HttpTiming) => void
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'timeout' | 'status' | 'network' = 'network'
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function decode(bytes: Uint8Array, encoding: Encoding): string {
  // TextDecoder('gbk') 由 Node 的 full-icu 提供（Node 22 默认带全量 ICU）
  return new TextDecoder(encoding).decode(bytes)
}

/** 4xx 重试没有意义：请求本身就是错的，重试只是多打一次接口 */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.kind === 'timeout' || error.kind === 'network') return true
    return error.status !== undefined && error.status >= 500
  }
  return true
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const {
    transport,
    limiter = createLimiter(4),
    timeoutMs: defaultTimeout = 3000,
    retries: defaultRetries = 1,
    backoffMs = 300,
    now = () => Date.now(),
    sleep = defaultSleep,
    onTiming,
  } = options

  async function once(url: string, opts: GetOptions, timeoutMs: number): Promise<HttpResponse> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const startedAt = now()

    try {
      const result = await transport(url, {
        headers: { 'User-Agent': USER_AGENT, ...opts.headers },
        signal: controller.signal,
      })
      if (result.status < 200 || result.status >= 300) {
        throw new HttpError(`HTTP ${result.status}`, result.status, 'status')
      }
      const receivedAt = now()
      // 只有 2xx 才取样：4xx/5xx 常常是被挡下来的中间页，那上面的 Date 未必是数据源的钟
      if (result.serverDateMs !== undefined && onTiming) {
        try {
          onTiming({ sentAt: startedAt, receivedAt, serverDateMs: result.serverDateMs })
        } catch {
          // 校时是附带品，它出错不该让一次成功的取数变成失败
        }
      }
      return {
        status: result.status,
        body: decode(result.bytes, opts.encoding ?? 'utf-8'),
        latencyMs: receivedAt - startedAt,
        ...(result.serverDateMs === undefined ? {} : { serverDateMs: result.serverDateMs }),
      }
    } catch (error) {
      if (timedOut) throw new HttpError(`请求超时（${timeoutMs}ms）`, undefined, 'timeout')
      if (error instanceof HttpError) throw error
      throw new HttpError(String((error as Error)?.message ?? error), undefined, 'network')
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async get(url, opts = {}) {
      const retries = opts.retries ?? defaultRetries
      const timeoutMs = opts.timeoutMs ?? defaultTimeout

      return limiter(async () => {
        let lastError: unknown
        for (let attempt = 0; attempt <= retries; attempt++) {
          if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1))
          try {
            return await once(url, opts, timeoutMs)
          } catch (error) {
            lastError = error
            if (!isRetryable(error)) break
          }
        }
        throw lastError instanceof Error ? lastError : new HttpError(String(lastError))
      })
    },
  }
}

/**
 * 生产传输层：undici + keep-alive（docs/02 §1、§2.4）。
 *
 * 动态 import 与 storage 的驱动同理 —— 这一层在 Vitest 里不会被加载，
 * 测试注入的是假 Transport，跑测试不需要网络也不该发真请求。
 */
export async function createUndiciTransport(): Promise<Transport> {
  const { Agent, request } = await import('undici')
  const agent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 4,
  })

  return async (url, init) => {
    const response = await request(url, {
      method: 'GET',
      headers: init.headers,
      signal: init.signal,
      dispatcher: agent,
      // 不跟随重定向（undici 8 默认如此，不再接受 maxRedirections 选项）：
      // 免费接口的 302 通常意味着被挡了，跟着跳只会拿到一张验证页，
      // 上层会把它当成 status 错误并降级 —— 这正是想要的行为
    })
    const buffer = await response.body.arrayBuffer()
    const serverDateMs = parseHttpDate(response.headers['date'])
    return {
      status: response.statusCode,
      bytes: new Uint8Array(buffer),
      ...(serverDateMs === null ? {} : { serverDateMs }),
    }
  }
}

/**
 * `Date` 响应头 → epoch ms。解析不出返回 null（**不返回 0** —— 那会被当成 1970 年
 * 的服务器时刻，把校准量拉成 −56 年）。
 *
 * undici 的 headers 值可能是数组（同名头出现多次），取第一条。
 */
export function parseHttpDate(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export { createLimiter, chainLimiters }
