/**
 * 提醒编排（docs/05 §3–§6）—— 信号真正走向用户的**唯一**出口。
 *
 * ```
 * SignalOutcome[] ─▶ buildAlerts ─▶ AlertDispatcher（四道闸门）─┬─▶ alert_log（每一条裁决）
 *                                                              ├─▶ 桌宠 / 状态点（PET）
 *                                                              ├─▶ 托盘角标 + 闪烁（TRAY）
 *                                                              ├─▶ 气泡（BUBBLE）
 *                                                              └─▶ 系统通知（OS_NOTIFY）
 * ```
 *
 * ## 四条纪律
 *
 * 1. **每一条候选都写 alert_log**，包括被丢弃的（docs/05 §4「不制造信息黑洞」）。
 *    用户要能在提醒日志里回答「它是不是漏提醒了」。
 * 2. **一次最多弹一个气泡**：本轮得分最高的那条。气泡会互相替换而不是排队 ——
 *    排队意味着用户盯着一串过时提醒轮播，那比不弹更烦人。
 * 3. **渠道失败不影响记账**。通知发不出去（系统关了通知）时提醒仍算发过：
 *    面板与角标已经拿到它了，把整条判为失败会让它在下一轮重发。
 * 4. **不读时钟**：`at` 由调用方（tick）传入，与 AlertDispatcher / src/core 同一条纪律。
 *    「收盘 15:00 那一轮会不会重发」必须能写成用例。
 */

import { randomUUID } from 'node:crypto'
import type { SecCode } from '@core/types'
import type { AlertRecord, AlertPayload, AppSettings } from '@shared/ipc-types'
import type { SignalOutcome } from '../engine/signals'
import type { AlertRepo, AlertRow } from '../storage/repositories/alert'
import { buildAlerts, type QuoteView } from './candidates'
import { AlertDispatcher, type AlertCandidate, type AlertDecision } from './dispatcher'
import type { QuietVerdict } from './dnd'
import { PetStateMachine } from './pet-state'

/** 渠道执行端。controller 实现它 —— 这一层不认识 BrowserWindow 与 Tray */
export interface AlertSink {
  /** L2+：弹气泡（一次一个，本轮得分最高的那条） */
  bubble(payload: AlertPayload): void
  /** L3：系统通知。`sound` 已经把 C5「默认无声」与用户设置算进去了 */
  notify(payload: AlertPayload, sound: boolean): void
  /** L3：托盘图标闪烁 */
  flash(): void
  /** 托盘角标：未读提醒数 */
  unread(count: number): void
  /** 桌宠 / 状态点需要重推。`nextChangeAt` 非空时调用方要安排一次回落重推 */
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
  handle(outcomes: readonly SignalOutcome[], ctx: { at: number; debounce: boolean }): DispatchSummary
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

  function rowOf(decision: AlertDecision, at: number): AlertRow {
    return {
      id: newId(),
      signalId: decision.candidate.signalId,
      // 被丢弃时记**它本来要发的**级别：「本想发 L3，被当日冷却挡了」比一个空值有用
      level: decision.level ?? decision.candidate.level,
      channels: decision.channels,
      suppressedReason: decision.reason,
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
        repo.insertMany(decisions.map((decision) => rowOf(decision, ctx.at)))
      } catch (error) {
        // 落库失败不该把提醒也一起吃掉 —— 但必须留痕（docs/02 §7）
        log.warn('[alert] alert_log 写入失败：', error)
      }

      let delivered = 0
      let bubble: AlertPayload | null = null
      let bubbleScore = -1
      let flashed = false

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
        if (decision.channels.includes('OS_NOTIFY')) {
          // C5：默认无声。只有用户显式开启且真的是 L3 才响
          sink.notify(shown, app.soundEnabled && decision.level === 'L3')
          if (!flashed) {
            flashed = true
            sink.flash()
          }
        }
      }

      // 有候选但一条都没发出：够得上 WATCHING，够不上表情（闸门挡下的不点亮 EXCITED/ALERT）
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
        }
        if (row.suppressedReason !== null) record.reason = row.suppressedReason
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
