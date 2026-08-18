/**
 * 一只标的走哪条提醒轨（docs/05 §3.2）。
 *
 * 判据只有两个输入，所以单独拎成纯函数：`controller` 那边是一行 lambda，
 * 而这一行管着「跌破止损会不会弹气泡」，值得有用例钉住。
 *
 * ## 为什么「有持仓」必须翻回 PRIMARY（2026-08-18 用户拍板）
 *
 * `OBSERVE` 轨的两条性质是为**观察名单**设计的：日配额只有 `observeDailyLimit`
 * （默认 2 条），且**抢不到气泡**（一次只弹一个，挑的时候先按轨道再按得分）。
 * 用在没有持仓的行业 ETF 上是对的 —— 它们的信号是「看看行业怎么走」。
 *
 * 但用户现在可以在行业 ETF 上真的建仓。持仓一旦存在，止损/回撤减仓那套
 * **持仓强制类** L3 提醒就会对它生效，而留在 OBSERVE 轨的后果是：
 * 跌破止损那一条可能被 2 条日配额吃掉、也可能被任何一条 PRIMARY 抢走气泡 ——
 * 一声不响。**少发的错误用户发现不了**，这是这个项目反复踩过的形状。
 *
 * 代价说清楚：M3 正在攒的提醒日志里，PRIMARY 那一侧从此可能混进 ETF 的行。
 * 但那些行对应的是**真持仓**，本来就属于「该不该被打断」这个问题的样本，
 * 要拆也拆得开（按 code）。
 */

import type { AlertTrack } from './dispatcher'

/**
 * @param group   `watchlist.group_name`。只有内置的「行业ETF」组有特殊待遇
 * @param hasPosition 当前**有没有持仓**。每轮现读，不缓存 ——
 *                    用户刚录完一笔成交，下一轮就该按个股待遇提醒
 * @param etfGroup 「行业ETF」分组名，由调用方传 —— 这一层与 `engine/announcements.ts`
 *                 同一条：不 import `@shared`，判据的来源留在编排层
 */
export function alertTrackOf(group: string, hasPosition: boolean, etfGroup: string): AlertTrack {
  return group === etfGroup && !hasPosition ? 'OBSERVE' : 'PRIMARY'
}
