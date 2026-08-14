/**
 * 一条信号的「AI 解读」（P2，docs/08 §后续）。
 *
 * 三条克制：
 *
 * 1. **来源标注不靠提示词。** 提示词里写了「不许说成经过验证的」，但模型可能不照做 ——
 *    所以顶部那行来源说明与底部那行免责是**固定拼在输出区外面**的 DOM，
 *    不经过模型，也不受模型输出影响。
 * 2. **流式渲染。** 一次解读跑几十秒是常态，一个转四十秒的圈在桌面应用里是不可接受的。
 * 3. **卸载即取消。** 面板关掉、行折叠、切换到别的信号，都要把在跑的请求断掉 ——
 *    否则用户已经不看了，钱还在烧。
 *
 * ## 等待期间必须一直有反馈（2026-08-14 补）
 *
 * 推理模型先思考几十秒、一个字都不吐是常态，而**思考过程本地刻意不显示**
 * （`ai/protocols.ts` 只取 `text_delta`，`thinking_delta` 直接丢）。
 * 于是在这之前，等待期的界面是一个空框加一个闪烁光标 —— 用户分不出
 * 「模型在想」和「连接死了」。现在等待期一直显示**已等待多少秒**，
 * 并在「有字了但停了很久」时单独说出来。
 *
 * 与之配套的一条：**停止之后绝不退回 idle。** 早先「停止」时若一个字都没收到，
 * 就 `setPhase('idle')` 把整块收回去 —— 用户看到的是「点了一下，界面自己没了」，
 * 既不知道发生过什么，也不知道要不要重试。现在退到 `stopped`，
 * 把「停在了哪一步」写出来，重新生成的按钮留在原地。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SecCode } from '@core/types'
import type { WatchSuggestion } from '@shared/ipc-types'
import { FOOTER_NOTE } from './disclaimer'
import { WatchPointForm } from './WatchPointForm'

type Phase = 'idle' | 'running' | 'done' | 'error' | 'stopped'

/** 有字之后停顿多久算「卡住了」。比一次正常的分片间隔大一个量级 */
const STALL_MS = 10_000

/**
 * 建议块是给程序读的，不显示给用户。
 *
 * 与主进程的 `stripSuggestionBlock()` 同一个正则 —— 抽取在主进程做（那边有白名单校验），
 * 这边只负责别把它印出来：它长得像「系统给的结论」，与「本段由外部模型生成」的定位冲突。
 */
const SUGGESTION_BLOCK = /<观察点建议>[\s\S]*?<\/观察点建议>/g

