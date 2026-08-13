/**
 * AI 解读编排（src/main/ai/service.ts）。
 *
 * 三件用户看不见但会付账的事：
 *   1. **去重** —— 双击一下就发两次请求，等于付两次钱
 *   2. **缓存** —— 反复展开同一条信号不该反复计费
 *   3. **取消** —— 面板关了、行折叠了，在跑的请求要断掉
 *
 * 外加一条边界：**未配置时不发请求**，而是推一条能看懂的错误。
 */

import { describe, expect, it, vi } from 'vitest'
import type { AiChunk } from '@shared/ipc-types'
import { AiError, type AiClient } from '@main/ai/client'
import { createAiService } from '@main/ai/service'
import type { AiConfig } from '@main/ai/types'

const CONFIG: AiConfig = {
  enabled: true,
  baseUrl: 'https://example.com/v1',
  model: 'm',
  timeoutMs: 30_000,
  maxTokens: 512,
}

/** AiConfigStore 的结构性替身 —— 只用到这四个方法 */
function fakeStore(usable = true) {
  return {
    config: () => CONFIG,
    apiKey: () => 'sk-x',
    usable: () => usable,
  } as unknown as Parameters<typeof createAiService>[0]['store']
}

/** 受控客户端：`release()` 之前一直挂着，用来观察「生成中」的状态 */
function controlledClient(pieces: string[]): { client: AiClient; release: () => void; calls: () => number } {
  let calls = 0
  let unlock: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    unlock = resolve
  })
  return {
    calls: () => calls,
    release: () => unlock?.(),
    client: {
      async *stream(request) {
        calls++
        await gate
        for (const piece of pieces) {
          if (request.signal.aborted) throw new AiError('已取消', 'canceled')
          yield piece
        }
      },
    },
  }
}

function instantClient(pieces: string[]): { client: AiClient; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    client: {
      async *stream() {
        calls++
        for (const piece of pieces) yield piece
      },
    },
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createAiService', () => {
  it('把分片推给渲染层，完成时推一条 done', async () => {
    const chunks: AiChunk[] = []
    const { client } = instantClient(['甲', '乙'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: (chunk) => chunks.push(chunk),
      buildUserMessage: () => 'ctx',
    })

    const { requestId } = service.explain('sig-1')
    await flush()

    expect(chunks.filter((c) => c.delta !== undefined).map((c) => c.delta)).toEqual(['甲', '乙'])
    expect(chunks.at(-1)).toEqual({ requestId, done: true })
  })

  it('完成后再问同一条信号 → 命中缓存，不再发请求', async () => {
    const { client, calls } = instantClient(['结果'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: () => {},
      buildUserMessage: () => 'ctx',
    })

    service.explain('sig-1')
    await flush()
    expect(calls()).toBe(1)

    const second = service.explain('sig-1')
    expect(second.cached).toBe('结果')
    expect(calls()).toBe(1)
  })

  it('force = true 时丢掉缓存重新生成 —— 否则「重新生成」按钮看起来像坏了', async () => {
    const { client, calls } = instantClient(['结果'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: () => {},
      buildUserMessage: () => 'ctx',
    })

    service.explain('sig-1')
    await flush()
    const forced = service.explain('sig-1', true)
    await flush()

    expect(forced.cached).toBeUndefined()
    expect(calls()).toBe(2)
  })

  it('同一条信号正在生成时，第二次点击复用同一次请求（不重复计费）', async () => {
    const chunks: AiChunk[] = []
    const { client, release, calls } = controlledClient(['甲'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: (chunk) => chunks.push(chunk),
      buildUserMessage: () => 'ctx',
    })

    const first = service.explain('sig-1')
    await flush()
    const second = service.explain('sig-1')

    expect(second.requestId).toBe(first.requestId)
    expect(calls()).toBe(1)

    release()
    await flush()
    expect(chunks.at(-1)?.done).toBe(true)
  })

  it('取消后不再推 done —— 用户已经不看了', async () => {
    const chunks: AiChunk[] = []
    const { client, release } = controlledClient(['甲', '乙'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: (chunk) => chunks.push(chunk),
      buildUserMessage: () => 'ctx',
    })

    const { requestId } = service.explain('sig-1')
    await flush()
    service.cancel(requestId)
    release()
    await flush()

    expect(chunks.some((c) => c.done === true)).toBe(false)
  })

  it('未配置时不发请求，推一条能看懂的错误', async () => {
    const chunks: AiChunk[] = []
    const { client, calls } = instantClient(['不该出现'])
    const service = createAiService({
      store: fakeStore(false),
      client,
      emit: (chunk) => chunks.push(chunk),
      buildUserMessage: () => 'ctx',
    })

    service.explain('sig-1')
    await flush()

    expect(calls()).toBe(0)
    expect(chunks[0]?.error).toContain('尚未配置')
  })

  it('上下文拿不到（信号被裁剪了）→ 报成一次失败，不静默', async () => {
    const chunks: AiChunk[] = []
    const { client } = instantClient(['x'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: (chunk) => chunks.push(chunk),
      buildUserMessage: () => {
        throw new Error('该信号已不在库中（可能已被保留策略裁剪）')
      },
    })

    service.explain('sig-1')
    await flush()
    expect(chunks[0]?.error).toContain('已不在库中')
  })

  it('dispose 断掉所有在跑的请求 —— 否则退出时会被 undici 吊住', async () => {
    const chunks: AiChunk[] = []
    const { client, release } = controlledClient(['甲'])
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: (chunk) => chunks.push(chunk),
      buildUserMessage: () => 'ctx',
    })

    service.explain('sig-1')
    await flush()
    service.dispose()
    release()
    await flush()

    expect(chunks.some((c) => c.done === true)).toBe(false)
  })

  it('测试连接：连不上时返回 ok=false 而不是抛错', async () => {
    const failing: AiClient = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new AiError('鉴权失败（HTTP 401）', 'auth')
      },
    }
    const service = createAiService({
      store: fakeStore(),
      client: failing,
      emit: () => {},
      buildUserMessage: () => 'ctx',
    })

    await expect(service.test()).resolves.toMatchObject({ ok: false })
  })

  it('缓存不是无限大 —— 超过上限后最早的一条被挤掉', async () => {
    const stream = vi.fn()
    let calls = 0
    const client: AiClient = {
      async *stream() {
        calls++
        stream()
        yield 'x'
      },
    }
    const service = createAiService({
      store: fakeStore(),
      client,
      emit: () => {},
      buildUserMessage: () => 'ctx',
    })

    for (let i = 0; i < 55; i++) {
      service.explain(`sig-${i}`)
      await flush()
    }
    expect(calls).toBe(55)

    // sig-0 已被挤出缓存 → 会重新生成；sig-54 还在
    expect(service.explain('sig-54').cached).toBe('x')
    expect(service.explain('sig-0').cached).toBeUndefined()
  })
})
