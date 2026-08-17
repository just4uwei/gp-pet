/**
 * 提醒分发的四道闸门（docs/05 §4）。
 *
 * 引擎给出的 `GatedSignal` 已经带了 `level`（L1/L2/L3，由风控层按 docs/05 §3 定）。
 * 这里管的是**要不要真的发出去**，四道闸门依次通过，任一不过就记原因后丢弃：
 *
 *   ① 防抖：盘中信号必须连续 N 个 tick 成立（默认 2，约 60s）
 *   ② 同键冷却：同 `code:direction` 在冷却期内不重复（L1 30min / L2 2h / L3 当日一次）
 *   ③ 频率上限：单标的每日 L2+L3 ≤ 4；全局每小时 L2+L3 ≤ 6；全局每日 L3 ≤ 10
 *   ④ 免打扰：静默时段 / 全屏 / 专注助手 / 手动免打扰 / 锁屏 → L2/L3 降为 L1
 *
 * 三个级别的**表现**只剩两档（2026-08-13 起托盘角标与系统通知已移除）：
 * L1 只改状态点，L2/L3 额外弹一个气泡。但级别本身仍然有区别 ——
 * 冷却窗口（L1 30min / L2 2h / L3 当日一次）与频率上限都是按级别算的。
 *
 * ## 三条实现纪律
 *
 * 1. **不读时钟。** `now` 由调用方传入，跨日与跨小时的边界都用它算。理由与 src/core 相同：
 *    「提醒会不会在 15:00 之后重发」这种事必须能在单测里写出来，而不是靠改系统时间试。
 * 2. **批量而不是逐条。** ③ 里「全局每小时超限时**按得分排序保留最高的**」这条规则
 *    需要同时看到本轮全部候选 —— 逐条 API 做不到（先到的低分信号会占掉配额）。
 *    ① 也需要：本轮没出现的键要清零，只有拿到全量才知道谁没出现。
 * 3. **闸门③④是降级，①②是丢弃。** 降级的仍然会发（变成 L1 进面板与未读计数），
 *    丢弃的只写 `alert_log.suppressed_reason`。**两者都不能悄悄消失** ——
 *    docs/05 §4 的原话是「不制造信息黑洞」，用户要能在面板里看到「今日被静默的 N 条」。
 */

import type { AlertLevel, GatedDirection, SecCode } from '@core/types'
import { shanghaiDayStartMs } from '../../shared/time'

/**
 * 分发渠道，与 `alert_log.channel` 的取值一致。
 *
 * `PET` 是悬浮条上的状态点（名字是历史，见 `PetState`），`BUBBLE` 是气泡。
 * `TRAY`（托盘角标 + 图标闪烁）与 `OS_NOTIFY`（系统通知）已移除 —— 历史库里
 * 仍有带这两个值的行，只读不再产出。
 */
export type AlertChannel = 'PET' | 'BUBBLE'

/**
 * 各级别对应的渠道（docs/05 §3）。高级别包含低级别的表现。
 *
 * L2 与 L3 现在**渠道相同**（都是状态点 + 气泡）—— 区别落在闸门②③上：
 * L3 当日只发一次、且受全局每日 L3 上限约束。别因为这两行长得一样就把级别合并掉。
 */
export const CHANNELS_BY_LEVEL: Record<AlertLevel, readonly AlertChannel[]> = {
  L1: ['PET'],
  L2: ['PET', 'BUBBLE'],
  L3: ['PET', 'BUBBLE'],
}

export interface AlertCandidate {
  signalId: string
  code: SecCode
  direction: GatedDirection
  level: AlertLevel
  /** 0..1，用于频率上限超限时的排序 */
  score: number
  /** 防抖键的一部分：本轮得分最高的子信号 ID */
  topSubSignalId: string
  /**
   * 持仓强制类（止损 / 移动止损 / 回撤减仓）。
   * docs/05 §4.2：**不受冷却限制**，改为「每次跌幅每扩大 2% 提醒一次」。
   */
  forced?: boolean
  /** `forced` 时的当前浮亏幅度（负数，如 −0.086）。用于那条 2% 的台阶判定 */
  lossPct?: number
}

