/**
 * OpenAI 兼容 `/chat/completions` 的流式客户端（P2）。
 *
 * ## 为什么不复用 net/http.ts
 *
 * 那一层只有 `get()`、默认 3s 超时、GBK 解码，**而且它的限流器与行情取数共用**。
 * 一次 40 秒的 LLM 调用挂上去会把 tick 饿死 —— 盘中每 30 秒要取一轮行情，
 * 而全局并发只有 4。所以这里另起一套：POST + SSE、自己的超时、并发 1。
 *
 * ## 为什么只做 OpenAI 兼容这一种形状
 *
 * DeepSeek、Kimi、智谱、通义、Ollama、OpenRouter 全在这一形状里，一份实现全覆盖。
 * **Anthropic 没有 OpenAI 兼容端点**，要支持 Claude 得另写一个走 `/v1/messages` 的
 * adapter（`x-api-key` + `anthropic-version` 头，SSE 事件形状也不同）。
 * 这一轮不做，`AiTransport` 与本文件的分层留着口子。
 *
 * ## 明文 http 不发 key
 *
 * 本地 Ollama 是 `http://127.0.0.1:11434/v1`，所以 http 不能一刀禁。
 * 但对**非回环地址**用 http 带 key，等于把钥匙裸奔发出去 —— 这一条在下面硬拒。
 */

import type { AiConfig, AiHttpResponse, AiTransport } from './types'
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
 * 拼 endpoint。base URL 已经带 `/v1` 时不重复追加 ——
 * 用户填 `https://api.deepseek.com/v1` 与 `https://api.deepseek.com` 都要能用。
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl)
  if (base === '') throw new AiError('还没有填接口地址', 'config')
  if (/\/chat\/completions$/.test(base)) return base
  return `${base}/chat/completions`
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
 */
export function createSseParser(): {
  push(chunk: string): string[]
  /** 流结束时把残留缓冲吐出来（有些实现最后一帧不带换行） */
  flush(): string[]
} {
  let buffer = ''

  function drain(lines: string[]): string[] {
    const deltas: string[] = []
    for (const raw of lines) {
      const line = raw.trim()
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
      const delta = deltaOf(parsed)
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

function deltaOf(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (first === null || typeof first !== 'object') return null
  const delta = (first as { delta?: unknown }).delta
  if (delta === null || typeof delta !== 'object') return null
  const content = (delta as { content?: unknown }).content
  return typeof content === 'string' && content !== '' ? content : null
}

/** 从错误响应体里挖出人能看懂的一句话。挖不到就原样截断 */
export function errorMessageOf(status: number, body: string): string {
  let detail = body.trim().slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    const message = parsed.error?.message ?? parsed.message
    if (typeof message === 'string' && message !== '') detail = message
  } catch {
    // 不是 JSON，用截断的原文
  }
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：${detail}`
  if (status === 404) return `接口地址或模型名不对（HTTP 404）：${detail}`
  if (status === 429) return `对面限流（HTTP 429）：${detail}`
  return `HTTP ${status}：${detail}`
}

export interface AiClient {
  /** 流式生成。逐段 yield 文本增量 */
  stream(request: AiChatRequest): AsyncGenerator<string, void, void>
}

export function createAiClient(transport: AiTransport): AiClient {
  return {
    async *stream(request) {
      const { config, apiKey, system, user, signal } = request
      if (config.model.trim() === '') throw new AiError('还没有填模型名', 'config')

      const url = chatCompletionsUrl(config.baseUrl)
      if (apiKey !== null) {
        const refusal = insecureKeyTransport(url)
        if (refusal !== null) throw new AiError(refusal, 'config')
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      }
      // Ollama 之类不需要 key，缺省时就不发这个头（有些实现见到空 Bearer 会 400）
      if (apiKey !== null) headers.Authorization = `Bearer ${apiKey}`

      const body = JSON.stringify({
        model: config.model.trim(),
        stream: true,
        max_tokens: config.maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      })

      let response: AiHttpResponse
      try {
        response = await transport({ url, headers, body, signal })
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
        throw new AiError(errorMessageOf(response.status, raw), kind)
      }

      const parser = createSseParser()
      let sawAny = false
      let first = true
      const startedAt = Date.now()

      try {
        for await (const chunk of response.chunks) {
          // 首字超时单独看：连接建起来了却一直不吐字，与「全程超时」是两种故障
          if (first && !sawAny && Date.now() - startedAt > FIRST_TOKEN_TIMEOUT_MS) {
            throw new AiError(`等了 ${FIRST_TOKEN_TIMEOUT_MS / 1000} 秒没有任何输出`, 'timeout')
          }
          for (const delta of parser.push(chunk)) {
            sawAny = true
            first = false
            yield delta
          }
        }
        for (const delta of parser.flush()) {
          sawAny = true
          yield delta
        }
      } catch (error) {
        if (error instanceof AiError) throw error
        if (signal.aborted) throw new AiError('已取消', 'canceled')
        throw new AiError(`读取响应中断：${messageOf(error)}`, 'network')
      }

      if (!sawAny) {
        // 200 但一个字都没有：多半是 base URL 指到了别的服务，或模型名不对而对面静默返回空
        throw new AiError('对面返回了 200，但没有任何内容 —— 检查接口地址与模型名', 'status')
      }
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
