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
 * 代价是这一屏会静止（收盘后引擎不再推 `push:engineStatus`，连那次重取也没了）——
 * 所以页头必须给出**生成时刻**与一个**刷新**按钮：静止是可以的，静止而看不出来不行。
 *
 * ## 每个栏目标题后面那个时刻是「数据时刻」，不是「重算时刻」（2026-08-18）
 *
 * 各节的新鲜度天生不同：行情每 30 秒一跳，而「今日提醒」可能从早上 09:03 起就没变过。
 * 全标成生成时刻等于每节都说「刚更新」，那是一个会说谎的数。判据在
 * `report/build.ts` 的 `stampsOf()`（纯函数 + 用例），这里只负责画。
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  DailyReport,
  DailyReportStock,
  NextDayPreview,
  NextDayPreviewRow,
  ReportEnvironment,
  ReportNoteView,
} from '@shared/ipc-types'
import { reportTargetId } from '@shared/ai-target'
import { shanghaiDate, shanghaiHhmmss, shanghaiMdHhmm } from '@shared/time'
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
 * 时刻一律按**北京时间**格式化（`shared/time.ts`）。
 * 用 `toLocaleTimeString` / `getHours()` 会按宿主时区二次偏移 —— 本机 UTC+7 上
 * 北京 15:00 会写成 14:00，而页头那个「北京时间」时钟就在同一屏上。
 *
 * 落在报告那一天之外的时刻带上日期：只给 `HH:mm` 会让昨晚的东西看起来像刚才的。
 */
function stampText(at: number, reportDate: string): string {
  return shanghaiDate(at) === reportDate ? shanghaiHhmmss(at) : shanghaiMdHhmm(at)
}

/**
 * 栏目标题后的数据时刻。
 *
 * `at` 为 null = 这一节还没有任何事实 → 说「暂无」。**不许退回生成时刻或 0**：
 * 那等于替一节空白内容担保「刚更新过」。
 */
function SectionTime({
  at,
  reportDate,
  what,
}: {
  at: number | null
  reportDate: string
  /** 这个时刻是「什么」的时刻 —— 写进 tooltip，别让用户猜 */
  what: string
}): React.JSX.Element {
  return (
    <span
      className="shrink-0 font-mono text-[11px] tabular-nums text-white/30"
      title={at === null ? `这一节暂无数据（${what}）` : `${what}：${stampText(at, reportDate)}（北京时间）`}
    >
      {at === null ? '暂无' : stampText(at, reportDate)}
    </span>
  )
}

/**
 * 今日环境（docs/11 N1）。**独立的一节，与「逐只」分开** ——
 * 上面那几张卡答的是「我自己的票今天怎么样」，这一节答的是「今天大盘与行业怎么样」。
 * 混在一起会让 15 只观察标的把用户自己的 7 只埋掉（`controller.ts` 的 `dailyReport()`）。
 *
 * 这里**只画数**，一句判断都不加：`lines` 由 `report/environment.ts` 拼好，
 * 每一句都能从同屏的数字里逐字推出。
 */
