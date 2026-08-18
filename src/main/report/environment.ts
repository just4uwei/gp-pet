/**
 * 今日环境陈述（[docs/11](../../../docs/11-盘外消息面简报功能需求.md) N1，2026-08-15）。
 * **纯模块**：不读时钟、不碰 IO、不 import Electron。与 `report/build.ts` 同一类。
 *
 * ## 它是 `dailyReport()` 那句「代价说清楚」的兑现
 *
 * 日报刻意不含内置的「行业ETF」组（`controller.ts` 的 `dailyReport()`），代价是
 * **日报里看不到行业动向**。那段注释同时给了正确的形状：
 *
 * > 真要在日报里给行业一段，那是**独立的一节**（与个股分开列），不是把它们混进来。
 *
 * 这个模块就是那一节。所以它产出的东西**不进** `stocks`、不进 `overview.watchCount`、
 * 不进 `byDirection` —— 那几个数答的是「我自己的票」，掺进 15 只观察标的就再也拆不开。
 *
 * ## 同一条纪律：只陈述，不评价
 *
 * `lines` 里的每一句都必须能从 `benchmark` / `industries` / `breadth` / `missing`
 * 这几个数里**逐字推出**。不许出现「今天环境不好」「普跌，注意风险」这种话：
 * 它读起来像结论，而它背后没有任何依据，用户却会当成软件的判断。
 * 判据与 `build.ts` 的 `highlightsOf()` 完全相同，理由也相同。
 *
 * ## 拿不到就是拿不到
 *
 * 行情缺席时 `quote` 是 **null**，不是一堆 0（约束 4），而且缺了哪几只要**显式列进
 * `missing`** —— 静默少几行的症状是「今天行业普涨」，而实际上只是跌的那几只没取到数。
 *
 * ## 不含隔夜外盘（说明，不是遗漏）
 *
 * [docs/11](../../../docs/11-盘外消息面简报功能需求.md) N1-a 写的是「现有 provider 能取到的隔夜外盘指数」。
 * 实际核对下来**取不到**：`src/core/code.ts` 的 `Market` 只有 `SH` / `SZ` / `BJ`，
 * 美股与港股指数在这个代码空间里**无法表示**。要做得先给 `src/core` 加一个市场，
 * 那是引擎层改动、需要另外论证（约束 5 的邻域），**不属于「零新增依赖」这一档**。
 * 所以本模块只做基准指数 + 行业 ETF，两样都已经在库里、已经在被取数。
 */

import type { DailyReportStock, ReportEnvironment, EnvironmentItem } from '@shared/ipc-types'
import type { SecCode } from '@core/types'
import type { BuildReportInput } from './build'
import { quoteOf } from './build'

/** 一个待陈述的标的。`name` 优先用库里的（数据源给的），拿不到才用清单里的短名 */
export interface EnvironmentTarget {
  code: SecCode
  name: string
  /** 基准指数没有行业 */
  industry?: string
}

export interface BuildEnvironmentInput {
  /** 基准指数（沪深300）。不在观察范围内时给 undefined */
  benchmark?: EnvironmentTarget | undefined
  /** 行业 ETF。顺序不重要，本模块按涨跌幅重排 */
  industries: readonly EnvironmentTarget[]
  /** 与 `buildDailyReport` **同一份** bars / snapshots，口径必须一致 */
  bars: BuildReportInput['bars']
  snapshots: BuildReportInput['snapshots']
  /** 那一天的北京 15:00，收盘线的「数据时刻」用它。与 `buildDailyReport` 同一个值 */
  closeMs: number
}

function itemOf(
  target: EnvironmentTarget,
  bars: BuildEnvironmentInput['bars'],
  snapshots: BuildEnvironmentInput['snapshots'],
  closeMs: number
): EnvironmentItem {
  // 复用 build.ts 的 quoteOf：收盘线优先、快照兜底、**两者不混用**。
  // 各写一份的症状是日报上半屏与下半屏的涨跌幅对不上，而用户没法判断哪个对。
  const quote = quoteOf(target.code, bars, snapshots, closeMs)
  return {
    code: target.code,
    name: target.name,
    ...(target.industry === undefined ? {} : { industry: target.industry }),
    quote,
  }
}

/** 涨跌幅降序；拿不到行情的一律排最后。并列时按代码定序 —— 顺序抖动的列表读起来像在闪 */
function byChangeDesc(a: EnvironmentItem, b: EnvironmentItem): number {
  const av = a.quote?.changePct
  const bv = b.quote?.changePct
  if (av === undefined && bv === undefined) return a.code < b.code ? -1 : 1
  if (av === undefined) return 1
  if (bv === undefined) return -1
  if (av !== bv) return bv - av
  return a.code < b.code ? -1 : 1
}