export interface DispatchContext {
  /** 免打扰生效中（静默时段 / 全屏 / 专注助手 / 手动 / 锁屏 任一成立） */
  quiet: boolean
  /** 免打扰的具体原因，写进 alert_log 便于用户理解「为什么没弹」 */
  quietReason?: string
  /** 盘中 tick 之外的场合（收盘确认轮）可关掉防抖 —— 那时没有「连续 N 个 tick」可言 */
  debounce?: boolean
}

/**
 * 四道闸门的离散标识（`alert_log.suppressed_gate` / `would_block` 的取值）。
 *
 * **`reason` 那句话不能拿去分组** —— 它嵌着连续量（「1/2 个 tick」「还有 87 分钟」），
 * 按它 GROUP BY 会得到成百上千个只差一个数字的桶。与 `signalSignature` 里
 * `reasons[0]` 那个坑同一个形状（两天落了 243 行同一条止损）。见 011 迁移的头注释。
 */
export type AlertGate = 'DEBOUNCE' | 'COOLDOWN' | 'CAP' | 'QUIET'

export interface AlertDecision {
  candidate: AlertCandidate
  /** 最终级别（可能被降级）；被丢弃时为 null */
  level: AlertLevel | null
  channels: readonly AlertChannel[]
  /** 非空表示被抑制/降级及原因，一律写 alert_log（docs/05 §6） */
  reason: string | null
  /**
   * 实际把它拦下/降级的**第一道**闸门。四道是串行的，所以这是「为什么没发出去」的答案。
   * null = 一路通过。
   */
  blockedBy: AlertGate | null
  /**
   * **假设前置闸门都放行**，哪几道各自也会拦。答的是「每道闸门各自有多严」。
   *
   * 为什么必须单独有这一项：闸门短路，被防抖挡下的候选**根本走不到冷却**，
   * 于是只看 `blockedBy` 会让靠后的闸门看起来永远很松 —— 而那只是前面的把流量吃光了。
   * **「某道闸门拦截率 < 10% ⇒ 形同虚设」这个判据只有拿这一项读才成立。**
   *
   * 独立评估不花钱：`checkCooldown` / `checkCaps` 都是纯读，只有 `checkDebounce` 会改
   * `streaks`，而它本来就是第一道、不存在被短路的问题。
   */
  wouldBlock: readonly AlertGate[]
}

export interface DispatcherOptions {
  /** 防抖需要的连续 tick 数（docs/05 §4.1，默认 2） */
  debounceTicks?: number
  /** 同键冷却毫秒数，按级别（docs/05 §4.2） */
  cooldownMs?: Record<AlertLevel, number>
  /** 单标的每日 L2+L3 上限（默认 4） */
  perCodeDailyLimit?: number
  /** 全局每小时 L2+L3 上限（默认 6） */
  hourlyLimit?: number
  /** 全局每日 L3 上限（默认 10） */
  dailyL3Limit?: number
  /** 强制类提醒的复发台阶：跌幅每扩大这么多才再提醒一次（默认 0.02） */
  forcedStepPct?: number
  /** 本地零点。默认按运行环境的本地时区算；注入是为了让单测不受时区影响 */
  startOfDay?: (ts: number) => number
}

const HOUR = 60 * 60 * 1000

const DEFAULT_COOLDOWN: Record<AlertLevel, number> = {
  L1: 30 * 60 * 1000,
  L2: 2 * HOUR,
  // 「当日一次」不能写成 24h：那会让今天 23:00 发过之后，明天 09:30 开盘还在冷却里。
  // 用 Infinity + 跨日重置来表达（见 rollDay）
  L3: Number.POSITIVE_INFINITY,
}

