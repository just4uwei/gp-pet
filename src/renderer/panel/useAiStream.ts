/**
 * 一次 AI 流式请求的状态机（2026-08-14）。
 *
 * ## 它从哪来，以及为什么先只有日报在用
 *
 * 这套东西原本长在 `AiExplain.tsx` 里，而那个文件的头注释记着好几条**踩出来的**行为：
 *
 *   - **卸载只退订，不取消。** 组件被渲染层顺手摘掉时，用户什么都没做而请求没了 ——
 *     那次调用已经计过费。取消只能是用户点「停止」。
 *   - **等待期必须一直有反馈。** 推理模型先想几十秒、一个字都不吐是常态；
 *     没有秒数的话用户分不出「在想」和「连接死了」。
 *   - **思考链与正文两份，永不合并。** 正文要落库、要抽观察点建议，
 *     混进草稿会让建议块解析错位，也会把想到一半的话当结论存下来。
 *   - **停止之后不退回 idle。** 早先「停止」时若一个字都没收到就把整块收回去，
 *     用户看到的是「点了一下，界面自己没了」。
 *
 * 日报的评价块需要**同样**这几条。抄一遍就意味着它要重新踩一次，所以提炼到这里。
 *
 * **`AiExplain` 暂时没有改用它**，这是个有意的取舍而不是遗漏：那个文件还带着
 * 建议块剥离与观察点表单，而这个项目**没有渲染层测试** ——
 * 在同一次改动里重构它，等于让一条真花钱的路径失去唯一的验证手段（人工走查）。
 * 迁移它是一次单独的改动，届时这里就是它的家。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type AiStreamPhase = 'idle' | 'running' | 'done' | 'error' | 'stopped'

/** 有字之后停顿多久算「卡住了」。比一次正常的分片间隔大一个量级 */
const STALL_MS = 10_000

export interface AiStream {
  phase: AiStreamPhase
  /** 正文。**不含思考链** */
  text: string
  thinking: string
  error: string | null
  /** 本轮已等待秒数。`phase !== 'running'` 时停在最后一次的值 */
  elapsedSec: number
  /** 已经出过字，但最近 10 秒没有任何动静 —— 界面要单独说出来 */
  stalled: boolean
  /** 命中两层缓存（内存 / 库）时为 true：这一次**没有产生任何调用** */
  cached: boolean
  /** `force` = 绕过两层缓存重新生成 */
  start: (force: boolean) => void
  /** 真的断掉请求。只有「停止」与「重新生成」用它 */
  stop: () => void
}

export function useAiStream(
  targetId: string,
  options: { onDone?: (fullText: string) => void } = {}
): AiStream {
  const [phase, setPhase] = useState<AiStreamPhase>('idle')
  const [text, setText] = useState('')
  const [thinking, setThinking] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [lastDeltaAt, setLastDeltaAt] = useState(0)
  const [now, setNow] = useState(0)

  const requestRef = useRef<string | null>(null)
  /**
   * 当前订阅的退订函数。**必须存在 ref 里**：`window.gp.on` 的退订只能由持有者调用，
   * 而流跑到一半时组件被卸载走不到任何一个 `off()` 分支 ——
   * 那样每挂一次就多累积一个监听器。**退订不等于取消**（见文件头）。
   */
  const offRef = useRef<(() => void) | null>(null)
  /** 累积正文。用 ref 而不是从 state 里读：done 那一刻要拿到**全量**交给 onDone */
  const textRef = useRef('')
  const thinkingRef = useRef('')
  const onDoneRef = useRef(options.onDone)
  onDoneRef.current = options.onDone

  /** 每秒一跳的时钟。**只在 running 时跑** —— 否则一个看完的结果会一直重渲染 */
  useEffect(() => {
    if (phase !== 'running') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase])

  /** 只退订，**不取消** —— 卸载走这一条 */
  const detach = useCallback((): void => {
    offRef.current?.()
    offRef.current = null
  }, [])

  const stop = useCallback((): void => {
    detach()
    const requestId = requestRef.current
    requestRef.current = null
    if (requestId !== null && !requestId.startsWith('cached-')) {
      void window.gp.invoke('ai:cancel', requestId)
    }
    // **不退回 idle**：把「停在了哪一步」留在界面上（见文件头）
    setPhase((current) => (current === 'running' ? 'stopped' : current))
  }, [detach])

  // 卸载只退订。**别把这里改成 stop** —— 那会让「关一下页签」等于烧掉一次调用
  useEffect(() => detach, [detach])

  const start = useCallback(
    (force: boolean): void => {
      // 重新发起时先把上一轮的订阅收掉，否则两个监听器会往同一个 state 里塞
      detach()
      setPhase('running')
      setStartedAt(Date.now())
      setLastDeltaAt(0)
      setCached(false)
      textRef.current = ''
      setText('')
      thinkingRef.current = ''
      setThinking('')
      setError(null)

      // 先挂订阅再发起：反过来会漏掉最前面几个分片
      offRef.current = window.gp.on('push:aiChunk', (chunk) => {
        if (chunk.requestId !== requestRef.current) return
        if (chunk.error !== undefined) {
          setError(chunk.error)
          setPhase('error')
          detach()
          return
        }
        // 思考单独累积，**不碰 textRef**。它也算「有动静」，所以一起刷 lastDeltaAt ——
        // 不刷的话思考期间会被判成「卡住了」
        if (chunk.thinking !== undefined) {
          thinkingRef.current += chunk.thinking
          setThinking(thinkingRef.current)
          setLastDeltaAt(Date.now())
        }
        if (chunk.delta !== undefined) {
          textRef.current += chunk.delta
          setText(textRef.current)
          setLastDeltaAt(Date.now())
        }
        if (chunk.done === true) {
          setPhase('done')
          detach()
          onDoneRef.current?.(textRef.current)
        }
      })

      void window.gp
        .invoke('ai:explain', targetId, force)
        .then((started) => {
          requestRef.current = started.requestId
          if (started.cached !== undefined) {
            // 命中缓存（内存或库）：不会再有任何推送，也**没有产生任何调用**
            textRef.current = started.cached
            setText(started.cached)
            setCached(true)
            setPhase('done')
            detach()
            onDoneRef.current?.(started.cached)
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
          detach()
        })
    },
    [targetId, detach]
  )

  const elapsedSec = startedAt === 0 ? 0 : Math.max(0, Math.round((now - startedAt) / 1000))
  const stalled =
    phase === 'running' && lastDeltaAt !== 0 && now - lastDeltaAt > STALL_MS

  return { phase, text, thinking, error, elapsedSec, stalled, cached, start, stop }
}
