/**
 * 补跑收盘确认轮（2026-08-14）。
 *
 * ## 为什么需要它：收盘确认轮**从来没有成功过**
 *
 * 实测用户库（两个交易日、8 只标的）：`signal` 表 769 行里 `CONFIRMED` **0 行**，
 * `indicator_daily` **0 行**，影子三张表 **全 0 行**。
 *
 * 成因是两个时间窗口对不上：`expectedLastBar()` 在 15:00 之后才把回补目标切到当天，
 * 而数据源发布**个股**日线通常在 15:05–15:30 —— **晚于应用的 SETTLE 窗口（15:00–15:10）**。
 * 15:10 一到 `needsQuotes` 变 false，引擎当天不再跑。于是引擎判的永远是拼出来的临时线，
 * `stage` 恒为 `PROVISIONAL`，而下面三处**全部以 `CONFIRMED` 为前提**：
 *
 *   * `reconcile()` —— 当日那条盘中信号永远不会被推进为 CONFIRMED / INVALIDATED
 *   * `cacheIndicators()` —— 指标截面永远不落库（每轮都在重算全部指标）
 *   * `carryover()` —— 昨日「明日观察」的次日兑现要求昨日那条已确认，于是永不触发
 *
 * 日线其实会补进来，只是在**第二天盘前**。这个模块就是在那一刻把 D 那天补跑一遍。
 *
 * ## 它不含任何判定逻辑
 *
 * `createSignalEngine` 本来就全都会，差的只是一个「历史行情」适配器：
 * `run()` 走 `market.getContext()`（尾部拼当日临时线），换成
 * `market.getContextThrough(code, D)`（截至 D 的收盘线、不拼临时线、不带快照）之后，
 * 末根就是 D 的真实收盘线 → `stage === 'CONFIRMED'`，其余一路照旧。
 * **所以这里一行判定都不要写** —— 写了就会与当日流水那条路分叉，
 * 而「补跑出来的结论和当天本该得到的结论不一样」这件事没有任何人看得出来。
 *
 * ## 三条边界
 *
 * 1. **不发提醒。** outcomes 直接丢弃，不进 `AlertService`。那天已经过去了，
 *    第二天早上补一条「昨天 14:xx 的买入信号」是纯粹的噪音；
 *    被判 INVALIDATED 的那条同理（撤销一条用户从没收到过的提醒）。
 * 2. **接影子运行，但有一道闸门**（2026-08-17 改；此前刻意不接）。这里的判断很微妙：
 *    D 的 CONFIRMED 信号按影子的成交模型是**次日开盘**成交 —— 若补跑发生在 D+1 盘前，
 *    那一刻 D+1 的开盘还没发生，**仍是前向的**；但用户 D+1 下午才开应用的话，
 *    开盘早过了，同一段代码就变成了回填，而回填出来的绩效不属于任何真实决策。
 *
 *    闸门因此是「**成交机会还没过**」：调用方（`engine/tick.ts`）只有在
 *    「今天是交易日 且 还没到 09:30」时才把 `shadow` 传进来，否则这一次补跑不喂影子。
 *    判据由调用方给，因为只有它知道 `ctx`；本模块不读时钟。
 *
 *    **为什么必须接**：不接的后果 2026-08-17 实测到了 —— `tick.ts` 原先每轮都调
 *    `shadow.advance`，于是当天**第一跳（盘前 09:02）**就用空 outcomes 把当天推进掉、
 *    写下净值行，`shadow_equity.trade_date` 主键的幂等闸门从此挡住后面每一轮，
 *    包括收盘确认轮。结果是**第 ⑥ 步（挂明天的委托）永远跑不到**：
 *    影子组合永远不会建仓，曲线一天一根笔直地画下去，而净值上看不出任何异常。
 *    实测三个交易日：`shadow_equity` 1 行、`shadow_trade` **0** 行。
 * 3. **新建引擎实例，不复用当日那个。** `persistedSignature` 是按 code 的内存 map，
 *    共用会让补跑把当日流水的去重状态冲掉 —— 症状是补跑之后当天第一条信号重复落一行。
 *
 * ## 只补**上一个交易日**，更早的不追
 *
 * 调用方（`engine/tick.ts`）用 `expectedLastBar()` 给出目标日，它最多回到上一个交易日。
 * 这不是偷懒：往前追等于给**应用没开机的那些天**凭空造出一份信号历史 ——
 * 那些信号从来没有出现在任何界面上、也从来没有经过闸门，
 * 却会让「今天引擎给了几条信号」这类统计再也答不准（与「观察点命中不写进 signal 表」同一条）。
 *
 * ## 在真实数据上验过一次（2026-08-14）
 *
 * 拿用户库的一致性副本（`VACUUM INTO`，**不能用 `cp`** —— WAL 下主文件不自足）跑
 * `settleDay('2026-08-13')`：7 只全部评估，新落 3 行 CONFIRMED，
 * 另有 3 条当日 PROVISIONAL 被 `reconcile()` 推进 → `CONFIRMED` **0 → 6**，
 * 指标缓存 **0 → 7**，落库行的 `created_at` 是 `2026-08-13T07:00:00Z`（北京时间 15:00）。
 */

