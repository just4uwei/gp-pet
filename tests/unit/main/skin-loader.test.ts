import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PET_ANIMATION_KEYS, type PetAnimationKey } from '@shared/ipc-types'
import { fallbackSkin } from '@main/skin/fallback'
import { loadSkin, loadSkinFrom } from '@main/skin/loader'

/**
 * 用例刻意**不**读 resources/pet/ 下的真实皮肤。
 *
 * 美术资源是外包件、不在仓库里手搓（CLAUDE.md），一份干净的 clone 与 CI 环境里
 * 那些目录就是空的。把测试挂在资源上会让「资源没交付」表现成「加载器坏了」，
 * 而真正该覆盖的恰恰是缺资源时的降级行为。
 *
 * 图集的像素级验收（尺寸、alpha 二值、限色、@2x 严格 2 倍）是另一件事，
 * 属 docs/09 §9.1 的 `pnpm verify:assets`，不在单元测试里做。
 */

const scratch: string[] = []

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** 按 docs/09 §3 的跨皮肤契约造一份合法清单 */
function validManifest(): Record<string, unknown> {
  const contract: Record<PetAnimationKey, Record<string, unknown>> = {
    idle: { frames: 8, fps: 8, loop: true },
    blink: { frames: 4, fps: 12, loop: false },
    look: { frames: 10, fps: 8, loop: false },
    watching: { frames: 6, fps: 8, loop: true },
    excited: { frames: 12, fps: 12, loop: false, minHold: 3000 },
    alert: { frames: 10, fps: 10, loop: false, minHold: 3000 },
    sleepy: { frames: 6, fps: 4, loop: true },
    offline: { frames: 4, fps: 4, loop: true },
    shush: { frames: 6, fps: 10, loop: false, minHold: 1200 },
  }
  const states: Record<string, unknown> = {}
  for (const key of PET_ANIMATION_KEYS) {
    states[key] = { sheet: `${key}.png`, ...contract[key] }
  }
  return {
    name: '测试皮肤',
    canvas: { width: 200, height: 200 },
    anchor: { bubbleX: 100, bubbleY: 14 },
    hitRects: [
      { x: 86, y: 14, w: 28, h: 30 },
      { x: 80, y: 44, w: 40, h: 76 },
    ],
    states,
  }
}

/** 写出一个皮肤目录。sheets 决定哪些图集实际落盘（内容无关，加载器只判存在性） */
function makeSkinDir(manifest: unknown, sheets: string[] = []): string {
  const dir = tempDir('gp-skin-')
  writeFileSync(join(dir, 'skin.json'), JSON.stringify(manifest), 'utf-8')
  for (const sheet of sheets) {
    const nested = sheet.includes('/')
    if (nested) mkdirSync(join(dir, sheet.slice(0, sheet.lastIndexOf('/'))), { recursive: true })
    writeFileSync(join(dir, sheet), '')
  }
  return dir
}

describe('loadSkinFrom · 合法皮肤', () => {
  const dir = makeSkinDir(validManifest(), ['idle.png', 'idle@2x.png', 'alert.png'])
  const urlBase = 'res://assets/pet/test'
  const skin = loadSkinFrom('test', { dir, urlBase })

  it('九个动画 key 齐备 —— 缺一即整套作废（docs/09 §1.2 能力对等）', () => {
    expect(Object.keys(skin.states).sort()).toEqual([...PET_ANIMATION_KEYS].sort())
  })

  it('帧数与 fps 取自 skin.json，加载器不臆造默认值', () => {
    expect(skin.states.idle).toMatchObject({ frames: 8, fps: 8, loop: true })
    expect(skin.states.excited).toMatchObject({ frames: 12, fps: 12, loop: false, minHold: 3000 })
    expect(skin.states.offline).toMatchObject({ frames: 4, fps: 4, loop: true })
  })

  it('无 minHold 的动画不会被塞进一个假的 minHold', () => {
    expect(skin.states.idle.minHold).toBeUndefined()
  })

  it('图集解析为 res:// URL —— 渲染层拿不到文件路径', () => {
    expect(skin.states.idle.url).toBe(`${urlBase}/idle.png`)
    expect(skin.states.idle.url2x).toBe(`${urlBase}/idle@2x.png`)
    expect(skin.states.idle.url).not.toContain(dir)
  })

  it('@2x 缺失时单独置 null，不让渲染层去请求一个 404', () => {
    expect(skin.states.alert.url).toBe(`${urlBase}/alert.png`)
    expect(skin.states.alert.url2x).toBeNull()
  })

  it('图集整体缺失也不致命：url 为 null，皮肤本身仍然可用', () => {
    expect(skin.fallback).toBe(false)
    expect(skin.states.shush.url).toBeNull()
  })

  it('带出命中区，供渲染层做 C2 判定', () => {
    expect(skin.hitRects).toHaveLength(2)
    for (const rect of skin.hitRects) {
      expect(rect.w).toBeGreaterThan(0)
      expect(rect.h).toBeGreaterThan(0)
    }
  })

  it('sheet 位于子目录时 URL 用正斜杠拼接，不混入平台分隔符', () => {
    const manifest = validManifest()
    const states = manifest['states'] as Record<string, Record<string, unknown>>
    states['idle'] = { ...states['idle'], sheet: 'sheets/idle.png' }
    const nestedDir = makeSkinDir(manifest, ['sheets/idle.png'])
    const nested = loadSkinFrom('nested', { dir: nestedDir, urlBase: 'res://assets/pet/nested' })
    expect(nested.states.idle.url).toBe('res://assets/pet/nested/sheets/idle.png')
  })
})

