/**
 * 内置占位皮肤。
 *
 * docs/06 §5：皮肤校验失败 → 回退默认皮肤并在面板提示，**不弹窗**。
 * 「回退」必须落到一个不依赖任何文件的常量上，否则默认皮肤本身损坏时会递归失败。
 *
 * 它没有图集（url 全为 null），渲染层据此画一个几何占位形状。
 * 命中区取 docs/09 §5 的示例值，覆盖占位形状的躯干。
 */

import { PET_ANIMATION_KEYS, type PetAnimation, type PetAnimationKey, type PetSkinView } from '@shared/ipc-types'

/** 与 docs/09 §3 的动画清单逐字一致；占位皮肤不播动画，但契约形状必须齐备 */
const CONTRACT: Record<PetAnimationKey, Omit<PetAnimation, 'url' | 'url2x' | 'sheet'>> = {
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

export function contractFor(key: PetAnimationKey): Omit<PetAnimation, 'url' | 'url2x' | 'sheet'> {
  return CONTRACT[key]
}

export function fallbackSkin(reason: string): PetSkinView {
  const states = {} as Record<PetAnimationKey, PetAnimation>
  for (const key of PET_ANIMATION_KEYS) {
    states[key] = { sheet: `${key}.png`, url: null, url2x: null, ...CONTRACT[key] }
  }
  return {
    id: 'fallback',
    name: '占位',
    canvas: { width: 200, height: 200 },
    anchor: { bubbleX: 100, bubbleY: 14 },
    hitRects: [{ x: 60, y: 70, w: 80, h: 110 }],
    states,
    fallback: true,
    fallbackReason: reason,
  }
}