import { createSignalEngine, type SignalEngineDeps, type SignalOutcome } from './signals'
import type { MarketDataService } from './market-data'
import { shanghaiToEpochMs } from '../providers/shared'
import type { SecCode, TradeDate } from '@core/types'

/**
 * A 股收盘时刻（北京时间 15:00）在当天的第几分钟 —— 与 `SESSION_BOUNDS.close` 同一个数。
 *
 * 导出是给 `./preview.ts` 用的：那条路要与补跑用**同一个** `minuteOfDay`，
 * 各写一个数会让「预览」与「明早的补跑」落在 `T1_LATE_BUY` 窗口（890–910）的两侧
 * —— 于是同一根 K 线一边给「买入」一边给「明日观察」，而没人看得出为什么。
 */
export const CLOSE_MINUTE = 15 * 60

/**
 * `YYYY-MM-DD` → 那天**北京时间 15:00** 的 epoch ms。补跑落库行的 `created_at` 用它。
 *
 * 必须走 `shanghaiToEpochMs` 而不是 `new Date(date + 'T15:00')`：后者按**本机时区**解析，
 * 在非 +08 的机器上会偏出几个小时 —— 而偏出去的后果是那些行落进错误的自然日，
 * 于是「昨天补跑的信号」出现在今天的列表里（面板与悬浮条都按本地零点筛）。
 * 与分时图那边共用同一个口径（CLAUDE.md：分时的时刻一律按北京时间读写）。
 */
export function closeMsOf(date: TradeDate): number {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) throw new Error(`补跑的日期不合法：${date}`)
  return shanghaiToEpochMs(y, m, d, 15, 0, 0)
}

export interface SettleDeps extends Omit<SignalEngineDeps, 'market'> {
  market: Pick<MarketDataService, 'getContextThrough' | 'snapshotOf'>
  /**
   * D 收盘那一刻的墙上时刻（ms）。**由调用方给** —— 本模块与 `src/core` 同一条纪律，不读时钟。
   *
   * 它会成为补跑落库那些行的 `created_at`。**绝不能用「现在」**：
   * 那会让昨天的信号出现在今天的列表里（面板与悬浮条都按 `created_at >= 今天 00:00` 筛）。
   */
  closedAt: number
  /**
   * 影子运行推进器。**给了就喂，不给就不喂** —— 「成交机会是否已过」那道闸门
   * 由调用方判（见头注释边界 2）。本模块不读时钟，也不认识日历。
   *
   * `advance` 返回 **null = 本轮什么都没做**（幂等闸门 / 引擎版本闸门）。类型写成
   * `object | null` 而不是 `unknown` 是刻意的：`unknown` 会让「跳过」在这里读不出来，
   * 而那正是 2026-08-18 那个静默缺陷的形状（见下面 `shadowAdvanced` 那段）。
   */
  shadow?: {
    advance(input: { date: TradeDate; at: number; outcomes: readonly SignalOutcome[] }): object | null
    /** 跳过的理由。拿得到就报出来 —— 「哪一天永久缺了」必须答得出具体原因 */
    lastSkip?(): { kind: string } | null
  }
  /** 喂影子那一步的墙上时刻。与 `closedAt` 分开：那个是 D 的收盘，这个是「现在」 */
  now?: number
}

