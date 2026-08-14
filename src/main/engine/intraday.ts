/**
 * 分时图的取舍规则：**远端完整曲线优先，拉不到才退回本机留痕**。
 *
 * 单独成文件而不是写在 data-layer 里，是因为装配层「只接线不做判断」
 * （data-layer.ts 头注释）—— 判断放这儿才写得成用例，而这里每一条都是
 * 「错了之后图上完全看不出来」的那一类：
 *
 * 1. **远端点先按请求窗口过滤。** 休市日数据源给的是**上一个交易日**的曲线，
 *    不滤的话那条线会被硬塞进「今天」的 x 轴里 —— 一张日期错位却毫无破绽的图。
 *    过滤掉之后自然降级成 LOCAL，而 LOCAL 的文案是诚实的。
 * 2. **`source` 必须跟着实际用了哪份数据走，不是「试了远端就算 REMOTE」。**
 *    渲染层靠它决定要不要说「覆盖全天」，说错了就是在替一条半截曲线担保。
 * 3. **两份数据不合并。** 远端可用时不去补本机那几个点：两边的采样口径不同
 *    （分钟收盘价 vs 30s 快照），混在一条线上会出现肉眼可见的锯齿，
 *    而用户没有任何办法看出那是两个来源。
 * 4. **`preClose` 远端优先、都没有就是 null**，绝不拿当日首个价顶替（约束 4）——
 *    顶替会让涨跌幅永远从 0% 开始，看起来像今天没波动过。
 */

import type { SecCode } from '@core/types'
import type { IntradaySeries } from '@shared/ipc-types'
import type { MinuteSeries } from '../providers'

/** 本机留痕那一份（quote_tick）。结构上就是 QuoteTickRepo 的返回，因此这里不 import storage */
export interface LocalIntraday {
  preClose: number | null
  points: readonly { ts: number; last: number }[]
}

export interface IntradayWindow {
  from: number
  to: number
}

/** 'YYYY-MM-DD'，按北京时间。分时的交易日永远以交易所时区为准，不看本机时区 */
export function shanghaiTradeDate(ts: number): string {
  const at = new Date(ts + 8 * 60 * 60_000)
  const y = at.getUTCFullYear()
  const m = String(at.getUTCMonth() + 1).padStart(2, '0')
  const d = String(at.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function mergeIntraday(
  code: SecCode,
  local: LocalIntraday,
  remote: MinuteSeries | null,
  window: IntradayWindow
): IntradaySeries {
  const fresh = (remote?.points ?? []).filter(
    (point) => point.ts >= window.from && point.ts <= window.to
  )

  const firstRemote = fresh[0]
  if (remote !== null && firstRemote !== undefined) {
    return {
      code,
      tradeDate: remote.tradeDate === '' ? shanghaiTradeDate(firstRemote.ts) : remote.tradeDate,
      source: 'REMOTE',
      // 远端没给昨收时才用本机留下的那个（同一天的快照里带着，值是一样的）
      preClose: remote.preClose ?? local.preClose,
      points: fresh.map((point) => ({ ts: point.ts, last: point.last, avg: point.avg })),
    }
  }

  const points = local.points.filter((point) => point.ts >= window.from && point.ts <= window.to)
  const firstLocal = points[0]
  return {
    code,
    tradeDate: firstLocal === undefined ? null : shanghaiTradeDate(firstLocal.ts),
    source: 'LOCAL',
    preClose: local.preClose,
    // 本机留痕没有均价（它只落了最新价），**不插值补一条出来** ——
    // 一条算出来的均价线与真的均价线在图上长得一模一样
    points: points.map((point) => ({ ts: point.ts, last: point.last, avg: null })),
  }
}

/** 分时缓存的有效期。与 tick 同频 —— 图上最多比面板上的价格旧一轮 */
export const MINUTE_CACHE_TTL_MS = 30_000

export interface MinuteCache {
  get(code: SecCode): Promise<MinuteSeries>
}

/**
 * 分时是**唯一**由用户交互直接触发的取数（打开抽屉「行情」页）。它不进 tick 轮询，
 * 所以那份「每日 < 1000 次」的预算（docs/03 §2.4）管不到它 —— 这道缓存就是它自己的闸门。
 *
 * 两条：
 *
 * 1. **缓存里存的是 Promise 而不是结果**，于是连点两次抽屉会共用同一趟请求。
 *    存结果的话，第二次点击在第一趟还没回来时会看到「没缓存」并再发一趟。
 * 2. **失败的那条立即剔除。** 缓存住一个错误等于把一次网络抖动钉死 30 秒，
 *    用户点「再看一次」也还是那个错，而他完全无从判断是网络还是软件。
 */
export function createMinuteCache(
  fetch: (code: SecCode) => Promise<MinuteSeries>,
  now: () => number,
  ttlMs = MINUTE_CACHE_TTL_MS
): MinuteCache {
  const entries = new Map<SecCode, { at: number; value: Promise<MinuteSeries> }>()
  return {
    get(code) {
      const at = now()
      // 顺手清掉过期项：条目数最多等于自选股数，但没人保证用户不会把自选清空再换一批
      for (const [key, entry] of entries) {
        if (at - entry.at >= ttlMs) entries.delete(key)
      }
      const hit = entries.get(code)
      if (hit) return hit.value

      const value = fetch(code)
      entries.set(code, { at, value })
      // 只在这一条还是当前那条时才剔除：期间已经有新请求覆盖过的话，删掉的会是别人的
      value.catch(() => {
        if (entries.get(code)?.value === value) entries.delete(code)
      })
      return value
    },
  }
}