/*
  日界走**北京时间**，不是宿主本地时区（2026-08-15 改）。

  原先是 `new Date(y, m, d)`，在 UTC+8 上恰好对、在 UTC+7 上无害（日界落到北京 01:00），
  但在西半球会落进交易时段中间：UTC−5 的本机 00:00 是北京 13:00，
  于是「每日 L2+L3 ≤ 4」「当日 L3 一次」会在午盘开盘那一刻重置。
  **少发的错误用户发现不了，多发的更发现不了** —— 两边日志都显示自己守规矩。
*/

/**
 * 分发器。**有状态**（防抖计数、冷却时间、各级计数器），所以整个应用只应有一个实例。
 * 状态全部在内存里：重启后冷却清零是可以接受的（用户重启应用时本来就期待看到当前状态），
 * 而把它们落库会让「重启后被冷却挡住、什么都不弹」变成一个很难查的问题。
 */
export class AlertDispatcher {
  private readonly debounceTicks: number
  private readonly cooldownMs: Record<AlertLevel, number>
  private readonly perCodeDailyLimit: number
  private readonly hourlyLimit: number
  private readonly dailyL3Limit: number
  private readonly forcedStepPct: number
  private readonly startOfDay: (ts: number) => number

  /** 防抖：`code:direction:topSubSignalId` → 连续成立的 tick 数 */
  private streaks = new Map<string, number>()
  /** 冷却：`code:direction` → { level, at } 最近一次实际发出的提醒 */
  private lastSent = new Map<string, { level: AlertLevel; at: number }>()
  /**
   * 强制类的台阶：`code` → **上次真的弹过气泡时**的浮亏幅度。
   *
   * 「真的弹过」这半句是硬的：被闸门③④降级成 L1 的那条没打扰过任何人，
   * 不该消耗台阶（见 `commit` 里那段注释）。
   */
  private lastForcedLoss = new Map<SecCode, number>()
  /** 滑动窗口：最近一小时内实际发出的 L2/L3 时间戳 */
  private recentHigh: number[] = []
  /** 当日计数 */
  private day = -1
  private perCodeToday = new Map<SecCode, number>()
  private l3Today = 0

  constructor(options: DispatcherOptions = {}) {
    this.debounceTicks = options.debounceTicks ?? 2
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN
    this.perCodeDailyLimit = options.perCodeDailyLimit ?? 4
    this.hourlyLimit = options.hourlyLimit ?? 6
    this.dailyL3Limit = options.dailyL3Limit ?? 10
    this.forcedStepPct = options.forcedStepPct ?? 0.02
    this.startOfDay = options.startOfDay ?? shanghaiDayStartMs
  }

