/**
 * 开机自启（src/main/auto-launch.ts）。
 *
 * 三条都是「少做一件事」的守卫，而少做的后果都不显眼：
 *   - 开发期不写注册表（否则注册进去的是裸 electron.exe，卸载也带不走）
 *   - 状态一致时不写（无条件写会覆盖用户在「任务管理器 → 启动」里的手动禁用）
 *   - 写失败不抛（组策略锁注册表时，后果应该只是不自启，不是设置保存失败）
 */

import { describe, expect, it, vi } from 'vitest'
import { autoLaunchAction, syncAutoLaunch, type AutoLaunchDeps } from '@main/auto-launch'

function deps(overrides: Partial<AutoLaunchDeps> = {}): {
  deps: AutoLaunchDeps
  writes: boolean[]
  warns: unknown[][]
} {
  const writes: boolean[] = []
  const warns: unknown[][] = []
  return {
    writes,
    warns,
    deps: {
      getOpenAtLogin: () => false,
      setOpenAtLogin: (value) => writes.push(value),
      packaged: true,
      log: { info: () => {}, warn: (...args) => warns.push(args) },
      ...overrides,
    },
  }
}

describe('autoLaunchAction', () => {
  it('未打包时什么都不做 —— 注册进去的会是裸 electron.exe', () => {
    expect(autoLaunchAction({ desired: true, current: false, packaged: false })).toEqual({
      skipped: 'unpackaged',
    })
  })

  it('与系统当前状态一致时不写', () => {
    expect(autoLaunchAction({ desired: true, current: true, packaged: true })).toEqual({
      skipped: 'already',
    })
    expect(autoLaunchAction({ desired: false, current: false, packaged: true })).toEqual({
      skipped: 'already',
    })
  })

  it('不一致才写，两个方向都写', () => {
    expect(autoLaunchAction({ desired: true, current: false, packaged: true })).toEqual({
      openAtLogin: true,
    })
    expect(autoLaunchAction({ desired: false, current: true, packaged: true })).toEqual({
      openAtLogin: false,
    })
  })
})

describe('syncAutoLaunch', () => {
  it('打开：写一次 true', () => {
    const h = deps()
    expect(syncAutoLaunch(true, h.deps)).toBe(true)
    expect(h.writes).toEqual([true])
  })

  it('已经是目标状态：一次都不写', () => {
    const h = deps({ getOpenAtLogin: () => true })
    expect(syncAutoLaunch(true, h.deps)).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('未打包：一次都不写，也不算失败', () => {
    const h = deps({ packaged: false })
    expect(syncAutoLaunch(true, h.deps)).toBe(false)
    expect(h.writes).toEqual([])
    expect(h.warns).toEqual([])
  })

  /**
   * 组策略锁住 Run 键是真实场景。这时正确的行为是留一条 warn 后继续 ——
   * 把异常抛出去会让 `patchSettings` 整个失败，用户改的其他设置一起存不下。
   */
  it('写失败不抛，留一条 warn', () => {
    const h = deps({
      setOpenAtLogin: () => {
        throw new Error('Access is denied')
      },
    })
    expect(() => syncAutoLaunch(true, h.deps)).not.toThrow()
    expect(syncAutoLaunch(true, h.deps)).toBe(false)
    expect(h.warns.length).toBeGreaterThan(0)
  })

  it('读当前状态失败也不抛', () => {
    const warn = vi.fn()
    const h = deps({
      getOpenAtLogin: () => {
        throw new Error('registry unavailable')
      },
      log: { info: () => {}, warn },
    })
    expect(syncAutoLaunch(false, h.deps)).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})
