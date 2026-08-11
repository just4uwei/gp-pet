/**
 * 免打扰截止时间计算（docs/06 §4 右键菜单、C8 双击静默）。
 *
 * 语义只有一个截止时间戳：null = 未静默，数值 = 静默到该时刻。
 * 不用布尔值 + 单独的定时器，是因为定时器会在系统休眠/唤醒后漂移
 * （docs/02 §6 powerMonitor），而时间戳在唤醒后重新比较即可自愈。
 *
 * 注意：这里的「至收盘」是本地时钟的 15:00 占位。真正的收盘时刻要看交易日历
 * （节假日、半日市），那是 M1 的 Scheduler 的职责 —— 接上后本函数应改为接受收盘时刻参数。
 */

export type QuietPreset = 'min30' | 'hour2' | 'untilClose'

const MINUTE = 60_000

/** A 股连续竞价结束时间（docs/03 交易时段） */
export const MARKET_CLOSE_HOUR = 15
export const MARKET_CLOSE_MINUTE = 0

export function quietUntil(now: number, preset: QuietPreset): number {
  switch (preset) {
    case 'min30':
      return now + 30 * MINUTE
    case 'hour2':
      return now + 120 * MINUTE
    case 'untilClose': {
      const close = new Date(now)
      close.setHours(MARKET_CLOSE_HOUR, MARKET_CLOSE_MINUTE, 0, 0)
      // 已过收盘就静默到下一个自然日的收盘，而不是立刻失效
      if (close.getTime() <= now) close.setDate(close.getDate() + 1)
      return close.getTime()
    }
  }
}

/** 截止时间是否仍在生效。null 与已过期都视为未静默。 */
export function isQuiet(until: number | null, now: number): boolean {
  return until !== null && until > now
}
