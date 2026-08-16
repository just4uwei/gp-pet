/**
 * 盘前简报的事实层（[docs/11](../../../docs/11-盘外消息面简报功能需求.md) N3，2026-08-16）。
 * **纯模块**：不读时钟、不碰 IO、不 import Electron。与 `report/build.ts` 同一类 ——
 * 可测的判据下沉，不埋进 JSX（项目**没有渲染层测试**，埋进组件就只能靠肉眼验收）。
 *
 * ## 一条纪律：只列不判
 *
 * 每条只给五样：**哪只票 · 什么时候 · 什么类型 · 什么标题 · 原文链接**。
 * 不打分、不判利好利空、不给买卖方向。三条理由（docs/11 §2.2），一条比一条硬：
 *
 * 1. **只有标题，没有正文** —— 本功能不解析 PDF，拿标题判利好利空是在没有依据的
 *    情况下下结论，而它读起来会非常像有依据；
 * 2. **两个来源、可能相反的结论，用户没有办法判断该信哪个** —— 与 `report/build.ts`
 *    的「只复述不推导」、`watch-mark.ts` 的「不许读 verdict 改方向」同一条纪律；
 * 3. **一旦打分，那个分就是一个参数**，而它无法回测 ⇒ 立刻变成一个永久 `UNTESTABLE`
 *    的、影响用户决策的数。
 *
 * ⚠ **2026-08-16 的三轮实测给了这条纪律一个额外的、经验上的理由**（M2 §5.25）：
 * 「公告方向」这个维度在 261 只 × 8.6 年上**测不出任何东西** ——
 * 同日巧合、事件+滞后确认、股票层面频率，三种形状全是否定，
 * 而按标题关键词分的「利好」桶在窗口放宽后从 78.5% 掉到 32.0%。
 * **所以这里连"利好/利空"的标签都不打** —— 我们自己的数据说它没有信息。
 *
 * ## 「建议先看」是类型白名单，不是评分
 *
 * `spotlight` 只按数据源给的**分类名**匹配一张白名单。它是**结构选择**（人工维护的一张表），
 * 不是标定参数，因此不进 `params.ts`、不进 `params-view.ts` 的 `STATUS` 表（docs/11 §6）。
 * 两条要求：
 * - **不许只显示白名单** —— 藏起来的那些正是用户可能真正关心的；
 * - 白名单命中**不改变排序之外的任何东西**，尤其不产生方向。
 */

import type { AnnouncementView, BriefItem, BriefStock, DailyBrief } from '@shared/ipc-types'
import type { SecCode, TradeDate } from '@core/types'

export interface BuildBriefInput {
  /** 简报归属的交易日 */
  date: TradeDate
  /** 生成时刻（墙上时间）。本模块不读时钟 */
  at: number
  /** 自选股（**调用方已摘掉内置行业 ETF**，见 controller） */
  items: readonly { code: SecCode; name: string; industry?: string | undefined; hasPosition: boolean }[]
  /** 已落库的公告，任意顺序 */
  announcements: readonly AnnouncementView[]
  /** 取数是否失败。**失败与「今天没有公告」是两件事**（docs/11 N2-e） */
  fetchError?: string | undefined
}

/**
 * 「建议先看」的类型白名单。**按数据源给的 `category` 精确匹配**（2026-08-16 改）。
 *
 * ## 判据只有一条
 *
 * **「用户漏看了会不会想知道」** —— 不是「预示涨跌」。
 * 2026-08-16 的三轮实测已经证明公告方向在本项目数据上测不出任何东西
 * （M2 §5.25：同日巧合 / 事件+滞后确认 / 股票层面频率，三种形状全是否定）。
 * 所以这张表**不是收益判据**，往里加减不需要走标定流程 —— 但要在这里写清为什么。
 *
 * ## 为什么从「关键词子串」改成「完整分类名」
 *
 * 实测 4500 条全市场公告：**175 个分类**，粒度相当细。原先的 18 个关键词子串匹配
 * 同时有误报和漏报，而且误报量很大：
 *
 * | 原写法命中 | 实际是什么 | |
 * |---|---|---|
 * | `'担保'` → 「提供/对外担保公告」**118 条（2.6%）** | 给子公司担保，常规经营 | 最大的误报源 |
 * | `'问询'` → 「创业板IPO问询与回复」 | 发行流程，不是监管质疑 | 误报 |
 * | `'回购'` → 「回购进展情况」 | 程序性进展 | 误报 |
 * | `'停牌'` → 「…转股价格暨转股停牌」 | 可转债程序性事项 | 误报 |
 * | `'重大资产重组'` | 真实分类叫「重组进展公告」 | **漏报** |
 *
 * 精确匹配把这些一次性解决，代价是**数据源新增分类时会默认不高亮** ——
 * 这是**安全的失败方向**：那一条照样列出来，只是不带标记。
 * 反过来（默认高亮）会让一个没人看过的新分类冒充"系统认为重要"。
 *
 * ## 刻意不收的两类
 *
 * - **「股票交易异常波动」**（1.04%）：它是**价格已经动过的结果**，不是原因。
 *   收进来等于用结果解释结果，而用户看盘面就知道了。
 * - **各类担保 / 募集资金 / 定期报告 / 股东大会 / 法律意见书**：占语料的大头，
 *   全是程序性的。它们照常列出，只是不标「建议先看」。
 */
