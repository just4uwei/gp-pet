/**
 * 流式对话客户端（P2）。**协议无关** —— 具体形状在 `protocols.ts`，
 * 这一层只管超时、鉴权前置检查、SSE 分帧与错误归类。
 *
 * ## 为什么不复用 net/http.ts
 *
 * 那一层只有 `get()`、默认 3s 超时、GBK 解码，**而且它的限流器与行情取数共用**。
 * 一次 40 秒的 LLM 调用挂上去会把 tick 饿死 —— 盘中每 30 秒要取一轮行情，
 * 而全局并发只有 4。所以这里另起一套：POST + SSE、自己的超时、并发 1。
 *
 * ## 明文 http 不发 key
 *
 * 本地 Ollama 是 `http://127.0.0.1:11434/v1`，所以 http 不能一刀禁。
 * 但对**非回环地址**用 http 带 key，等于把钥匙裸奔发出去 —— 这一条在下面硬拒。
 */

import type { AiConfig, AiHttpResponse, AiTransport } from './types'
import { adapterOf, protocolHint, type AiDelta, type ProtocolAdapter } from './protocols'
import { normalizeBaseUrl } from './config'

/** 首字超时。对面接受了连接却一个 token 都不吐，多半是挂了而不是在想 */
export const FIRST_TOKEN_TIMEOUT_MS = 60_000

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'auth' | 'timeout' | 'network' | 'status' | 'canceled' = 'network'
  ) {
    super(message)
    this.name = 'AiError'
  }
}

/**
 * 拼 endpoint。协议决定后缀，`ProtocolAdapter.endpoint` 自己判重 ——
 * 用户把完整路径整个粘进来时不该拼两遍。
 */
export function endpointUrl(config: Pick<AiConfig, 'baseUrl' | 'protocol'>): string {
  if (normalizeBaseUrl(config.baseUrl) === '') throw new AiError('还没有填接口地址', 'config')
  return adapterOf(config.protocol).endpoint(config.baseUrl)
}

/** 非回环地址 + 明文 http + 带 key = 拒发。返回 null 表示放行 */
export function insecureKeyTransport(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '接口地址不是合法 URL'
  }
  if (parsed.protocol !== 'http:') return null
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return null
  return `拒绝通过明文 http 把 API key 发给 ${parsed.hostname} —— 请改用 https（本机地址除外）`
}

export interface AiChatRequest {
  config: AiConfig
  apiKey: string | null
  system: string
  user: string
  signal: AbortSignal
}

/**
 * SSE 行解析。**必须按行缓冲** —— 一个 `data:` 帧被 TCP 切成两半是常态，
 * 按到达的分片直接 JSON.parse 会随机报错，而且症状是「偶尔解读到一半就断」。
 *
 * 分帧对两种协议是一样的（都是按行、`data:` 前缀），差异只在「怎么从一帧里取字」，
 * 所以把取字的那一步作为参数传进来 —— 容易写错的是分帧，那部分只写一份。
 */
export function createSseParser(extract: (parsed: unknown) => AiDelta | null): {
  push(chunk: string): AiDelta[]
  /** 流结束时把残留缓冲吐出来（有些实现最后一帧不带换行） */
  flush(): AiDelta[]
} {
  let buffer = ''

  function drain(lines: string[]): AiDelta[] {
    const deltas: AiDelta[] = []
    for (const raw of lines) {
      const line = raw.trim()
      // `event:` 行不带内容（Anthropic 每帧都会先发一行），跳过即可 ——
      // 类型信息在 data 的 JSON 里也有一份
      if (line === '' || !line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        // 单帧解不开不该终止整段解读：跳过并继续
        continue
      }
      const delta = extract(parsed)
      if (delta !== null) deltas.push(delta)
    }
    return deltas
  }

  return {
    push(chunk) {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      return drain(lines)
    },
    flush() {
      const rest = buffer
      buffer = ''
      return rest === '' ? [] : drain([rest])
    },
  }
}

