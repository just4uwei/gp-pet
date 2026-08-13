/**
 * OpenAI 兼容流式客户端（src/main/ai/client.ts）。
 *
 * 盯的是三处「静默失真」：
 *
 *   1. **SSE 必须按行缓冲。** 一个 `data:` 帧被 TCP 切成两半是常态，按到达的分片
 *      直接 JSON.parse 会随机丢字，症状是「偶尔解读到一半就断」—— 从界面上看不出原因
 *   2. **200 但一个字都没有要报错**，不能静默返回空串（base URL 指到别的服务时就是这样）
 *   3. **非回环地址 + 明文 http + 带 key = 拒发**，不能把钥匙裸奔发出去
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AiError,
  chatCompletionsUrl,
  createAiClient,
  createSseParser,
  errorMessageOf,
  insecureKeyTransport,
} from '@main/ai/client'
import type { AiConfig, AiTransport } from '@main/ai/types'

const CONFIG: AiConfig = {
  enabled: true,
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
  timeoutMs: 30_000,
  maxTokens: 512,
}

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

/** 把若干字符串当成一次响应的分片流 */
function transportOf(status: number, pieces: string[]): AiTransport {
  return () =>
    Promise.resolve({
      status,
      chunks: (async function* () {
        for (const piece of pieces) yield piece
      })(),
    })
}

async function collect(pieces: string[], status = 200, apiKey: string | null = 'sk-x'): Promise<string> {
  const client = createAiClient(transportOf(status, pieces))
  let text = ''
  for await (const delta of client.stream({
    config: CONFIG,
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
  it('一个帧被切成两半也要拼得回来', () => {
    const parser = createSseParser()
    const whole = frame('你好')
    const cut = Math.floor(whole.length / 2)

    expect(parser.push(whole.slice(0, cut))).toEqual([])
    expect(parser.push(whole.slice(cut))).toEqual(['你好'])
  })

  it('一次到达多个帧要全部吐出来', () => {
    const parser = createSseParser()
    expect(parser.push(`${frame('a')}${frame('b')}${frame('c')}`)).toEqual(['a', 'b', 'c'])
  })

  it('[DONE] 与非 data 行忽略掉', () => {
    const parser = createSseParser()
    expect(parser.push(': keep-alive\n\ndata: [DONE]\n\n')).toEqual([])
  })

  it('单帧 JSON 坏掉时跳过它而不是终止整段', () => {
    const parser = createSseParser()
    expect(parser.push(`data: {坏掉的\n\n${frame('后面还有')}`)).toEqual(['后面还有'])
  })

  it('flush 吐出最后一帧 —— 有些实现末帧不带换行', () => {
    const parser = createSseParser()
    parser.push(`data: ${JSON.stringify({ choices: [{ delta: { content: '尾' } }] })}`)
    expect(parser.flush()).toEqual(['尾'])
  })
})

describe('chatCompletionsUrl', () => {
  it('base URL 带不带尾斜杠、带不带 /v1 都要拼对', () => {
    expect(chatCompletionsUrl('https://a.com/v1')).toBe('https://a.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://a.com/v1/')).toBe('https://a.com/v1/chat/completions')
    expect(chatCompletionsUrl('https://a.com/v1/chat/completions')).toBe(
      'https://a.com/v1/chat/completions'
    )
  })

  it('空地址报「还没填」而不是拼出一个坏 URL', () => {
    expect(() => chatCompletionsUrl('')).toThrow(AiError)
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
})

describe('createAiClient', () => {
  it('把分片拼成完整文本', async () => {
    expect(await collect([frame('一'), frame('二'), 'data: [DONE]\n\n'])).toBe('一二')
  })

  it('200 但一个字都没有 → 报错，不静默返回空串', async () => {
    await expect(collect(['data: [DONE]\n\n'])).rejects.toThrow('没有任何内容')
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
