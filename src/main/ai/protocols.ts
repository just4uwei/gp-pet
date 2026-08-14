/**
 * 两种接口协议的适配（P2 续，2026-08-13）。
 *
 * 一开始只做了 OpenAI 兼容那一种，因为国内绝大多数服务都是那个形状。
 * 加第二种是被一个具体地址逼出来的：**火山方舟的 `…/api/coding` 是 Anthropic 协议**，
 * 而它的 OpenAI 兼容路径要多一截 `/v3`（`…/api/coding/v3`）——
 * 两条路都真实存在（实测都返回 401 而不是 404），用户拿到哪条全看他从哪个页面复制。
 *
 * ## 两种协议实际只差四个点
 *
 * | | OpenAI 兼容 | Anthropic 兼容 |
 * |---|---|---|
 * | 路径 | `{base}/chat/completions` | `{base}/v1/messages` |
 * | 鉴权头 | `Authorization: Bearer` | `x-api-key`（+ `anthropic-version`） |
 * | system | `messages[0]` 里的一条 | **顶层 `system` 字段** |
 * | 增量 | `choices[0].delta.content` | `delta.text`（且 `type` 要是 `text_delta`） |
 *
 * SSE 的**分帧**（按行、`data:` 前缀）两边一样，所以只把「怎么从一帧里取字」参数化，
 * 分帧逻辑仍然共用一份 —— 那部分才是容易写错的地方（一帧被 TCP 切两半）。
 *
 * ## 鉴权头为什么只发一个
 *
 * 实测火山方舟 `x-api-key` 与 `Authorization: Bearer` **都认**
 * （两种都回「API key format is incorrect」而不是「missing」）。
 * 但真 Anthropic 在同时收到两种凭据时会拒绝请求，所以这里只发 `x-api-key` ——
 * 它是唯一一个两边都能用的选择。
 */

import type { AiConfig, AiProtocol } from './types'
import { normalizeBaseUrl } from './config'

export interface ProtocolAdapter {
  readonly id: AiProtocol
  /** 人能看懂的名字，用在错误提示里 */
  readonly label: string
  endpoint(baseUrl: string): string
  headers(apiKey: string | null): Record<string, string>
  body(config: AiConfig, system: string, user: string): string
  /** 从一个已 JSON.parse 的 SSE 帧里取文本增量；取不到返回 null */
  delta(parsed: unknown): string | null
  /**
   * 从一个**非流式**响应体里取全文。
   *
   * 存在的理由：有些兼容网关**不认 `stream: true`**，照样返回一整个 JSON。
   * 那时一个 `data:` 行都没有，按流式读会得到「200 但一个字都没有」——
   * 而内容其实就在那儿。取不到返回 null。
   */
  fullText(parsed: unknown): string | null
}

function tail(base: string, suffix: string): string {
  // 用户可能把完整路径整个粘进来，此时不要再拼一次
  return base.endsWith(suffix) ? base : `${base}${suffix}`
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

// ─────────────────────────── OpenAI 兼容 ───────────────────────────

export const OPENAI_ADAPTER: ProtocolAdapter = {
  id: 'openai',
  label: 'OpenAI 兼容',

  endpoint(baseUrl) {
    return tail(normalizeBaseUrl(baseUrl), '/chat/completions')
  },

  headers(apiKey) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }
    // Ollama 之类不需要 key；缺省时不发这个头（有些实现见到空 Bearer 会 400）
    if (apiKey !== null) headers.Authorization = `Bearer ${apiKey}`
    return headers
  },

  body(config, system, user) {
    return JSON.stringify({
      model: config.model.trim(),
      stream: true,
      max_tokens: config.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })
  },

  delta(parsed) {
    const root = record(parsed)
    const choices = root?.choices
    if (!Array.isArray(choices) || choices.length === 0) return null
    const delta = record(record(choices[0])?.delta)
    const content = delta?.content
    return typeof content === 'string' && content !== '' ? content : null
  },

  fullText(parsed) {
    const root = record(parsed)
    const choices = root?.choices
    if (!Array.isArray(choices) || choices.length === 0) return null
    const content = record(record(choices[0])?.message)?.content
    return typeof content === 'string' && content !== '' ? content : null
  },
}

// ─────────────────────────── Anthropic 兼容 ───────────────────────────

/** Anthropic Messages API 的版本头。这是必填项，缺了会 400 */
export const ANTHROPIC_VERSION = '2023-06-01'

export const ANTHROPIC_ADAPTER: ProtocolAdapter = {
  id: 'anthropic',
  label: 'Anthropic 兼容',

  endpoint(baseUrl) {
    return tail(normalizeBaseUrl(baseUrl), '/v1/messages')
  },

  headers(apiKey) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    // 只发 x-api-key：方舟两种都认，而真 Anthropic 同时收到两种凭据会拒绝
    if (apiKey !== null) headers['x-api-key'] = apiKey
    return headers
  },

  body(config, system, user) {
    return JSON.stringify({
      model: config.model.trim(),
      stream: true,
      max_tokens: config.maxTokens,
      // ⚠ system 是**顶层字段**，不是 messages 里的一条。
      // 塞进 messages 会被拒（Anthropic 的 role 只有 user / assistant）
      system,
      messages: [{ role: 'user', content: user }],
    })
  },

  delta(parsed) {
    const root = record(parsed)
    if (root?.type !== 'content_block_delta') return null
    const delta = record(root.delta)
    // **只取 text_delta**：thinking_delta 是模型的思考过程，不该出现在给用户的解释里；
    // input_json_delta 是工具调用参数，我们不发工具
    if (delta?.type !== 'text_delta') return null
    const text = delta.text
    return typeof text === 'string' && text !== '' ? text : null
  },

  fullText(parsed) {
    const blocks = record(parsed)?.content
    if (!Array.isArray(blocks)) return null
    // content 是块数组，可能混着 thinking / tool_use —— 只拼 text
    const text = blocks
      .map((block) => {
        const item = record(block)
        return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
      })
      .join('')
    return text === '' ? null : text
  },
}

