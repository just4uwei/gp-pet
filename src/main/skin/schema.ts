/**
 * skin.json 的 schema（结构见 docs/06 §5，取值要求见 docs/09 §5）。
 *
 * 九个动画 key 全部 required —— 这是 docs/09 §1.2 的「能力对等原则」：
 * 缺任何一个，整套皮肤作废并回退默认皮肤，而不是让某个状态默默播不出动画。
 *
 * 刻意**不**用 strict 模式：skin.json 里出现未知字段时忽略而非报错，
 * 免得未来给 schema 加字段把已交付的旧皮肤全部判死。
 */

import { z } from 'zod'
import { PET_ANIMATION_KEYS } from '@shared/ipc-types'

const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
})

const AnimationSchema = z.object({
  sheet: z.string().min(1),
  frames: z.number().int().positive(),
  fps: z.number().positive(),
  loop: z.boolean(),
  minHold: z.number().positive().optional(),
})

const statesShape = Object.fromEntries(
  PET_ANIMATION_KEYS.map((key) => [key, AnimationSchema])
) as Record<(typeof PET_ANIMATION_KEYS)[number], typeof AnimationSchema>

export const SkinSchema = z.object({
  name: z.string().min(1),
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  anchor: z.object({
    bubbleX: z.number(),
    bubbleY: z.number(),
  }),
  // 至少一个命中区，否则桌宠整体不可点击（连 C8 的双击都做不到）
  hitRects: z.array(RectSchema).min(1),
  states: z.object(statesShape),
})

export type SkinManifest = z.infer<typeof SkinSchema>
