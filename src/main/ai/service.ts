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
 * ## 缓存有两层：内存 + 库（2026-08-14 加的第二层）
 *
 * 这里原先的结论是「AI 解读花钱但**可重来**，所以只做内存 LRU」。那句话的后半截是错的：
 * **重来要再花一次钱**，而重启一次内存缓存就空了 —— 于是同一条信号会被重复计费。
 * 现在多一层 `history`（落到 `ai_explain` 表，008 迁移），`explain()` 按
 * **内存 → 库 → 真发请求** 的顺序找。这同时让「上次 AI 怎么说这只票的」变成可查的。
 *
 * **只有 `done` 才落库。** 用户点了停止的那半截不存 —— 一段截断的解读放进历史里，
 * 日后翻到时既不知道它为什么短，也不知道结论完不完整。正文仍留在界面上，只是不入库。
 *
 * 落库**不改变 AI 的定位**：存的是解释文本，它照旧不回流到信号、闸门、状态点或影子运行。
 *
 * ## 去重
 *
 * 同一 `signalId` 已在生成中时，第二次点击复用同一次请求，不再发一遍。
 * 用户双击一下就付两次钱是很容易发生的事。
 * **这条路现在还兼职「关掉抽屉再打开」**：渲染层不再卸载即取消，重开时会再调一次
 * `explain()`，靠这里把已经吐出来的部分补发一遍接上。
 */

import type { AiChunk, AiTestResult } from '@shared/ipc-types'
import { AiError, type AiClient } from './client'
import type { AiConfigStore } from './config'
import { AI_PING_SYSTEM, AI_PING_USER, AI_SYSTEM_PROMPT, AI_USER_SUFFIX } from './prompt'

/** 内存缓存上限。一条解读几百字，50 条约 100KB 量级 */
const CACHE_LIMIT = 50

/**
 * 落库那一层。**由 controller 注入**：service 不认识 SQLite，也不认识 `SignalRecord`
 * 的形状 —— 一行历史要带的信号快照（方向 / 阶段 / 置信 / 当时价）是 controller
 * 从信号库里补的，service 只知道 signalId 与正文。
 */
export interface AiHistorySink {
  /** 这条信号最近一次解读的全文；没有则 undefined。**防重复计费走它** */
  latest(signalId: string): string | undefined
  /** 只在 `done` 时被调。失败或取消都不落库（见文件头） */
  save(entry: { signalId: string; text: string; startedAt: number; finishedAt: number }): void
}

export interface AiServiceDeps {
  store: AiConfigStore
  client: AiClient
  /** 推给渲染层。生产传 `windows.push.bind(windows, 'push:aiChunk')` */
  emit: (chunk: AiChunk) => void
  /** 由调用方组装的上下文文本（见 context.ts）。拿不到信号时抛错 */
  buildUserMessage: (signalId: string) => string
  /**
   * 历史落库。**缺省是个空实现** —— 数据层还没起来时 AI 仍然要能用，
   * 只是那几条不进历史（而不是整块报错）。
   */
  history?: AiHistorySink
  log?: { info: (message: string) => void; warn: (message: string, error?: unknown) => void }
  /** 注入用于测试；生产传 Date.now */
  now?: () => number
}

export interface AiService {
  /**
   * 返回 requestId；命中缓存（内存或库）时同时返回全文，此时不会有任何推送。
   * `force` = 绕过两层缓存重新生成（「重新生成」按钮点了却原样返回旧文，看起来像坏了），
   * 完成后会在历史里**多留一条**，旧的那条不删 —— 那正是「同一条信号解读了两次」。
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
  const history: AiHistorySink = deps.history ?? { latest: () => undefined, save: () => {} }
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

      for await (const piece of stream) {
        if (entry.controller.signal.aborted) break
        // 思考链**不进 `entry.text`**：那份正文要落库、要抽观察点建议，
        // 混进模型的草稿会让建议块解析错位，也会把草稿当成结论存下来
        if (piece.kind === 'thinking') {
          emit({ requestId, thinking: piece.value })
          continue
        }
        entry.text += piece.value
        emit({ requestId, delta: piece.value })
      }

      if (entry.controller.signal.aborted) {
        log.info(`[ai] ${entry.signalId} 已取消（${now() - startedAt}ms）`)
        return
      }

      remember(entry.signalId, entry.text)
      // 落库在推 done 之前：渲染层收到 done 就会去拉历史列表，
      // 反过来的话新生成的这条**恰好赶不上**那次刷新，看起来像没存下来
      const finishedAt = now()
      try {
        history.save({ signalId: entry.signalId, text: entry.text, startedAt, finishedAt })
      } catch (error) {
        // 存不下不该让用户白等的这段正文一起没掉 —— 界面上照常给全文，只是进不了历史
        log.warn(`[ai] ${entry.signalId} 解读已完成但存历史失败：`, error)
      }
      emit({ requestId, done: true })
      log.info(`[ai] ${entry.signalId} 解读完成，${entry.text.length} 字，${finishedAt - startedAt}ms`)
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
      // 内存 → 库。第二层是重启之后唯一挡得住重复计费的东西（见文件头），
      // `force` 时两层都跳过 —— 用户明确要一份新的
      const cached = force ? undefined : (cache.get(signalId) ?? history.latest(signalId))
      if (cached !== undefined) {
        // 从库里读回来的也放进内存，省得同一次会话里反复查库
        remember(signalId, cached)
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
