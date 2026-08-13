/**
 * 全屏 / 专注助手探测（src/main/alerts/notification-state.ts）。
 *
 * 探测本身要起一个 PowerShell 子进程，所以这里全部用注入的假 `exec` 跑 ——
 * 要验的是**它周围的那层保护**，而那层才是会出事的地方：
 *   - 分发路径读的是缓存，绝不等子进程
 *   - TTL 内不重复起进程（30s 一轮 tick，起 30 个进程就是另一种打扰）
 *   - 连续失败后永久停用，并且停用后判为「可以提醒」而不是「一直静默」
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createNotificationStateProbe,
  encodedProbeCommand,
  isSilencing,
  parseNotificationState,
} from '@main/alerts/notification-state'

describe('parseNotificationState', () => {
  it('按 shellapi.h 的枚举顺序映射 1–7', () => {
    expect(parseNotificationState('1')).toBe('NOT_PRESENT')
    expect(parseNotificationState('3\r\n')).toBe('RUNNING_D3D_FULL_SCREEN')
    expect(parseNotificationState(' 5 ')).toBe('ACCEPTS_NOTIFICATIONS')
    expect(parseNotificationState('6')).toBe('QUIET_TIME')
  })

  it('认不出来的输出一律 UNKNOWN，不猜', () => {
    expect(parseNotificationState('')).toBe('UNKNOWN')
    expect(parseNotificationState('0')).toBe('UNKNOWN')
    expect(parseNotificationState('Add-Type : 无法加载类型')).toBe('UNKNOWN')
  })
})

describe('要静默的状态（docs/05 §4.4）', () => {
  it('全屏 / 演示 / 忙碌 / 专注助手 / 锁屏都静默', () => {
    expect(isSilencing('RUNNING_D3D_FULL_SCREEN')).toBe(true)
    expect(isSilencing('PRESENTATION_MODE')).toBe(true)
    expect(isSilencing('BUSY')).toBe(true)
    expect(isSilencing('QUIET_TIME')).toBe(true)
    expect(isSilencing('NOT_PRESENT')).toBe(true)
  })

  it('可提醒与探测不到都不静默', () => {
    expect(isSilencing('ACCEPTS_NOTIFICATIONS')).toBe(false)
    expect(isSilencing('UNKNOWN')).toBe(false)
  })
})

describe('探测脚本', () => {
  it('用 UTF-16LE base64 编码，解回来能看到那次 P/Invoke', () => {
    const decoded = Buffer.from(encodedProbeCommand(), 'base64').toString('utf16le')
    expect(decoded).toContain('SHQueryUserNotificationState')
    expect(decoded).toContain('shell32.dll')
  })
})

describe('缓存、TTL 与失败退避', () => {
  it('current() 在第一次刷新落地前是 UNKNOWN —— 分发路径不等子进程', async () => {
    const probe = createNotificationStateProbe({ exec: async () => '2', enabled: true, now: () => 0 })
    expect(probe.current()).toBe('UNKNOWN')
    await probe.refreshNow()
    expect(probe.current()).toBe('BUSY')
  })

  it('TTL 内不重复起进程', async () => {
    let clock = 0
    const exec = vi.fn(async () => '5')
    const probe = createNotificationStateProbe({ exec, enabled: true, now: () => clock, ttlMs: 15_000 })

    await probe.refreshNow()
    expect(exec).toHaveBeenCalledTimes(1)

    clock = 14_999
    probe.refresh()
    expect(exec).toHaveBeenCalledTimes(1)

    clock = 15_000
    probe.refresh()
    await probe.refreshNow()
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('并发调用只起一个进程（单飞）', async () => {
    const exec = vi.fn(async () => '5')
    const probe = createNotificationStateProbe({ exec, enabled: true, now: () => 0 })
    await Promise.all([probe.refreshNow(), probe.refreshNow(), probe.refreshNow()])
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('连续失败到上限后永久停用，并回到「可以提醒」', async () => {
    const warn = vi.fn()
    const exec = vi.fn(async () => {
      throw new Error('powershell 不可用')
    })
    let clock = 0
    const probe = createNotificationStateProbe({
      exec,
      enabled: true,
      now: () => clock,
      ttlMs: 0,
      maxFailures: 3,
      log: { info: () => {}, warn },
    })

    for (let i = 0; i < 3; i++) {
      clock += 1000
      await probe.refreshNow()
    }

    expect(probe.disabled).toBe(true)
    expect(probe.current()).toBe('UNKNOWN')
    expect(isSilencing(probe.current())).toBe(false)

    // 停用之后不再起进程 —— 反复重试只会每 15 秒起一个注定失败的进程
    const before = exec.mock.calls.length
    clock += 60_000
    probe.refresh()
    await probe.refreshNow()
    expect(exec.mock.calls.length).toBe(before)
    expect(warn).toHaveBeenCalled()
  })

  it('中途成功一次就把失败计数清零', async () => {
    let output = 'boom'
    let clock = 0
    const exec = vi.fn(async () => {
      if (output === 'boom') throw new Error('boom')
      return output
    })
    const probe = createNotificationStateProbe({
      exec,
      enabled: true,
      now: () => clock,
      ttlMs: 0,
      maxFailures: 3,
    })

    clock += 1
    await probe.refreshNow()
    clock += 1
    await probe.refreshNow()
    output = '4'
    clock += 1
    await probe.refreshNow()
    expect(probe.current()).toBe('PRESENTATION_MODE')

    output = 'boom'
    clock += 1
    await probe.refreshNow()
    clock += 1
    await probe.refreshNow()
    expect(probe.disabled).toBe(false)
  })

  it('非 Windows 平台一开始就是停用状态，一个进程都不起', async () => {
    const exec = vi.fn(async () => '2')
    const probe = createNotificationStateProbe({ exec, enabled: false })
    expect(probe.disabled).toBe(true)
    probe.refresh()
    await probe.refreshNow()
    expect(exec).not.toHaveBeenCalled()
  })
})
