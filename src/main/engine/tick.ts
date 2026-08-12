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
 *   连续竞价 / 盘后   → 取数之后跑一轮引擎（M2）
 *   15:00 之后       → 目标日线变成当日，收盘线由这一轮补进来，引擎据此做收盘确认
 *
 * 顺序是刻意的：**先取数、再算信号**。反过来会让引擎用上一轮的数据产出「新」信号。
 * 引擎失败不影响取数结果的上报 —— 行情能看，只是这一轮没有信号（docs/02 §7：缺口要看得见）。
 * 提醒（气泡、通知、冷却、免打扰）仍属 M3，这里只把评估结果交给回调。
 */

import type { SecCode } from '@core/types'
import type { TickContext, TradingCalendar } from '../scheduler'
import { shanghaiTime } from '../scheduler'
import { META_KEYS } from '../storage/repositories/meta'
import { expectedLastBar, type MarketDataService, type SnapshotOutcome } from './market-data'
import type { SignalEngine, SignalOutcome } from './signals'
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
  /**
   * 需要日线、但不产出信号也不需要快照的代码 —— 眼下就是基准指数（docs/04 §1.6）。
   * 它不在自选股表里，但 RSI 的动态阈值要靠它算大盘情绪，所以日线必须一起补齐。
   */
  auxCodes?: () => SecCode[]
  /** 保留策略裁剪。返回 null 表示这次没到点 */
  prune?: (at: number) => unknown
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  onQuotes?: (ctx: TickContext, snapshots: SnapshotOutcome) => void
  /** M2 引擎。不传则整轮退化为 M1 行为（只取数、不算信号） */
  engine?: Pick<SignalEngine, 'run'>
  /** 引擎跑完一轮后的去处：M2 用它刷新面板，M3 接 AlertDispatcher */
  onSignals?: (ctx: TickContext, outcomes: SignalOutcome[]) => void
  maintenanceIntervalMs?: number
}

export interface TickState {
  lastTickAt: number
  lastCtx: TickContext | null
  lastSnapshots: SnapshotOutcome | null
  /** 最近一轮的评估结果（引擎未接入时为空数组） */
  lastSignals: SignalOutcome[]
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
    auxCodes,
    prune,
    log = { info: () => {}, warn: () => {} },
    onQuotes,
    engine,
    onSignals,
    maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
  } = deps

  let lastTickAt = 0
  let lastCtx: TickContext | null = null
  let lastSnapshots: SnapshotOutcome | null = null
  let lastSignals: SignalOutcome[] = []

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

      // 日线：目标是「此刻应该已存在的最后一根」。已补齐时 backfill 一个请求都不发。
      // 基准指数与自选股一起补 —— 少了它，情绪值会一直退化为中性 0.5，
      // 而那会静默地让 RSI 阈值停在 75/25，没人看得出来
      const through = expectedLastBar(calendar, ctx.date, ctx.minuteOfDay)
      if (through) {
        const daily = [...new Set([...codes, ...(auxCodes?.() ?? [])])]
        for (const outcome of await market.backfill(daily, through)) {
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

      // ── 引擎（M2）─────────────────────────────────────────────────
      // 竞价时段 producesSignals 为 false，引擎自己会空转返回 —— 这里不重复判断，
      // 免得两处判据日后走岔。探测轮同理（scheduler 已把它的 producesSignals 置为 false）
      if (engine) {
        try {
          lastSignals = engine.run({
            date: ctx.date,
            minuteOfDay: ctx.minuteOfDay,
            session: ctx.session,
            at: ctx.at,
            producesSignals: ctx.producesSignals,
          })
          onSignals?.(ctx, lastSignals)
        } catch (error) {
          // 引擎整体失败（单只失败已在引擎内部兜住）：行情照常上报，本轮没有信号
          log.warn(`[signal] ${ctx.date} ${ctx.session} 引擎异常：${String(error)}`)
        }
      }
    },

    state: () => ({ lastTickAt, lastCtx, lastSnapshots, lastSignals }),
  }
}
