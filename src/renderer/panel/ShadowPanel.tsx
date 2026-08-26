/**
 * 影子运行视图（docs/07 §2.3、docs/08 M4）。
 *
 * 「若每条信号都照做，到今天赚没赚」—— 前向累积，不是回测。
 *
 * ## 这一屏最容易出的错是**把数字说成结论**
 *
 * 所以措辞纪律在这里是硬要求（CLAUDE.md）：
 *
 * - 观察期（满 90 天前）内，只并列数字，**不出现**「跑赢」「有效」「表现不错」。
 *   `seasoned` 为 false 时顶部固定一条提示，且沪深300 那一栏只并排显示，
 *   **不算差值**（算了就会被读成「超额 +X%」，而两周的超额什么都不说明）。
 * - 「胜率」两个口径都给且都标明：一行 trade 是一次卖出，回撤减仓会把一次建仓拆成
 *   两三行，两个口径实测能差 16 个百分点（M2 §5.18）。**建仓级是用户口径**，放在前面。
 * - 资金占用率与基准收益**同框显示**。基准是满仓的，缺这个数会把超额读反（M2 §5.13）。
 * - 「置信度」不得称「胜率」—— 但影子运行里的胜率是**已实现的模拟成交统计**，
 *   那是事实而不是预测，可以叫胜率。两者的区别就在这里：一个是回头看，一个是往前猜。
 *
 * ## 「模拟持仓」那一节是这一屏唯一读实时行情的地方（2026-08-26）
 *
 * 其余每个数字都来自模拟账本（`shadow/summary.ts`），而持仓那几行要答「现在值多少」，
 * 于是多了现价与**当日参考盈亏**两列。两条边界写死在 `dayPnlOf` 的头注释里，
 * 最要紧的一条是：**当日参考盈亏不在净值里** —— 净值按最后一个已推进交易日的收盘价盯市，
 * 把它和「浮动盈亏」相加等于把今天算两遍。界面上因此两列各有列头、脚注点名说「别相加」。
 */

import { useCallback, useEffect, useState } from 'react'
import { shanghaiHhmm, shanghaiMdHhmm } from '@shared/time'
import type { SecCode } from '@core/types'
import type {
  MaintenanceResult,
  QuoteTick,
  ShadowJournalView,
  ShadowSummary,
  ShadowTradeView,
} from '@shared/ipc-types'

const REGIME_LABEL: Record<string, string> = {
  TREND_UP: '上升趋势',
  TREND_DOWN: '下降趋势',
  RANGE: '震荡',
  TRANSITION: '过渡',
}

const ACTION_LABEL: Record<string, string> = { BUY: '买入', SELL: '卖出', REDUCE: '减仓' }

/**
 * 流水每一档的显示样式。**只陈述动作，不评价** —— 与这个文件其余部分同一条纪律。
 *
 * `NOT_ADVANCED` 用警示色是刻意的：它意味着那个交易日的前向记录**永久缺失**，
 * 而这件事此前只在主进程日志里出现一行，界面上完全不可见。
 */
const KIND_LABEL: Record<ShadowJournalView['kind'], { text: string; tone: string }> = {
  PLACED: { text: '挂委托', tone: 'text-sky-300/80' },
  FILLED_BUY: { text: '建仓', tone: 'text-rose-300/90' },
  FILLED_SELL: { text: '平仓', tone: 'text-emerald-300/90' },
  VOIDED: { text: '委托作废', tone: 'text-white/45' },
  DEFERRED: { text: '顺延', tone: 'text-white/45' },
  CLOSED_OUT: { text: '移出自选而了结', tone: 'text-white/45' },
  NOT_ADVANCED: { text: '未推进', tone: 'text-amber-300/90' },
}

