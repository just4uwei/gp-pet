/**
 * 流式客户端与两种协议（src/main/ai/client.ts + protocols.ts）。
 *
 * 盯的是四处「静默失真」：
 *
 *   1. **SSE 必须按行缓冲。** 一个 `data:` 帧被 TCP 切成两半是常态，按到达的分片
 *      直接 JSON.parse 会随机丢字，症状是「偶尔解读到一半就断」—— 界面上看不出原因
 *   2. **200 但一个字都没有要报错**，不能静默返回空串（协议选错时就是这样）
 *   3. **非回环地址 + 明文 http + 带 key = 拒发**，不能把钥匙裸奔发出去
 *   4. **Anthropic 的 system 是顶层字段**，塞进 messages 会被拒（它的 role 只有 user/assistant）
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AiError,
  createAiClient,
  createSseParser,
  endpointUrl,
  errorMessageOf,
  insecureKeyTransport,
} from '@main/ai/client'
import {
  ANTHROPIC_ADAPTER,
  OPENAI_ADAPTER,
  detectProtocol,
  protocolHint,
} from '@main/ai/protocols'
import type { AiConfig, AiTransport } from '@main/ai/types'

const CONFIG: AiConfig = {
  enabled: true,
  baseUrl: 'https://example.com/v1',
  protocol: 'openai',
  model: 'test-model',
  timeoutMs: 30_000,
  maxTokens: 512,
}

/** OpenAI 兼容的一帧 */
function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

/** Anthropic 的一帧（真实形状：event 行 + data 行） */
function aFrame(text: string): string {
  const payload = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
  return `event: content_block_delta\ndata: ${JSON.stringify(payload)}\n\n`
}

function transportOf(status: number, pieces: string[]): AiTransport {
  return () =>
    Promise.resolve({
      status,
      chunks: (async function* () {
        for (const piece of pieces) yield piece
      })(),
    })
}

async function collect(
  pieces: string[],
  status = 200,
  config: AiConfig = CONFIG,
  apiKey: string | null = 'sk-x'
): Promise<string> {
  const client = createAiClient(transportOf(status, pieces))
  let text = ''
  for await (const delta of client.stream({
    config,
    apiKey,
    system: 's',
    user: 'u',
    signal: new AbortController().signal,
  })) {
    text += delta
  }
  return text
}

describe('createSseParser', () => {
  const openai = (): ReturnType<typeof createSseParser> => createSseParser(OPENAI_ADAPTER.delta)

  it('一个帧被切成两半也要拼得回来', () => {
    const parser = openai()
    const whole = frame('你好')
    const cut = Math.floor(whole.length / 2)

    expect(parser.push(whole.slice(0, cut))).toEqual([])
    expect(parser.push(whole.slice(cut))).toEqual(['你好'])
  })

  it('一次到达多个帧要全部吐出来', () => {
    expect(openai().push(`${frame('a')}${frame('b')}${frame('c')}`)).toEqual(['a', 'b', 'c'])
  })

  it('[DONE] 与非 data 行忽略掉', () => {
    expect(openai().push(': keep-alive\n\ndata: [DONE]\n\n')).toEqual([])
  })

  it('单帧 JSON 坏掉时跳过它而不是终止整段', () => {
    expect(openai().push(`data: {坏掉的\n\n${frame('后面还有')}`)).toEqual(['后面还有'])
  })

  it('flush 吐出最后一帧 —— 有些实现末帧不带换行', () => {
    const parser = openai()
    parser.push(`data: ${JSON.stringify({ choices: [{ delta: { content: '尾' } }] })}`)
    expect(parser.flush()).toEqual(['尾'])
  })

  it('Anthropic：只取 text_delta，thinking_delta 与 ping 一律丢掉', () => {
    const parser = createSseParser(ANTHROPIC_ADAPTER.delta)
    const thinking = `data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: '不该出现在给用户的解释里' },
    })}\n\n`
    const ping = 'event: ping\ndata: {"type":"ping"}\n\n'
    const start = 'event: message_start\ndata: {"type":"message_start"}\n\n'

    expect(parser.push(`${start}${ping}${thinking}${aFrame('正文')}`)).toEqual(['正文'])
  })

  it('两种协议的分帧共用一份：Anthropic 的帧被切两半也拼得回来', () => {
    const parser = createSseParser(ANTHROPIC_ADAPTER.delta)
    const whole = aFrame('切开我')
    const cut = Math.floor(whole.length / 2)
    expect(parser.push(whole.slice(0, cut))).toEqual([])
    expect(parser.push(whole.slice(cut))).toEqual(['切开我'])
  })
})

