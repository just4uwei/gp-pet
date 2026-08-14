/**
 * 收盘日报（面板第五个页签，2026-08-14）。
 *
 * ## 三条与别处一致的克制
 *
 * 1. **只显示已经有的东西。** 拿不到行情的那只显示「—」，不给 0 占位 ——
 *    0 会让「今天平盘」与「没有数据」长得一模一样（约束 4 的展示层版本）。
 * 2. **数据来源必须写在脸上。** `PROVISIONAL` 的数字取自盘中最后一次行情，
 *    集合竞价会改收盘价，两版对不上而用户看不出是哪个对。
 * 3. **「明日关注」的每一项都指回一个已经存在的东西**（判据在 report/build.ts）。
 *    这一屏不许自己推导任何结论 —— 那是信号层的活。
 *
 * 与「观察点」「影子运行」同一形态：**不订阅推送**，切进来时拉一次。
 * 日报是「一天结束后看一眼」的东西，让它每 30 秒跳一次数字既没必要也让人分心。
 */

import { useCallback, useEffect, useState } from 'react'
import type { DailyReport, DailyReportStock } from '@shared/ipc-types'
import { FOOTER_NOTE } from './disclaimer'

const DIRECTION_LABEL: Record<string, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

const DIRECTION_TONE: Record<string, string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  REDUCE: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  NEXT_DAY_WATCH: 'border-sky-400/40 bg-sky-400/10 text-sky-200',
  NONE: 'border-white/20 bg-white/5 text-white/60',
}

const KIND_LABEL: Record<DailyReport['tomorrow'][number]['kind'], string> = {
  NEXT_DAY_WATCH: '明日观察',
  WATCH_POINT: '观察点',
  POSITION_RISK: '持仓',
}