/**
 * 从错误响应体里挖出人能看懂的一句话。挖不到就原样截断。
 *
 * 401/404 额外附一句协议提示：**同一家服务的两种协议路径不同**，
 * 而选错协议的症状恰恰就是这两个码（火山方舟的 `/api/coding` 与 `/api/coding/v3`）。
 */
export function errorMessageOf(
  status: number,
  body: string,
  config?: Pick<AiConfig, 'baseUrl' | 'protocol'>
): string {
  let detail = body.trim().slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string' && message !== '') detail = message
  } catch {
    // 不是 JSON，用截断的原文
  }

  const hint =
    config !== undefined && (status === 401 || status === 403 || status === 404)
      ? `\n${protocolHint(config.protocol, config.baseUrl)}`
      : ''

  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：${detail}${hint}`
  if (status === 404) return `接口地址或模型名不对（HTTP 404）：${detail}${hint}`
  if (status === 429) return `对面限流（HTTP 429）：${detail}`
  return `HTTP ${status}：${detail}`
}

export interface AiClient {
  /**
   * 流式生成。逐段 yield 增量，`kind` 区分正文与思考链 —— 调用方**必须分开累积**
   * （见 protocols.ts 的 `AiDelta`）。
   */
  stream(request: AiChatRequest): AsyncGenerator<AiDelta, void, void>
}

export function createAiClient(transport: AiTransport): AiClient {
  return {
    async *stream(request) {
      const { config, apiKey, system, user, signal } = request
      if (config.model.trim() === '') throw new AiError('还没有填模型名', 'config')

      const adapter: ProtocolAdapter = adapterOf(config.protocol)
      const url = endpointUrl(config)
      if (apiKey !== null) {
        const refusal = insecureKeyTransport(url)
        if (refusal !== null) throw new AiError(refusal, 'config')
      }

      let response: AiHttpResponse
      try {
        response = await transport({
          url,
          headers: adapter.headers(apiKey),
          body: adapter.body(config, system, user),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw new AiError('已取消', 'canceled')
        throw new AiError(`连不上 ${url}：${messageOf(error)}`, 'network')
      }

      if (response.status < 200 || response.status >= 300) {
        let raw = ''
        try {
          for await (const chunk of response.chunks) {
            raw += chunk
            if (raw.length > 4000) break
          }
        } catch {
          // 错误体都读不出来，只能报状态码
        }
        const kind = response.status === 401 || response.status === 403 ? 'auth' : 'status'
        throw new AiError(errorMessageOf(response.status, raw, config), kind)
      }

      const parser = createSseParser(adapter.delta)
      /**
       * **「有没有输出」只认正文。**
       *
       * 选错协议的典型症状是「HTTP 200 但一个字都没有」（用 OpenAI 的取字逻辑读
       * Anthropic 的流，每一帧都取不出增量）。下面那段兜底靠这个标志抛错并点名协议。
       * 若把思考也算进来，选错协议时会退化成「只有思考、没有正文」而**不报错**，
       * 而那种状态在界面上看起来就是「模型想了半天什么也没说」。
       */
      let sawText = false
      /** 思考单独记：只影响首字超时的判定（推理模型先想几十秒是常态） */
      let sawThinking = false
      /**
       * 还没取到任何增量时留一份原文。
       *
       * 早先这里什么都不留，于是「200 但一个字都没有」这条错误**把唯一的证据扔了**
       * —— 用户和排查的人都只能靠猜。留 4KB 足够看清是非 SSE 的整包 JSON、
       * 是错误对象，还是一种没见过的帧。取到第一个增量后就不再累积（正文可能很长）。
       */
      let preview = ''
      const startedAt = Date.now()

      try {
        for await (const chunk of response.chunks) {
          // 首字超时单独看：连接建起来了却一直不吐字，与「全程超时」是两种故障。
          // **思考也算「吐字了」**：推理模型先想几十秒是常态，把它算成「没有输出」
          // 会让这类模型每次都被判超时
          if (!sawText && !sawThinking && Date.now() - startedAt > FIRST_TOKEN_TIMEOUT_MS) {
            throw new AiError(`等了 ${FIRST_TOKEN_TIMEOUT_MS / 1000} 秒没有任何输出`, 'timeout')
          }
          if (!sawText && preview.length < 4000) preview += chunk
          for (const delta of parser.push(chunk)) {
            if (delta.kind === 'text') sawText = true
            else sawThinking = true
            yield delta
          }
        }
        for (const delta of parser.flush()) {
          if (delta.kind === 'text') sawText = true
          else sawThinking = true
          yield delta
        }
      } catch (error) {
        if (error instanceof AiError) throw error
        if (signal.aborted) throw new AiError('已取消', 'canceled')
        throw new AiError(`读取响应中断：${messageOf(error)}`, 'network')
      }

      if (sawText) return

      // ── 一条正文都没取到 ────────────────────────────────────────────
      // 注意这里**只看正文**：思考出了一堆但正文一个字没有，仍然要走到下面报错，
      // 那正是「协议选错了」最常见的形状之一（见 sawText 的注释）。
      //
      // 先试「对面根本没按流式返回」这一种：有些兼容网关不认 stream: true，
      // 照样回一整个 JSON。内容其实就在那儿，不该报成空
      const whole = tryParseJson(preview)
      if (whole !== null) {
        const text = adapter.fullText(whole)
        if (text !== null) {
          yield { kind: 'text', value: text }
          return
        }
        // 是 JSON 但取不出文本 —— 多半是错误对象，把里面那句话捞出来比原样贴强
        const message = errorMessageOf(200, preview, config)
        throw new AiError(`对面返回了 200，但没有可用内容：${message}`, 'status')
      }

      throw new AiError(
        (sawThinking
          ? // 这一种最容易被误读成「模型没想好」：思考链取到了，正文一个字都没有。
            // 多半是模型把 max_tokens 全花在思考上了，或者思考块没有正常收尾
            `对面只返回了思考过程，没有正文。可能是 max_tokens（当前 ${config.maxTokens}）` +
            `全被思考用光了 —— 调大它，或换一个不带思考链的模型。\n`
          : `对面返回了 200，但没有解析出任何内容。\n`) +
          `${protocolHint(config.protocol, config.baseUrl)}\n` +
          `实际发到：${url}\n` +
          `响应开头：${preview.trim().slice(0, 300) || '(空)'}`,
        'status'
      )
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 整包是不是一个 JSON（即「对面没按流式返回」）。不是就返回 null */
function tryParseJson(raw: string): unknown {
  const text = raw.trim()
  if (text === '' || (!text.startsWith('{') && !text.startsWith('['))) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 生产传输层：undici，动态 import（与 `net/http.ts` 的 `createUndiciTransport()` 同理，
 * 这一层在 Vitest 里不会被加载）。
 *
 * 自带**全程**超时；首字超时在上面按到达时刻判。
 */
export function createUndiciAiTransport(timeoutMs: number): AiTransport {
  return async ({ url, headers, body, signal }) => {
    const { request } = await import('undici')
    const response = await request(url, {
      method: 'POST',
      headers,
      body,
      signal,
      headersTimeout: FIRST_TOKEN_TIMEOUT_MS,
      bodyTimeout: timeoutMs,
    })

    const decoder = new TextDecoder('utf-8')
    async function* chunks(): AsyncGenerator<string, void, void> {
      for await (const piece of response.body) {
        // stream: true 意味着多字节字符可能被切开 —— decode 必须带 stream 标志
        yield decoder.decode(piece as Uint8Array, { stream: true })
      }
      const tail = decoder.decode()
      if (tail !== '') yield tail
    }

    return { status: response.statusCode, chunks: chunks() }
  }
}
