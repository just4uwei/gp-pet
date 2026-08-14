/**
 * 抽屉「AI」页签的内容：一条信号的解读 + 这只票的全部历史解读。
 *
 * ## 为什么是页签，而不是再叠一层抽屉
 *
 * 这块东西搬过两次家，两次都是为了同一件事 —— **别让渲染层顺手取消一次花过钱的调用**：
 *
 *   1. 最早内嵌在信号行的展开区里。那个列表每轮 tick 都在重排（同一只票来条新信号
 *      就换组头），正在流式生成的解读跟着被卸载、请求被取消，
 *      用户看到的是「等了四十秒的分析界面自己没了」。
 *   2. 于是改成叠在 `StockDrawer` 之上的独立一层。不再被列表碰到了，
 *      但它挡住了同一只票的行情与持仓 —— 而那两样恰恰是看解读时最想对照的东西。
 *
 * 现在是 `StockDrawer` 的一个页签：状态同样在 `App`（列表碰不到），
 * 又能随手切回行情看 K 线。**切页签会卸载这个组件，但不会取消请求** ——
 * `AiExplain` 早就不是「卸载即取消」了，切回来时 `ai:explain` 命中 service 的在途去重，
 * 把已经吐出来的部分补发一遍接上。这条是「便于查看未分析完的记录」的全部实现，
 * **别把卸载即取消加回去**。
 *
 * ## 三条
 *
 * 1. **打开页签不等于发请求。** `ai:explain` 先查内存缓存、再查 `ai_explain` 表，
 *    两层都没有才真发。别为了「点开就有反应」把查库那层去掉 ——
 *    那会让翻一次历史重复计费一次，而用户完全看不出来。
 * 2. **来源标注与免责是固定 DOM**，不经过模型。提示词里写了「不许说成经过验证的」，
 *    但模型可能不照做。
 * 3. **历史是只读的。** 想要新的一份得回到「当前」那条点重新生成 —— 那会真的花钱，
 *    所以按钮上写着。
 *
 * ## 两种正文模式
 *
 * - `live`：当前选中的那条信号。可流式、可停止、可重新生成、可设观察点。
 * - `archive`：历史里选中的某一条，只读。它可能来自已经被裁剪掉的信号，
 *   所以「哪天、什么方向、多少置信」全部读那一行自带的快照，不去 join 信号表。
 *
 * 「‹ 更早 / 更新 ›」在历史里按时间前后走 —— 列表是倒序的（新的在上），
 * 但走起来是按真实发生顺序的。
 */

import { useCallback, useEffect, useState } from 'react'
import type { GatedDirection, SecCode } from '@core/types'
import type { AiExplainRecord, SignalRecord } from '@shared/ipc-types'
import { AiExplain, visibleAiText } from './AiExplain'

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

export function AiPanel({
  code,
  name,
  signals,
  initialSignalId,
  onWatchCreated,
  onError,
}: {
  code: SecCode
  name: string
  /** 该股今日的全部信号，新的在前。解读的对象只能是其中一条 */
  signals: readonly SignalRecord[]
  /** 从信号行进来时指定解读哪一条；缺省取最新那条 */
  initialSignalId?: string
  onWatchCreated: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [history, setHistory] = useState<AiExplainRecord[]>([])
  /** 选中的历史条目 id；null = 看当前那条（live） */
  const [viewing, setViewing] = useState<string | null>(null)
  /** 解读哪一条信号 */
  const [target, setTarget] = useState<string | null>(initialSignalId ?? null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback((): void => {
    void window.gp
      .invoke('ai:history', { code })
      .then(setHistory)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
  }, [code, onError])

  useEffect(reload, [reload])

  // 换了一只票（抽屉里点开另一只）时重置：别停在上一只票的历史或信号上
  useEffect(() => {
    setViewing(null)
    setTarget(initialSignalId ?? null)
  }, [code, initialSignalId])

  const signal = signals.find((row) => row.id === target) ?? signals[0]

  const index = viewing === null ? -1 : history.findIndex((row) => row.id === viewing)
  const current = index >= 0 ? history[index] : undefined
  // 列表倒序（新的在上），所以「更早」往下走、「更新」往上走
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

  return (
    <div className="space-y-3">
      {/* 固定来源标注 —— 不经过模型，模型改不了它 */}
      <p className="text-[10px] leading-snug text-violet-200/70">
        以下由你配置的外部模型生成，不是本应用的策略结论。模型可能出错或编造，
        它读到的只有本地这几项数据。
      </p>

      {signals.length === 0 ? (
        <p className="py-6 text-center text-xs leading-relaxed text-white/35">
          这只票今天还没有信号，没有可解读的对象。
          <br />
          下面是它以前的解读记录。
        </p>
      ) : (
        <section className="rounded border border-violet-400/25 bg-violet-500/[0.06] p-2">
          {/*
            解读哪一条。从信号行进来时已经指定了，但从自选行 / 「仓」按钮进来时没有 ——
            那时默认最新那条，并把选择器摆出来（同一只票一天里会出好几条，
            而「上午那条买入」与「下午那条卖出」值得分别问一次）
          */}
          {signals.length > 1 ? (
            <div className="mb-2 flex flex-wrap items-center gap-1 border-b border-white/10 pb-2">
              <span className="text-[10px] text-white/35">解读哪一条：</span>
              {signals.map((row) => (
                <button
                  key={row.id}
                  className={`rounded border px-1.5 py-px text-[10px] ${
                    row.id === signal?.id
                      ? 'border-violet-400/50 bg-violet-400/15 text-white/85'
                      : 'border-white/15 text-white/40 hover:text-white/70'
                  }`}
                  onClick={() => {
                    setTarget(row.id)
                    setViewing(null)
                  }}
                >
                  {stamp(row.createdAt).slice(6)} {DIRECTION_LABEL[row.direction]}
                </button>
              ))}
            </div>
          ) : null}

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
          ) : signal ? (
            <AiExplain
              /* key 换了才重新开一次：换信号要重来，而同一条信号切页签回来要接上 */
              key={signal.id}
              signalId={signal.id}
              code={code}
              name={name}
              /* 从信号行的「AI 解读」进来才自动发；单纯切到这个页签只给按钮（见 AiExplain） */
              autoStart={initialSignalId !== undefined && signal.id === initialSignalId}
              onWatchCreated={onWatchCreated}
              onDone={reload}
              onError={onError}
            />
          ) : null}
        </section>
      )}

      <section>
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
                <li
                  key={row.id}
                  className="flex items-center gap-2 border-b border-white/[0.06] py-1 last:border-b-0"
                >
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
      </section>
    </div>
  )
}