function pct(value: number | null, digits = 2): string {
  if (value === null) return '—'
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`
}

function plain(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits)
}

function money(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

/**
 * 夏普的显示值。交易日不够时给「样本不足」而不是数字 ——
 * 这是刻意**不显示一个已经算出来的数**：`bars = 4` 时它是 12.58，
 * 而那个量级在真实日频权益策略上不存在，印出来只会被读成绩效。
 */
function sharpeText(value: number | null, bars: number, minBars: number): string {
  if (bars < minBars) return '样本不足'
  return plain(value)
}

/** 恒返回字符串：`exactOptionalPropertyTypes` 下 `hint={undefined}` 不合法 */
function sharpeHint(bars: number, minBars: number): string {
  if (bars < minBars) return `只有 ${bars} 个交易日，不足 ${minBars} 个不给这个数`
  return '×√243 假设日收益独立；这个长度仍判不出夏普（MinTRL 以年计）'
}

function tone(value: number): string {
  // A 股习惯：红涨绿跌
  if (value > 0) return 'text-rose-400'
  if (value < 0) return 'text-emerald-400'
  return 'text-white/60'
}

/** 带符号的金额。0 也不加号 —— 「持平」不该看起来像一次微小的盈利 */
function signedMoney(value: number): string {
  return `${value > 0 ? '+' : ''}${money(value)}`
}

/**
 * 当日参考盈亏（2026-08-26）：`股数 ×（现价 − 昨收）`，两个价都是**不复权**的。
 *
 * 三条边界，少一条就会被读错：
 *
 * 1. **它不在净值里。** 上面那个「累计收益」是影子账本按**最后一个已推进交易日的收盘价**
 *    盯市算出来的（`shadow/summary.ts` 的 `positionValue`），而这个数取的是此刻的行情 ——
 *    两个相加等于把今天算两遍。所以它只放在持仓这一节，且旁边写清「未计入累计收益」。
 * 2. **昨收拿不到就是 null**（显示「—」）。算成 0 元等于说「今天没赚没亏」，
 *    而真相是这个数算不出来（约束 4）。`QuoteTick.changePct` 恰恰在这种情况下给 0，
 *    所以这里读 `preClose` 而**不是**拿涨跌幅去反推金额。
 * 3. **不复权，与影子的浮动盈亏（前复权）不是同一口径** —— 但它只取**同一天之内**
 *    的价差，除权除息在这个窗口里不会发生，两个价一起偏或一起不偏。
 *
 * ⚠ 行情可能是 `STORED`（重启后从留痕或日线读回来的，甚至是上一个交易日的）。
 * 那时「当日」这两个字就不准了，所以调用处必须灰显并把价格时刻写进 `title`。
 */
function dayPnlOf(shares: number, quote: QuoteTick | undefined): number | null {
  if (!quote || quote.preClose === null || quote.preClose <= 0) return null
  return (quote.last - quote.preClose) * shares
}

function Metric({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string
  value: string
  hint?: string
  valueClass?: string
}): React.JSX.Element {
  return (
    <div className="rounded border border-white/10 bg-white/[0.03] px-3 py-2">
      <div className="text-[11px] text-white/40">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${valueClass ?? 'text-white/85'}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] leading-snug text-white/30">{hint}</div> : null}
    </div>
  )
}

export function ShadowPanel({
  refreshKey,
  quoteOf,
  onError,
}: {
  refreshKey: number
  /**
   * 实时行情（上层那份 `push:quoteTick` 投影）。**只用于「模拟持仓」那一节的现价与
   * 当日参考盈亏** —— 绩效那一堆数字一律来自模拟账本，不受它影响。
   *
   * 这一屏本身刻意不订阅推送（与日报同一条：切进来拉一次），但行情由上层推着走，
   * 于是持仓那几行会跟着跳而别处静止 —— 那正是想要的：只有「现在多少钱」需要实时。
   */
  quoteOf: Map<SecCode, QuoteTick>
  onError: (message: string) => void
}): React.JSX.Element {
  const [summary, setSummary] = useState<ShadowSummary | null>(null)
  const [trades, setTrades] = useState<ShadowTradeView[]>([])
  const [journal, setJournal] = useState<ShadowJournalView[]>([])
  const [notice, setNotice] = useState<MaintenanceResult | null>(null)

  const load = useCallback((): void => {
    void Promise.all([
      window.gp.invoke('shadow:summary'),
      window.gp.invoke('shadow:trades', { limit: 30 }),
      window.gp.invoke('shadow:journal', { limit: 60 }),
    ])
      .then(([next, rows, log]) => {
        setSummary(next)
        setTrades(rows)
        setJournal(log)
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
  }, [onError])

  useEffect(load, [load, refreshKey])

  const reset = useCallback((): void => {
    void window.gp
      .invoke('shadow:reset')
      .then((result) => {
        setNotice(result)
        if (result.status === 'DONE') load()
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
  }, [load, onError])

  if (!summary) {
    return <p className="px-1 py-10 text-center text-sm text-white/35">读取影子运行记录…</p>
  }

  // 还没有任何交易日 —— 「尚未开始」与「跑了但没赚」是两件事，不能显示成一屏 0
  if (summary.startedAt === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded border border-white/15 bg-white/5 px-3 py-2.5 text-xs leading-relaxed text-white/55">
          影子运行会在下一个交易日收盘后开始累积。它记录的是「若每条收盘确认信号都照做」的
          模拟持仓 —— <span className="text-white/75">前向累积，不用历史行情补</span>
          （补出来的那个叫回测，而它证明不了同一件事）。
        </p>
        <p className="text-xs text-white/30">起始资金 100 万元，每笔建仓名义金额 10 万元，按双边佣金 + 印花税 + 过户费 + 0.1% 滑点扣费。</p>
        {/* 一天都没推进过，但流水里有东西 —— 那正是「为什么还没开始」的答案，
            这一屏恰恰是最该显示它的地方 */}
        {journal.length > 0 ? (
          <ul className="flex flex-col gap-1 text-[11px]">
            {journal.map((row) => (
              <li key={`${row.date}-${row.seq}`} className="flex items-start gap-2">
                <span className="w-11 shrink-0 font-mono text-white/30">{row.date.slice(5)}</span>
                <span className={`w-24 shrink-0 ${KIND_LABEL[row.kind].tone}`}>{KIND_LABEL[row.kind].text}</span>
                <span className="min-w-0 flex-1 text-white/30">{row.reason ?? ''}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }

  const remaining = Math.max(0, summary.seasoningDays - summary.calendarDays)

  return (
    <div className="flex flex-col gap-3">
      {/* 观察期提示。这一条在满 90 天前**必须**在最上面（docs/07 §2.3） */}
      {summary.seasoned ? null : (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
          观察期：已运行 {summary.calendarDays} 天，还差 {remaining} 天满 {summary.seasoningDays} 天。
          下面的数字<span className="font-medium">只作观察，不构成任何绩效结论</span> ——
          样本这么短时，赚和亏都在噪音里。
        </p>
      )}

      {summary.stalledEngineVersion === null ? null : (
        <div className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-200">
          <p>
            引擎参数已变（记录于 <span className="font-mono">{summary.stalledEngineVersion}</span>，当前{' '}
            <span className="font-mono">{summary.engineVersion}</span>），
            <span className="font-medium">影子运行已暂停累积</span>。
            继续往同一条曲线上加点，会把两套参数的结果混在一起，而那条曲线不属于任何一套参数。
          </p>
          <p className="mt-1.5 text-rose-200/70">
            要么把灵敏度改回原档位继续累积，要么清空重新开始（已有记录无法重建）。
          </p>
          <button className="gp-btn mt-2 border-rose-400/40 text-rose-100" onClick={reset}>
            清空并重新开始…
          </button>
        </div>
      )}

      {notice ? (
        <p
          className={`rounded border px-3 py-2 text-xs ${
            notice.status === 'FAILED'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : 'border-white/15 bg-white/5 text-white/60'
          }`}
        >
          {notice.message}
          {notice.error ? `：${notice.error}` : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="gp-chip">
          起点 <span className="text-white/70">{summary.startedDate ?? '—'}</span>
        </span>
        <span className="gp-chip">
          交易日 <span className="text-white/70">{summary.bars}</span>
        </span>
        <span className="gp-chip">
          净值 <span className="text-white/70">{money(summary.equity)}</span> / {money(summary.startCapital)}
        </span>
      </div>

      {/* ── 运行状态 ────────────────────────────────────────────────
          「它在不在跑」用现有几个数答不出来：全空仓时净值曲线是一条 1000000 的直线，
          与「压根没推进」长得一模一样。所以这一块只摆事实：推进到哪天、挂着什么。 */}
      <div className="rounded border border-white/10 bg-white/[0.03] p-3">
        <h3 className="text-xs font-medium text-white/70">运行状态</h3>
        <div className="mt-1.5 flex flex-col gap-1 text-[11px] text-white/55">
          <div>
            最后推进到 <span className="font-mono text-white/80">{summary.lastAdvancedDate ?? '—'}</span>
            {summary.lastTradingDate === null ? null : (
              <>
                ，最后一个已收盘交易日是{' '}
                <span className="font-mono text-white/80">{summary.lastTradingDate}</span>
              </>
            )}
          </div>
          {/* 「晚一天」是设计，不是故障 —— 不许把它显示成告警（tick.ts 的 feedShadow 闸门） */}
          <p className="text-[10px] leading-snug text-white/30">
            影子在<span className="text-white/50">次日盘前</span>那一跳推进（那时 D 的收盘线刚补进来、
            D+1 的开盘还没发生，按次日开盘成交仍是前向的）。所以它正常就比最后一个交易日晚一天；
            应用某天没开机，或开机时已过开盘，那一天的记录<span className="text-white/50">永久缺失</span>
            —— 下面的流水里会有一条「未推进」。
          </p>
        </div>

        {summary.pending.length > 0 ? (
          <div className="mt-2 border-t border-white/10 pt-2">
            <div className="text-[11px] text-white/45">待次日开盘成交 {summary.pending.length} 笔</div>
            <ul className="mt-1 flex flex-col gap-1">
              {summary.pending.map((order) => (
                <li key={order.code} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 truncate text-white/70" title={order.code}>
                    {order.name}
                  </span>
                  <span className="w-16 shrink-0 font-mono text-white/30">{order.code}</span>
                  <span className="w-8 shrink-0 text-white/60">{ACTION_LABEL[order.action] ?? order.action}</span>
                  <span className="w-24 shrink-0 truncate text-white/40" title={order.rule}>
                    {order.rule}
                  </span>
                  <span className="w-14 shrink-0 text-white/30">
                    {REGIME_LABEL[order.regime] ?? order.regime}
                  </span>
                  <span className="w-12 shrink-0 text-right font-mono text-white/40">
                    {order.score.toFixed(2)}
                  </span>
                  <span className="text-white/25">
                    {order.placedDate.slice(5)} 挂
                    {order.deferredBars > 0 ? ` · 已顺延 ${order.deferredBars} 天` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {/* ── 组合 ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric
          label="累计收益"
          value={pct(summary.totalReturn)}
          valueClass={`font-mono ${tone(summary.totalReturn)}`}
          hint="已扣双边费用与滑点"
        />
        <Metric
          label="同期沪深300"
          value={pct(summary.benchmarkReturn)}
          valueClass={`font-mono ${summary.benchmarkReturn === null ? 'text-white/40' : tone(summary.benchmarkReturn)}`}
          // 刻意不算差值：基准满仓、策略绝大多数时间空仓，两个收益率不在同一个分母上
          hint="满仓口径，与左边不可直接相减"
        />
        <Metric
          label="平均资金占用"
          value={summary.exposure === null ? '—' : `${(summary.exposure * 100).toFixed(1)}%`}
          hint="缺这个数会把上面的对比读反"
        />
        {/* beta 与占用率是同一个问题的两种量法（回测报告里也是这么并排印的，M2 §5.41 ①）。
            null 是「算不出」而不是「与大盘无关」，所以显示成 — 而不是 0.00 */}
        <Metric
          label="beta"
          value={summary.beta === null ? '—' : summary.beta.toFixed(3)}
          hint="暴露的第二种量法，与左边互相印证"
        />
        <Metric label="最大回撤" value={pct(summary.maxDrawdown)} valueClass="font-mono text-white/85" />
        {/* exactOptionalPropertyTypes 下 `hint={undefined}` 不合法，只能整条不传 */}
        {summary.seasoned ? (
          <Metric label="年化" value={pct(summary.annualized)} />
        ) : (
          <Metric label="年化" value={pct(summary.annualized)} hint="样本太短，仅算术外推" />
        )}
        {/*
          两个夏普**并排**，且各自把 rf 写在标签上 —— rf 是自由参数，脱开取值这个数
          没有意义（回测那侧实测 rf=0 给 −0.412、rf=2% 给 −0.502）。
          机会成本只按逐日持仓占用收，不是直接减：直接减会因为常年空仓罚两次
          （见 `backtest/metrics.ts` 的 `riskFreeAdjustedSharpe`）。

          交易日不够时显示「样本不足」而不是数字：4 个净值点能算出年化夏普 12.58
          （其中一天全空仓、日收益率恰好 0），那个数唯一表达的是样本量。
          阈值的性质见 `SHARPE_MIN_BARS` —— 它是展示阈值，真门槛以年计。
        */}
        <Metric
          label="夏普（rf=0）"
          value={sharpeText(summary.sharpe, summary.bars, summary.sharpeMinBars)}
          hint={sharpeHint(summary.bars, summary.sharpeMinBars)}
        />
        <Metric
          label={`夏普（rf=${(summary.riskFreeRate * 100).toFixed(0)}%）`}
          value={sharpeText(summary.sharpeNet, summary.bars, summary.sharpeMinBars)}
          hint="机会成本只按逐日持仓占用收，不是整体减 rf"
        />
      </div>

      {/* ── 两个胜率口径 ────────────────────────────────────────── */}
      <div className="rounded border border-white/10 bg-white/[0.03] p-3">
        <h3 className="text-xs font-medium text-white/70">模拟成交统计</h3>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] sm:grid-cols-4">
          <div>
            <div className="text-white/40">建仓次数</div>
            <div className="font-mono text-white/80">{summary.entries.count}</div>
          </div>
          <div>
            {/* 用户口径放在前面：「我按提醒买了一次，最后赚没赚」 */}
            <div className="text-white/40">建仓级胜率</div>
            <div className="font-mono text-white/80">
              {summary.entries.winRate === null ? '—' : `${(summary.entries.winRate * 100).toFixed(1)}%`}
            </div>
          </div>
          <div>
            <div className="text-white/40">平均每次建仓</div>
            <div className={`font-mono ${summary.entries.avgPnl === null ? 'text-white/40' : tone(summary.entries.avgPnl)}`}>
              {summary.entries.avgPnl === null ? '—' : `${summary.entries.avgPnl > 0 ? '+' : ''}${money(summary.entries.avgPnl)} 元`}
            </div>
          </div>
          <div>
            <div className="text-white/40">盈亏比</div>
            <div className="font-mono text-white/80">{plain(summary.entries.payoffRatio)}</div>
          </div>
          <div>
            <div className="text-white/40">卖出笔数</div>
            <div className="font-mono text-white/80">{summary.trades.count}</div>
          </div>
          <div>
            <div className="text-white/40">逐笔胜率</div>
            <div className="font-mono text-white/80">
              {summary.trades.winRate === null ? '—' : `${(summary.trades.winRate * 100).toFixed(1)}%`}
            </div>
          </div>
          <div>
            <div className="text-white/40">平均持有</div>
            <div className="font-mono text-white/80">
              {summary.trades.avgHoldingBars === null ? '—' : `${summary.trades.avgHoldingBars.toFixed(1)} 日`}
            </div>
          </div>
          <div>
            <div className="text-white/40">累计费用</div>
            <div className="font-mono text-white/80">{money(summary.trades.totalCosts)} 元</div>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-snug text-white/30">
          两个胜率口径不一样：一「笔」是一次卖出，而回撤减仓会把一次建仓拆成两三笔。
          你体验到的是<span className="text-white/50">建仓级</span>那个数
          {summary.entries.reduced > 0 ? `（其中 ${summary.entries.reduced} 次中途减过仓）` : ''}。
        </p>
      </div>

      {/* 被跳过的建仓要报出来：静默跳过会让「信号密集期的收益」凭空消失 */}
      {summary.skippedNoCash > 0 || summary.limitBlocked > 0 ? (
        <p className="text-[11px] leading-relaxed text-white/40">
          {summary.skippedNoCash > 0 ? `${summary.skippedNoCash} 次因模拟现金不足没能建仓；` : ''}
          {summary.limitBlocked > 0 ? `${summary.limitBlocked} 次因涨停买不到或跌停卖不掉而顺延或作废。` : ''}
          这些是记账口径的限制，不是策略判断 —— 列在这里以免它们被算成「信号不值钱」。
        </p>
      ) : null}

      {/* ── 未平仓 ───────────────────────────────────────────────
          两个盈亏并排，**必须各自有列头**：一个是「从建仓到最后一次盯市」（进净值），
          一个是「今天」（不进净值）。只给数字的话它们看起来是同一种东西的两个值。 */}
      {summary.open.length > 0 ? (
        <div className="rounded border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs font-medium text-white/70">模拟持仓 {summary.open.length} 只</h3>
            {/*
              合计当日参考盈亏。**只加得出来的那几只**，缺行情的不当 0 计 ——
              否则「3 只里 2 只没行情」会显示成一个看起来完整、实际只覆盖 1 只的合计。
              所以覆盖只数写在旁边。
            */}
            {(() => {
              const priced = summary.open
                .map((p) => dayPnlOf(p.shares, quoteOf.get(p.code)))
                .filter((v): v is number => v !== null)
              if (priced.length === 0) return <span className="text-[10px] text-white/25">当日参考盈亏 —</span>
              const total = priced.reduce((sum, v) => sum + v, 0)
              return (
                <span className="text-[10px] text-white/35">
                  当日参考盈亏合计{' '}
                  <span className={`font-mono ${tone(total)}`}>{signedMoney(total)} 元</span>
                  {priced.length < summary.open.length ? (
                    <span className="text-white/25">（{priced.length}/{summary.open.length} 只有行情）</span>
                  ) : null}
                </span>
              )
            })()}
          </div>

          <div className="mt-1.5 flex items-center gap-2 border-b border-white/[0.06] pb-1 text-[10px] text-white/30">
            <span className="w-20 shrink-0">名称</span>
            <span className="w-16 shrink-0 font-mono">代码</span>
            <span className="w-16 shrink-0 text-right">股数</span>
            <span className="w-12 shrink-0 text-right">建仓价</span>
            <span className="w-12 shrink-0 text-right">现价</span>
            <span className="w-20 shrink-0 text-right" title="股数 ×（现价 − 昨收），未计入上面的累计收益">
              当日参考
            </span>
            <span className="w-20 shrink-0 text-right" title="建仓至最后一次收盘盯市，已计入上面的累计收益">
              浮动盈亏
            </span>
            <span className="w-14 shrink-0 text-right">持有</span>
          </div>

          <ul className="mt-1 flex flex-col gap-1">
            {summary.open.map((position) => {
              const quote = quoteOf.get(position.code)
              const dayPnl = dayPnlOf(position.shares, quote)
              // 行情不是这一轮真的拉到的（重启后回落、或取数失败）⇒ 「当日」两个字就不准了。
              // 灰显 + 把价格时刻写进 title，与自选列表那一列同一条口径（不许用 toLocaleTimeString）
              const stale = quote?.stale === true
              const priceTitle = quote
                ? stale
                  ? `${shanghaiMdHhmm(quote.at)} 的价，非实时`
                  : `${shanghaiHhmm(quote.at)} 的价`
                : '还没有这只的行情'
              return (
                <li key={position.code} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 shrink-0 truncate text-white/70" title={position.name}>
                    {position.name}
                  </span>
                  <span className="w-16 shrink-0 font-mono text-white/35">{position.code}</span>
                  <span className="w-16 shrink-0 text-right font-mono text-white/45">{position.shares} 股</span>
                  <span
                    className="w-12 shrink-0 text-right font-mono text-white/45"
                    title="模拟建仓价（不复权，含滑点）"
                  >
                    {position.entryPrice.toFixed(2)}
                  </span>
                  {/* 没有行情就是「—」，不拿最后一次收盘价冒充现价 */}
                  <span
                    className={`w-12 shrink-0 text-right font-mono ${stale ? 'text-white/30' : 'text-white/60'}`}
                    title={priceTitle}
                  >
                    {quote ? quote.last.toFixed(2) : '—'}
                  </span>
                  <span
                    className={`w-20 shrink-0 text-right font-mono ${
                      dayPnl === null ? 'text-white/30' : stale ? 'text-white/35' : tone(dayPnl)
                    }`}
                    title={
                      dayPnl === null
                        ? '拿不到这只的现价或昨收，算不出来 —— 不是「今天没赚没亏」'
                        : `${priceTitle}；${position.shares} 股 ×（现价 − 昨收）`
                    }
                  >
                    {dayPnl === null ? '—' : signedMoney(dayPnl)}
                  </span>
                  <span className={`w-20 shrink-0 text-right font-mono ${tone(position.unrealized)}`}>
                    {signedMoney(position.unrealized)}
                  </span>
                  <span className="w-14 shrink-0 text-right text-white/25">{position.barsHeld} 日</span>
                </li>
              )
            })}
          </ul>

          <p className="mt-1.5 text-[10px] leading-snug text-white/30">
            「浮动盈亏」已经计入上面的「累计收益」：净值每个交易日按收盘价盯市。
            「当日参考」是<span className="text-white/45">另一件事</span> —— 它按此刻的行情算
            （股数 ×（现价 − 昨收），未扣卖出费用），
            <span className="text-white/45">还没有进净值</span>，两个数别相加。
          </p>
        </div>
      ) : null}

      {/* ── 最近的模拟交易 ─────────────────────────────────────── */}
      {trades.length > 0 ? (
        <div className="rounded border border-white/10 bg-white/[0.03] p-3">
          <h3 className="text-xs font-medium text-white/70">最近 {trades.length} 笔模拟卖出</h3>
          <ul className="mt-1.5 flex max-h-56 flex-col gap-1 overflow-y-auto">
            {trades.map((trade) => (
              <li key={trade.id} className="flex items-center gap-2 text-[11px]">
                <span className="w-20 shrink-0 truncate text-white/60" title={trade.code}>
                  {trade.name}
                </span>
                <span className="w-24 shrink-0 font-mono text-white/30">
                  {trade.entryDate.slice(5)}→{trade.exitDate.slice(5)}
                </span>
                <span className={`w-16 shrink-0 text-right font-mono ${tone(trade.pnl)}`}>
                  {trade.pnlPct > 0 ? '+' : ''}
                  {(trade.pnlPct * 100).toFixed(1)}%
                </span>
                <span className="w-20 shrink-0 text-right font-mono text-white/45">
                  {trade.pnl > 0 ? '+' : ''}
                  {money(trade.pnl)}
                </span>
                <span className="truncate text-white/25" title={trade.exitRule}>
                  {REGIME_LABEL[trade.regimeAtEntry] ?? trade.regimeAtEntry} ·{' '}
                  {trade.exitRule === 'WATCHLIST_REMOVED' ? '移出自选而了结' : trade.exitRule}
                  {trade.partial ? ' · 减仓' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── 推进流水 ────────────────────────────────────────────────
          委托一旦成交 `clearOrder` 就把它删了 ⇒ 只靠上面那张待成交表，
          事后拼不出「那天挂了哪两单」。这张流水是它唯一的出处（013）。 */}
      {journal.length > 0 ? (
        <div className="rounded border border-white/10 bg-white/[0.03] p-3">
          <h3 className="text-xs font-medium text-white/70">推进流水</h3>
          <ul className="mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto">
            {journal.map((row) => {
              const kind = KIND_LABEL[row.kind]
              return (
                <li key={`${row.date}-${row.seq}`} className="flex items-start gap-2 text-[11px]">
                  <span className="w-11 shrink-0 font-mono text-white/30">{row.date.slice(5)}</span>
                  <span className="w-10 shrink-0 font-mono text-white/25">{shanghaiHhmm(row.at)}</span>
                  <span className={`w-24 shrink-0 ${kind.tone}`}>{kind.text}</span>
                  <span className="w-20 shrink-0 truncate text-white/60" title={row.code ?? ''}>
                    {row.name ?? row.code ?? ''}
                  </span>
                  <span className="w-24 shrink-0 text-right font-mono text-white/45">
                    {row.shares === null ? '' : `${row.shares} 股`}
                    {row.price === null ? '' : ` @${row.price.toFixed(2)}`}
                  </span>
                  <span className="min-w-0 flex-1 text-white/25">
                    {[row.rule, row.reason].filter((part) => part !== null && part !== '').join(' · ')}
                  </span>
                </li>
              )
            })}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-white/30">
            这张流水只记录发生了什么，不参与任何绩效计算 —— 上面那些数字一律来自模拟账本。
          </p>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        <button className="gp-btn" onClick={load}>
          刷新
        </button>
        <button className="gp-btn" onClick={reset}>
          清空并重新开始…
        </button>
        <span className="text-[10px] text-white/25">
          引擎 <span className="font-mono">{summary.engineVersion}</span>
        </span>
      </div>
    </div>
  )
}
