/**
 * 一条信号的 AI 解读正文块（P2，docs/08 §后续）。住在 `AiDrawer` 里，不再内嵌在信号行里。
 *
 * ## ⚠ 它**不再是**「卸载即取消」的（2026-08-14 改）
 *
 * 原先这里有一条 `useEffect(() => stop, [stop])`：组件一卸载就 `ai:cancel`。
 * 那条纪律的本意是「用户已经不看了，钱别再烧」，但它把**两件完全不同的事**混在了一起：
 *
 *   * 用户主动放弃（点「停止」、关掉抽屉）—— 该不该取消可以讨论；
 *   * **组件被渲染层顺手摘掉** —— 用户什么都没做，请求却没了。
 *
 * 后者真的发生过：这块东西过去长在信号列表里，同一只票来一条新信号就换组头，
 * 正在流式生成的解读跟着消失，用户看到的是「等了四十秒的界面自己没了」。
 *
 * 现在的取舍是：
 *   1. **搬进 `AiDrawer`**，状态挂在 `App` —— 列表怎么重排都碰不到它（这是根治）；
 *   2. **关抽屉不取消**，请求在主进程继续跑完并落库（钱已经花了，跑完存下来还能看）。
 *      重开抽屉时 `ai:explain` 会命中 service 的在途去重，把已吐出的部分补发一遍接上。
 *   3. **只有「停止」按钮真的调 `ai:cancel`**，那是用户明确说不要了。
 *
 * ## 另外三条克制（都还成立）
 *
 * 1. **来源标注不靠提示词。** 提示词里写了「不许说成经过验证的」，但模型可能不照做 ——
 *    所以那行来源说明与底部那行免责是**固定拼在输出区外面**的 DOM（现在由 `AiDrawer` 画），
 *    不经过模型，也不受模型输出影响。
 * 2. **流式渲染。** 一次解读跑几十秒是常态，一个转四十秒的圈在桌面应用里是不可接受的。
 * 3. **等待期间必须一直有反馈。** 推理模型先思考几十秒、一个字都不吐是常态，
 *    而思考过程本地刻意不显示（`ai/protocols.ts` 只取 `text_delta`，`thinking_delta` 直接丢）。
 *    所以等待期一直显示**已等待多少秒**，并在「有字了但停了很久」时单独说出来 ——
 *    否则用户分不出「模型在想」和「连接死了」。
 *
 * 与之配套的一条：**停止之后绝不退回 idle。** 早先「停止」时若一个字都没收到，
 * 就把整块收回去 —— 用户看到的是「点了一下，界面自己没了」，既不知道发生过什么，
 * 也不知道要不要重试。现在退到 `stopped`，把「停在了哪一步」写出来。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SecCode } from '@core/types'
import type { WatchSuggestion } from '@shared/ipc-types'
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

/** 把机器读的建议块摘掉 */
export function visibleAiText(text: string): string {
  return text.replace(SUGGESTION_BLOCK, '').trimEnd()
}