export interface SettleResult {
  date: TradeDate
  /** 真的跑了评估的标的数（当天没有收盘线的会被 getContextThrough 挡掉） */
  evaluated: number
  /** 本次新落库的行数 */
  persisted: number
  /**
   * 当日旧行被判**失效**的条数。
   * 注意它不含「被确认」的那些 —— `reconcile()` 确认时返回 null（没有可报的事），
   * 只有失效才带回一条通知。想数确认数得去查库，别在这里凑一个半对的数。
   */
  invalidated: number
  /**
   * 这次补跑有没有喂给影子运行**并且真的推进了**。
   * **必须报出来**：「补跑了但没喂影子」与「补跑了并喂了」在净值曲线上看不出区别，
   * 而前者意味着那一天的前向记录永久缺失（见头注释边界 2）。
   */
  shadowAdvanced: boolean
  /**
   * 喂了、但推进器自己跳过了的理由（`ShadowSkip['kind']`，或抛错时的 `ERROR`）。
   * 推进成功时**不出现**这个键。
   */
  shadowSkip?: string
}

/**
 * 把 `date` 那天补跑一遍收盘确认。
 *
 * 幂等：`persist()` 按签名去重、`reconcile()` 只动 PROVISIONAL 行、`indicators.put` 是 upsert，
 * 所以重复调用不会产生重复数据。但调用方仍应按 `META_KEYS.lastSettledDate` 一天只跑一次
 * —— 它要为每只标的算一遍 320 根的全套指标，没必要每轮 tick 都来。
 */
export function settleDay(date: TradeDate, deps: SettleDeps): SettleResult {
  const { closedAt, market, ...rest } = deps

  const engine = createSignalEngine({
    ...rest,
    market: {
      // 「D 那天收盘时这只票长什么样」。停牌 / 数据没到时它回空序列，引擎自己会跳过
      getContext: (code: SecCode, _date: TradeDate, bars?: number) =>
        market.getContextThrough(code, date, bars),
      // 补跑不看快照：那是「此刻」的价，与 D 收盘那一刻无关
      snapshotOf: () => null,
    },
  })

  const outcomes = engine.run({
    date,
    minuteOfDay: CLOSE_MINUTE,
    session: 'SETTLE',
    at: closedAt,
    producesSignals: true,
  })

  /*
    喂影子运行（边界 2）。**outcomes 仍然不返回给调用方** ——
    影子在这里就地消费掉，免得日后有人顺手把同一份 outcomes 接到 AlertService 上。

    单独 try：模拟账本出错不该让整次补跑作废（否则 `lastSettledDate` 不落，
    下一轮又要为每只标的重算 320 根指标）。
  */
  let shadowAdvanced = false
  let shadowSkip: string | undefined
  if (deps.shadow) {
    try {
      /*
        `advance` 返回 null = 它自己跳过了（`ALREADY_DONE` / `ENGINE_VERSION_CHANGED`）。
        **「喂了」不等于「推进了」** —— 把两者读成一件事会让日志替一次没发生的推进担保。

        2026-08-18 实测到过这个形状：08-17 盘前那条修复前的代码留下的净值行，
        让第二天补跑一进 advance 就 `ALREADY_DONE` 返回 null，
        而这里照样报 `shadowAdvanced: true`、日志照样打「已推进影子运行」——
        于是「第 ⑥ 步（挂明天的委托）那天根本没跑、那一天永久缺失」这件事
        在日志上完全看不出来，而那正是边界 2 要求可见的东西。
      */
      const advanced = deps.shadow.advance({ date, at: deps.now ?? closedAt, outcomes })
      shadowAdvanced = advanced !== null
      if (!shadowAdvanced) shadowSkip = deps.shadow.lastSkip?.()?.kind ?? 'UNKNOWN'
    } catch (error) {
      shadowSkip = 'ERROR'
      deps.log?.warn?.(`[settle] ${date} 喂影子运行失败：${String(error)}`)
    }
  }

  // outcomes 到此为止 —— **不返回给调用方**，免得日后有人顺手接到 AlertService 上（见边界 1）
  return {
    date,
    shadowAdvanced,
    // 条件展开：推进成功时不该多出一个恒为 undefined 的键
    ...(shadowSkip === undefined ? {} : { shadowSkip }),
    evaluated: outcomes.length,
    persisted: outcomes.filter((outcome) => outcome.persisted).length,
    invalidated: outcomes.filter((outcome) => outcome.invalidated !== undefined).length,
  }
}
