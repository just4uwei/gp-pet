/**
 * 提醒编排（docs/05 §3–§6）—— 信号真正走向用户的**唯一**出口。
 *
 * ```
 * SignalOutcome[] ─▶ buildAlerts ─▶ AlertDispatcher（四道闸门）─┬─▶ alert_log（每一条裁决）
 *                                                              ├─▶ 悬浮条状态点（PET）
 *                                                              └─▶ 气泡（BUBBLE）
 * ```
 *
 * **气泡是提醒唯一的可见出口**（2026-08-13）：托盘角标 + 图标闪烁与系统通知都已移除。
 * 未读计数仍然算（面板的提醒日志要用），只是不再有人把它画成角标。
 *
 * ## 四条纪律
 *
 * 1. **每一条候选都写 alert_log**，包括被丢弃的（docs/05 §4「不制造信息黑洞」）。
 *    用户要能在提醒日志里回答「它是不是漏提醒了」。
 * 2. **一次最多弹一个气泡**：本轮得分最高的那条。气泡会互相替换而不是排队 ——
 *    排队意味着用户盯着一串过时提醒轮播，那比不弹更烦人。
 * 3. **渠道失败不影响记账**。气泡窗口建不出来时提醒仍算发过：
 *    面板与未读计数已经拿到它了，把整条判为失败会让它在下一轮重发。
 * 4. **不读时钟**：`at` 由调用方（tick）传入，与 AlertDispatcher / src/core 同一条纪律。
 *    「收盘 15:00 那一轮会不会重发」必须能写成用例。
 */

import { randomUUID } from 'node:crypto'
import type { SecCode } from '@core/types'
import type { AlertRecord, AlertPayload, AppSettings } from '@shared/ipc-types'
import type { SignalOutcome } from '../engine/signals'
import type { AlertRepo, AlertRow } from '../storage/repositories/alert'
import type { WatchHit } from '../watch/evaluate'
import { buildAlerts, type QuoteView } from './candidates'
import { AlertDispatcher, type AlertCandidate, type AlertDecision } from './dispatcher'
import type { QuietVerdict } from './dnd'
import { PetStateMachine } from './pet-state'

/** 渠道执行端。controller 实现它 —— 这一层不认识 BrowserWindow 与 Tray */
export interface AlertSink {
  /** L2+：弹气泡（一次一个，本轮得分最高的那条）。**唯一的可见渠道** */
  bubble(payload: AlertPayload): void
  /** 未读提醒数。面板的提醒日志用它，不再有托盘角标 */
  unread(count: number): void
  /** 状态点需要重推。`nextChangeAt` 非空时调用方要安排一次回落重推 */
  petState(nextChangeAt: number | null): void
}

