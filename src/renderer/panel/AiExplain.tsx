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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SecCode } from '@core/types'
import type { WatchSuggestion } from '@shared/ipc-types'
import { FOOTER_NOTE } from './disclaimer'
import { WatchPointForm } from './WatchPointForm'

type Phase = 'idle' | 'running' | 'done' | 'error'

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
              setPhase(text === '' ? 'idle' : 'done')
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