describe('detectProtocol', () => {
  it('火山方舟：/api/coding 是 Anthropic，加了 /v3 才是 OpenAI 兼容', () => {
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/coding')).toBe('anthropic')
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/coding/')).toBe('anthropic')
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/coding/v3')).toBe('openai')
  })

  it('火山方舟的 Agent Plan 同理（/api/plan 与 /api/plan/v3）', () => {
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/plan')).toBe('anthropic')
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/plan/v3')).toBe('openai')
  })

  it('真 Anthropic 与 /anthropic 后缀的代理', () => {
    expect(detectProtocol('https://api.anthropic.com')).toBe('anthropic')
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/v3/anthropic')).toBe('anthropic')
  })

  it('用户把完整路径粘进来时按路径判，这是最可靠的信号', () => {
    expect(detectProtocol('https://x.com/api/coding/v1/messages')).toBe('anthropic')
    expect(detectProtocol('https://x.com/v1/chat/completions')).toBe('openai')
  })

  it('其余一律 OpenAI 兼容 —— 国内绝大多数服务是这个形状', () => {
    expect(detectProtocol('https://api.deepseek.com/v1')).toBe('openai')
    expect(detectProtocol('http://127.0.0.1:11434/v1')).toBe('openai')
    expect(detectProtocol('')).toBe('openai')
    expect(detectProtocol('不是 URL')).toBe('openai')
  })
})