describe('loadSkinFrom · 校验失败', () => {
  it('缺任一动画 key 即拒绝', () => {
    const manifest = validManifest()
    delete (manifest['states'] as Record<string, unknown>)['shush']
    const dir = makeSkinDir(manifest)
    expect(() => loadSkinFrom('broken', { dir, urlBase: 'res://assets/x' })).toThrow()
  })

  it('命中区为空即拒绝 —— 没有命中区的桌宠连双击静默都做不到', () => {
    const manifest = validManifest()
    manifest['hitRects'] = []
    const dir = makeSkinDir(manifest)
    expect(() => loadSkinFrom('broken', { dir, urlBase: 'res://assets/x' })).toThrow()
  })

  it('帧数非正整数即拒绝 —— 0 帧会让渲染层除零', () => {
    const manifest = validManifest()
    const states = manifest['states'] as Record<string, Record<string, unknown>>
    states['idle'] = { ...states['idle'], frames: 0 }
    const dir = makeSkinDir(manifest)
    expect(() => loadSkinFrom('broken', { dir, urlBase: 'res://assets/x' })).toThrow()
  })

  it('skin.json 不是合法 JSON 即拒绝', () => {
    const dir = tempDir('gp-skin-bad-')
    writeFileSync(join(dir, 'skin.json'), '{ 这不是 JSON', 'utf-8')
    expect(() => loadSkinFrom('broken', { dir, urlBase: 'res://assets/x' })).toThrow()
  })

  it('未知字段被忽略而非拒绝 —— 免得将来加字段把已交付的旧皮肤全判死', () => {
    const manifest = validManifest()
    manifest['futureField'] = { whatever: true }
    const dir = makeSkinDir(manifest)
    expect(() => loadSkinFrom('ok', { dir, urlBase: 'res://assets/x' })).not.toThrow()
  })
})

describe('loadSkin · 回退', () => {
  it('目录不存在时回退占位皮肤并给出原因，不抛给调用方（docs/06 §5：不弹窗）', () => {
    const warnings: string[] = []
    const skin = loadSkin(
      'nope',
      [{ dir: join(tmpdir(), 'gp-does-not-exist-ever'), urlBase: 'res://assets/x' }],
      (m) => warnings.push(m)
    )

    expect(skin.fallback).toBe(true)
    expect(skin.fallbackReason).toBeTruthy()
    expect(warnings).toHaveLength(1)
  })

  it('按 sources 顺序取第一个可用的 —— 用户皮肤同名覆盖内置（docs/06 §5）', () => {
    const builtin = makeSkinDir(validManifest(), ['idle.png'])
    const skin = loadSkin('shared-name', [
      { dir: tempDir('gp-empty-'), urlBase: 'res://assets/user' },
      { dir: builtin, urlBase: 'res://assets/builtin' },
    ])

    expect(skin.fallback).toBe(false)
    expect(skin.states.idle.url).toBe('res://assets/builtin/idle.png')
  })

  it('占位皮肤自身满足契约 —— 回退路径不能再次失败', () => {
    const skin = fallbackSkin('测试')
    expect(Object.keys(skin.states).sort()).toEqual([...PET_ANIMATION_KEYS].sort())
    expect(skin.hitRects.length).toBeGreaterThan(0)
    for (const key of PET_ANIMATION_KEYS) {
      expect(skin.states[key].url).toBeNull()
      expect(skin.states[key].frames).toBeGreaterThan(0)
      expect(skin.states[key].fps).toBeGreaterThan(0)
    }
  })

  it('占位皮肤的帧率契约与 docs/09 §3 一致', () => {
    const skin = fallbackSkin('测试')
    expect(skin.states.sleepy.fps).toBe(4) // C7 休市零开销
    expect(skin.states.offline.fps).toBe(4)
    expect(skin.states.excited.minHold).toBe(3000)
  })
})