function EnvironmentCard({
  env,
  at,
  reportDate,
}: {
  env: ReportEnvironment
  at: number | null
  reportDate: string
}): React.JSX.Element {
  return (
    <section className="gp-card">
      <div className="flex items-baseline justify-between gap-2 px-3 py-2">
        <h2 className="flex items-baseline gap-2 text-sm text-white/70">
          今日环境
          <SectionTime at={at} reportDate={reportDate} what="这一节里最新的一条行情" />
        </h2>
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

function StockRow({ stock, reportDate }: { stock: DailyReportStock; reportDate: string }): React.JSX.Element {
  const quote = stock.quote
  const last = stock.signals.last
  return (
    <li className="border-b border-white/[0.06] px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate">{stock.name}</span>
            {/*
              快照来源要逐只标注：同一份日报里可能一部分定稿、一部分还没有。
              时刻也逐只给（tooltip）—— 停牌股的「最后成交」可以是几天前的，
              而整节那个时刻取的是最新值，看不出某一行有多旧。
            */}
            {quote?.source === 'SNAPSHOT' ? (
              <span
                className="shrink-0 rounded bg-white/10 px-1 text-[10px] text-white/50"
                title={`当日日线尚未入库，这一行取自盘中最后一次行情（最后成交 ${stampText(quote.at, reportDate)}）`}
              >
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
          <h2 className="flex items-baseline gap-2 text-sm text-white/70">
            整体评价（AI）
            {/*
              这一节的「数据时刻」就是那段话的生成时刻（脚注里也有一份，那份还带模型名）。
              流式跑着的时候不显示 —— 那时它还没有落库时刻，写一个「刚才」是编的
            */}
            {stream.phase === 'idle' && stored ? (
              <SectionTime at={stored.createdAt} reportDate={date} what="这段评价的生成时刻" />
            ) : null}
          </h2>
          {/*
            「评的是今天」这句话原先靠**位置**表达（这一块排在今日的事实之后）。
            2026-08-26 置顶之后位置不再说这件事，所以它必须写在字面上并点名日期 ——
            否则一段排在最上面、又紧挨着「明日预览」的评价，很容易被读成在评明天。
          */}
          <p className="mt-0.5 text-[11px] leading-snug text-white/35">
            对 <span className="font-mono text-white/50">{date}</span> 这一天的横向观察
            —— 由你在设置里配置的模型生成，只看下面已经算好的事实，不改任何结论、也不给单只票的买卖建议。
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
            {/* 时刻按北京时间，与这一屏其余时刻同一口径（`toLocaleString` 会按宿主时区偏） */}
            {stream.phase === 'idle' && stored ? `（${stored.model}，${shanghaiMdHhmm(stored.createdAt)}）` : ''}
            ，不是本软件的结论，也未经任何回测验证。
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** 明日预览的动作标签。与方向标签分开 —— 「明日观察」这个方向在未持仓时才变成「买」 */
const ACTION_LABEL: Record<NextDayPreviewRow['action'], string> = {
  BUY: '买',
  SELL: '卖',
  REDUCE: '减',
}

const ACTION_TONE: Record<NextDayPreviewRow['action'], string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  REDUCE: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
}

/**
 * 「明日预览」：盘后点一下，就地算一次当日收盘确认，答「明天准备买 / 卖 / 减什么」。
 *
 * ## 三处刻意的设计，改之前先读
 *
 * 1. **不并进「明日关注」那一节**（2026-08-26 置顶后它排在下面）—— 那一节的纪律是
 *    「每一项都要指回一个**已经存在**的东西」（今日已落库的信号 / 观察点 / 持仓裁决），
 *    而预览是就地算的、**不落库**，
 *    它指不回去。并进去就把那条纪律破了。
 * 2. **要点按钮才算**，不跟着页签打开就跑：它要为每只自选算一遍 320 根的全套指标。
 *    与「分时图的量由人决定」同一条。
 * 3. **`UNAVAILABLE` 与「空清单」必须显示成两件事**。前者是「今日收盘线还没入库，
 *    算不出来」（盘中打开就是这样），后者是「明天确实没有要做的」——
 *    把前者显示成后者，就是拿「不知道」冒充「没问题」。
 */
function NextDayPreviewBlock({ reportDate }: { reportDate: TradeDate }): React.JSX.Element {
  const [preview, setPreview] = useState<NextDayPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback((): void => {
    setBusy(true)
    void window.gp
      .invoke('report:preview')
      .then((next) => {
        setPreview(next)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }, [])

  return (
    <section className="gp-card">
      <div className="px-3 py-2">
        <h2 className="flex items-baseline gap-2 text-sm text-white/70">
          明日预览
          <span className="text-[11px] text-white/30">盘后算一次 · 不落库</span>
        </h2>
        <p className="mt-0.5 text-[11px] leading-snug text-white/35">
          按 {reportDate} 的收盘线就地跑一遍收盘确认，列出明天准备买 / 卖 / 减的票。
          <span className="text-white/45">明早还会再算一次，结论可能改口</span>
          —— 那一次才是入库的定论。
        </p>
        <button className="gp-btn mt-2" onClick={run} disabled={busy}>
          {busy ? '正在算…' : preview === null ? '算明日预览' : '重新算'}
        </button>
      </div>

      {error !== null ? (
        <p className="border-t border-white/[0.06] px-3 py-3 text-xs text-rose-300">{error}</p>
      ) : preview === null ? null : (
        <div className="border-t border-white/[0.06]">
          <p className="px-3 py-2 text-[11px] leading-snug text-white/35">
            {preview.coverage.withClose}/{preview.coverage.total} 只已有 {preview.date} 的收盘线
            {preview.coverage.missing.length > 0 ? (
              <>
                {' · '}
                <span className="text-amber-200/70" title={preview.coverage.missing.join(' ')}>
                  缺 {preview.coverage.missing.length} 只（
                  {preview.coverage.missing.slice(0, 3).join('、')}
                  {preview.coverage.missing.length > 3 ? '…' : ''}）
                </span>
              </>
            ) : null}
          </p>

          {/* 「算不出来」与「没有要做的」是两件事，分两支写 */}
          {preview.status === 'UNAVAILABLE' ? (
            <p className="px-3 pb-3 text-sm text-amber-200/80">
              {preview.date} 的收盘线一根都还没入库，<strong>算不出来</strong> ——
              不是「明天没有要做的」。个股日线通常 15:05–15:30 发布，收盘后再来。
            </p>
          ) : preview.rows.length === 0 ? (
            <p className="px-3 pb-3 text-sm text-white/40">明天没有准备交易的票。</p>
          ) : (
            <ul>
              {preview.rows.map((row) => (
                <li
                  key={row.code}
                  className="flex items-center gap-3 border-t border-white/[0.06] px-3 py-2 text-sm"
                >
                  <span
                    className={`w-7 shrink-0 rounded border px-1 py-0.5 text-center text-[10px] ${ACTION_TONE[row.action]}`}
                  >
                    {ACTION_LABEL[row.action]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="truncate">{row.name}</span>
                    <span className="ml-2 font-mono text-xs text-white/35">{row.code}</span>
                    {row.holding ? (
                      <span className="ml-2 text-[10px] text-white/35">持仓</span>
                    ) : null}
                  </span>
                  {/* 方向与动作分开显示：同一个「明日观察」在持仓时不会变成买 */}
                  <span className="shrink-0 text-[11px] text-white/45">
                    {DIRECTION_LABEL[row.direction] ?? row.direction}
                  </span>
                  <span
                    className="shrink-0 truncate text-[11px] text-white/35"
                    title={`归因：${row.rule}`}
                  >
                    {row.rule}
                  </span>
                  {/* 「得分」不叫概率也不叫胜率（措辞纪律） */}
                  <span
                    className="shrink-0 font-mono text-[11px] tabular-nums text-white/30"
                    title="组合层得分，不是上涨概率"
                  >
                    {Math.round(row.score * 100)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="border-t border-white/[0.06] px-3 py-2 text-[11px] leading-snug text-white/30">
            这一屏按<strong>你自己的持仓</strong>算，所以它不等于影子运行明天会挂的委托
            （那边用影子组合的持仓）。它不落库、不发提醒、不推进影子。
          </p>
        </div>
      )}
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

  /*
    页头那个「数据截至」= 各节数据时刻的**最大值**。

    在这里现算而不是让主进程多给一个字段：它是 `stamps` 的纯派生量，
    多一个字段就多一个会与那五个数不一致的地方。
  */
  const newestStamp = Object.values(report.stamps).reduce<number | null>(
    (best, at) => (at !== null && (best === null || at > best) ? at : best),
    null
  )

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
        **排序 2026-08-26 由用户改成「可操作的在最上面」**，旧的时间线排法记在下面。

        现在：页头 → 整体评价（AI）→ 明日预览 → 今日环境 → 逐只 → 今日汇总
        → 明日关注 → 今日提醒（折叠）。

        判据是**这一屏哪两块需要人动手**：那两块各有一个按钮，且都要花时间或花钱
        （AI 评价按第三方规则计费，明日预览要为每只自选算一遍 320 根的全套指标）。
        它们此前排在第 4、第 8 位 —— 而这一屏有八张卡，滚到底才看见按钮，
        等于把「要不要点这一下」这个决定藏在了一屏静态数字后面。

        旧排法（2026-08-15）是**按交易日的时间线**：今日环境（背景）→ 逐只（盘中）
        → 今日汇总（收盘）→ 整体评价 → 明日关注 → 明日预览。它当时有一条具体的理由，
        换过来就得认这个代价：**AI 评的是「今天」，现在它排在今天的事实之前** ——
        所以那一块的副标题必须自己说清它评的是什么，不能靠位置暗示（见 ReportNoteBlock）。
        「明日关注」仍留在原位：它是**复述**，没有按钮，不属于「可操作」那一档，
        且它与「明日预览」刻意不并排（两者的纪律不同，见 NextDayPreviewBlock 的第 1 条）。

        页头**不是卡片**，只是一行：日期与「已定稿 / 盘中数据」是整屏的限定条件，
        不属于任何一个时段的板块。把它塞进第一张卡会让那张卡看起来比别的卡更重要，
        而它其实只是个标题。
      */}
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm text-white/70">收盘日报</h2>
          <span className="font-mono text-xs text-white/40">{report.date}</span>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] ${
              report.stage === 'FINAL'
                ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                : 'border-amber-400/40 bg-amber-400/10 text-amber-200'
            }`}
            title={
              report.stage === 'FINAL'
                ? '每只有数据的标的都用上了当日收盘线'
                : '当日日线尚未入库（数据源 15:05–15:30 才发布），部分数字取自盘中最后一次行情，次日盘前定稿'
            }
          >
            {/*
              未定稿态的文案刻意不叫「盘中数据」（2026-08-18 改）：日期改成当前交易日之后，
              这个 badge 在 16:00 也会出现，那时「盘中」是错的。具体几点的数由旁边的时刻回答。
            */}
            {report.stage === 'FINAL' ? '已定稿' : '未定稿'}
          </span>
        </div>
        <div className="flex shrink-0 items-baseline gap-2 text-[11px] text-white/35">
          {/*
            两个时刻分开给，别合成一个：
            「数据截至」= 这份报告里最新的一条事实是几点的（各节取最大）；
            「生成」= 这一屏是几点算出来的。收盘后引擎停止推送 ⇒ 这一屏会静止，
            那时两个数会一起停住，而点「刷新」只会让后一个前进 —— 那个区别正是要让人看见的。
          */}
          <span className="font-mono tabular-nums" title="这份报告里最新的一条事实的时刻（北京时间）">
            数据截至 {newestStamp === null ? '—' : stampText(newestStamp, report.date)}
          </span>
          <span className="font-mono tabular-nums text-white/25" title="这一屏是什么时候算出来的（北京时间）">
            生成 {stampText(report.at, report.date)}
          </span>
          <button
            className="gp-btn text-[11px]"
            onClick={load}
            disabled={loading}
            title="重新汇总一次。收盘后引擎不再推送，这一屏不会自己更新"
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>

      {/*
        可操作的两块置顶（2026-08-26，用户拍板）。顺序是「评今天 → 看明天」，
        与它们各自的内容一致；两块都**不会自己跑**，要点按钮才动。
      */}
      <ReportNoteBlock date={report.date} onSaved={load} />
      <NextDayPreviewBlock reportDate={report.date} />

      <EnvironmentCard env={report.environment} at={report.stamps.environment} reportDate={report.date} />

      <section className="gp-card">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <h2 className="flex items-baseline gap-2 text-sm text-white/70">
            逐只
            <SectionTime
              at={report.stamps.stocks}
              reportDate={report.date}
              what="这一节里最新的一条行情或信号"
            />
          </h2>
          <span className="text-xs text-white/30">
            {report.data.withClose}/{report.overview.watchCount} 已有收盘线
          </span>
        </div>
        <ul className="border-t border-white/[0.06]">
          {report.stocks.map((stock) => (
            <StockRow key={stock.code} stock={stock} reportDate={report.date} />
          ))}
        </ul>
      </section>

      <section className="gp-card">
        <div className="px-3 py-2">
          <h2 className="flex items-baseline gap-2 text-sm text-white/70">
            今日汇总
            {/* 它是上面几节的复述 ⇒ 时刻取它复述的那些事实里最新的一条（stampsOf 的边界 3） */}
            <SectionTime at={report.stamps.summary} reportDate={report.date} what="被复述的那些事实里最新的一条" />
          </h2>
        </div>
        <div className="space-y-1 border-t border-white/[0.06] px-3 py-2.5 text-sm text-white/70">
          {report.highlights.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      </section>

      <section className="gp-card">
        <div className="px-3 py-2">
          <h2 className="flex items-baseline gap-2 text-sm text-white/70">
            明日关注
            <SectionTime at={report.stamps.tomorrow} reportDate={report.date} what="被复述的那些结论里最新的一条" />
          </h2>
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
                {/* 被复述的那条东西自己是几点得出的 —— 「只复述不推导」的可核对版本 */}
                <span
                  className="shrink-0 font-mono text-[11px] tabular-nums text-white/25"
                  title="被复述的那条信号 / 观察点自己的时刻（北京时间）"
                >
                  {stampText(row.at, report.date)}
                </span>
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
          <h2 className="flex items-baseline gap-2 text-sm text-white/70">
            今日提醒
            {/* 这一节可能从早上 09:03 起就没变过 —— 那正是「数据时刻」要说的事 */}
            <SectionTime at={report.stamps.alerts} reportDate={report.date} what="今日最后一条提醒的时刻" />
          </h2>
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