describe('endpointUrl', () => {
  it('按协议拼后缀', () => {
    expect(endpointUrl({ baseUrl: 'https://a.com/v1', protocol: 'openai' })).toBe(
      'https://a.com/v1/chat/completions'
    )
    expect(
      endpointUrl({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', protocol: 'anthropic' })
    ).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages')
  })

  it('末尾斜杠与已经带全路径的写法都不重复拼', () => {
    expect(endpointUrl({ baseUrl: 'https://a.com/v1/', protocol: 'openai' })).toBe(
      'https://a.com/v1/chat/completions'
    )
    expect(
      endpointUrl({ baseUrl: 'https://a.com/v1/chat/completions', protocol: 'openai' })
    ).toBe('https://a.com/v1/chat/completions')
    expect(endpointUrl({ baseUrl: 'https://a.com/v1/messages', protocol: 'anthropic' })).toBe(
      'https://a.com/v1/messages'
    )
  })

  it('空地址报「还没填」而不是拼出一个坏 URL', () => {
    expect(() => endpointUrl({ baseUrl: '', protocol: 'openai' })).toThrow(AiError)
  })
})

describe('协议报文形状', () => {
  it('OpenAI：system 是 messages 里的一条', () => {
    const body = JSON.parse(OPENAI_ADAPTER.body(CONFIG, 'SYS', 'USER')) as {
      messages: { role: string; content: string }[]
      system?: unknown
    }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(body.system).toBeUndefined()
  })

  it('Anthropic：system 是**顶层字段**，messages 里只有 user', () => {
    const body = JSON.parse(ANTHROPIC_ADAPTER.body(CONFIG, 'SYS', 'USER')) as {
      messages: { role: string }[]
      system: string
    }
    expect(body.system).toBe('SYS')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.role).toBe('user')
    // role 只有 user / assistant，塞 system 进去会被拒
    expect(body.messages.some((m) => m.role === 'system')).toBe(false)
  })

  it('鉴权头：OpenAI 用 Bearer，Anthropic 用 x-api-key + 版本头', () => {
    expect(OPENAI_ADAPTER.headers('sk-x').Authorization).toBe('Bearer sk-x')
    const anthropic = ANTHROPIC_ADAPTER.headers('sk-x')
    expect(anthropic['x-api-key']).toBe('sk-x')
    expect(anthropic['anthropic-version']).toBe('2023-06-01')
    // 只发一种凭据：真 Anthropic 同时收到两种会拒绝
    expect(anthropic.Authorization).toBeUndefined()
  })

  it('没有 key 时两种协议都不发鉴权头', () => {
    expect(OPENAI_ADAPTER.headers(null).Authorization).toBeUndefined()
    expect(ANTHROPIC_ADAPTER.headers(null)['x-api-key']).toBeUndefined()
  })
})

describe('insecureKeyTransport', () => {
  it('本机 http 放行 —— 本地 Ollama 就是这个形状', () => {
    expect(insecureKeyTransport('http://127.0.0.1:11434/v1/chat/completions')).toBeNull()
    expect(insecureKeyTransport('http://localhost:8000/v1/chat/completions')).toBeNull()
  })

  it('非本机 http 拒发', () => {
    expect(insecureKeyTransport('http://api.example.com/v1/chat/completions')).toContain('拒绝')
  })

  it('https 一律放行', () => {
    expect(insecureKeyTransport('https://api.example.com/v1/chat/completions')).toBeNull()
  })
})

describe('errorMessageOf', () => {
  it('从 OpenAI 风格错误体里挖出那句话', () => {
    const message = errorMessageOf(401, JSON.stringify({ error: { message: 'Invalid API key' } }))
    expect(message).toContain('鉴权失败')
    expect(message).toContain('Invalid API key')
  })

  it('不是 JSON 就截断原文', () => {
    expect(errorMessageOf(502, '<html>bad gateway</html>')).toContain('bad gateway')
  })

  it('401/404 时点名协议 —— 选错协议的症状恰恰就是这两个码', () => {
    const message = errorMessageOf(404, '{}', {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      protocol: 'openai',
    })
    expect(message).toContain('/v3')
    expect(message).toContain('Anthropic')
  })

  it('429 不点协议 —— 限流与协议无关，加一句只会误导', () => {
    const message = errorMessageOf(429, '{}', { baseUrl: 'https://x.com/v1', protocol: 'openai' })
    expect(message).not.toContain('协议')
  })
})

describe('protocolHint', () => {
  it('协议与地址不一致时才叫人切协议，并指出该切到哪一个', () => {
    const wrongOnArk = protocolHint('openai', 'https://ark.cn-beijing.volces.com/api/coding')
    expect(wrongOnArk).toContain('切到「Anthropic 兼容」')
    expect(wrongOnArk).toContain('/v3')

    const wrongOnArkV3 = protocolHint('anthropic', 'https://ark.cn-beijing.volces.com/api/plan/v3')
    expect(wrongOnArkV3).toContain('切到「OpenAI 兼容」')
  })

  /**
   * 真实回归：用户地址是 `/api/coding`、协议**已经**是 anthropic，报错时却被告知
   * 「请把协议切到 Anthropic 兼容」—— 指着他已经在用的那一个。
   * 把人往错误方向指比不给提示更糟。
   */
  it('协议已经对上时，绝不再叫人切协议', () => {
    const hint = protocolHint('anthropic', 'https://ark.cn-beijing.volces.com/api/coding')
    expect(hint).not.toContain('切到')
    expect(hint).toContain('匹配')
    // 转而指向真正的两个嫌疑：模型名别名、两种订阅的 key 不通用
    expect(hint).toContain('模型名')
    expect(hint).toContain('互不通用')
  })

  it('非方舟地址：对上了说「问题不在这里」，没对上才叫人切', () => {
    expect(protocolHint('openai', 'https://api.deepseek.com/v1')).toContain('匹配')
    const mismatch = protocolHint('anthropic', 'https://api.deepseek.com/v1')
    expect(mismatch).toContain('切过去')
    expect(mismatch).toContain('OpenAI 兼容')
  })
})

describe('createAiClient', () => {
  it('OpenAI：把分片拼成完整文本', async () => {
    expect(await collect([frame('一'), frame('二'), 'data: [DONE]\n\n'])).toBe('一二')
  })

  it('Anthropic：把分片拼成完整文本', async () => {
    const config: AiConfig = {
      ...CONFIG,
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      protocol: 'anthropic',
      model: 'ark-code-latest',
    }
    const tail = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    expect(await collect([aFrame('甲'), aFrame('乙'), tail], 200, config)).toBe('甲乙')
  })

  it('协议决定发到哪个 URL 与什么头', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = []
    const transport: AiTransport = (request) => {
      seen.push({ url: request.url, headers: request.headers, body: request.body })
      return Promise.resolve({
        status: 200,
        chunks: (async function* () {
          yield aFrame('ok')
        })(),
      })
    }
    const client = createAiClient(transport)
    // 只关心发出去的请求，正文顺带确认能取到
    for await (const delta of client.stream({
      config: {
        ...CONFIG,
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
        protocol: 'anthropic',
      },
      apiKey: 'ark-key',
      system: 's',
      user: 'u',
      signal: new AbortController().signal,
    })) {
      expect(delta).toBe('ok')
    }

    expect(seen[0]?.url).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages')
    expect(seen[0]?.headers['x-api-key']).toBe('ark-key')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({ system: 's', stream: true })
  })

  it('200 但一个字都没有 → 报错，不静默返回空串', async () => {
    await expect(collect(['data: [DONE]\n\n'])).rejects.toThrow('没有解析出任何内容')
  })

  /**
   * 真实回归：这条错误早先**把唯一的证据扔了** —— 只说「没有任何内容」，
   * 于是用户和排查的人都只能靠猜。响应开头与实际发到的地址必须带出来。
   */
  it('零增量时把实际地址与响应开头带进错误 —— 不许扔掉证据', async () => {
    const weird = 'event: some_unknown_event\ndata: {"type":"nothing_we_know"}\n\n'
    await expect(collect([weird])).rejects.toThrow(/响应开头[\s\S]*nothing_we_know/)
    await expect(collect([weird])).rejects.toThrow('实际发到：https://example.com/v1/chat/completions')
  })

  it('用 OpenAI 协议读 Anthropic 的流会一个字都取不到 —— 必须报错而不是空白', async () => {
    // 这正是协议选错时的真实症状：HTTP 200、有数据流、但取不出增量
    await expect(collect([aFrame('取不到')])).rejects.toThrow('没有解析出任何内容')
  })

  it('对面不认 stream:true、回了整包 JSON 时照样取得到文（OpenAI 形状）', async () => {
    const whole = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整包回来的正文' } }] })
    expect(await collect([whole])).toBe('整包回来的正文')
  })

  it('对面不认 stream:true、回了整包 JSON 时照样取得到文（Anthropic 形状）', async () => {
    const config: AiConfig = { ...CONFIG, protocol: 'anthropic' }
    const whole = JSON.stringify({
      type: 'message',
      content: [
        { type: 'thinking', thinking: '不该出现' },
        { type: 'text', text: '整包' },
        { type: 'text', text: '回来的正文' },
      ],
    })
    expect(await collect([whole], 200, config)).toBe('整包回来的正文')
  })

  it('200 但整包是个错误对象时，把里面那句话捞出来而不是原样贴', async () => {
    const body = JSON.stringify({ error: { message: 'model not found: glm-5.2' } })
    await expect(collect([body])).rejects.toThrow('model not found: glm-5.2')
  })

  it('非 2xx → 读出错误体并按类型分档', async () => {
    await expect(
      collect([JSON.stringify({ error: { message: 'no such model' } })], 404)
    ).rejects.toThrow('接口地址或模型名不对')
  })

  it('非本机 http 带 key 时一个字节都不发出去', async () => {
    const transport = vi.fn<AiTransport>()
    const client = createAiClient(transport)
    const iterator = client.stream({
      config: { ...CONFIG, baseUrl: 'http://api.example.com/v1' },
      apiKey: 'sk-x',
      system: 's',
      user: 'u',
      signal: new AbortController().signal,
    })
    await expect(iterator.next()).rejects.toThrow('拒绝')
    expect(transport).not.toHaveBeenCalled()
  })

  it('没有 key 时不发 Authorization 头 —— 有些本地实现见到空 Bearer 会 400', async () => {
    const seen: Record<string, string>[] = []
    const transport: AiTransport = (request) => {
      seen.push(request.headers)
      return Promise.resolve({
        status: 200,
        chunks: (async function* () {
          yield frame('ok')
        })(),
      })
    }
    const client = createAiClient(transport)
    // 只关心请求头，正文丢掉
    for await (const delta of client.stream({
      config: { ...CONFIG, baseUrl: 'http://127.0.0.1:11434/v1' },
      apiKey: null,
      system: 's',
      user: 'u',
      signal: new AbortController().signal,
    })) {
      expect(delta).toBe('ok')
    }
    expect(seen[0]).not.toHaveProperty('Authorization')
  })

  it('模型名为空时直接报「还没填模型名」，不去发请求', async () => {
    const transport = vi.fn<AiTransport>()
    const client = createAiClient(transport)
    await expect(
      client
        .stream({
          config: { ...CONFIG, model: '  ' },
          apiKey: 'sk-x',
          system: 's',
          user: 'u',
          signal: new AbortController().signal,
        })
        .next()
    ).rejects.toThrow('模型名')
    expect(transport).not.toHaveBeenCalled()
  })
})
