/**
 * `ai:explain` 的目标标识（2026-08-14）。**主进程与渲染层共用这一份。**
 *
 * ## 为什么日报要借道 `ai:explain`
 *
 * `AiService` 那一套（两层缓存防重复计费、在途去重、取消、流式接续、只有 done 落库）
 * 只该有一份实现。给日报另起一条通道等于把那套机器再抄一遍，
 * 而它每一条都是踩出来的 —— 抄一遍就意味着日报那条会重新踩一次。
 *
 * 代价是 `signalId` 这个参数现在有两种取值。**所以格式必须只有一处定义** ——
 * 渲染层拼一个 `report:` 前缀、主进程用另一个字符串判断，
 * 症状会是「点了没反应」或者更糟：走到解释单条信号那条路上，
 * 拿日报的日期去信号表里查，报一句「该信号已不在库中」。
 */

import type { TradeDate } from '@core/types'

const REPORT_PREFIX = 'report:'

/** 某一天的收盘日报评价。**唯一**的构造入口 */
export function reportTargetId(date: TradeDate): string {
  return `${REPORT_PREFIX}${date}`
}

/** 是不是一条日报评价请求。主进程按它分发提示词、上下文与落库口 */
export function isReportTarget(id: string): boolean {
  return id.startsWith(REPORT_PREFIX)
}

/** 取回交易日；不是日报请求时返回 null（**不返回空串** —— 那会一路传下去） */
export function reportDateOf(id: string): TradeDate | null {
  return isReportTarget(id) ? (id.slice(REPORT_PREFIX.length) as TradeDate) : null
}
