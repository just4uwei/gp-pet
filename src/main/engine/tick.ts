/**
 * 一轮 tick 做什么（docs/02 §4、docs/03 §2.4/§3）。
 *
 * 从 data-layer 里抽出来单独成文件，是因为这段是 M1 真正的行为，而 data-layer 只是接线：
 * 「休市一个请求都不发」「日线补齐了就整轮跳过」「探测轮拿真成交去纠正日历」这些判断
 * 必须能用假 provider 跑出来，不能只靠真机启动一次来验证。
 *
 * 时段 → 行为：
 *   休市 / 午休      → 不碰行情接口，只做每周一次的日历与基础信息维护
 *   PRE_OPEN 及之后  → 先补日线缺口（无缺口则零请求），再批量拉快照
 *   15:00 之后       → 目标日线变成当日，收盘线由这一轮补进来（M2 确认轮的输入）
 *
 * 这里**不算指标、不产信号、不发提醒** —— 那是 M2/M3。
 */

import type { SecCode } from '@core/types'
import type { TickContext, TradingCalendar } from '../scheduler'
import { shanghaiTime } from '../scheduler'
import { META_KEYS } from '../storage/repositories/meta'
import { expectedLastBar, type MarketDataService, type SnapshotOutcome } from './market-data'
import type { WatchlistService } from './watchlist'

/** 日历与基础信息的刷新间隔（docs/03 §1：每周一次足够，节假日安排不会天天变） */
export const MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60_000

/** MetaRepo 结构上就满足它 */
export interface TickMetaStore {
  getNumber(key: string): number | null
  setNumber(key: string, value: number): void
}

export interface TickPipelineDeps {
  market: Pick<MarketDataService, 'backfill' | 'refreshSnapshots' | 'looksLikeTradingNow'>
  watchlist: Pick<WatchlistService, 'codes' | 'refreshProfiles'>
  calendar: Pick<TradingCalendar, 'resolve' | 'refresh' | 'markObserved'>
  meta: TickMetaStore
  /** 保留策略裁剪。返回 null 表示这次没到点 */
  prune?: (at: number) => unknown
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  onQuotes?: (ctx: TickContext, snapshots: SnapshotOutcome) => void
  maintenanceIntervalMs?: number
}

export interface TickState {
  lastTickAt: number
  lastCtx: TickContext | null
  lastSnapshots: SnapshotOutcome | null
}

export interface TickPipeline {
  run(ctx: TickContext): Promise<void>
  /** 供 status() / quoteTicks() 读取最近一轮的结果 */
  state(): TickState
}

export function createTickPipeline(deps: TickPipelineDeps): TickPipeline {
  const {
    market,
    watchlist,
    calendar,
    meta,
    prune,
    log = { info: () => {}, warn: () => {} },
    onQuotes,
    maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
  } = deps

  let lastTickAt = 0
  let lastCtx: TickContext | null = null
  let lastSnapshots: SnapshotOutcome | null = null

  const due = (key: string, at: number): boolean => (meta.getNumber(key) ?? 0) + maintenanceIntervalMs < at

  /** 休市期间唯一允许发出的请求（docs/03 §2.4） */
  async function maintain(at: number): Promise<void> {
    const year = Number(shanghaiTime(at).date.slice(0, 4))

    if (due(META_KEYS.calendarRefreshedAt, at)) {
      // 当年 + 次年：跨年前后都要有覆盖，否则元旦那几天全靠内置表
      const results = await calendar.refresh([year, year + 1])
      // 有一年成功就记时间；全失败则不记，下一轮还会再试
      if (results.some((r) => r.ok)) meta.setNumber(META_KEYS.calendarRefreshedAt, at)
      for (const failed of results.filter((r) => !r.ok)) {
        log.warn(`[calendar] ${failed.year} 刷新失败：${failed.error ?? '未知原因'}`)
      }
    }

    if (due(META_KEYS.profileRefreshedAt, at)) {
      const updated = await watchlist.refreshProfiles()
      if (updated > 0) meta.setNumber(META_KEYS.profileRefreshedAt, at)
    }

    const pruned = prune?.(at)
    if (pruned) log.info(`[retention] 裁剪：${JSON.stringify(pruned)}`)
  }

  return {
    async run(ctx) {
      lastTickAt = ctx.at
      lastCtx = ctx

      const codes: SecCode[] = watchlist.codes()

      if (!ctx.needsQuotes) {
        await maintain(ctx.at)
        return
      }
      if (codes.length === 0) return

      // 日线：目标是「此刻应该已存在的最后一根」。已补齐时 backfill 一个请求都不发
      const through = expectedLastBar(calendar, ctx.date, ctx.minuteOfDay)
      if (through) {
        for (const outcome of await market.backfill(codes, through)) {
          if (outcome.status === 'FAILED') log.warn(`[daily] ${outcome.code} 回补失败：${outcome.error}`)
          if (outcome.status === 'REFETCHED') {
            log.info(`[daily] ${outcome.code} 复权口径变化（${outcome.drift?.date}），已整只重拉`)
          }
        }
      }

      const snapshots = await market.refreshSnapshots(codes)
      lastSnapshots = snapshots
      if (snapshots.stale) log.warn(`[quote] 行情离线：${snapshots.error ?? '未知原因'}`)

      // 探测轮：日历说今天休市，但有真成交 → 纠正日历，下一跳回到正常轮询（docs/03 §3）
      if (ctx.probe && market.looksLikeTradingNow(snapshots.snapshots)) {
        calendar.markObserved(ctx.date, true)
        log.info(`[calendar] ${ctx.date} 实测有成交，已纠正为交易日`)
      }

      onQuotes?.(ctx, snapshots)
    },

    state: () => ({ lastTickAt, lastCtx, lastSnapshots }),
  }
}
