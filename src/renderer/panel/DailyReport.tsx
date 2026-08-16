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
import type { DailyReport, DailyReportStock, ReportEnvironment, ReportNoteView } from '@shared/ipc-types'
import { reportTargetId } from '@shared/ai-target'
import type { TradeDate } from '@core/types'
import { FOOTER_NOTE } from './disclaimer'
import { useAiStream } from './useAiStream'

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

/**
 * 今日环境（docs/11 N1）。**独立的一节，与「逐只」分开** ——
 * 上面那几张卡答的是「我自己的票今天怎么样」，这一节答的是「今天大盘与行业怎么样」。
 * 混在一起会让 15 只观察标的把用户自己的 7 只埋掉（`controller.ts` 的 `dailyReport()`）。
 *
 * 这里**只画数**，一句判断都不加：`lines` 由 `report/environment.ts` 拼好，
 * 每一句都能从同屏的数字里逐字推出。
 */
function EnvironmentCard({ env }: { env: ReportEnvironment }): React.JSX.Element {
  return (
    <section className="gp-card">
      <div className="flex items-baseline justify-between px-3 py-2">
        <h2 className="text-sm text-white/70">今日环境</h2>
        <span className="text-xs text-white/30">
          {env.breadth.withQuote}/{env.industries.length} 行业有行情
        </span>
      </div>

      <div className="space-y-1 border-t border-white/[0.06] px-3 py-2.5 text-sm text-white/70">
        {env.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      {env.industries.length > 0 ? (
        <ul className="grid grid-cols-2 gap-x-4 border-t border-white/[0.06] px-3 py-2 sm:grid-cols-3">
          {env.industries.map((row) => (
            <li key={row.code} className="flex items-baseline justify-between gap-2 py-0.5 text-xs">
              <span className="truncate text-white/55" title={`${row.name}（${row.code}）`}>
                {row.industry ?? row.name}
              </span>
              <span
                className={`shrink-0 font-mono ${row.quote ? changeTone(row.quote.changePct) : 'text-white/30'}`}
                // 拿不到行情与「平盘」必须看得出区别，所以缺数是「—」不是 0.00%
                title={row.quote ? `收 ${row.quote.close.toFixed(2)}（${row.quote.source === 'CLOSE' ? '收盘线' : '盘中快照'}）` : '今日无行情数据'}
              >
                {row.quote ? signed(row.quote.changePct) : '—'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="border-t border-white/[0.06] px-3 py-1.5 text-[11px] leading-snug text-white/30">
        行业 ETF 是内置的观察名单，不进提醒、不计入上面的自选统计。此处只列行情，不含消息面。
      </p>
    </section>
  )
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

/**
 * 「让 AI 评一下」。
 *
 * 四条与信号那边一致的纪律（`useAiStream` 的头注释是它们的家）：
 *
 * 1. **打开页签不等于发请求。** 这一块默认只显示已经存过的那条（`report:note`，纯读）。
 *    按钮上必须写清会花钱 —— 这是全应用唯一一处按第三方规则计费的动作。
 * 2. **切页签不取消**，只有「停止」真的 `ai:cancel`。
 * 3. **免责与来源标注不靠提示词** —— 模型可能不照做，所以那两行是固定的 DOM。
 * 4. **它不改任何结论。** 这段话不进 signal 表、不进 alert_log、不点状态点；
 *    日报的「明日关注」也不受它影响（提示词里明令禁止它另列一份）。
 */
function ReportNoteBlock({
  date,
  onSaved,
}: {
  date: TradeDate
  /** 一次评价真的完成了（已落库）—— 上层据此重取那条存下来的 */
  onSaved: () => void
}): React.JSX.Element {
  const [stored, setStored] = useState<ReportNoteView | null>(null)
  const stream = useAiStream(reportTargetId(date), { onDone: onSaved })

  useEffect(() => {
    void window.gp
      .invoke('report:note')
      .then(setStored)
      .catch(() => setStored(null))
  }, [date, onSaved])

  // 流里已经有字就显示流；否则显示存下来的那条
  const showing = stream.phase === 'idle' ? (stored?.text ?? '') : stream.text
  const running = stream.phase === 'running'

  return (
    <section className="gp-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div>
          <h2 className="text-sm text-white/70">整体评价（AI）</h2>
          <p className="mt-0.5 text-[11px] leading-snug text-white/35">
            由你在设置里配置的模型生成。它只做跨标的的横向观察，不改任何结论、也不给单只票的买卖建议。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <button className="gp-btn text-[11px]" onClick={stream.stop}>
              停止
            </button>
          ) : (
            <button className="gp-btn text-[11px]" onClick={() => stream.start(showing !== '')}>
              {showing === '' ? '让 AI 评一下' : '重新生成'}
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-white/[0.06] px-3 py-2.5 text-xs">
        {/* 这段评价写于事实层的上一个版本 —— 必须说出来，别让用户自己去发现 */}
        {stream.phase === 'idle' && stored?.stale === true ? (
          <p className="mb-2 rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1 text-[11px] text-amber-200/80">
            这段评价写于日报定稿之前，上面的数字已经更新过 —— 重新生成才会对上。
          </p>
        ) : null}

        {stream.thinking !== '' && stream.text === '' ? (
          <p className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-white/10 bg-black/20 px-2 py-1.5 text-[11px] leading-relaxed text-white/40">
            {stream.thinking}
            <span className="animate-pulse text-white/30">▍</span>
          </p>
        ) : null}

        {stream.error !== null ? (
          <p className="leading-relaxed text-rose-200/80">{stream.error}</p>
        ) : showing === '' ? (
          <p className="py-3 text-center text-white/30">
            {running ? '正在生成…' : '还没有评价。点右上角的按钮生成一次（调用你配置的模型，按对方规则计费）。'}
          </p>
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed text-white/75">
            {showing}
            {running ? <span className="animate-pulse text-white/40">▍</span> : null}
          </p>
        )}

        {/* 等待期必须一直有反馈：推理模型先想几十秒、一个字都不吐是常态 */}
        {running ? (
          <p className="mt-1.5 text-[11px] text-white/35">
            已等待 {stream.elapsedSec} 秒
            {stream.stalled ? ' · 已有一段时间没有新内容，可能是网络或对方服务的问题' : ''}
          </p>
        ) : null}

        {stream.phase === 'stopped' ? (
          <p className="mt-1.5 text-[11px] text-white/35">已停止。上面是停止前收到的部分，未存入历史。</p>
        ) : null}

        {/* 来源标注固定在这里，不经过模型（纪律 3） */}
        {showing !== '' && stream.error === null ? (
          <p className="mt-2 border-t border-white/[0.06] pt-1.5 text-[10px] leading-snug text-white/30">
            以上由模型根据本地已算出的日报生成
            {stream.phase === 'idle' && stored ? `（${stored.model}，${new Date(stored.createdAt).toLocaleString('zh-CN')}）` : ''}
            ，不是本软件的结论，也未经任何回测验证。
          </p>
        ) : null}
      </div>
    </section>
  )
}

export function DailyReportPanel({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [report, setReport] = useState<DailyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** 今日提醒默认折叠：与概览页的提醒日志重复，而日报的主线是逐只发生了什么 */
  const [alertsOpen, setAlertsOpen] = useState(false)

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
    /*
      **高度自适应，不要 `flex-1` / `overflow-y-auto`**：滚动是外层那一层的事
      （App.tsx 里 `tab === 'REPORT'` 那个容器，与其余页签逐字相同）。

      在这里限死高度会踩一个不显眼的坑：`.gp-card` 是 `display:flex; min-height:0`，
      作为列容器的 flex 子项它**默认收缩** —— 一旦父容器被限死在视口高度，
      每张卡都会被压到比内容矮，内容溢出到下一张卡上面，看起来就是「重叠错乱」。
    */
    <div className="flex flex-col gap-4">
      {/*
        **板块按交易日的时间线排**（2026-08-15）：
        页头 → 今日环境（今天的背景，贯穿全天）→ 逐只（盘中各只发生了什么）
        → 今日汇总（收盘后的统计）→ 整体评价 → 明日关注（明天）→ 今日提醒（折叠）。

        页头**不是卡片**，只是一行：日期与「已定稿 / 盘中数据」是整屏的限定条件，
        不属于任何一个时段的板块。把它塞进第一张卡会让那张卡看起来比别的卡更重要，
        而它其实只是个标题。
      */}
      <div className="flex items-center justify-between px-1">
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

      <EnvironmentCard env={report.environment} />

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
          <h2 className="text-sm text-white/70">今日汇总</h2>
        </div>
        <div className="space-y-1 border-t border-white/[0.06] px-3 py-2.5 text-sm text-white/70">
          {report.highlights.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </section>

      {/*
        AI 评价排在事实之后、明日关注之前：先看今天发生了什么，再看模型怎么评今天，
        最后才是明天。它评的是**今天**，排到「明日关注」后面会读起来像在评明天。
      */}
      <ReportNoteBlock date={report.date} onSaved={load} />

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

      {/*
        今日提醒**默认折叠**（2026-08-14 改）：这一块与概览页的「提醒日志」说的是同一件事，
        而日报这一屏的主线是「今天这些票怎么了」。摊开放在这里会让主线被一段
        每天都长得差不多的统计顶下去。

        但**汇总数留在标题行上**，不折进去 —— 「今天发了几条、被挡了几条」是一眼要看到的，
        真要追问「被哪道闸门挡的」才需要展开（那个问题概览页的提醒日志答得更全）。
      */}
      <section className="gp-card">
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setAlertsOpen((open) => !open)}
        >
          <span className="inline-block w-2 text-xs text-white/35">{alertsOpen ? '▾' : '▸'}</span>
          <h2 className="text-sm text-white/70">今日提醒</h2>
          <span className="ml-auto text-xs text-white/45">
            发出 {report.alerts.delivered} 条 · 挡下或降级 {report.alerts.gated} 条
          </span>
        </button>
        {alertsOpen ? (
          <div className="border-t border-white/[0.06] px-3 py-2.5 text-sm text-white/60">
            {report.alerts.reasons.length === 0 ? (
              <p className="text-xs text-white/40">没有被闸门挡下的提醒。</p>
            ) : (
              <ul className="space-y-0.5 text-xs text-white/45">
                {report.alerts.reasons.map((row) => (
                  <li key={row.reason}>
                    {row.reason} · {row.count} 次
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] leading-snug text-white/30">
              完整的提醒日志（含每一条被丢弃的候选与原因）在「概览」页右下角。
            </p>
          </div>
        ) : null}
      </section>

      {/*
        缺数据的提示**不放进上面那个折叠块** —— 它说的是「这份报告有几只是空的」，
        与提醒无关，而且折起来就等于没说。
      */}
      {report.data.missing.length > 0 ? (
        <p className="rounded border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/70">
          {report.data.missing.length} 只今日既无收盘线也无行情快照，报告里显示为「—」。
        </p>
      ) : null}

      <p className="px-1 pb-2 text-center text-[11px] text-white/30">{FOOTER_NOTE}</p>
    </div>
  )
}
