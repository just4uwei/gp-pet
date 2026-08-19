/**
 * 建仓体检卡（2026-08-19）。持仓页选「买入」时出现在录入表单**上方**。
 *
 * ## 它回答的是哪个问题
 *
 * 「我自己想买这只票，有没有已知的阻碍」—— **不是**「该不该买」。
 * 每一条都来自一个已经存在的风控裁决或一个能核对的数（判据全在
 * `src/core/risk/entry.ts`，这里一个字都不推导）。所以：
 *
 * - **不出现「可以买 / 建议买入 / 值得买」**，`CLEAR` 的说法是「未发现已知阻碍」；
 * - **`UNKNOWN` 与 `CLEAR` 用完全不同的样式**。「体检做不了」显示成「没问题」
 *   是这个项目一直在防的那类错误，两者长得像就等于没有区分；
 * - **底部那行免责是固定 DOM**，不由任何数据拼出来（与 AI 解读同一条纪律）。
 *
 * ## 为什么价格没填也请求
 *
 * 结构性的那几条（停牌、涨停、ST、次新股、引擎当前结论）与买多少无关，
 * 而那正是「先帮我判断危险性」最想看的部分。填了价与股数之后再追加
 * 止损参考价、最大亏损与建仓后的行业占比。
 */

import { useEffect, useState } from 'react'
import type { SecCode } from '@core/types'
import type { EntryCheckView } from '@shared/ipc-types'

const VERDICT_TEXT: Record<EntryCheckView['verdict'], string> = {
  BLOCKED: '有阻碍',
  CAUTION: '需要注意',
  CLEAR: '未发现已知阻碍',
  UNKNOWN: '体检做不了',
}

const VERDICT_TONE: Record<EntryCheckView['verdict'], string> = {
  BLOCKED: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  CAUTION: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  CLEAR: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  // 刻意与 CLEAR 完全不同：灰、带问号 —— 「不知道」不该看起来像「没事」
  UNKNOWN: 'border-white/20 bg-white/5 text-white/50',
}

const SEVERITY_DOT: Record<EntryCheckView['items'][number]['severity'], string> = {
  BLOCK: 'bg-rose-300',
  WARN: 'bg-amber-300',
  NOTE: 'bg-white/30',
}

export function EntryCheckCard({
  code,
  price,
  shares,
  /** 账本变了要重算（刚录完一笔之后持仓与行业占比都变了） */
  revision,
  onError,
}: {
  code: SecCode
  /** 意向价；填不出数时传 undefined（**不要传 0**） */
  price: number | undefined
  shares: number | undefined
  revision: unknown
  onError: (message: string) => void
}): React.JSX.Element {
  const [check, setCheck] = useState<EntryCheckView | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.gp
      .invoke('trade:entryCheck', {
        code,
        ...(price === undefined ? {} : { price }),
        ...(shares === undefined ? {} : { shares }),
      })
      .then((result) => {
        if (!cancelled) setCheck(result)
      })
      .catch((error: unknown) => {
        // 体检失败不该让持仓页整个报错 —— 它是附加信息，不是这一页的主体
        if (!cancelled) setCheck(null)
        onError(`建仓体检失败：${String(error)}`)
      })
    return () => {
      cancelled = true
    }
  }, [code, price, shares, revision, onError])

  if (check === null) {
    return (
      <section className="rounded border border-white/10 bg-black/20 p-3 text-[11px] text-white/35">
        建仓体检加载中…
      </section>
    )
  }

  return (
    <section className="rounded border border-white/10 bg-black/20 p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-white/45">建仓体检</span>
        <span className={`rounded border px-1.5 py-px text-[10px] ${VERDICT_TONE[check.verdict]}`}>
          {VERDICT_TEXT[check.verdict]}
        </span>
        {check.engine ? (
          <span className="ml-auto truncate text-[10px] text-white/30">{check.engine.headline}</span>
        ) : null}
      </div>

      <ul className="mt-2 space-y-1">
        {check.items.map((item, index) => (
          <li key={`${item.rule}-${index}`} className="flex items-start gap-1.5 text-[11px] leading-snug">
            <span className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${SEVERITY_DOT[item.severity]}`} />
            <span className={item.severity === 'NOTE' ? 'text-white/45' : 'text-white/75'}>{item.text}</span>
          </li>
        ))}
      </ul>

      {/* 数值区：填了意向价与股数才有内容，没填时整块不出现（而不是显示一堆 —） */}
      {check.stop !== undefined || check.dayPosition !== undefined || check.industryShareAfter !== undefined ? (
        <div className="mt-2 grid grid-cols-2 gap-y-1 border-t border-white/10 pt-2 text-[10px]">
          {check.stop !== undefined ? (
            <>
              <span className="text-white/35">止损参考（按出厂止损幅）</span>
              <span className="text-right font-mono text-white/60">
                {check.stop.price.toFixed(2)}
                {check.stop.lossAmount === undefined ? '' : ` · 最大亏损 ${check.stop.lossAmount.toFixed(0)}`}
              </span>
            </>
          ) : null}
          {check.dayPosition !== undefined ? (
            <>
              <span className="text-white/35">现价在今日振幅中的位置</span>
              <span className="text-right font-mono text-white/60">
                {(check.dayPosition * 100).toFixed(0)}%
              </span>
            </>
          ) : null}
          {check.industryShareAfter !== undefined ? (
            <>
              <span className="text-white/35">建仓后该行业持仓占比</span>
              <span className="text-right font-mono text-white/60">
                {(check.industryShareAfter * 100).toFixed(0)}%
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      <p className="mt-2 text-[10px] leading-snug text-white/25">
        体检只列出<span className="text-white/40">已知的阻碍</span>，不判断该不该买。
        没有阻碍不等于这一笔划算。仅供参考，非投资建议。
      </p>
    </section>
  )
}
