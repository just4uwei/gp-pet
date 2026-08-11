/**
 * 皮肤加载（docs/06 §5、docs/09）。
 *
 * 职责边界：本模块只做「读 + 校验 + 解析 URL」，不碰 Electron、不碰窗口。
 * 渲染层永远拿不到文件路径，只拿到 res:// URL —— 这样沙箱化的渲染进程不需要文件系统权限。
 *
 * 失败一律回退到内置占位皮肤并附原因，绝不抛到调用方（docs/06 §5：不弹窗）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PET_ANIMATION_KEYS, type PetAnimation, type PetAnimationKey, type PetSkinView } from '@shared/ipc-types'
import { fallbackSkin } from './fallback'
import { SkinSchema } from './schema'

export interface SkinSource {
  /** 皮肤目录绝对路径，例如 <resources>/pet/marshal */
  dir: string
  /** 该目录对应的 res:// URL 前缀，例如 res://assets/pet/marshal */
  urlBase: string
}

/** 图集缺失的容忍度：缺 sheet 不致命（url 为 null，渲染层退化），缺 skin.json 或校验失败才回退整套皮肤 */
export function loadSkinFrom(id: string, source: SkinSource): PetSkinView {
  const manifestPath = join(source.dir, 'skin.json')
  const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const manifest = SkinSchema.parse(raw)

  const states = {} as Record<PetAnimationKey, PetAnimation>
  for (const key of PET_ANIMATION_KEYS) {
    const spec = manifest.states[key]
    const at1x = join(source.dir, spec.sheet)
    const sheet2x = spec.sheet.replace(/\.png$/i, '@2x.png')
    const at2x = join(source.dir, sheet2x)
    states[key] = {
      sheet: spec.sheet,
      frames: spec.frames,
      fps: spec.fps,
      loop: spec.loop,
      ...(spec.minHold === undefined ? {} : { minHold: spec.minHold }),
      url: existsSync(at1x) ? `${source.urlBase}/${spec.sheet}` : null,
      url2x: existsSync(at2x) ? `${source.urlBase}/${sheet2x}` : null,
    }
  }

  return {
    id,
    name: manifest.name,
    canvas: manifest.canvas,
    anchor: manifest.anchor,
    hitRects: manifest.hitRects,
    states,
    fallback: false,
  }
}

/**
 * 按 sources 顺序尝试加载，第一个成功的胜出。
 * 顺序即优先级：用户皮肤（%APPDATA%）在前，内置皮肤在后 —— 同名覆盖内置（docs/06 §5）。
 */
export function loadSkin(
  id: string,
  sources: readonly SkinSource[],
  onWarn?: (message: string) => void
): PetSkinView {
  const errors: string[] = []
  for (const source of sources) {
    try {
      return loadSkinFrom(id, source)
    } catch (err) {
      errors.push(`${source.dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const reason = `皮肤「${id}」不可用；${errors.join(' | ')}`
  onWarn?.(reason)
  return fallbackSkin(reason)
}
