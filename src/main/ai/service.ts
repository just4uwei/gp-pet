/**
 * AI 解读的编排层（P2）：去重 · 内存缓存 · 取消 · 流式推送。
 *
 * ## 它是只读的解释层
 *
 * 结果**不回流**到信号、闸门、状态点或影子运行。状态点只认 `PetStateMachine`，
 * 而它只接受过了四道闸门的提醒 —— 让一段模型输出去点亮状态点，等于开一条绕过
 * 冷却与免打扰的旁路（CLAUDE.md 那条纪律）。这里连 `WindowManager.push('push:petState')`
 * 都不碰，只推自己的 `push:aiChunk`。
 *
 * ## 为什么不建表
 *
 * 影子账本那种**无法重建**的前向记录才值得进库。AI 解读花钱但可重来，
 * 而加一张表要连带走迁移 003 + 备份 + 保留策略三处。所以只做内存 LRU：
 * 主进程活着期间反复展开同一条信号不会重复计费，重启后重新生成。
 *
 * ## 去重
 *
 * 同一 `signalId` 已在生成中时，第二次点击复用同一次请求，不再发一遍。
 * 用户双击一下就付两次钱是很容易发生的事。
 */

import type { AiChunk, AiTestResult } from '@shared/ipc-types'
import { AiError, type AiClient } from './client'
import type { AiConfigStore } from './config'
import { AI_PING_SYSTEM, AI_PING_USER, AI_SYSTEM_PROMPT, AI_USER_SUFFIX } from './prompt'

/** 内存缓存上限。一条解读几百字，50 条约 100KB 量级 */
const CACHE_LIMIT = 50

export interface AiServiceDeps {
  store: AiConfigStore
  client: AiClient
  /** 推给渲染层。生产传 `windows.push.bind(windows, 'push:aiChunk')` */
  emit: (chunk: AiChunk) => void
  /** 由调用方组装的上下文文本（见 context.ts）。拿不到信号时抛错 */
  buildUserMessage: (signalId: string) => string
  log?: { info: (message: string) => void; warn: (message: string, error?: unknown) => void }
  /** 注入用于测试；生产传 Date.now */
  now?: () => number
}

export interface AiService {
  /**
   * 返回 requestId；命中缓存时同时返回全文，此时不会有任何推送。
   * `force` = 丢掉缓存重新生成（「重新生成」按钮点了却原样返回旧文，看起来像坏了）。
   */
  explain(signalId: string, force?: boolean): { requestId: string; cached?: string }
  /** 「测试连接」。**不抛错** —— 连不上是用户能看懂的正常结局（与 config:* 同一做法） */
  test(): Promise<AiTestResult>
  cancel(requestId: string): void
  /** 应用退出时把在跑的请求都断掉，不留悬挂连接 */
  dispose(): void
}

interface InFlight {
  signalId: string
  controller: AbortController
  /** 已累积的文本 —— 完成时进缓存 */
  text: string
}

export function createAiService(deps: AiServiceDeps): AiService {
  const { store, client, emit, buildUserMessage } = deps
  const log = deps.log ?? { info: () => {}, warn: () => {} }
  const now = deps.now ?? (() => Date.now())

  const cache = new Map<string, string>()
  const inFlight = new Map<string, InFlight>()
  /** signalId → requestId，用于去重 */
  const bySignal = new Map<string, string>()
  let seq = 0

  function remember(signalId: string, text: string): void {
    // Map 保插入序：删掉最早的一条就是 LRU 的近似（读命中不重排，够用）
    cache.set(signalId, text)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  async function run(requestId: string, entry: InFlight): Promise<void> {
    const startedAt = now()
    try {
      const user = `${buildUserMessage(entry.signalId)}${AI_USER_SUFFIX}`
      const stream = client.stream({
        config: store.config(),
        apiKey: store.apiKey(),
        system: AI_SYSTEM_PROMPT,
        user,
        signal: entry.controller.signal,
      })

      for await (const delta of stream) {
        if (entry.controller.signal.aborted) break
        entry.text += delta
        emit({ requestId, delta })
      }

      if (entry.controller.signal.aborted) {
        log.info(`[ai] ${entry.signalId} 已取消（${now() - startedAt}ms）`)
        return
      }

      remember(entry.signalId, entry.text)
      emit({ requestId, done: true })
      log.info(`[ai] ${entry.signalId} 解读完成，${entry.text.length} 字，${now() - startedAt}ms`)
    } catch (error) {
      if (error instanceof AiError && error.kind === 'canceled') {
        log.info(`[ai] ${entry.signalId} 已取消`)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      log.warn(`[ai] ${entry.signalId} 解读失败：${message}`)
      emit({ requestId, error: message })
    } finally {
      inFlight.delete(requestId)
      if (bySignal.get(entry.signalId) === requestId) bySignal.delete(entry.signalId)
    }
  }

  return {
    explain(signalId, force = false) {
      if (force) cache.delete(signalId)
      const cached = cache.get(signalId)
      if (cached !== undefined) {
        return { requestId: `cached-${signalId}`, cached }
      }

      // 去重：同一条信号已在生成中，复用那次请求（渲染层照样收得到后续分片）
      const running = bySignal.get(signalId)
      if (running !== undefined) {
        const entry = inFlight.get(running)
        if (entry !== undefined) {
          // 把已经吐出去的部分补发一次，否则第二个订阅者只能看到后半截
          if (entry.text !== '') emit({ requestId: running, delta: entry.text })
          return { requestId: running }
        }
        bySignal.delete(signalId)
      }

      if (!store.usable()) {
        const requestId = `err-${++seq}`
        // 用微任务推，让调用方先拿到 requestId 再收到错误
        queueMicrotask(() =>
          emit({ requestId, error: 'AI 分析尚未配置或已关闭 —— 请到设置页填写接口地址、模型与 API key' })
        )
        return { requestId }
      }

      const requestId = `ai-${++seq}`
      const entry: InFlight = { signalId, controller: new AbortController(), text: '' }
      inFlight.set(requestId, entry)
      bySignal.set(signalId, requestId)
      void run(requestId, entry)
      return { requestId }
    },

    async test() {
      const config = store.config()
      if (config.baseUrl.trim() === '') return { ok: false, message: '还没有填接口地址' }
      if (config.model.trim() === '') return { ok: false, message: '还没有填模型名' }

      const controller = new AbortController()
      // 探针不该等满 60s：连不上要能很快说出来
      const timer = setTimeout(() => controller.abort(), 20_000)
      const startedAt = now()
      try {
        let text = ''
        for await (const delta of client.stream({
          // 探针只验鉴权与模型名，不烧 token
          config: { ...config, maxTokens: 32 },
          apiKey: store.apiKey(),
          system: AI_PING_SYSTEM,
          user: AI_PING_USER,
          signal: controller.signal,
        })) {
          text += delta
          if (text.length > 200) break
        }
        return { ok: true, message: `连接正常，对面回了「${text.trim().slice(0, 20)}」`, latencyMs: now() - startedAt }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn(`[ai] 测试连接失败：${message}`)
        return { ok: false, message }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    },

    cancel(requestId) {
      const entry = inFlight.get(requestId)
      if (entry === undefined) return
      entry.controller.abort()
    },

    dispose() {
      for (const entry of inFlight.values()) entry.controller.abort()
      inFlight.clear()
      bySignal.clear()
    },
  }
}
