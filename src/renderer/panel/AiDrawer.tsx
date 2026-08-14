/**
 * AI 解读抽屉 —— 叠在 `StockDrawer` 之上的**第二层**。
 *
 * ## 为什么要单独一层（这是这个文件存在的全部理由）
 *
 * AI 解读原先内嵌在信号行的展开区里，而那个列表每轮 tick 都在重排：
 * 同一只票来一条新信号就换组头，正在流式生成的解读跟着被卸载。
 * 用户看到的是「等了四十秒的分析界面自己没了」，而那次调用已经计过费。
 *
 * 现在它的状态挂在 `App`（`aiDrawer`），与信号列表**没有任何父子关系** ——
 * 列表怎么分组、怎么排序、怎么条件渲染，都碰不到这里。这是结构性保证，不是小心翼翼。
 *
 * ## 三条
 *
 * 1. **打开抽屉不等于发请求。** `ai:explain` 先查内存缓存、再查历史库
 *    （008_ai_explain.sql），两层都没有才真发。**别为了「打开就有反应」把这条去掉** ——
 *    那会让翻一次历史就重复计费一次，而用户完全看不出来。
 * 2. **关抽屉不取消。** 请求在主进程继续跑完并落库；重开时靠 service 的在途去重接上
 *    （见 `AiExplain` 头注释）。只有「停止」按钮真的取消。
 * 3. **来源标注与免责是固定 DOM**，不经过模型。提示词里写了「不许说成经过验证的」，
 *    但模型可能不照做 —— 这两行不受模型输出影响。
 *
 * ## 两种正文模式
 *
 * - `live`：当前这条信号。可流式、可停止、可重新生成、可设观察点。
 * - `archive`：历史里选中的某一条，**只读**。它可能来自已经被裁剪掉的信号，
 *   所以「哪天、什么方向、多少置信」全部读那一行自带的快照，不去 join 信号表。
 *
 * 「‹ 更早 / 更新 ›」在历史里按时间前后走 —— 列表是倒序的（新的在上），
 * 但走起来是按真实发生顺序的。
 */

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GatedDirection, SecCode } from '@core/types'
import type { AiExplainRecord } from '@shared/ipc-types'
import { AiExplain, visibleAiText } from './AiExplain'
import { FOOTER_NOTE } from './disclaimer'

/** 与 PanelWindow.ts 的 TITLE_BAR_HEIGHT 成对，改一处要改两处 */
const TITLE_BAR_HEIGHT = 40

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

