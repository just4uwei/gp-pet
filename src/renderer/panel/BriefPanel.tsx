/**
 * 盘前简报（[docs/11](../../../docs/11-盘外消息面简报功能需求.md) N5）。
 *
 * ## 它不是提醒，也不是结论
 *
 * 只列出数据源给的公告标题与分类，**不判利好利空、不给买卖方向**。
 * 它答的是引擎答不了的那个问题：「这只票今天为什么跌破止损」——
 * 可能是趋势走坏（引擎能说），也可能是昨晚出了减持公告（引擎完全看不见）。
 *
 * ## 三条界面纪律
 *
 * 1. **空态说「无新公告」，不说「无异常」** —— 本功能只覆盖公告这一类，
 *    说成"无异常"是替一个从来没查过的范围担保。
 * 2. **失败态与空态必须分开** —— 「没能取到」和「今天没有」是两件事；
 *    把前者显示成后者，用户会以为已经确认过了。
 * 3. **每条都能点回原文** —— 这是本功能唯一的防幻觉结构保证。
 *    没有链接的条目在解析层就被丢掉了，所以这一屏上不存在点不开的条目。
 *
 * ## 「拉取」是显式动作
 *
 * 打开这一页**只读库**（`brief:daily`），不发请求。要去数据源拉是另一个按钮
 * （`announcement:refresh`）—— 与「打开 AI 页签不等于花钱」同一条纪律。
 * 也**不做定时推送**：盘前用户的机器可能根本没开，一个「必须开机才生效」的定时任务
 * 会静默地时有时无，而用户无法分辨是「今天没消息」还是「今天没跑」。
 */

import { useCallback, useEffect, useState } from 'react'
import type { BriefItem, BriefStock, DailyBrief } from '@shared/ipc-types'
import { FOOTER_NOTE } from './disclaimer'

/** 默认回看窗口：3 天。周五收盘后到周一开盘之间隔着两个自然日，短于它会漏掉整个周末 */
const LOOKBACK_DAYS = 3

function timeText(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function ItemRow({ item }: { item: BriefItem }): React.JSX.Element {
  return (
    <li className="flex items-baseline gap-2 border-b border-white/[0.06] px-3 py-1.5 text-sm last:border-b-0">
      <span className="w-24 shrink-0 font-mono text-[11px] text-white/35">{timeText(item.publishedAt)}</span>
      {/* 分类拿不到时显示「—」，**不显示「其他」** —— 那会让 null 看起来像一个真实分类 */}
      <span
        className={`w-24 shrink-0 truncate rounded px-1 text-[11px] ${
          item.spotlight ? 'bg-amber-400/10 text-amber-200' : 'text-white/35'
        }`}
        title={item.spotlight ? '属于建议先看的类型（只是标记，不是判断好坏）' : undefined}
      >
        {item.category ?? '—'}
      </span>
      <a
        className="min-w-0 flex-1 truncate text-white/70 underline decoration-white/20 underline-offset-2 hover:text-white"
        href={item.url}
        target="_blank"
        rel="noreferrer"
        title={item.title}
      >
        {item.title}
      </a>
    </li>
  )
}

function StockBlock({ stock }: { stock: BriefStock }): React.JSX.Element {
  return (
    <section className="gp-card">
      <div className="flex items-baseline justify-between px-3 py-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm text-white/70">{stock.name}</h3>
          <span className="font-mono text-xs text-white/40">{stock.code}</span>
          {stock.hasPosition ? (
            <span className="rounded border border-sky-400/40 bg-sky-400/10 px-1 text-[10px] text-sky-200">持仓</span>
          ) : null}
        </div>
        <span className="text-xs text-white/30">{stock.items.length} 条</span>
      </div>
      <ul className="border-t border-white/[0.06]">
        {stock.items.map((item) => (
          <ItemRow key={item.id} item={item} />
        ))}
      </ul>
    </section>
  )
}

export function BriefPanel({ onError }: { onError: (message: string | null) => void }): React.JSX.Element {
  const [brief, setBrief] = useState<DailyBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)

  const sinceMs = (): number => Date.now() - LOOKBACK_DAYS * 86_400_000

  const load = useCallback((): void => {
    setLoading(true)
    void window.gp
      .invoke('brief:daily', sinceMs())
      .then((next) => setBrief(next))
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [onError])

  useEffect(load, [load])

  /** 唯一会发网络请求的动作。**由用户点，不定时** */
  const refresh = (): void => {
    setRefreshing(true)
    setRefreshNote(null)
    void window.gp
      .invoke('announcement:refresh', sinceMs())
      .then((result) => {
        // 失败与「今天没有公告」分开说 —— 后者会让用户以为已经确认过了
        setRefreshNote(
          result.ok
            ? `取到 ${result.fetched} 条，新增 ${result.added} 条。`
            : `没能取到公告：${result.error}`
        )
        load()
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRefreshing(false))
  }

  if (loading && brief === null) {
    return <p className="px-3 py-10 text-center text-sm text-white/35">正在读取…</p>
  }
  if (brief === null) {
    return <p className="px-3 py-10 text-center text-sm text-white/35">数据层尚未就绪。</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm text-white/70">自选股公告</h2>
          <span className="font-mono text-xs text-white/40">近 {LOOKBACK_DAYS} 天</span>
        </div>
        <button
          type="button"
          className="rounded border border-white/15 px-2 py-1 text-xs text-white/60 hover:border-white/30 hover:text-white/80 disabled:opacity-40"
          onClick={refresh}
          disabled={refreshing}
          title="去数据源拉一次。打开这一页本身不会发请求"
        >
          {refreshing ? '正在拉取…' : '拉取最新'}
        </button>
      </div>

      <section className="gp-card">
        <div className="space-y-1 px-3 py-2.5 text-sm text-white/70">
          {brief.lines.map((line) => (
            <p key={line} className={brief.fetchError === undefined ? '' : 'text-amber-200/80'}>
              {line}
            </p>
          ))}
          {refreshNote === null ? null : <p className="text-[11px] text-white/40">{refreshNote}</p>}
        </div>
      </section>

      {brief.stocks.length === 0 && brief.fetchError === undefined ? (
        <section className="gp-card">
          {/*
            空态文案是硬要求（docs/11 N5-b）：只能说「无新公告」。
            **不许**写成「今日无异常」「今日平安」—— 本功能只覆盖公告这一类
          */}
          <p className="px-3 py-8 text-center text-sm text-white/35">
            近 {LOOKBACK_DAYS} 天内，自选股没有新公告。
          </p>
        </section>
      ) : (
        brief.stocks.map((stock) => <StockBlock key={stock.code} stock={stock} />)
      )}

      {/* 覆盖范围声明是固定 DOM，不靠提示词也不靠模型（docs/11 §8 第 5 条） */}
      <p className="px-1 text-[11px] leading-relaxed text-white/30">
        只列出数据源提供的公告标题与分类，<span className="text-white/50">未解析正文</span>
        ，也不判断利好利空。内置的「行业ETF」不在范围内。{FOOTER_NOTE}。
      </p>
    </div>
  )
}