/** 涨跌用 A 股习惯：红涨绿跌 */
function changeTone(value: number): string {
  if (value > 0) return 'text-rose-400'
  if (value < 0) return 'text-emerald-400'
  return 'text-white/60'
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** 拿不到就是「—」。**不许用 0 顶替** */
function num(value: number | null | undefined, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
}

function StockRow({ stock }: { stock: DailyReportStock }): React.JSX.Element {
  const quote = stock.quote
  const last = stock.signals.last
  return (
    <li className="border-b border-white/[0.06] px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate">{stock.name}</span>
            {/* 快照来源要逐只标注：同一份日报里可能一部分定稿、一部分还没有 */}
            {quote?.source === 'SNAPSHOT' ? (
              <span className="shrink-0 rounded bg-white/10 px-1 text-[10px] text-white/50" title="当日日线尚未入库，这一行取自盘中最后一次行情">
                盘中
              </span>
            ) : null}
          </span>
          <span className="block font-mono text-xs text-white/40">
            {stock.code}
            {stock.industry ? ` · ${stock.industry}` : ''}
          </span>
        </span>

        <span className="w-16 text-right font-mono">{num(quote?.close)}</span>
        <span className={`w-18 text-right font-mono ${quote ? changeTone(quote.changePct) : 'text-white/35'}`}>
          {quote ? signed(quote.changePct) : '—'}
        </span>
        <span className="w-16 text-right font-mono text-xs text-white/45" title="当日振幅（相对昨收）">
          {quote?.amplitudePct === null || quote === null ? '—' : `${quote.amplitudePct.toFixed(1)}%`}
        </span>

        <span className="w-20 shrink-0 text-right">
          {last ? (
            <span className={`rounded border px-1.5 py-0.5 text-[11px] ${DIRECTION_TONE[last.direction] ?? ''}`}>
              {DIRECTION_LABEL[last.direction] ?? last.direction}
            </span>
          ) : (
            // 引擎今天没说话就说没说话，不填一个像建议的中性词（措辞纪律）
            <span className="text-[11px] text-white/30">无信号</span>
          )}
        </span>
      </div>

      {(stock.position || stock.signals.total > 0 || stock.watch.hit > 0 || stock.signals.suppressedReasons.length > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/45">
          {stock.position ? (
            <>
              <span>
                持仓 {stock.position.shares} 股 · 成本 {num(stock.position.cost)}
              </span>
              <span className={stock.position.pnlPct === null ? '' : changeTone(stock.position.pnlPct)}>
                浮动 {stock.position.pnlPct === null ? '—' : signed(stock.position.pnlPct)}
              </span>
              {/* 距止损线是这一屏最该被看到的数：负数意味着已经跌破 */}
              <span className={(stock.position.toStopPct ?? 1) <= 0 ? 'text-amber-200' : ''}>
                距止损线 {stock.position.toStopPct === null ? '—' : signed(stock.position.toStopPct)}
                {stock.position.stopFloor === undefined ? '' : `（你确认的线 ${num(stock.position.stopFloor)}）`}
              </span>
            </>
          ) : null}
          {stock.signals.total > 0 ? (
            <span>
              今日 {stock.signals.actionable} 条信号
              {stock.signals.total > stock.signals.actionable
                ? `（另有 ${stock.signals.total - stock.signals.actionable} 条被静默）`
                : ''}
            </span>
          ) : null}
          {stock.watch.hit > 0 ? <span className="text-sky-200/70">观察点命中 {stock.watch.hit} 次</span> : null}
          {stock.signals.suppressedReasons.map((reason) => (
            <span key={reason} className="text-amber-200/70">
              静默：{reason}
            </span>
          ))}
        </div>
      )}
    </li>
  )
}

export function DailyReportPanel({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [report, setReport] = useState<DailyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback((): void => {
    setLoading(true)
    void window.gp
      .invoke('report:daily')
      .then((next) => {
        setReport(next)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load, refreshKey])

  if (loading && report === null) {
    return <p className="px-3 py-10 text-center text-sm text-white/35">正在汇总…</p>
  }
  if (error !== null) {
    return <p className="px-3 py-10 text-center text-sm text-rose-300">{error}</p>
  }
  if (report === null) {
    // 「数据层还没起来」与「今天什么都没发生」是两件事，分开说
    return <p className="px-3 py-10 text-center text-sm text-white/35">数据层尚未就绪。</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <section className="gp-card">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm text-white/70">收盘日报</h2>
            <span className="font-mono text-xs text-white/40">{report.date}</span>
          </div>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              report.stage === 'FINAL'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                : 'border-amber-400/40 bg-amber-400/10 text-amber-200'
            }`}
            title={
              report.stage === 'FINAL'
                ? '每只有数据的标的都用上了当日收盘线'
                : '当日日线尚未入库，部分数字取自盘中最后一次行情，收盘后可能微调'
            }
          >
            {report.stage === 'FINAL' ? '已定稿' : '盘中数据'}
          </span>
        </div>

        <div className="space-y-1 border-t border-white/[0.06] px-3 py-2.5 text-sm text-white/70">
          {report.highlights.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </section>

      <section className="gp-card">
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-sm text-white/70">逐只</h2>
          <span className="text-xs text-white/30">
            {report.data.withClose}/{report.overview.watchCount} 已有收盘线
          </span>
        </div>
        <ul className="border-t border-white/[0.06]">
          {report.stocks.map((stock) => (
            <StockRow key={stock.code} stock={stock} />
          ))}
        </ul>
      </section>

      <section className="gp-card">
        <div className="px-3 py-2">
          <h2 className="text-sm text-white/70">明日关注</h2>
          {/*
            这一句不是客套：它是「日报只复述不推导」这条纪律对用户的交代 ——
            让他知道这里不会冒出一个别处没有的结论
          */}
          <p className="mt-0.5 text-[11px] leading-snug text-white/35">
            全部来自今日已产生的信号、你自己设的观察点与未了结的持仓，这里不产生新的判断。
          </p>
        </div>
        {report.tomorrow.length === 0 ? (
          <p className="border-t border-white/[0.06] px-3 py-6 text-center text-sm text-white/35">
            没有需要明天跟进的事项。
          </p>
        ) : (
          <ul className="border-t border-white/[0.06]">
            {report.tomorrow.map((row) => (
              <li
                key={`${row.code}-${row.kind}-${row.note}`}
                className="flex items-center gap-3 border-b border-white/[0.06] px-3 py-2 text-sm last:border-b-0"
              >
                <span className="w-16 shrink-0 rounded border border-white/15 px-1 py-0.5 text-center text-[10px] text-white/55">
                  {KIND_LABEL[row.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="truncate">{row.name}</span>
                  <span className="ml-2 font-mono text-xs text-white/35">{row.code}</span>
                </span>
                <span className="text-xs text-white/50">{row.note}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="gp-card">
        <div className="px-3 py-2">
          <h2 className="text-sm text-white/70">今日提醒</h2>
        </div>
        <div className="border-t border-white/[0.06] px-3 py-2.5 text-sm text-white/60">
          <p>
            发出 {report.alerts.delivered} 条，被闸门挡下或降级 {report.alerts.gated} 条。
          </p>
          {report.alerts.reasons.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 text-xs text-white/45">
              {report.alerts.reasons.map((row) => (
                <li key={row.reason}>
                  {row.reason} · {row.count} 次
                </li>
              ))}
            </ul>
          ) : null}
          {report.data.missing.length > 0 ? (
            <p className="mt-2 text-xs text-amber-200/70">
              {report.data.missing.length} 只今日既无收盘线也无行情快照，报告里显示为「—」。
            </p>
          ) : null}
        </div>
      </section>

      <p className="px-1 pb-2 text-center text-[11px] text-white/30">{FOOTER_NOTE}</p>
    </div>
  )
}