function stamp(ms: number): string {
  const at = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function AiDrawer({
  signalId,
  code,
  name,
  onWatchCreated,
  onError,
  onClose,
}: {
  /** 当前这条信号。抽屉是从它的「AI 解读」按钮开的 */
  signalId: string
  code: SecCode
  name: string
  onWatchCreated: () => void
  onError: (message: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [history, setHistory] = useState<AiExplainRecord[]>([])
  /** 选中的历史条目 id；null = 看当前这条（live） */
  const [viewing, setViewing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback((): void => {
    void window.gp
      .invoke('ai:history', { code })
      .then(setHistory)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
  }, [code, onError])

  useEffect(reload, [reload])

  // 换了一只票 / 换了一条信号：回到 live，别停在上一只票的某条历史上
  useEffect(() => setViewing(null), [signalId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const index = viewing === null ? -1 : history.findIndex((row) => row.id === viewing)
  const current = index >= 0 ? history[index] : undefined
  // 列表是倒序的（新的在上），所以「更早」是往下走、「更新」是往上走
  const older = index >= 0 && index < history.length - 1 ? history[index + 1] : undefined
  const newer = index > 0 ? history[index - 1] : undefined

  const remove = (id: string): void => {
    setBusy(true)
    void window.gp
      .invoke('ai:remove', id)
      .then((removed) => {
        // false = 用户在系统确认框里取消了，什么都没动
        if (!removed) return
        if (viewing === id) setViewing(null)
        reload()
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return createPortal(
    <>
      {/*
        遮罩与面板都比 StockDrawer（z-40 / z-50）高一层。
        `top` 同样从标题栏下方开始：右上角那一块归系统窗口控件，盖住它用户就关不掉窗口了。
      */}
      <div
        className="fixed inset-x-0 bottom-0 z-[60] bg-black/45"
        style={{ top: TITLE_BAR_HEIGHT }}
        onClick={onClose}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${name} 的 AI 解读`}
        className="fixed bottom-0 right-0 z-[70] flex w-[520px] max-w-full flex-col border-l border-violet-400/20 bg-[var(--gp-surface)] shadow-2xl"
        style={{ top: TITLE_BAR_HEIGHT }}
      >
        <header className="shrink-0 border-b border-white/10 px-4 pt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-violet-200/70">AI 解读</span>
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="font-mono text-xs text-white/35">{code}</span>
            <button
              className="ml-auto shrink-0 text-xs text-white/35 hover:text-white/70"
              onClick={onClose}
            >
              ✕
            </button>
          </div>

          {/* 固定来源标注 —— 不经过模型，模型改不了它 */}
          <p className="mb-2 mt-1.5 text-[10px] leading-snug text-violet-200/70">
            以下由你配置的外部模型生成，不是本应用的策略结论。模型可能出错或编造，
            它读到的只有本地这几项数据。
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {current ? (
            <>
              <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[11px] text-white/45">
                <span className="text-amber-200/70">历史记录</span>
                <span>{stamp(current.createdAt)}</span>
                <span>·</span>
                <span>{DIRECTION_LABEL[current.direction]}</span>
                <span>·</span>
                <span>置信 {Math.round(current.score * 100)}%</span>
                <span className="text-white/25">{current.model}</span>
              </div>
              {/* 历史是只读的：重新解读要回到「当前」那条，那会真的花钱 */}
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-white/75">
                {visibleAiText(current.text)}
              </p>
              <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-2">
                <button
                  className="gp-btn px-1.5 py-0.5 text-[10px]"
                  disabled={!older}
                  onClick={() => older && setViewing(older.id)}
                >
                  ‹ 更早
                </button>
                <button
                  className="gp-btn px-1.5 py-0.5 text-[10px]"
                  disabled={!newer}
                  onClick={() => newer && setViewing(newer.id)}
                >
                  更新 ›
                </button>
                <button
                  className="gp-btn ml-auto px-1.5 py-0.5 text-[10px]"
                  onClick={() => setViewing(null)}
                >
                  回到当前这条
                </button>
              </div>
            </>
          ) : (
            <AiExplain
              signalId={signalId}
              code={code}
              name={name}
              onWatchCreated={onWatchCreated}
              onDone={reload}
              onError={onError}
            />
          )}
        </div>

        <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-white/10 px-4 py-2">
          <div className="flex items-baseline gap-2 text-[11px] text-white/40">
            <span>历史解读</span>
            <span className="text-white/25">本票 {history.length} 条</span>
            <span className="ml-auto text-[10px] text-white/20">不会自动清理，只能手动删</span>
          </div>

          {history.length === 0 ? (
            <p className="py-3 text-center text-[11px] text-white/30">
              这只票还没有解读记录。生成完的会存在这里，重启也还在。
            </p>
          ) : (
            <ul className="mt-1">
              {history.map((row) => {
                const active = row.id === viewing
                return (
                  <li key={row.id} className="flex items-center gap-2 border-b border-white/[0.06] py-1 last:border-b-0">
                    <button
                      className={`flex min-w-0 flex-1 items-baseline gap-2 text-left text-[11px] ${
                        active ? 'text-white/85' : 'text-white/50 hover:text-white/75'
                      }`}
                      onClick={() => setViewing(row.id)}
                    >
                      <span className="shrink-0 text-white/25">{active ? '●' : '○'}</span>
                      <span className="shrink-0 font-mono">{stamp(row.createdAt)}</span>
                      <span className="shrink-0">{DIRECTION_LABEL[row.direction]}</span>
                      <span className="truncate text-white/25">{row.model}</span>
                    </button>
                    <button
                      className="shrink-0 text-[10px] text-white/25 hover:text-rose-200/70"
                      disabled={busy}
                      onClick={() => remove(row.id)}
                    >
                      删
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <footer className="shrink-0 border-t border-white/10 px-4 py-2 text-[10px] text-white/30">
          {FOOTER_NOTE}
        </footer>
      </aside>
    </>,
    document.body
  )
}