export function AiExplain({
  signalId,
  code,
  name,
  onWatchCreated,
  onError,
}: {
  signalId: string
  code: SecCode
  name: string
  /** 新建成功后通知上层刷新「观察点」页与计数 */
  onWatchCreated: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<string | null>(null)
  /**
   * 当前订阅的退订函数。**必须存在 ref 里**：`window.gp.on` 的退订只能由持有者调用，
   * 而流跑到一半时组件被卸载（行折叠、面板关闭）走不到任何一个 `off()` 分支 ——
   * 那样每开一次就多累积一个监听器，正是 preload 头注释警告的那件事。
   */
  const offRef = useRef<(() => void) | null>(null)
  const [suggestions, setSuggestions] = useState<WatchSuggestion[]>([])
  const [formOpen, setFormOpen] = useState(false)
  /** 累积正文。用 ref 而不是从 state 里读：done 那一刻要拿到**全量**去抽建议 */
  const textRef = useRef('')
  /** 本轮开始的时刻与最后一次收到增量的时刻。等待期的全部反馈都从这两个数推出来 */
  const [startedAt, setStartedAt] = useState(0)
  const [lastDeltaAt, setLastDeltaAt] = useState(0)
  /** 每秒一跳的时钟。**只在 running 时跑** —— 否则一个看完的解读会一直重渲染 */
  const [now, setNow] = useState(0)

  useEffect(() => {
    if (phase !== 'running') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [phase])

  /** 显示给用户的正文：把机器读的建议块摘掉 */
  const visibleText = useMemo(() => text.replace(SUGGESTION_BLOCK, '').trimEnd(), [text])

  const stop = useCallback((): void => {
    offRef.current?.()
    offRef.current = null

    const requestId = requestRef.current
    requestRef.current = null
    if (requestId !== null && !requestId.startsWith('cached-')) {
      void window.gp.invoke('ai:cancel', requestId)
    }
  }, [])

  // 卸载（行折叠 / 面板关闭 / 换了一条信号）：退订 + 断掉在跑的请求。
  // 少了这一下，用户已经不看了钱还在烧
  useEffect(() => stop, [stop])

  const start = useCallback(
    (force: boolean): void => {
      // 重新生成时先把上一轮的订阅收掉，否则两个监听器会往同一个 state 里塞
      offRef.current?.()
      offRef.current = null

      setPhase('running')
      setStartedAt(Date.now())
      setLastDeltaAt(0)
      textRef.current = ''
      setText('')
      setError(null)
      setSuggestions([])
      setFormOpen(false)

      const finish = (): void => {
        offRef.current?.()
        offRef.current = null
      }

      // 先挂订阅再发起：反过来会漏掉最前面几个分片
      offRef.current = window.gp.on('push:aiChunk', (chunk) => {
        if (chunk.requestId !== requestRef.current) return
        if (chunk.error !== undefined) {
          setError(chunk.error)
          setPhase('error')
          finish()
          return
        }
        if (chunk.delta !== undefined) {
          textRef.current += chunk.delta
          setText(textRef.current)
          setLastDeltaAt(Date.now())
        }
        if (chunk.done === true) {
          setPhase('done')
          finish()
          // 全文到齐才抽建议：流式过程中那一块可能只到一半，抽出来的阈值会缺位
          void window.gp
            .invoke('watch:suggest', textRef.current)
            .then(setSuggestions)
            .catch(() => setSuggestions([]))
        }
      })

      void window.gp
        .invoke('ai:explain', signalId, force)
        .then((started) => {
          requestRef.current = started.requestId
          if (started.cached !== undefined) {
            // 命中主进程内存缓存：不会再有任何推送
            textRef.current = started.cached
            setText(started.cached)
            setPhase('done')
            finish()
            void window.gp
              .invoke('watch:suggest', started.cached)
              .then(setSuggestions)
              .catch(() => setSuggestions([]))
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
          finish()
        })
    },
    [signalId]
  )

  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000))
  const sinceDelta = lastDeltaAt === 0 ? 0 : Math.max(0, Math.round((now - lastDeltaAt) / 1000))

  if (phase === 'idle') {
    return (
      <button className="gp-btn mt-2 w-full justify-center text-[11px]" onClick={() => start(false)}>
        AI 解读（调用你配置的模型，按对方规则计费）
      </button>
    )
  }

  return (
    <div className="mt-2 rounded border border-violet-400/25 bg-violet-500/[0.06] p-2 text-xs">
      {/* 固定来源标注 —— 不经过模型，模型改不了它 */}
      <p className="mb-1.5 border-b border-white/10 pb-1.5 text-[10px] leading-snug text-violet-200/70">
        以下由你配置的外部模型生成，不是本应用的策略结论。模型可能出错或编造，
        它读到的只有本地这几项数据。
      </p>

      {error === null ? (
        <p className="whitespace-pre-wrap leading-relaxed text-white/75">
          {visibleText}
          {phase === 'running' ? <span className="animate-pulse text-white/40">▍</span> : null}
        </p>
      ) : (
        <p className="leading-relaxed text-rose-200/80">{error}</p>
      )}

      {/*
        等待反馈。这一块的**唯一目的**是让用户分得出「模型在想」与「连接死了」——
        思考过程本地不显示（见文件头），所以只能靠时间说话。三种措辞对应三种状态，
        都不许说成「即将完成」一类无依据的安抚。
      */}
      {phase === 'running' ? (
        <p className="mt-1.5 text-[10px] leading-snug text-white/35">
          {textRef.current === '' ? (
            <span>
              已等待 {elapsed}s · 模型还没吐出第一个字。
              推理模型会先思考几十秒（思考过程本地不显示），再等不到会自动报超时。
            </span>
          ) : sinceDelta >= STALL_MS / 1000 ? (
            <span className="text-amber-200/60">
              已 {sinceDelta}s 没有新内容（共 {elapsed}s，{textRef.current.length} 字）——
              可能还在思考，也可能连接断了。
            </span>
          ) : (
            <span>
              生成中 · {elapsed}s · {textRef.current.length} 字
            </span>
          )}
        </p>
      ) : null}

      {/*
        停止之后**不收回界面**。收回去（退到 idle）的话，用户看到的是
        「点了一下，界面自己没了」—— 既不知道发生过什么，也不知道要不要重试。
      */}
      {phase === 'stopped' ? (
        <p className="mt-1.5 text-[10px] leading-snug text-amber-200/60">
          {text === ''
            ? `已停止，等了 ${elapsed}s 一个字都没收到。可能是模型还在思考，也可能接口不通 —— 可以重新生成，或去设置页点「测试连接」。`
            : `已停止，上面是收到的部分内容（${elapsed}s）。`}
        </p>
      ) : null}

      {/*
        把第 4 段（失效条件）变成可跟踪的东西。**只在生成完之后出现**：
        流式过程中建议块可能只到一半。抽不到建议时按钮照样在 —— 表单空着让用户自己填，
        模型不照格式输出是常态，不该因此让这条路走不通。
      */}
      {phase === 'done' && error === null ? (
        formOpen ? (
          <WatchPointForm
            signalId={signalId}
            code={code}
            name={name}
            suggestions={suggestions}
            onDone={() => {
              setFormOpen(false)
              onWatchCreated()
            }}
            onCancel={() => setFormOpen(false)}
            onError={onError}
          />
        ) : (
          <button
            className="gp-btn mt-2 w-full justify-center text-[11px]"
            onClick={() => setFormOpen(true)}
          >
            {suggestions.length > 0
              ? `设为观察点（模型建议了 ${suggestions.length} 条，需你确认）`
              : '设为观察点（自己填条件）'}
          </button>
        )
      ) : null}

      <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-1.5">
        <span className="text-[10px] text-white/30">{FOOTER_NOTE}</span>
        {phase === 'running' ? (
          <button
            className="gp-btn ml-auto px-1.5 py-0.5 text-[10px]"
            onClick={() => {
              stop()
              // 一个字都没有时**也不退回 idle**：那会把整块界面收掉（见上面那段注释）。
              // 有内容时算 'done'，观察点表单照常可用 —— 收到一半的正文里
              // 建议块可能不全，但表单本来就允许留空自己填
              setPhase(text === '' ? 'stopped' : 'done')
            }}
          >
            停止
          </button>
        ) : (
          <button
            className="gp-btn ml-auto px-1.5 py-0.5 text-[10px]"
            onClick={() => {
              stop()
              // force：不带这一下，缓存会把旧文原样吐回来，按钮看起来像坏了
              start(true)
            }}
          >
            重新生成
          </button>
        )}
      </div>
    </div>
  )
}