function fmtPct(value: number): string {
  // 保留两位并显式带符号：`+0.00%` 与 `−0.00%` 在这里是同一件事，统一成 0.00%
  if (Math.abs(value) < 0.005) return '0.00%'
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}%`
}

export function buildEnvironment(input: BuildEnvironmentInput): ReportEnvironment {
  const { benchmark, industries, bars, snapshots, closeMs } = input

  const benchmarkItem = benchmark ? itemOf(benchmark, bars, snapshots, closeMs) : null
  const industryItems = industries.map((t) => itemOf(t, bars, snapshots, closeMs)).sort(byChangeDesc)

  const priced = industryItems.filter((i) => i.quote !== null)
  const breadth = {
    withQuote: priced.length,
    up: priced.filter((i) => (i.quote?.changePct ?? 0) > 0).length,
    down: priced.filter((i) => (i.quote?.changePct ?? 0) < 0).length,
    flat: priced.filter((i) => (i.quote?.changePct ?? 0) === 0).length,
  }

  const missing: SecCode[] = [
    ...(benchmarkItem && benchmarkItem.quote === null ? [benchmarkItem.code] : []),
    ...industryItems.filter((i) => i.quote === null).map((i) => i.code),
  ]

  // 任何一项用了盘中快照，整段就要带一句「可能微调」——
  // 与 DailyReport.stage 是同一条纪律：数字来自哪儿必须让用户看得见
  const anySnapshot =
    benchmarkItem?.quote?.source === 'SNAPSHOT' || priced.some((i) => i.quote?.source === 'SNAPSHOT')

  return {
    benchmark: benchmarkItem,
    industries: industryItems,
    breadth,
    missing,
    lines: linesOf({
      benchmark: benchmarkItem,
      priced,
      breadth,
      // 陈述句只数**行业**的缺失：基准自己那一行已经说过「暂缺」了，
      // 再把它算进「另有 N 只」等于同一件事报两遍
      missingIndustries: industryItems.filter((i) => i.quote === null).length,
      anySnapshot,
    }),
  }
}

/**
 * 几句陈述。**每一句都能从入参逐字推出** —— 这一条与 `highlightsOf()` 同源，
 * 违反它就等于让规则拼出来的句子冒充判断。
 */
export function linesOf(input: {
  benchmark: EnvironmentItem | null
  /** 已经排好序、且**有行情**的行业项 */
  priced: readonly EnvironmentItem[]
  breadth: ReportEnvironment['breadth']
  /** 今日没有行情的**行业**只数（不含基准） */
  missingIndustries: number
  anySnapshot: boolean
}): string[] {
  const { benchmark, priced, breadth, missingIndustries, anySnapshot } = input
  const lines: string[] = []

  if (benchmark) {
    lines.push(
      benchmark.quote
        ? `${benchmark.name} ${fmtPct(benchmark.quote.changePct)}（收 ${benchmark.quote.close.toFixed(2)}）。`
        : `${benchmark.name} 今日行情暂缺。`
    )
  }

  if (breadth.withQuote > 0) {
    const parts = [`${breadth.up} 只上涨`, `${breadth.down} 只下跌`]
    if (breadth.flat > 0) parts.push(`${breadth.flat} 只平盘`)
    lines.push(`行业 ETF ${breadth.withQuote} 只有行情：${parts.join('、')}。`)
  } else if (missingIndustries > 0) {
    // 一只都没取到。**这句必须有** —— 没有它，这一节会是一片「—」而不说为什么
    lines.push(`行业 ETF ${missingIndustries} 只今日均无行情数据。`)
  }

  // 两端只在「至少两只有行情」时说 —— 一只的时候「最高也是最低」是句废话
  const top = priced[0]
  const bottom = priced[priced.length - 1]
  if (priced.length >= 2 && top?.quote && bottom?.quote) {
    lines.push(
      `涨幅最高 ${top.name} ${fmtPct(top.quote.changePct)}，` +
        `最低 ${bottom.name} ${fmtPct(bottom.quote.changePct)}。`
    )
  }

  // 缺失显式说出来。少几行而不吭声，会让「普涨」这类读数凭空成立。
  // 只在「有一部分取到了」时说 —— 一只都没取到时上面那句已经讲完了
  if (breadth.withQuote > 0 && missingIndustries > 0) {
    lines.push(`另有 ${missingIndustries} 只今日无行情数据，未计入上面的统计。`)
  }

  // 与 build.ts 的 highlightsOf 同一句、同一条理由（2026-08-18 改口径）：
  // 新日期口径下这一句在收盘之后也会出现，「收盘后可能微调」那时是自相矛盾的
  if (anySnapshot) lines.push('部分数字取自盘中最后一次行情，次日盘前定稿后可能微调。')

  return lines.length > 0 ? lines : ['今日环境数据暂缺。']
}

/** 便于用例与调用方复用的展示格式化，不参与判据 */
export { fmtPct as formatChangePct }

export type { DailyReportStock }
