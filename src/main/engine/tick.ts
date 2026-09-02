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
 *   15:10–16:00      → **只补日线**的收尾窗口（见 `CLOSE_CATCHUP`）+ **补齐了就当天跑一次
 *                      收盘确认轮**（2026-09-02 拍板，见 `settleDue`）。仍不拉快照、不跑盘中引擎
 *
 * 顺序是刻意的：**先取数、再算信号**。反过来会让引擎用上一轮的数据产出「新」信号。
 * 引擎失败不影响取数结果的上报 —— 行情能看，只是这一轮没有信号（docs/02 §7：缺口要看得见）。
 * 提醒（气泡、通知、冷却、免打扰）仍属 M3，这里只把评估结果交给回调。
 */

import type { SecCode } from '@core/types'
import type { TickContext, TradingCalendar } from '../scheduler'
import { shanghaiTime } from '../scheduler'
import { SESSION_BOUNDS } from '@core/session'
import { META_KEYS } from '../storage/repositories/meta'
import { expectedLastBar, type MarketDataService, type SnapshotOutcome } from './market-data'
import type { SignalEngine, SignalOutcome } from './signals'
import type { WatchlistService } from './watchlist'

/** 日历与基础信息的刷新间隔（docs/03 §1：每周一次足够，节假日安排不会天天变） */
export const MAINTENANCE_INTERVAL_MS = 7 * 24 * 60 * 60_000

/**
 * 「只差行业」的那批标的多久再试一次（2026-08-30）。
 *
 * **为什么不能跟着 `MAINTENANCE_INTERVAL_MS` 走**：整周那趟刷新只要拿到名字就算成功
 * 并盖下时间戳，而行业只有主源给 —— 主源那一刻在冷却里的话，这一整周就都没有行业。
 * 真机上正是这么丢的（`engine/watchlist.ts` 的 `profileOf` 头注释有逐条时刻）。
 *
 * **为什么是一天而不是更密**：一天一趟的上界是「还缺行业的股票数」个请求
 * （自选上限 200，实际 79），而且**拿到即收敛**（`COALESCE` 保住存量、板块筛掉 ETF/指数）
 * ⇒ 稳态是零请求。再密就要开始跟 docs/03 §2.4 那份轮询预算抢额度，
 * 而 eastmoney 的冷却只有 5 分钟，隔天再来足够了。
 */
export const INDUSTRY_RETRY_INTERVAL_MS = 24 * 60 * 60_000

/**
 * 收盘后的**日线收尾窗口**（2026-08-19）。
 *
 * ## 修的是什么
 *
 * 日报 `stage = FINAL` 要求**每只有行情的自选票**都拿到当日收盘线（`report/build.ts`），
 * 而 `needsQuotes('CLOSED') === false` 让应用 15:10 之后一个日线请求都不发，
 * 个股日线数据源却是 15:05–15:30 才发布 —— 于是当天的收盘线要到**次日盘前**才入库。
 * 后果不是「慢一点」而是「几乎永远看不到」：`reportSubjectDate` 在次日 09:30 之后就切到新一天，
 * 所以定稿版只在次日 08:05–09:30 那段窗口里存在。实测 2026-08-19 15:29，
 * 库里当天的日线只有 12/80 只，而 08-18 是 80/80。
 *
 * ## 为什么可以挂在休市时段上（docs/03 §2.4 的请求礼节）
 *
 * 三条一起才成立，少一条就会变成「休市期间一直在发请求」：
 *
 * 1. **只补日线**。不拉快照、不跑盘中引擎 —— `market.backfill` 在已补齐时
 *    **一个请求都不发**，这是它能挂在这里的前提。
 *    ⚠ **2026-09-02 起它会碰 settle**（用户拍板「补齐才提前」）：补齐那一刻**同一跳**
 *    多跑一次收盘确认轮。这一条不破上面那句 —— `settleDay()` **只读库**
 *    （走 `market.getContextThrough`，不拼临时线、不带快照、不发任何网络请求）
 *    ⇒ docs/03 §2.4 那份轮询预算一个请求都不多。判据与代价见 `settleDue`。
 * 2. **窗口收口在 16:00**。数据源 15:30 前发完，留半小时余量。
 * 3. **两道停手闸门**。全部补齐 → 记 `dailyCompleteDate` 从此不再试；
 *    补不齐（那 10 只腾讯结构性没有 `qfqday`、eastmoney 又间歇失败的 ETF）→
 *    按 `maxAttempts` 数轮停手。没有第二道的话，那几只会把窗口里每一轮都烧满。
 *
 * CLOSED 的 tick 间隔是 300s ⇒ 窗口内至多 10 轮，实际被 `maxAttempts` 压到 8 轮，
 * 且每轮只请求仍然缺的那几只。
 */