  /**
   * 跑一轮分发。**返回本轮全部候选的裁决**（含被丢弃的），调用方按 `reason` 决定
   * 是发出去还是只写 alert_log。
   */
  dispatch(candidates: readonly AlertCandidate[], now: number, ctx: DispatchContext): AlertDecision[] {
    this.rollDay(now)
    this.pruneHourly(now)

    const decisions: AlertDecision[] = []
    // 闸门①②：逐条判，先把「不该发」的丢掉
    const survivors: AlertCandidate[] = []
    const seen = new Set<string>()
    // 幸存者的独立评估结果留到闸门③④那一轮再用（那时 quiet 已经确定）
    const wouldBlockOf = new Map<AlertCandidate, AlertGate[]>()

    for (const candidate of candidates) {
      const debounceKey = `${candidate.code}:${candidate.direction}:${candidate.topSubSignalId}`
      seen.add(debounceKey)

      const gate1 = this.checkDebounce(candidate, debounceKey, ctx)
      // ⚠ 无论 ① 有没有拦下来都要算 ②③④ —— 那是 `wouldBlock` 的全部意义。
      // 三个 check 都是纯读（记账在 commit 里），所以提前算不会改变分发行为
      const gate2 = this.checkCooldown(candidate, now)
      const gate3 = candidate.level === 'L1' ? null : this.checkCaps(candidate, candidate.level)
      const quiet = ctx.quiet === true && candidate.level !== 'L1'
      const wouldBlock: AlertGate[] = []
      if (gate1) wouldBlock.push('DEBOUNCE')
      if (gate2) wouldBlock.push('COOLDOWN')
      if (gate3) wouldBlock.push('CAP')
      if (quiet) wouldBlock.push('QUIET')

      if (gate1) {
        decisions.push(drop(candidate, gate1, 'DEBOUNCE', wouldBlock))
        continue
      }
      if (gate2) {
        decisions.push(drop(candidate, gate2, 'COOLDOWN', wouldBlock))
        continue
      }
      survivors.push(candidate)
      wouldBlockOf.set(candidate, wouldBlock)
    }

    // 本轮没出现的防抖键清零 —— 指标在阈值附近抖动时，「消失过」就得重新连续 N 次
    for (const key of [...this.streaks.keys()]) if (!seen.has(key)) this.streaks.delete(key)

    // 闸门③④：降级。**按得分降序处理**，这样配额留给最值得发的那条（docs/05 §4.3）
    for (const candidate of [...survivors].sort((a, b) => b.score - a.score)) {
      let level = candidate.level
      const reasons: string[] = []
      // ③④ 是**降级**不是丢弃，所以「第一道拦下它的」取先触发的那个。
      // 免打扰在前（先判），频率上限在后
      let blockedBy: AlertGate | null = null

      // ④ 免打扰：L2/L3 一律降为 L1（不弹气泡，只改状态点 + 进未读计数）
      if (ctx.quiet && level !== 'L1') {
        reasons.push(`免打扰${ctx.quietReason ? `（${ctx.quietReason}）` : ''}，降为 L1`)
        blockedBy = 'QUIET'
        level = 'L1'
      }

      // ③ 频率上限：三条各自判，都是降级而不是丢弃
      if (level !== 'L1') {
        const cap = this.checkCaps(candidate, level)
        if (cap) {
          reasons.push(cap)
          blockedBy ??= 'CAP'
          level = 'L1'
        }
      }

      this.commit(candidate, level, now)
      decisions.push({
        candidate,
        level,
        channels: CHANNELS_BY_LEVEL[level],
        reason: reasons.length > 0 ? reasons.join('；') : null,
        blockedBy,
        wouldBlock: wouldBlockOf.get(candidate) ?? [],
      })
    }

    return decisions
  }

  /** ① 防抖（docs/05 §4.1）。强制类不防抖：止损晚一个 tick 是真金白银 */
  private checkDebounce(candidate: AlertCandidate, key: string, ctx: DispatchContext): string | null {
    if (candidate.forced === true || ctx.debounce === false || this.debounceTicks <= 1) {
      this.streaks.set(key, this.debounceTicks)
      return null
    }
    const next = (this.streaks.get(key) ?? 0) + 1
    this.streaks.set(key, next)
    if (next < this.debounceTicks) {
      return `防抖：连续成立 ${next}/${this.debounceTicks} 个 tick，未达确认次数`
    }
    return null
  }

  /** ② 同键冷却（docs/05 §4.2） */
  private checkCooldown(candidate: AlertCandidate, now: number): string | null {
    if (candidate.forced === true) {
      // 持仓强制类不受冷却，改为「跌幅每扩大 forcedStepPct 提醒一次」——
      // 既不骚扰（不是每 tick 都喊）也不漏报（跌得更深时一定会再喊一次）
      const loss = candidate.lossPct
      if (loss === undefined) return null
      const previous = this.lastForcedLoss.get(candidate.code)
      if (previous !== undefined && loss > previous - this.forcedStepPct) {
        return `强制提醒台阶：跌幅 ${(loss * 100).toFixed(1)}% 未比上次（${(previous * 100).toFixed(
          1
        )}%）再扩大 ${(this.forcedStepPct * 100).toFixed(0)}%`
      }
      return null
    }

    const key = `${candidate.code}:${candidate.direction}`
    const last = this.lastSent.get(key)
    if (!last) return null
    // 冷却期按**上次实际发出的级别**算：L3 发过之后当日不再重复，即便这次只是 L1
    const window = this.cooldownMs[last.level]
    if (now - last.at >= window) return null
    const minutes = Math.round((window - (now - last.at)) / 60000)
    return window === Number.POSITIVE_INFINITY
      ? `同键冷却：${key} 今日已发过 ${last.level}`
      : `同键冷却：${key} 上次 ${last.level} 提醒后还有 ${minutes} 分钟`
  }

