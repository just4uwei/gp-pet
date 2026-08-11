import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from '@main/settings/schema'
import { SettingsStore } from '@main/settings/store'

describe('sanitizeSettings', () => {
  it('空输入即出厂默认值', () => {
    expect(sanitizeSettings(undefined).settings).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({}).repaired).toEqual([])
  })

  it('非对象整份回默认并留痕', () => {
    const result = sanitizeSettings([1, 2, 3])
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
    expect(result.repaired[0]?.field).toBe('(整份)')
  })

  it('坏字段单独回默认，好字段保留 —— 不因一项错误丢弃整份配置', () => {
    const result = sanitizeSettings({
      pollIntervalSec: 3, // 低于 10s 是对免费接口的滥用
      sensitivity: 'CONSERVATIVE', // 合法，应保留
      minimalMode: 'yes', // 类型错
    })
    expect(result.settings.pollIntervalSec).toBe(DEFAULT_SETTINGS.pollIntervalSec)
    expect(result.settings.sensitivity).toBe('CONSERVATIVE')
    expect(result.settings.minimalMode).toBe(false)
    expect(result.repaired.map((r) => r.field).sort()).toEqual(['minimalMode', 'pollIntervalSec'])
  })

  it('轮询频率上下界 10–120s', () => {
    expect(sanitizeSettings({ pollIntervalSec: 10 }).settings.pollIntervalSec).toBe(10)
    expect(sanitizeSettings({ pollIntervalSec: 120 }).settings.pollIntervalSec).toBe(120)
    expect(sanitizeSettings({ pollIntervalSec: 121 }).repaired).toHaveLength(1)
    expect(sanitizeSettings({ pollIntervalSec: 30.5 }).repaired).toHaveLength(1)
  })

  it('静默时段必须是 HH:MM', () => {
    const ok = sanitizeSettings({ quietHours: [{ start: '09:00', end: '17:30' }] })
    expect(ok.repaired).toEqual([])
    expect(ok.settings.quietHours).toHaveLength(1)
    expect(sanitizeSettings({ quietHours: [{ start: '9:00', end: '17:30' }] }).repaired).toHaveLength(1)
    expect(sanitizeSettings({ quietHours: [{ start: '25:00', end: '17:30' }] }).repaired).toHaveLength(1)
  })

  it('数据源优先级只认已实现的三个源，且不允许为空', () => {
    expect(sanitizeSettings({ providerPriority: ['sina', 'tencent'] }).settings.providerPriority).toEqual([
      'sina',
      'tencent',
    ])
    expect(sanitizeSettings({ providerPriority: [] }).repaired).toHaveLength(1)
    expect(sanitizeSettings({ providerPriority: ['xueqiu'] }).repaired).toHaveLength(1)
  })

  it('dataDir 缺省时不留 undefined 键', () => {
    expect('dataDir' in sanitizeSettings({}).settings).toBe(false)
    expect(sanitizeSettings({ dataDir: 'D:/gp' }).settings.dataDir).toBe('D:/gp')
    expect(sanitizeSettings({ dataDir: '' }).repaired).toHaveLength(1)
  })
})

describe('SettingsStore', () => {
  let dir: string
  let file: string
  const logs: string[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gp-settings-'))
    file = join(dir, 'settings.json')
    logs.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const store = (): SettingsStore => new SettingsStore(file, (m) => logs.push(m))

  it('文件不存在时静默用默认值（首次启动不是错误）', () => {
    expect(store().load()).toEqual(DEFAULT_SETTINGS)
    expect(logs).toEqual([])
  })

  it('坏 JSON 记一条日志后回默认值', () => {
    writeFileSync(file, '{ 这不是 json', 'utf8')
    expect(store().load()).toEqual(DEFAULT_SETTINGS)
    expect(logs.join()).toContain('读取失败')
  })

  it('patch 落盘，重新 load 能读回', () => {
    const first = store()
    first.load()
    const patched = first.patch({ pollIntervalSec: 60, minimalMode: true })
    expect(patched.pollIntervalSec).toBe(60)

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(persisted['pollIntervalSec']).toBe(60)
    expect(store().load().minimalMode).toBe(true)
  })

  it('非法补丁被忽略且不污染已有取值', () => {
    const s = store()
    s.load()
    s.patch({ pollIntervalSec: 60 })
    const after = s.patch({ pollIntervalSec: 1 } as Partial<{ pollIntervalSec: number }>)
    expect(after.pollIntervalSec).toBe(DEFAULT_SETTINGS.pollIntervalSec)
    expect(logs.join()).toContain('忽略非法补丁字段')
  })

  it('get 返回副本，外部改动不会渗回主进程状态', () => {
    const s = store()
    s.load()
    const snapshot = s.get()
    snapshot.quietHours.push({ start: '00:00', end: '01:00' })
    expect(s.get().quietHours).toEqual([])
  })

  it('写入失败不抛错（内存值继续生效）', () => {
    const broken = new SettingsStore(join(dir, 'no-such-dir', '\u0000bad', 'settings.json'), (m) =>
      logs.push(m)
    )
    broken.load()
    expect(() => broken.patch({ minimalMode: true })).not.toThrow()
    expect(broken.get().minimalMode).toBe(true)
    expect(logs.join()).toContain('写入失败')
  })
})
