/**
 * 免打扰聚合（src/main/alerts/dnd.ts，docs/05 §4.4）。
 *
 * 这一层是「为什么刚才没弹」的唯一答案来源，所以每条用例都盯着一个具体的误判：
 *   - 跨午夜的静默时段（22:00–07:00）是最常用的一条，也是朴素比较必错的一条
 *   - 手动开关要压过系统探测的说法，否则用户看到「全屏应用运行中」会以为不是自己关的
 *   - `respectFullscreen` 关掉之后系统态不许再静默 —— 那是个开关，不是建议
 *   - 探测不到（UNKNOWN）时**照常提醒**：多发会被抱怨，漏发用户发现不了
 */

import { describe, expect, it } from 'vitest'
import { inQuietHours, minutesOfClock, resolveQuiet, type QuietInputs } from '@main/alerts/dnd'

/** 本地时间构造，静默时段判定用的是墙上时钟 */
function at(hour: number, minute = 0): number {
  return new Date(2026, 7, 13, hour, minute, 0, 0).getTime()
}

function inputs(overrides: Partial<QuietInputs> = {}): QuietInputs {
  return {
    now: at(10, 30),
    manualUntil: null,
    quietHours: [],
    respectFullscreen: true,
    notificationState: 'ACCEPTS_NOTIFICATIONS',
    locked: false,
    ...overrides,
  }
}

describe('minutesOfClock', () => {
  it('解析 HH:MM', () => {
    expect(minutesOfClock('00:00')).toBe(0)
    expect(minutesOfClock('09:30')).toBe(570)
    expect(minutesOfClock('23:59')).toBe(1439)
  })

  it('格式非法返回 null 而不是猜一个数', () => {
    expect(minutesOfClock('24:00')).toBeNull()
    expect(minutesOfClock('9:30')).toBeNull()
    expect(minutesOfClock('')).toBeNull()
  })
})

describe('静默时段（docs/05 §4.4）', () => {
  const night = [{ start: '22:00', end: '07:00' }]

  it('跨午夜的时段两侧都要命中 —— 朴素的 start<end 比较在这里恒为假', () => {
    expect(inQuietHours(at(23, 0), night)).not.toBeNull()
    expect(inQuietHours(at(2, 0), night)).not.toBeNull()
    expect(inQuietHours(at(6, 59), night)).not.toBeNull()
  })

  it('跨午夜时段的外面不命中', () => {
    expect(inQuietHours(at(7, 0), night)).toBeNull()
    expect(inQuietHours(at(12, 0), night)).toBeNull()
    expect(inQuietHours(at(21, 59), night)).toBeNull()
  })

  it('同日时段按左闭右开', () => {
    const lunch = [{ start: '11:30', end: '13:00' }]
    expect(inQuietHours(at(11, 30), lunch)).not.toBeNull()
    expect(inQuietHours(at(12, 59), lunch)).not.toBeNull()
    expect(inQuietHours(at(13, 0), lunch)).toBeNull()
  })

  it('start == end 视为整天静默', () => {
    expect(inQuietHours(at(3, 0), [{ start: '09:00', end: '09:00' }])).not.toBeNull()
  })

  it('坏格式的那一条被跳过，不影响同数组里正确的那条', () => {
    const ranges = [
      { start: '99:99', end: '07:00' },
      { start: '10:00', end: '11:00' },
    ]
    expect(inQuietHours(at(10, 30), ranges)?.start).toBe('10:00')
  })
})

describe('resolveQuiet 的优先级与开关', () => {
  it('手动免打扰压过系统探测 —— 否则用户看到的原因不是自己按的那个开关', () => {
    const verdict = resolveQuiet(
      inputs({ manualUntil: at(11, 0), notificationState: 'RUNNING_D3D_FULL_SCREEN' })
    )
    expect(verdict.quiet).toBe(true)
    expect(verdict.source).toBe('MANUAL')
  })

  it('手动截止时间已过就不再算数', () => {
    expect(resolveQuiet(inputs({ manualUntil: at(10, 29) })).quiet).toBe(false)
  })

  it('锁屏静默，且原因写明是锁屏', () => {
    const verdict = resolveQuiet(inputs({ locked: true }))
    expect(verdict.quiet).toBe(true)
    expect(verdict.reason).toContain('锁定')
  })

  it.each(['BUSY', 'RUNNING_D3D_FULL_SCREEN', 'PRESENTATION_MODE', 'QUIET_TIME', 'NOT_PRESENT'] as const)(
    '系统态 %s 要静默',
    (state) => {
      expect(resolveQuiet(inputs({ notificationState: state })).quiet).toBe(true)
    }
  )

  it('respectFullscreen 关掉后系统态一律不静默', () => {
    const verdict = resolveQuiet(
      inputs({ respectFullscreen: false, notificationState: 'PRESENTATION_MODE' })
    )
    expect(verdict.quiet).toBe(false)
  })

  it('探测不到（UNKNOWN）时照常提醒 —— 少发的错误用户发现不了', () => {
    expect(resolveQuiet(inputs({ notificationState: 'UNKNOWN' })).quiet).toBe(false)
  })

  it('什么都没成立时不带原因', () => {
    const verdict = resolveQuiet(inputs())
    expect(verdict).toEqual({ quiet: false })
  })
})