export const SPOTLIGHT_CATEGORIES: ReadonlySet<string> = new Set([
  // ── 股东与股本：直接改变持股结构，持有者漏看代价大 ──
  '股份质押、冻结',
  '股东/实际控制人股份减持',
  '股东/实际控制人股份增持',
  '权益变动报告书',
  '限售股份上市流通',
  '高管人员持股变动',

  // ── 业绩与分配 ──
  '业绩快报',
  '业绩预告',
  '业绩预告修正',
  '分配预案',
  '分配方案实施',
  '分配方案调整',

  // ── 风险与监管：这一组是「漏看代价」最高的 ──
  '诉讼仲裁',
  '处罚',
  '警示函公告',
  '上交所股票监管工作函',
  '深交所股票监管工作函',
  '上交所股票公开谴责',
  '深交所股票公开谴责',
  '风险提示性公告',
  '其它风险提示公告',
  '终止上市风险提示',
  // 撤销风险警示是**好消息**，但同样是用户想知道的 —— 再次说明这张表不是方向判据
  '申请撤销风险警示及特别处理',
  // 对交易所问询函的回复 = 监管质疑。**注意与「XX板IPO/再融资问询与回复」区分**，
  // 后者是发行流程的一部分，精确匹配才分得开
  '回复问询函公告',
  '会计师事务所问询函回复公告',

  // ── 重大交易与停复牌 ──
  '收购出售资产/股权',
  '重组进展公告',
  '重大合同',
  '股权转让',
  // 停牌里混着可转债转股停牌（程序性），分类名一样、分不开。
  // 保留并接受这点误报 —— 实测只占 0.13%，而漏掉一次真停牌的代价大得多
  '停牌公告',
])

export function isSpotlight(category: string | null): boolean {
  if (category === null) return false
  return SPOTLIGHT_CATEGORIES.has(category)
}

/** 新到旧；同一时刻按 id 定序 —— 顺序抖动的列表读起来像在闪 */
function byTimeDesc(a: BriefItem, b: BriefItem): number {
  if (a.publishedAt !== b.publishedAt) return b.publishedAt - a.publishedAt
  return a.id < b.id ? -1 : 1
}

export function buildDailyBrief(input: BuildBriefInput): DailyBrief {
  const { date, at, items, announcements, fetchError } = input

  const byCode = new Map<SecCode, BriefItem[]>()
  for (const row of announcements) {
    // 没有原文链接的条目在解析层就该被丢掉（docs/11 N2-d）。这里再挡一次：
    // 「每条都能点回原文」是本功能唯一的防幻觉结构保证，比提示词硬
    if (row.url === '') continue
    const bucket = byCode.get(row.code)
    const item: BriefItem = {
      id: row.id,
      title: row.title,
      category: row.category,
      publishedAt: row.publishedAt,
      noticeDate: row.noticeDate,
      url: row.url,
      spotlight: isSpotlight(row.category),
    }
    if (bucket) bucket.push(item)
    else byCode.set(row.code, [item])
  }

  const stocks: BriefStock[] = []
  for (const item of items) {
    const rows = byCode.get(item.code)
    if (rows === undefined || rows.length === 0) continue
    rows.sort(byTimeDesc)
    stocks.push({
      code: item.code,
      name: item.name,
      ...(item.industry === undefined ? {} : { industry: item.industry }),
      hasPosition: item.hasPosition,
      items: rows,
    })
  }

  /*
    持仓票排在前面 —— 它对用户的实际影响更大（与「明日关注」的排序理由同类）。
    其余按「建议先看」的条数、再按公告条数、再按代码定序。
    **排序是这一层唯一被允许的"判断"**，而且它不改变任何一条的内容。
  */
  stocks.sort((a, b) => {
    if (a.hasPosition !== b.hasPosition) return a.hasPosition ? -1 : 1
    const sa = a.items.filter((i) => i.spotlight).length
    const sb = b.items.filter((i) => i.spotlight).length
    if (sa !== sb) return sb - sa
    if (a.items.length !== b.items.length) return b.items.length - a.items.length
    return a.code < b.code ? -1 : 1
  })

  const total = stocks.reduce((n, s) => n + s.items.length, 0)
  const spotlight = stocks.reduce((n, s) => n + s.items.filter((i) => i.spotlight).length, 0)

  return {
    date,
    at,
    watchCount: items.length,
    stocks,
    counts: { stocks: stocks.length, total, spotlight },
    ...(fetchError === undefined ? {} : { fetchError }),
    lines: linesOf({ watchCount: items.length, stocks: stocks.length, total, spotlight, fetchError }),
  }
}

/**
 * 几句**陈述**。与 `report/build.ts` 的 `highlightsOf()` 同一条纪律：
 * 每一句都能从计数里逐字推出。
 *
 * **两句绝对不许出现**（docs/11 §8）：
 * - 「今日无异常」「今日平安」—— 本功能只覆盖公告这一类，说成"无异常"
 *   是替一个没查过的范围担保；
 * - 任何对某条公告的好坏评价。
 */
export function linesOf(input: {
  watchCount: number
  stocks: number
  total: number
  spotlight: number
  fetchError?: string | undefined
}): string[] {
  const { watchCount, stocks, total, spotlight, fetchError } = input

  // 失败优先说，而且**不许顺带说「今天没有公告」** —— 那是两件事（docs/11 N2-e）
  if (fetchError !== undefined) return [`今天没能取到公告：${fetchError}`]

  if (watchCount === 0) return ['还没有自选股。']
  if (total === 0) return [`${watchCount} 只自选，今日无新公告。`]

  const lines = [`${watchCount} 只自选中 ${stocks} 只有新公告，共 ${total} 条。`]
  if (spotlight > 0) lines.push(`其中 ${spotlight} 条属于建议先看的类型。`)
  return lines
}
