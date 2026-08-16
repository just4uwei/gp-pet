/**
 * 公告拉取编排（[docs/11](../../../docs/11-盘外消息面简报功能需求.md) N2）。
 *
 * ## 它不是提醒，也不进 tick
 *
 * 不进 `alert_log`、不点状态点、不弹气泡、不占提醒配额（docs/11 §2.3）。
 * 公告是高频的 —— 实测四只票一次查就返回 20 条；接进闸门会把止损提醒挤掉，
 * 而**被挤掉的那条止损用户发现不了**。
 *
 * 触发方式是**用户打开那一屏**，不是定时推送（docs/11 §3.4）：
 * 盘前 08:30 用户的机器可能根本没开，一个「必须开机才生效」的定时任务
 * 会静默地时有时无，而用户无法分辨是「今天没消息」还是「今天没跑」。
 *
 * 于是它与 `quote:intraday` 同属「**量由人决定**」那一类，
 * docs/03 §2.4 的轮询预算管不到它 —— 前提恰恰是它由人触发。
 * 闸门是本模块的**当日去重**：同一个交易日只真的拉一次。
 *
 * ## 三条边界（都在下面的代码里，不要绕过）
 *
 * 1. **内置行业 ETF 不拉**（N2-c）。它们没有个股公告，拉了也是空；
 *    而且摘要要在**请求之前**摘，摘晚了等于白发一次请求。
 *    注意只摘内置的那 15 只 —— 用户自己加进「自选」的 ETF 照拉，
 *    那是他自己的选择（代价是基金公告量大，由展示层分类）。
 * 2. **拿不到原文链接的条目不入库**（N2-d）。解析层已经丢掉了，这里再断言一次：
 *    「每条都能点回原文」是防幻觉的结构性保证，比提示词硬。
 * 3. **失败与「今天没有公告」是两回事**（N2-e）。前者要让用户看见并能重试，
 *    后者是常态。把失败显示成「今天没有公告」等于替一个没查过的范围担保。
 */

import type { SecCode } from '@core/types'
import type { Announcement } from '../providers/types'
import type { AnnouncementRow } from '../storage/repositories/announcement'

/** 本模块**不读时钟**（与 core 同一条纪律）：`now` 与 `sinceMs` 都由调用方给 */
export interface FetchAnnouncementsInput {
  /** 自选股全量。内置行业 ETF 由本模块摘掉，调用方不必先过滤 */
  items: readonly { code: SecCode; group?: string | undefined }[]
  /** 内置行业 ETF 的分组名（`INDUSTRY_ETF_GROUP`），由调用方传 —— 这一层不 import shared */
  etfGroup: string
  /** 发布时刻下界（含） */
  sinceMs: number
  now: number
  provider: string
  fetch: (codes: SecCode[], sinceMs: number) => Promise<Announcement[]>
}

export type FetchAnnouncementsResult =
  | { ok: true; rows: AnnouncementRow[]; skipped: number }
  /**
   * **失败是一等结果，不是异常**。调用方据它显示「今天没能取到公告」+ 重试，
   * 而不是显示成「今天没有公告」（N2-e）。
   */
  | { ok: false; error: string }

/** 一条公告能不能进库。**链接是硬条件** */
export function isStorable(row: Announcement): boolean {
  return row.id !== '' && row.title !== '' && row.url !== '' && Number.isFinite(row.publishedAt)
}

export async function fetchAnnouncements(
  input: FetchAnnouncementsInput
): Promise<FetchAnnouncementsResult> {
  const { items, etfGroup, sinceMs, now, provider, fetch } = input

  // 边界 1：**在请求之前**摘掉内置行业 ETF
  const codes = items.filter((item) => item.group !== etfGroup).map((item) => item.code)
  // 没有自选股不是失败，是「没什么可拉的」—— 不发请求，也不报错
  if (codes.length === 0) return { ok: true, rows: [], skipped: 0 }

  let raw: Announcement[]
  try {
    raw = await fetch(codes, sinceMs)
  } catch (error) {
    // 边界 3：失败带原文回去，让用户看得见
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const wanted = new Set(codes)
  const rows: AnnouncementRow[] = []
  let skipped = 0
  const seen = new Set<string>()

  for (const row of raw) {
    // 边界 2：链接是硬条件
    if (!isStorable(row)) {
      skipped++
      continue
    }
    // 数据源理论上按 stock_list 过滤，但**不能假设它守规矩** ——
    // 混进来的条目会让用户看到一堆与自己无关的公司，而界面上完全看不出来
    if (!wanted.has(row.code)) {
      skipped++
      continue
    }
    // 同一次返回里出现同一个 id（翻页边界重叠）时只留一条
    if (seen.has(row.id)) continue
    seen.add(row.id)

    rows.push({ ...row, fetchedAt: now, provider })
  }

  return { ok: true, rows, skipped }
}