export function AiExplain({
  signalId,
  code,
  name,
  onWatchCreated,
  onDone,
  onError,
}: {
  signalId: string
  code: SecCode
  name: string
  /** 新建成功后通知上层刷新「观察点」页与计数 */
  onWatchCreated: () => void
  /** 一次解读真的完成了（已落库）—— 抽屉据此刷新历史列表 */
  onDone: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<string | null>(null)
  /**
   * 当前订阅的退订函数。**必须存在 ref 里**：`window.gp.on` 的退订只能由持有者调用，
   * 而流跑到一半时组件被卸载（关抽屉）走不到任何一个 `off()` 分支 ——
   * 那样每开一次就多累积一个监听器，正是 preload 头注释警告的那件事。
   *
   * 注意：**退订不等于取消**。卸载时只退订，请求照旧在主进程跑完（见文件头）。
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

  const visibleText = useMemo(() => visibleAiText(text), [text])

  /** 只退订，**不取消** —— 卸载走这一条 */
  const detach = useCallback((): void => {
    offRef.current?.()
    offRef.current = null
  }, [])

  /** 真的断掉请求。只有「停止」按钮和「重新生成」用它 */
  const stop = useCallback((): void => {
    detach()
    const requestId = requestRef.current
    requestRef.current = null
    if (requestId !== null && !requestId.startsWith('cached-')) {
      void window.gp.invoke('ai:cancel', requestId)
    }
  }, [detach])

  // 卸载只退订。**别把这里改回 stop** —— 那会让「关一下抽屉」等于烧掉一次调用
  useEffect(() => detach, [detach])

  const start = useCallback(
    (force: boolean): void => {
      // 重新发起时先把上一轮的订阅收掉，否则两个监听器会往同一个 state 里塞
      detach()

      setPhase('running')
      setStartedAt(Date.now())
      setLastDeltaAt(0)
      textRef.current = ''
      setText('')
      setError(null)
      setSuggestions([])
      setFormOpen(false)

      const finish = (): void => detach()

      const afterFullText = (full: string): void => {
        void window.gp
          .invoke('watch:suggest', full)
          .then(setSuggestions)
          .catch(() => setSuggestions([]))
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
          afterFullText(textRef.current)
          // 主进程是先落库再推 done 的，所以这时候去拉历史一定拉得到这条
          onDone()
        }
      })

      void window.gp
        .invoke('ai:explain', signalId, force)
        .then((started) => {
          requestRef.current = started.requestId
          if (started.cached !== undefined) {
            // 命中缓存（内存或库）：不会再有任何推送，也没有产生任何调用
            textRef.current = started.cached
            setText(started.cached)
            setPhase('done')
            finish()
            afterFullText(started.cached)
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setPhase('error')
          finish()
        })
    },
    [signalId, detach, onDone]
  )

  /*
    换了一条信号就自动跑一次。**这不等于「无条件计费」**：`ai:explain` 会先查
    内存缓存、再查历史库（008_ai_explain.sql），两层都没有才真发请求。
    抽屉是用户点「AI 解读」才开的，所以「开了就开始」是他要的；
    而重开抽屉看一条已经解读过的信号，走的是缓存那条路，一分钱不花。

    **用 ref 记住「已经为哪条信号自动发过」**，而不是依赖 `start` 的引用稳定性：
    上层哪天把某个回调写成每次渲染新建，这个 effect 就会反复重发 —— 而症状是
    「解读一直从头开始」，且每一次都可能是一笔真实调用。
  */
  const autoStartedFor = useRef<string | null>(null)
  useEffect(() => {
    if (autoStartedFor.current === signalId) return
    autoStartedFor.current = signalId
    start(false)
  }, [signalId, start])

  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000))
  const sinceDelta = lastDeltaAt === 0 ? 0 : Math.max(0, Math.round((now - lastDeltaAt) / 1000))

  return (
    <div className="text-xs">
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
        停止之后**不收回界面**。收回去的话，用户看到的是「点了一下，界面自己没了」——
        既不知道发生过什么，也不知道要不要重试。
        另外：停止的那半截**不入历史**（主进程只在 done 时落库），所以这里要说清
        「关掉就没了」，别让用户以为它留在历史里了。
      */}
      {phase === 'stopped' ? (
        <p className="mt-1.5 text-[10px] leading-snug text-amber-200/60">
          {text === ''
            ? `已停止，等了 ${elapsed}s 一个字都没收到。可能是模型还在思考，也可能接口不通 —— 可以重新生成，或去设置页点「测试连接」。`
            : `已停止，上面是收到的部分内容（${elapsed}s）。半截的解读不会进历史，关掉这里就没了。`}
        </p>
      ) : null}

      {/*
        把第 4 段（失效条件）变成可跟踪的东西。**只在生成完之后出现**：
        流式过程中建议块可能只到一半。抽不到建议时按钮照样在 —— 表单空着让用户自己填，
        模型不照格式输出是常态，不该因此让这条路走不通。
      */}
      {phase === 'done' && error === null ? (
        formOpen ? (
          <div className="mt-2">
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
          </div>
        ) : (
          <button
            className="gp-btn mt-3 w-full justify-center text-[11px]"
            onClick={() => setFormOpen(true)}
          >
            {suggestions.length > 0
              ? `设为观察点（模型建议了 ${suggestions.length} 条，需你确认）`
              : '设为观察点（自己填条件）'}
          </button>
        )
      ) : null}

      <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-2">
        {phase === 'running' ? (
          <>
            <span className="text-[10px] text-white/30">关掉这个抽屉不会中断它</span>
            <button
              className="gp-btn ml-auto px-1.5 py-0.5 text-[10px]"
              onClick={() => {
                stop()
                // 一个字都没有时**也不退回 idle**：那会把整块界面收掉（见上面那段注释）
                setPhase(text === '' ? 'stopped' : 'done')
              }}
            >
              停止
            </button>
          </>
        ) : (
          <>
            <span className="text-[10px] text-white/30">重新生成会再调用一次模型接口</span>
            <button
              className="gp-btn ml-auto px-1.5 py-0.5 text-[10px]"
              onClick={() => {
                stop()
                // force：不带这一下，缓存会把旧文原样吐回来，按钮看起来像坏了。
                // 完成后历史里会**多一条**，旧那条不删 —— 那正是「解读了两次」
                start(true)
              }}
            >
              重新生成
            </button>
          </>
        )}
      </div>
    </div>
  )
}
