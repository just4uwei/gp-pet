/**
 * 首次启动引导 + 免责声明（docs/01 §8、docs/08 M4）。
 *
 * ## 为什么是**挡在前面**的一屏，而不是页脚一行小字
 *
 * docs/01 §8 要求免责声明「须在应用内展示」。页脚那行「仅供参考，非投资建议」是
 * 常态提示，但它答不了「用户到底看过没有」—— 而这个软件的参数几乎全部未标定
 * （ADR-0003），第一次打开就该说清这件事。所以：确认之前面板的其余内容不可用，
 * 确认时刻落到 `AppSettings.disclaimerAcceptedAt`。
 *
 * ## 两条克制
 *
 * 1. **只有一个按钮，且要滚到底才亮。** 没有「以后再说」——「以后」不会到来。
 *    但也不做倒计时或强制阅读秒数：那只会让人去点别处，不会让人读得更认真。
 * 2. **不在这里教怎么用。** 引导只讲四条**边界**（disclaimer.ts 的
 *    `ONBOARDING_POINTS`），不讲操作步骤 —— 界面本身要能自解释，
 *    用一屏引导补救说不清的界面是本末倒置。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark } from './BrandMark'
import { DISCLAIMER, ONBOARDING_POINTS } from './disclaimer'

export function Onboarding({ onAccept }: { onAccept: () => Promise<void> }): React.JSX.Element {
  const [readToEnd, setReadToEnd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  /**
   * 内容不足一屏时**直接放行**：否则在大窗口上滚不动，按钮永远是灰的 ——
   * 「读到底才能继续」这条规则会变成「无法继续」。
   */
  const checkScroll = useCallback((): void => {
    const el = scroller.current
    if (!el) return
    const slack = el.scrollHeight - el.clientHeight
    if (slack <= 8 || el.scrollTop >= slack - 8) setReadToEnd(true)
  }, [])

  useEffect(() => {
    checkScroll()
  }, [checkScroll])

  async function accept(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onAccept()
    } catch (err) {
      // 设置写不进去（目录只读、组策略）时不能假装确认成功：
      // 下次启动还会弹，用户至少知道是存不下而不是自己没点
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <header
        className="shrink-0 border-b border-white/10 bg-[var(--gp-surface)] px-6 py-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2.5 pr-[144px]">
          <BrandMark />
          <h1 className="text-sm font-semibold tracking-wide">蹲点 · 开始之前</h1>
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={checkScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <p className="text-sm leading-relaxed text-white/70">
            这是一个跑在你自己电脑上的 A 股信号提醒工具。占用一条 300×38 的悬浮条和一个托盘图标，
            尽量不打断你正在做的事。开始之前有四件事要说清楚。
          </p>

          <ol className="flex flex-col gap-3">
            {ONBOARDING_POINTS.map((point, i) => (
              <li key={point.title} className="rounded border border-white/10 bg-white/[0.03] p-3.5">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-white/30">{String(i + 1).padStart(2, '0')}</span>
                  <h2 className="text-sm font-medium text-white/85">{point.title}</h2>
                </div>
                <p className="mt-1.5 pl-6 text-xs leading-relaxed text-white/55">{point.body}</p>
              </li>
            ))}
          </ol>

          <section className="rounded border border-amber-500/30 bg-amber-500/[0.07] p-3.5">
            <h2 className="text-xs font-medium tracking-wide text-amber-200/90">免责声明</h2>
            <p className="mt-2 text-xs leading-relaxed text-amber-100/70">{DISCLAIMER}</p>
          </section>

          <p className="text-xs text-white/30">
            这段声明随后可以在「设置 → 关于」里重新查看。
          </p>
        </div>
      </div>

      <footer className="shrink-0 border-t border-white/10 px-6 py-3.5">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <button
            className="gp-btn border-sky-400/40 px-4 py-2 text-sm text-sky-100 hover:border-sky-300/60"
            disabled={!readToEnd || busy}
            onClick={() => void accept()}
          >
            {busy ? '保存中…' : '我已阅读并理解，开始使用'}
          </button>
          {readToEnd ? null : (
            <span className="text-xs text-white/35">请向下滚动读完全部内容</span>
          )}
          {error ? <span className="text-xs text-rose-300">保存失败：{error}</span> : null}
        </div>
      </footer>
    </main>
  )
}
