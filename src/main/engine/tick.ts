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
  /** 补跑闸门存的是**日期串**不是时刻，所以要这两个（见 META_KEYS.lastSettledDate） */
  get(key: string): string | null
  set(key: string, value: string): void
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
  /**
   * `market.db` 的周期备份（M4）。返回 null 表示这次没到点。
   *
   * 与裁剪一起挂在**休市维护**里，不挂在竞价那条路上：`VACUUM INTO` 要读全库，
   * 放在盘中会和取数抢同一个 SQLite 连接（storage/backup.ts 头注释）。
   */
  backup?: (at: number) => unknown
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  onQuotes?: (ctx: TickContext, snapshots: SnapshotOutcome) => void
  /** M2 引擎。不传则整轮退化为 M1 行为（只取数、不算信号） */
  engine?: Pick<SignalEngine, 'run'>
  /** 引擎跑完一轮后的去处：controller 拿它跑提醒分发并刷新面板 */
  onSignals?: (ctx: TickContext, outcomes: SignalOutcome[]) => void
  /**
   * 补跑某个交易日的收盘确认轮（`engine/settle.ts`）。不传则整块跳过。
   *
   * **不返回 outcomes 是刻意的**：那天已经过去了，补出来的结论一条都不该进提醒层
   * （settle.ts 的边界 1）。这里只拿一个计数打日志。
   */
  settle?: (date: string) => { evaluated: number; persisted: number; invalidated: number }
  /**
   * 影子运行推进（M4，docs/07 §2.3）。排在提醒**之后**且**单独 try**：
   * 模拟账本记错了不该连带把提醒吃掉，两者的重要性差一个量级。
   * 它自己判幂等（一个交易日只推进一次），所以这里每轮都调无妨。
   */
  shadow?: { advance(input: { date: string; at: number; outcomes: readonly SignalOutcome[] }): unknown }
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
    backup,
    log = { info: () => {}, warn: () => {} },
    onQuotes,
    engine,
    onSignals,
    settle,
    shadow,
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

    // 备份排在裁剪**之后**：先删掉过期数据再快照，备份文件小一圈
    backup?.(at)
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

      /*
        补跑上一个交易日的收盘确认轮（engine/settle.ts）。

        **位置是必须的**：排在 backfill 之后 —— 它要用的正是刚刚补进来的那根收盘线。
        排在 refreshSnapshots 之前则是因为补跑与快照无关，早跑早写完，
        不必让它跟当轮取数抢同一个 SQLite 连接。

        触发判据直接用 `through`：`expectedLastBar()` 给的是「此刻应该已存在的最后一根」，
        15:00 前它就是上一个交易日。`through === ctx.date` 时不补跑 ——
        那是当天，正常的收盘确认轮（engine.run 的 SETTLE 那一轮）自己会做。

        实践上这一段几乎总是在**次日盘前**那一跳执行：数据源发布个股日线在 15:05–15:30，
        晚于当天的 SETTLE 窗口，所以当天那一轮拿不到收盘线（这正是要补跑的原因）。
      */
      if (settle && through && through < ctx.date && meta.get(META_KEYS.lastSettledDate) !== through) {
        try {
          const result = settle(through)
          // 先记账再说：即使一只都没跑成（全部停牌 / 数据仍未到），也不该每轮重试 ——
          // 那会把每一跳都变成一次全量指标重算
          meta.set(META_KEYS.lastSettledDate, through)
          log.info(
            `[settle] ${through} 收盘确认补跑：评估 ${result.evaluated} 只，新落 ${result.persisted} 行，判失效 ${result.invalidated} 条`
          )
        } catch (error) {
          // 补跑挂了不该拖垮当轮取数（与引擎失败同一条：行情能看，只是少了这一步）
          log.warn(`[settle] ${through} 补跑失败：${String(error)}`)
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

        // 影子运行（M4）。单独 try：账本出错不该把上面的提醒一起带走
        if (shadow) {
          try {
            shadow.advance({ date: ctx.date, at: ctx.at, outcomes: lastSignals })
          } catch (error) {
            log.warn(`[shadow] ${ctx.date} 推进失败：${String(error)}`)
          }
        }
      }
    },

    state: () => ({ lastTickAt, lastCtx, lastSnapshots, lastSignals }),
  }
}