  /** ③ 频率上限（docs/05 §4.3）。返回非空表示要降级 */
  private checkCaps(candidate: AlertCandidate, level: AlertLevel): string | null {
    if ((this.perCodeToday.get(candidate.code) ?? 0) >= this.perCodeDailyLimit) {
      return `频率上限：${candidate.code} 今日 L2+L3 已达 ${this.perCodeDailyLimit} 条，降为 L1`
    }
    if (this.recentHigh.length >= this.hourlyLimit) {
      return `频率上限：全局每小时 L2+L3 已达 ${this.hourlyLimit} 条，降为 L1`
    }
    if (level === 'L3' && this.l3Today >= this.dailyL3Limit) {
      return `频率上限：全局今日 L3 已达 ${this.dailyL3Limit} 条，降为 L1`
    }
    return null
  }

  /** 记账。只有**实际发出**的才计入冷却与配额 —— 被降级成 L1 的不占 L2/L3 的额度 */
  private commit(candidate: AlertCandidate, level: AlertLevel, now: number): void {
    this.lastSent.set(`${candidate.code}:${candidate.direction}`, { level, at: now })
    if (level === 'L1') return
    /*
      ⚠ 强制类台阶**必须记在这条早退之后**（2026-08-17 修，真机日志掉出来的）。

      台阶就是一种额度，与下面三个计数器同一条纪律：被降级成 L1 的那条**没有弹气泡**，
      不该占用任何额度。原先它记在早退之前，于是：
        08-17 09:30:05 开盘第一轮，三只跌破止损线的持仓（浮亏 −7.8%）被
        「免打扰（屏幕已锁定）」降为 L1 —— 降级本身是设计（§4.4，只改状态点不弹气泡），
        但台阶照样记成 −7.8%。解锁之后跌到 −8.4% 也再不提醒（要再扩大 2%），
        整天 0 条气泡、1580 行「台阶未扩大」。
      docs/05 §4.2 那句「既不骚扰又不漏报」被打穿了一半：那天没骚扰过任何人，只漏报。
      而这正是本项目最贵的错误类别 —— 少发的错误用户自己发现不了。

      代价是免打扰持续期间每轮都会重新造一条候选并落痕（被 006 的判重折成一行），
      换来的是**免打扰一解除，那条止损气泡立刻补上**。
    */
    if (candidate.forced === true && candidate.lossPct !== undefined) {
      this.lastForcedLoss.set(candidate.code, candidate.lossPct)
    }
    this.recentHigh.push(now)
    this.perCodeToday.set(candidate.code, (this.perCodeToday.get(candidate.code) ?? 0) + 1)
    if (level === 'L3') this.l3Today++
  }

  /** 跨日重置：当日计数、L3 的「当日一次」冷却、强制类台阶 */
  private rollDay(now: number): void {
    const day = this.startOfDay(now)
    if (day === this.day) return
    this.day = day
    this.perCodeToday.clear()
    this.l3Today = 0
    this.lastForcedLoss.clear()
    // L3 的冷却是 Infinity（当日一次），跨日必须清掉，否则永远发不出第二条
    for (const [key, last] of [...this.lastSent.entries()]) {
      if (last.at < day) this.lastSent.delete(key)
    }
  }

  /**
   * 「每小时 ≤ 6」用**滑动窗口**而不是整点桶。
   * 整点桶会允许 10:59 发 6 条、11:00 再发 6 条 —— 用户体验到的是「两分钟内 12 条」。
   */
  private pruneHourly(now: number): void {
    this.recentHigh = this.recentHigh.filter((at) => now - at < HOUR)
  }
}

function drop(
  candidate: AlertCandidate,
  reason: string,
  blockedBy: AlertGate,
  wouldBlock: readonly AlertGate[]
): AlertDecision {
  return { candidate, level: null, channels: [], reason, blockedBy, wouldBlock }
}