export const CLOSE_CATCHUP = {
  /** 从这一分钟开始（15:10，`SESSION_BOUNDS.settleEnd`，正常轮询恰好在这里停） */
  from: SESSION_BOUNDS.settleEnd,
  /** 到这一分钟为止（16:00） */
  to: 16 * 60,
  /** 同一个交易日最多试几轮 */
  maxAttempts: 8,
} as const

/**
 * 「喂了影子、但它自己跳过了」的人话。
 *
 * 这几行不是装饰：`ALREADY_DONE` 意味着**那个交易日的第 ⑥ 步（挂明天的委托）永远不会跑**，
 * 而影子不补跑历史 ⇒ 那一天的前向记录永久缺失。日志里只写「未喂影子」答不出「为什么」，
 * 而那恰恰是 2026-08-18 查「影子一直不动」时唯一想知道的东西。
 */
const SHADOW_SKIP_TEXT: Record<string, string> = {
  ALREADY_DONE: '那天已有净值行（第 ⑥ 步没跑，该交易日永久缺失）',
  ENGINE_VERSION_CHANGED: '引擎参数已变，影子停止累积',
  ERROR: '推进失败，见上一条 warn',
}

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
  watchlist: Pick<WatchlistService, 'codes' | 'refreshProfiles' | 'pendingIndustry'>
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
  settle?: (
    date: string,
    /**
     * 这次补跑要不要喂影子运行 —— 「成交机会还没过」（见下面 `shadow` 那段与
     * settle.ts 的边界 2）。判据在本模块，因为只有它知道 `ctx`。
     */
    feedShadow: boolean
  ) => {
    evaluated: number
    persisted: number
    invalidated: number
    shadowAdvanced: boolean
    /** 喂了但推进器自己跳过时的理由（`ShadowSkip['kind']` / `ERROR`），见 `SHADOW_SKIP_TEXT` */
    shadowSkip?: string
  }
  /**
   * ⚠ **影子运行不在这里推进了**（2026-08-17 改）。它挂在 `settle` 那条路上。
   *
   * 原先每轮 tick 都调 `shadow.advance`，看着无害（它自己判幂等），实际是个静默缺陷：
   * 当天**第一跳往往在盘前**（实测 09:02），那时 `producesSignals` 为 false ⇒ outcomes 为空，
   * 而 advance 照样写下当天的净值行 ⇒ `shadow_equity.trade_date` 主键的幂等闸门
   * 从此挡住后面每一轮（`ALREADY_DONE`），**包括收盘确认轮**。
   * 于是 runner 的第 ⑥ 步「用今天的 CONFIRMED 信号挂明天的委托」永远跑不到：
   * 影子组合永远不建仓，而净值曲线一天一根笔直画下去，从数字上看不出任何异常。
   * 实测三个交易日：`shadow_equity` 1 行、`shadow_trade` **0** 行。
   *
   * 现在的接线是「**只在补跑那一刻推进，且必须是盘前**」：那时 D 的收盘线刚补进来、
   * D+1 的开盘还没发生，`orderFrom` 挂的委托按次日开盘成交仍是**前向**的。
   * 代价是净值曲线比自然日**晚一天**落，且应用某天没开就永久缺那一天 —— 两者都是诚实的。
   */
  maintenanceIntervalMs?: number
  /** 补行业那趟的间隔，见 `INDUSTRY_RETRY_INTERVAL_MS`（测试用它把一天压成几毫秒） */
  industryRetryIntervalMs?: number
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
    maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
    industryRetryIntervalMs = INDUSTRY_RETRY_INTERVAL_MS,
  } = deps

  let lastTickAt = 0
  let lastCtx: TickContext | null = null
  let lastSnapshots: SnapshotOutcome | null = null
  let lastSignals: SignalOutcome[] = []

  const dueBy = (key: string, at: number, intervalMs: number): boolean =>
    (meta.getNumber(key) ?? 0) + intervalMs < at
  const due = (key: string, at: number): boolean => dueBy(key, at, maintenanceIntervalMs)

  /**
   * 只差行业的那批标的，每天再试一趟（`INDUSTRY_RETRY_INTERVAL_MS`）。
   *
   * 三条边界：**整周那趟刚跑过就不跑**（同一批代码连打两遍，而主源在冷却里时第二遍
   * 必然还是备源）· **一个都不缺时不发请求也不写 meta**（稳态零请求）·
   * **发过就盖时间戳**，哪怕一个都没补上 —— 补不上的原因多半是主源在冷却，
   * 那不是再打一轮能解决的。
   */
  async function retryIndustry(at: number, refreshedNow: boolean): Promise<void> {
    if (refreshedNow) return
    if (!dueBy(META_KEYS.industryRetryAt, at, industryRetryIntervalMs)) return
    const pending = watchlist.pendingIndustry()
    if (pending.length === 0) return
    await watchlist.refreshProfiles(pending)
    meta.setNumber(META_KEYS.industryRetryAt, at)
    const left = watchlist.pendingIndustry().length
    log.info(`[watchlist] 补行业：${pending.length} 只待补，这趟之后还缺 ${left} 只`)
  }

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

    let refreshedNow = false
    if (due(META_KEYS.profileRefreshedAt, at)) {
      const updated = await watchlist.refreshProfiles()
      if (updated > 0) meta.setNumber(META_KEYS.profileRefreshedAt, at)
      refreshedNow = true
    }

    // ⚠ 这一趟补的是「刷新报了成功、行业却仍然空着」那一批，见 retryIndustry 的头注释
    await retryIndustry(at, refreshedNow)

    const pruned = prune?.(at)
    if (pruned) log.info(`[retention] 裁剪：${JSON.stringify(pruned)}`)

    // 备份排在裁剪**之后**：先删掉过期数据再快照，备份文件小一圈
    backup?.(at)
  }

  /**
   * 补日线。返回「这一轮之后是不是每只都补齐了」——
   * 有一只 FAILED 就是 false（还缺着，值得下一轮再试）。
   */
  async function backfillDaily(codes: readonly SecCode[], through: string): Promise<boolean> {
    const daily = [...new Set([...codes, ...(auxCodes?.() ?? [])])]
    let complete = true
    for (const outcome of await market.backfill(daily, through)) {
      if (outcome.status === 'FAILED') {
        complete = false
        log.warn(`[daily] ${outcome.code} 回补失败：${outcome.error}`)
      }
      if (outcome.status === 'REFETCHED') {
        log.info(`[daily] ${outcome.code} 复权口径变化（${outcome.drift?.date}），已整只重拉`)
      }
    }
    return complete
  }

  /**
   * 这一跳该不该为 `through` 跑收盘确认轮（2026-09-02 用户拍板：**补齐才提前**）。
   *
   * ## 两条路，判据不同
   *
   * - `through < ctx.date`：**次日盘前补跑**，老路，一个字没改。
   * - `through === ctx.date`：**当日提前**，而它多要一个条件 ——
   *   `meta.dailyCompleteDate === ctx.date`，也就是**当日收盘线真的一只不缺**。
   *
   * ## 为什么必须是「补齐才提前」，而不是「试到底就算数」
   *
   * 后者会在一次**不完整**的补跑上写下 `lastSettledDate` 与 `shadow_equity.trade_date`
   * 两道幂等闸门 ⇒ **次日那次完整补跑被整个挡掉**，缺线那只票当天的确认永久缺失
   * （2026-08-17 那个静默缺陷的同一形状）。而本判据下，补不齐的日子**什么都不写**
   * ⇒ 次日盘前照旧补跑，行为与改动前逐字相同。
   *
   * ## 它能覆盖多少天：近五个交易日 3/5
   *
   * 真机实测（`grep 已补齐 $APPDATA/gp-pet/logs/main-*.log`）：08-24 第 3 轮 ✅ ·
   * 08-25 ❌ · 08-26 第 1 轮 ✅ · 08-27 ❌ · 08-28 第 5 轮 ✅。
   * 拒绝这条路的第一条理由曾是「`dailyCompleteDate` 从来没被置位过」，2026-08-30 被这批
   * 日志推翻 ⇒ 它是「时灵时不灵」而不是「永不成立」。剩下的两个 ❌ 卡在
   * `backfillDaily` 的 all-or-nothing（登记项 `daily-complete-partial`）。
   *
   * ## ⚠ 当日那条路只从 `closeCatchup`（15:10 之后）进，不从取数轮进
   *
   * 15:10 之前**盘中引擎还在跑**，而它落的是 `PROVISIONAL` 行。补跑一旦先执行，
   * `lastSettledDate` 就写下了 ⇒ 之后那几轮（15:05–15:10）落的 PROVISIONAL 行
   * **再也不会被 `reconcile()` 推进**，永久停在 PROVISIONAL。
   * 所以取数轮那一处显式只走 `through < ctx.date`；判据留在这里是为了两条路共用同一段话。
   */
  function settleDue(ctx: TickContext, through: string): boolean {
    if (!settle) return false
    if (meta.get(META_KEYS.lastSettledDate) === through) return false
    if (through < ctx.date) return true
    return through === ctx.date && meta.get(META_KEYS.dailyCompleteDate) === ctx.date
  }

  /**
   * 跑一次收盘确认轮并记账。**两条路共用这一个出处** —— 各写一份会让「当日那条」
   * 与「次日那条」在闸门、影子判据或日志上悄悄分叉。
   */
  function settlePass(ctx: TickContext, through: string): void {
    if (!settle) return
    /*
      「成交机会还没过」这道闸门（settle.ts 的边界 2）。

      影子按次日开盘成交 ⇒ 判据是「`through` 之后的那个开盘到了没」：

      - **次日盘前那条路**（`through < ctx.date`）：要求今天是交易日且还没到 09:30。
        用户下午才开应用的话，那一刻的「次日开盘」已经过去 ⇒ **不喂**，
        否则同一段代码会从前向模拟退化成回填。
        判据用 `ctx.minuteOfDay < SESSION_BOUNDS.open` 而不是 `ctx.session`：
        竞价时段的切分与「开盘了没」不是同一件事，而这里问的恰恰是后者。
      - **当日那条路**（`through === ctx.date`）：走到这里必然是 15:00 之后
        （`expectedLastBar` 要收盘才把目标切到当天）⇒ 下一个开盘**必然还没到**
        ⇒ 恒为 true。这不是放宽纪律，是同一条判据在这条路上的取值。

      ⚠ 顺带一个真实的收益：老路要求用户**次日 09:30 之前**开着应用，否则那个交易日的
      影子记录永久缺失（`SHADOW_SKIP_TEXT` 那几行就是在说这件事）。当日路把这个条件
      换成了「当天收盘后应用还开着」—— 对一个桌面常驻应用，后者容易得多。
    */
    const feedShadow =
      through === ctx.date ||
      (calendar.resolve(ctx.date).isOpen && ctx.minuteOfDay < SESSION_BOUNDS.open)
    const when = through === ctx.date ? '当日' : '次日盘前'
    try {
      const result = settle(through, feedShadow)
      // 先记账再说：即使一只都没跑成（全部停牌 / 数据仍未到），也不该每轮重试 ——
      // 那会把每一跳都变成一次全量指标重算
      meta.set(META_KEYS.lastSettledDate, through)
      log.info(
        `[settle] ${through} 收盘确认补跑（${when}）：评估 ${result.evaluated} 只，新落 ${result.persisted} 行，判失效 ${result.invalidated} 条` +
          // 「没喂影子」必须可见：它意味着那一天的前向记录永久缺失
          (result.shadowAdvanced
            ? '，已推进影子运行'
            : // 「喂了但被跳过」与「压根没喂」是两件事，别合并成一句
              `，**未喂影子**（${
                result.shadowSkip === undefined
                  ? feedShadow
                    ? '推进失败，见上一条 warn'
                    : '开盘已过或今日休市'
                  : (SHADOW_SKIP_TEXT[result.shadowSkip] ?? result.shadowSkip)
              }）`)
      )
    } catch (error) {
      // 补跑挂了不该拖垮当轮取数（与引擎失败同一条：行情能看，只是少了这一步）
      log.warn(`[settle] ${through} 补跑失败：${String(error)}`)
    }
  }

  /** 收盘后的日线收尾窗口。四道闸门全过才发请求，见 `CLOSE_CATCHUP` */
  async function closeCatchup(ctx: TickContext, codes: readonly SecCode[]): Promise<void> {
    if (codes.length === 0) return
    if (!ctx.isTradingDay) return
    if (ctx.minuteOfDay < CLOSE_CATCHUP.from || ctx.minuteOfDay >= CLOSE_CATCHUP.to) return

    // 收盘后 expectedLastBar 给的就是当日。给不出当日说明日历判它不是交易日 —— 上面已经挡过，
    // 这里再判一次是因为「补的必须是今天那根」是这段代码存在的全部理由
    const through = expectedLastBar(calendar, ctx.date, ctx.minuteOfDay)
    if (through !== ctx.date) return

    /*
      ⚠ 「已补齐」这道闸门**只挡取数，不挡补跑**（2026-09-02 改）。
      原先它是整个函数的早退，于是「15:00–15:10 的 SETTLE 轮就已经补齐」那种日子
      会在 15:10 直接返回 ⇒ 当日确认轮一次都跑不成，而那恰恰是最该跑的日子。
    */
    if (meta.get(META_KEYS.dailyCompleteDate) !== ctx.date) {
      // 次数跨日清零：昨天用满的额度不该让今天一轮都不跑
      const counted = meta.get(META_KEYS.dailyCatchupDate) === ctx.date
      const attempts = counted ? (meta.getNumber(META_KEYS.dailyCatchupAttempts) ?? 0) : 0
      if (attempts >= CLOSE_CATCHUP.maxAttempts) return

      meta.set(META_KEYS.dailyCatchupDate, ctx.date)
      meta.setNumber(META_KEYS.dailyCatchupAttempts, attempts + 1)

      if (await backfillDaily(codes, through)) {
        meta.set(META_KEYS.dailyCompleteDate, ctx.date)
        log.info(`[daily] ${ctx.date} 当日收盘线已补齐（收盘后第 ${attempts + 1} 轮），日报可定稿`)
      }
    }

    // 补齐了就把当天的收盘确认轮跑掉（2026-09-02 拍板「补齐才提前」）。
    // 补不齐时 `settleDue` 恒 false ⇒ 什么都不写 ⇒ 次日盘前照旧补跑
    if (settleDue(ctx, through)) settlePass(ctx, through)
  }

  return {
    async run(ctx) {
      lastTickAt = ctx.at
      lastCtx = ctx

      const codes: SecCode[] = watchlist.codes()

      if (!ctx.needsQuotes) {
        // 休市期间唯一允许发出的两种请求：收盘后的日线收尾 + 每周一次的维护
        await closeCatchup(ctx, codes)
        await maintain(ctx.at)
        return
      }
      if (codes.length === 0) return

      // 日线：目标是「此刻应该已存在的最后一根」。已补齐时 backfill 一个请求都不发。
      // 基准指数与自选股一起补 —— 少了它，情绪值会一直退化为中性 0.5，
      // 而那会静默地让 RSI 阈值停在 75/25，没人看得出来
      const through = expectedLastBar(calendar, ctx.date, ctx.minuteOfDay)
      if (through) {
        // 补齐了就记一笔：收盘后那个窗口据此停手（15:00–15:10 的 SETTLE 轮偶尔就能补齐）
        if ((await backfillDaily(codes, through)) && through === ctx.date) {
          meta.set(META_KEYS.dailyCompleteDate, ctx.date)
        }
      }

      /*
        收盘确认轮（engine/settle.ts）。

        **位置是必须的**：排在 backfill 之后 —— 它要用的正是刚刚补进来的那根收盘线。
        排在 refreshSnapshots 之前则是因为补跑与快照无关，早跑早写完，
        不必让它跟当轮取数抢同一个 SQLite 连接。

        触发判据在 `settleDue()`。**这一处显式只走 `through < ctx.date`**：
        `expectedLastBar()` 15:00 前给的就是上一个交易日，那是老路（次日盘前补跑）。
        当日那条路（2026-09-02 拍板）**刻意不从这里进** —— 15:10 之前盘中引擎还在跑，
        先补跑会把 `lastSettledDate` 写下，之后那几轮落的 PROVISIONAL 行就再也不会被
        `reconcile()` 推进。它只从 `closeCatchup`（15:10–16:00，引擎已停）进。

        实践上老路几乎总是在次日盘前那一跳执行：数据源发布个股日线在 15:05–15:30，
        晚于当天的 SETTLE 窗口（15:00–15:10）。
      */
      if (through && through < ctx.date && settleDue(ctx, through)) settlePass(ctx, through)

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
