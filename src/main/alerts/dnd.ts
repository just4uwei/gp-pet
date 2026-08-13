/**
 * 免打扰的**聚合**判定（docs/05 §4.4）。
 *
 * 五个来源各自独立，任一成立即静默：
 *
 * | 来源 | 从哪来 |
 * |---|---|
 * | 手动免打扰（双击 / 托盘 / 定时） | `AppController.quietUntilTs`（见 util/quiet.ts） |
 * | 静默时段 | `AppSettings.quietHours` |
 * | 锁屏 / 会话断开 | `powerMonitor` 的 lock-screen / unlock-screen |
 * | 全屏 / 演示 / 专注助手 | `SHQueryUserNotificationState`（见 notification-state.ts） |
 * | 系统未登录 / 屏保 | 同上（`NOT_PRESENT`） |
 *
 * **判定是纯函数**：输入全部由调用方给，不读时钟、不碰 Electron。理由与 src/core 相同 ——
 * 「23:00 之后是不是静默时段」「跨午夜的 22:00–07:00 怎么算」这种事必须能写成用例。
 *
 * 静默的结果**不是丢弃**，而是把 L2/L3 降为 L1（`AlertDispatcher` 的闸门④）：
 * 提醒仍然进面板与托盘角标，只是不发声、不弹窗。
 */

import { isQuiet } from '../util/quiet'
import { isSilencing, STATE_REASON, type NotificationState } from './notification-state'

export type QuietSource = 'MANUAL' | 'QUIET_HOURS' | 'LOCKED' | 'SYSTEM'

export interface QuietVerdict {
  quiet: boolean
  /** 写进 alert_log 与面板：用户要能理解「为什么刚才没弹」 */
  reason?: string
  source?: QuietSource
}

export interface QuietHourRange {
  /** 'HH:MM' */
  start: string
  end: string
}

export interface QuietInputs {
  now: number
  /** 手动免打扰的截止时刻，null = 未设 */
  manualUntil: number | null
  quietHours: readonly QuietHourRange[]
  /** AppSettings.respectFullscreen。关掉后系统态一律不静默 */
  respectFullscreen: boolean
  notificationState: NotificationState
  locked: boolean
}

/** 'HH:MM' → 自午夜起的分钟数。格式非法返回 null（schema 已校验过，这里只是不猜） */
export function minutesOfClock(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * 某时刻是否落在静默时段内。
 *
 * **跨午夜要单独处理**：22:00–07:00 这种写法在「start < end」的朴素比较下恒为假，
 * 而它恰恰是最常用的一条（睡觉时间）。start == end 视为整天静默。
 */
export function inQuietHours(now: number, ranges: readonly QuietHourRange[]): QuietHourRange | null {
  const at = new Date(now)
  const minute = at.getHours() * 60 + at.getMinutes()
  for (const range of ranges) {
    const start = minutesOfClock(range.start)
    const end = minutesOfClock(range.end)
    if (start === null || end === null) continue
    if (start === end) return range
    const hit = start < end ? minute >= start && minute < end : minute >= start || minute < end
    if (hit) return range
  }
  return null
}

/**
 * 五个来源合成一条裁决。
 *
 * 顺序即优先级，只影响**显示哪条原因**（都静默时哪个说法更有用），不影响结论。
 * 手动排第一：用户自己按下去的开关，不该被「检测到全屏」这种解释盖过。
 */
export function resolveQuiet(input: QuietInputs): QuietVerdict {
  if (isQuiet(input.manualUntil, input.now)) {
    return { quiet: true, reason: '手动免打扰', source: 'MANUAL' }
  }

  const range = inQuietHours(input.now, input.quietHours)
  if (range) {
    return { quiet: true, reason: `静默时段 ${range.start}–${range.end}`, source: 'QUIET_HOURS' }
  }

  if (input.locked) {
    return { quiet: true, reason: '屏幕已锁定', source: 'LOCKED' }
  }

  if (input.respectFullscreen && isSilencing(input.notificationState)) {
    return { quiet: true, reason: STATE_REASON[input.notificationState], source: 'SYSTEM' }
  }

  return { quiet: false }
}