export interface AlertServiceDeps {
  repo: AlertRepo
  sink: AlertSink
  settings: () => AppSettings
  quiet: () => QuietVerdict
  /** 最新报价，用于气泡与通知里的现价/涨跌（拿不到就退回 K 线收盘价） */
  quotes?: () => ReadonlyMap<SecCode, QuoteView>
  /** code → 名称。提醒日志要显示名称，而 alert_log 里只有代码 */
  nameOf?: (code: SecCode) => string
  dispatcher?: AlertDispatcher
  pet?: PetStateMachine
  newId?: () => string
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export interface DispatchSummary {
  decisions: AlertDecision[]
  delivered: number
  suppressed: number
}

export interface AlertService {
  readonly pet: PetStateMachine
  /** 跑一轮分发。`debounce` 在收盘确认轮要传 false（那时没有「连续 N 个 tick」可言） */
  handle(
    outcomes: readonly SignalOutcome[],
    ctx: { at: number; debounce: boolean; watchHits?: readonly WatchHit[] }
  ): DispatchSummary
  history(query: { code?: SecCode; from?: number; to?: number; limit?: number }): AlertRecord[]
  /** 空数组 = 全部已读 */
  markRead(ids: readonly string[], at: number): number
  unreadCount(): number
  /** 状态机随时间回落后重算用 */
  petStateAt(at: number): void
}

export function createAlertService(deps: AlertServiceDeps): AlertService {
  const {
    repo,
    sink,
    settings,
    quiet,
    quotes,
    nameOf = (code) => code,
    dispatcher = new AlertDispatcher(),
    pet = new PetStateMachine(),
    newId = () => randomUUID(),
    log = { info: () => {}, warn: () => {} },
  } = deps

  /**
   * 上一条已落库的裁决，按标的记（006_alert_repeat.sql）。
   *
   * 盘中每 30s 一轮都会对同一个持续中的信号造一次候选、被同键冷却挡一次，
   * 而**被丢弃的裁决照样要留痕**（docs/05 §4「不制造信息黑洞」）。两条加起来的后果是
   * 一条持续一上午的买入信号在日志里刷 200+ 行一模一样的东西，
   * 用户翻不动，真正发出去的那几条被淹掉。
   *
   * 所以：签名相同 → 把首行的 `repeat_count + 1`（信息一条不少，噪音没了）；
   * 签名不同 → 照常插一行。
   *
   * **这是内存态，重启后清空** → 重启后同一个持续状态会多留一行。可以接受，
   * 而且**不要**改成启动时去库里回捞上一条来对齐：那要在每轮 tick 的热路径上
   * 加一次查询，换来的只是省下一行日志。
   */
  const lastDecision = new Map<SecCode, { signature: string; rowId: string }>()

  /**
   * 判重签名。
   *
   * **`signalId` 必须在里面**：新信号就是新事件，哪怕文案一字不差也要新行 ——
   * 否则「早上那条买入」与「下午重新触发的那条买入」会被记成同一件事。
   * 得分不在里面（它每轮都抖，含它等于没有去重，与 signals.ts 的落库签名同一条纪律）。
   */
  function decisionSignature(decision: AlertDecision): string {
    return [
      decision.candidate.signalId,
      decision.level ?? '-',
      decision.channels.join(','),
      decision.reason ?? '-',
    ].join('|')
  }

  function rowOf(decision: AlertDecision, at: number): AlertRow {
    return {
      id: newId(),
      signalId: decision.candidate.signalId,
      // 被丢弃时记**它本来要发的**级别：「本想发 L3，被当日冷却挡了」比一个空值有用
      level: decision.level ?? decision.candidate.level,
      channels: decision.channels,
      suppressedReason: decision.reason,
      // ⚠ 这两列**刻意不进 `decisionSignature`**。
      // `blockedBy` 由 `reason` 唯一决定（文案变了签名本来就变），加进去是冗余；
      // 而 `wouldBlock` 会随时间自己变（冷却到期、小时配额滚出窗口），把它算进签名
      // 会让同一条裁决在结果完全没变的情况下反复落新行 —— 那正是 006 那次去重要解决的问题。
      // 代价是被去重的行保留**第一次**的 `wouldBlock`，聚合时按「候选出现次数」读即可。
      suppressedGate: decision.blockedBy,
      wouldBlock: decision.wouldBlock,
      readAt: null,
      createdAt: at,
    }
  }

  return {
    pet,

    handle(outcomes, ctx) {
      const app = settings()
      const prepared = buildAlerts(outcomes, {
        levelOffset: app.alertLevelOffset,
        ...(quotes ? { quotes: quotes() } : {}),
        at: ctx.at,
        // 观察点命中与信号走同一套闸门 —— 不新开分发路径（见 candidates.ts 的 watchHitAlert）
        ...(ctx.watchHits === undefined ? {} : { watchHits: ctx.watchHits }),
      })

      if (prepared.length === 0) {
        return { decisions: [], delivered: 0, suppressed: 0 }
      }

      const payloadOf = new Map<AlertCandidate, AlertPayload>(
        prepared.map((item) => [item.candidate, item.payload])
      )
      const verdict = quiet()
      const decisions = dispatcher.dispatch(
        prepared.map((item) => item.candidate),
        ctx.at,
        {
          quiet: verdict.quiet,
          ...(verdict.reason === undefined ? {} : { quietReason: verdict.reason }),
          debounce: ctx.debounce,
        }
      )

      // 先落库再执行渠道：渠道抛错时审计记录已经在了（顺序反过来会丢掉那一条）
      try {
        const fresh: AlertRow[] = []
        for (const decision of decisions) {
          const code = decision.candidate.code
          const signature = decisionSignature(decision)
          const previous = lastDecision.get(code)
          // bumpRepeat 返回 false = 那一行已经不在了（被裁剪掉），退回插新行 ——
          // 不能静默丢掉这一轮的裁决，那才是真的信息黑洞
          if (previous?.signature === signature && repo.bumpRepeat(previous.rowId, ctx.at)) continue
          const row = rowOf(decision, ctx.at)
          fresh.push(row)
          lastDecision.set(code, { signature, rowId: row.id })
        }
        repo.insertMany(fresh)
      } catch (error) {
        // 落库失败不该把提醒也一起吃掉 —— 但必须留痕（docs/02 §7）
        log.warn('[alert] alert_log 写入失败：', error)
      }

      let delivered = 0
      let bubble: AlertPayload | null = null
      let bubbleScore = -1

      for (const decision of decisions) {
        if (decision.level === null) continue
        delivered += 1
        const payload = payloadOf.get(decision.candidate)
        if (!payload) continue
        // 实际发出的级别可能被降级过，展示层要用降级后的
        const shown: AlertPayload = { ...payload, level: decision.level }

        pet.onAlert(decision.candidate.direction, ctx.at)

        if (decision.channels.includes('BUBBLE') && decision.candidate.score > bubbleScore) {
          bubbleScore = decision.candidate.score
          bubble = shown
        }
      }

      // 有候选但一条都没发出：够得上 WATCHING，够不上高优先级状态（闸门挡下的不点亮 EXCITED/ALERT）
      if (delivered === 0) pet.onActivity(ctx.at)
      if (bubble) sink.bubble(bubble)

      sink.unread(repo.unreadCount())
      sink.petState(pet.nextChangeAt(ctx.at))

      return { decisions, delivered, suppressed: decisions.length - delivered }
    },

    history(query) {
      return repo.query(query).map((row) => {
        const record: AlertRecord = {
          id: row.id,
          signalId: row.signalId,
          code: row.code,
          name: nameOf(row.code),
          createdAt: row.createdAt,
          direction: row.direction,
          score: row.score,
          regime: row.regime,
          stage: row.stage,
          headline: row.headline,
          level: row.level,
          channels: [...row.channels],
          read: row.readAt !== null,
          repeatCount: row.repeatCount ?? 1,
        }
        if (row.suppressedReason !== null) record.reason = row.suppressedReason
        if (row.lastAt !== null && row.lastAt !== undefined) record.lastAt = row.lastAt
        return record
      })
    },

    markRead(ids, at) {
      const changed = ids.length === 0 ? repo.markAllRead(at) : repo.markRead(ids, at)
      if (changed > 0) sink.unread(repo.unreadCount())
      return changed
    },

    unreadCount: () => repo.unreadCount(),

    petStateAt(at) {
      sink.petState(pet.nextChangeAt(at))
    },
  }
}
