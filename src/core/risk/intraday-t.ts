/**
 * 日内做T建议（2026-08-14，docs/05 §2.4）。
 *
 * ## 它是什么
 *
 * 「现价已经跑到今天振幅的高位 / 低位」这一个事实，外加「你手上有底仓」这个前提。
 * A 股 T+0 只能用**老仓**做：先卖后买（高抛）或先买后卖（低吸，卖的是老仓那部分），
 * 没有底仓时同样的判据讲出来就是一条开仓建议 —— 那是买入信号的活，不该混进来。
 *
 * ## ⚠ 三件必须先知道的事
 *
 * 1. **它不进回测，也不进影子运行。** 日线回测原理上看不见日内路径（一根 K 线只有
 *    开高低收四个数，不知道先到高点还是先到低点），所以这里的每个阈值都**无法**用
 *    现有工具标定 —— 它们是 `params-view.ts` 里的 `UNTESTABLE` 一档，
 *    与 `alert.bubbleScore` 那几个同类。往 `CALIBRATED` 里加行要走清单 4.9a。
 * 2. **它不发提醒**（2026-08-14 的取舍）：日内位置天天都在动，按提醒发会淹掉真信号，
 *    而它的时效只有几十分钟 —— 冷却往往让它来不及，而来不及的提醒比不提醒更烦。
 *    出口只有悬浮条与面板，用户主动看的时候才看得到。
 * 3. **它不改 `direction`。** 引擎今天判买/判卖/没判，与「现在这一刻价格在日内哪个位置」
 *    是两件事。混进方向里会让 `signal` 表、回测、影子运行全部跟着变味，
 *    而那三处都不该认识日内位置。所以它挂在 `GatedSignal.tTrade` 上单独一格。
 *
 * ## 为什么不用 `quote_tick` 的分时留痕
 *
 * 判据只要「今日最高 / 最低 / 现价 / 昨收」四个数，而**快照本来就带这四个**
 * （`Snapshot.high/low/last/preClose`，每轮 30s 取数已经拿到了）。
 * 读 `quote_tick` 会让 `src/core` 依赖一张只在应用开着时才有数据的表 ——
 * 用户下午一点开机，上午的高低点就不在里面，而算出来的「日内位置」看不出是残缺的。
 */

import type { EngineParams } from '../params'
import { SESSION_BOUNDS } from '../session'
import type { Snapshot, TTradeAdvice, TradingSession } from '../types'

export interface TTradeInput {
  snapshot: Snapshot | undefined
  /** 有底仓才谈得上做T。这里只要股数 */
  shares: number
  session: TradingSession
  /** 含午休的自然分钟（与 `risk.lateBuyCutoffMinutes` 同一口径） */
  minuteOfDay: number
  /** 涨跌停价。取不到时按「没涨跌停」处理 —— 见下方 `limits` 那段 */
  limits: { limitUp: number; limitDown: number } | null
  params: EngineParams
}

/** 连续竞价之外不给：集合竞价买不进卖不出，收盘之后今天已经没有「日内」可言 */
function isContinuous(session: TradingSession): boolean {
  return session === 'CONTINUOUS_AM' || session === 'CONTINUOUS_PM'
}

/**
 * 给不给一条日内做T建议。
 *
 * 返回 null 的情形都是**结构性的**（没底仓、不在盘中、振幅不够、已经封死在涨跌停），
 * 不是「今天不建议做T」这种判断 —— 这一层不做判断，只报事实。
 */
export function tTradeAdvice(input: TTradeInput): TTradeAdvice | null {
  const { snapshot, shares, session, minuteOfDay, limits, params } = input
  if (shares <= 0) return null
  if (!snapshot || snapshot.suspended) return null
  if (!isContinuous(session)) return null

  const { high, low, last, preClose } = snapshot
  // 四个数缺一不可。**任何一个不正就整条不给** —— 用 0 兜底会算出一个假的日内位置，
  // 而那个位置看起来和真的一模一样（约束 4 的同一条纪律）
  if (!(high > 0 && low > 0 && last > 0 && preClose > 0)) return null
  if (high <= low) return null

  const amplitude = (high - low) / preClose
  const t = params.tTrade
  // 振幅不够时来回一趟赚的还不够手续费与印花税。**这不是「机会不好」，是算术上不成立**
  if (amplitude < t.minAmplitudePct) return null

  const position = (last - low) / (high - low)

  if (position >= t.highPct) {
    // 涨停不高抛：封住的板卖出去就接不回来了，那不是做T是清仓
    if (limits && last >= limits.limitUp - 0.001) return null
    return {
      side: 'HIGH_SELL',
      position,
      amplitude,
      reason: `现价处于今日振幅 ${(amplitude * 100).toFixed(1)}% 的高位（${(position * 100).toFixed(0)}%）`,
    }
  }

  if (position <= t.lowPct) {
    // 跌停不低吸：接跌停板与「做T」是两回事
    if (limits && last <= limits.limitDown + 0.001) return null
    /*
      尾盘不给低吸。**这一条最容易被漏掉**：T+1 下今天买的明天才能卖，
      过了这条线再买进来，卖不掉的那一半就变成了加仓 ——
      而用户以为自己在做T。沿用 `risk.lateBuyCutoffMinutes`（与 T1_LATE_BUY 同一个数、
      同一个理由），高抛不受这条限制：卖出随时都能成交。
    */
    if (minuteOfDay >= SESSION_BOUNDS.open + params.risk.lateBuyCutoffMinutes) return null
    return {
      side: 'LOW_BUY',
      position,
      amplitude,
      reason: `现价处于今日振幅 ${(amplitude * 100).toFixed(1)}% 的低位（${(position * 100).toFixed(0)}%）`,
    }
  }

  return null
}