export const ADAPTERS: Record<AiProtocol, ProtocolAdapter> = {
  openai: OPENAI_ADAPTER,
  anthropic: ANTHROPIC_ADAPTER,
}

export function adapterOf(protocol: AiProtocol): ProtocolAdapter {
  return ADAPTERS[protocol]
}

// ─────────────────────────── 协议识别 ───────────────────────────

/**
 * 从 base URL 猜协议。**猜错的代价是一次 401/404**，不是静默失真，
 * 所以这里可以激进一点 —— 而且猜的结果会显示在设置页的选择器上，用户看得见也改得回。
 *
 * 规则按可靠性排序，第一条命中即返回：
 */
export function detectProtocol(baseUrl: string): AiProtocol {
  const base = normalizeBaseUrl(baseUrl)
  if (base === '') return 'openai'

  let url: URL
  try {
    url = new URL(base)
  } catch {
    return 'openai'
  }
  const path = url.pathname.replace(/\/+$/, '')

  // ① 用户把完整路径粘进来了 —— 最可靠的信号
  if (path.endsWith('/v1/messages')) return 'anthropic'
  if (path.endsWith('/chat/completions')) return 'openai'

  // ② 真 Anthropic
  if (url.hostname === 'api.anthropic.com') return 'anthropic'

  // ③ 路径显式点名（Ark 还有 `…/api/v3/anthropic` 这种别名，别的代理也常用这个后缀）
  if (path.endsWith('/anthropic')) return 'anthropic'

  // ④ 火山方舟：`/api/coding` 与 `/api/plan` 是 Anthropic 协议，
  //    加了 `/v3` 才是 OpenAI 兼容。这一条是这次改动的直接起因
  if (/\/api\/(coding|plan)$/.test(path)) return 'anthropic'

  // ⑤ 其余一律按 OpenAI 兼容 —— 国内绝大多数服务都是这个形状
  return 'openai'
}

/**
 * 地址层面的**风险提示**（不是错误，是「你可能不该用这个地址」）。
 *
 * 火山方舟的 Coding Plan / Agent Plan 套餐额度**只允许在 AI 编程工具里用**，
 * 拿这套 base URL + key 去做别的 API 调用可能被判定为滥用，
 * 后果是订阅停用甚至封号。蹲点是行情信号解释器，不是编程工具 ——
 * 用户很可能只是「手边有这把 key」就填进来了，而代价他事先不知道。
 *
 * 这一条**必须摆在界面上**：一个能让人被封号的默认路径，不该只写在文档里。
 * 返回 null 表示这个地址没有已知风险。
 */
export function endpointAdvisory(baseUrl: string): string | null {
  const base = normalizeBaseUrl(baseUrl)
  if (!/\/api\/(coding|plan)(\/v3)?$/.test(base)) return null
  return (
    '这是火山方舟的编程套餐专用地址。它的额度按官方说明**只在 AI 编程工具里生效**，' +
    '用于其他 API 调用可能被判定为滥用，导致订阅停用或账号封禁 —— ' +
    '本应用不是编程工具。建议改用方舟的通用接口 ' +
    'https://ark.cn-beijing.volces.com/api/v3（OpenAI 兼容，按量计费），' +
    '并换一把普通的方舟 API Key。'
  )
}

/**
 * 出错时给一句能直接照做的话。
 *
 * **必须先看当前协议对不对，再决定说什么。** 早先这个函数只看地址就无脚本地喊
 * 「请切到 Anthropic 兼容」—— 于是一个**已经**在用 Anthropic 协议的用户报错时，
 * 被告知去切到他已经在用的那一个。提示词把人往错误方向指，比不给提示更糟。
 */
export function protocolHint(protocol: AiProtocol, baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl)
  const detected = detectProtocol(base)
  const ark = /\/api\/(coding|plan)(\/v3)?$/.exec(base)

  // ── 协议与地址不一致：这才是「切协议」有意义的唯一情形 ──────────────
  if (detected !== protocol) {
    if (ark !== null) {
      const plan = ark[1]
      return ark[2] === undefined
        ? `火山方舟的 ${plan} 路径不带 /v3 时是 Anthropic 协议，而当前按「${adapterOf(protocol).label}」发 ——` +
            `请把协议切到「Anthropic 兼容」，或把地址改成 ${base}/v3 走 OpenAI 兼容。`
        : `火山方舟的 ${plan} 路径带 /v3 时是 OpenAI 兼容，而当前按「${adapterOf(protocol).label}」发 ——` +
            `请把协议切到「OpenAI 兼容」。`
    }
    return `这个地址看起来是「${adapterOf(detected).label}」，而当前按「${adapterOf(protocol).label}」发 —— 先把协议切过去再试。`
  }

  // ── 协议与地址一致：问题在别处，别再让人去动协议 ────────────────────
  if (ark !== null) {
    return (
      `协议与地址是匹配的（${adapterOf(protocol).label}），问题多半不在这里。两处最常见：` +
      `① **模型名**要用方舟控制台给的别名（如 ark-code-latest / glm-4.7 / kimi-k2.5 / deepseek-v3.2），` +
      `不是通用的模型名，也不是原生推理接口那种 ep-… 端点 ID；` +
      `② coding 与 plan 是两种订阅，**key 互不通用**，用错会一直报鉴权失败。`
    )
  }
  return (
    `协议与地址是匹配的（${adapterOf(protocol).label}），问题多半不在这里 ——` +
    `先核对模型名与 API key 是不是这个服务的。`
  )
}
