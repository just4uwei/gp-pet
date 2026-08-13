/**
 * settings.json 的 schema 与出厂默认值（docs/03 §4.1）。
 *
 * 配置用 JSON 而非入库：用户可直接编辑、可备份、出问题时能手工修复。
 * 代价是文件可能被改坏 —— 所以启动时逐字段校验，坏字段单独退回默认值并留痕，
 * 而不是整份丢弃（把用户改对的九项一起清掉，比那一项改错更烦人）。
 */

import { z } from 'zod'
import type { AppSettings } from '@shared/ipc-types'

/** 'HH:MM' */
const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间格式应为 HH:MM')

export const AppSettingsSchema = z.object({
  // 10–120s：低于 10s 对免费接口是滥用（docs/03 §2.4）
  pollIntervalSec: z.number().int().min(10).max(120),
  sensitivity: z.enum(['SENSITIVE', 'BALANCED', 'CONSERVATIVE']),
  alertLevelOffset: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  quietHours: z.array(z.object({ start: TimeSchema, end: TimeSchema })),
  respectFullscreen: z.boolean(),
  providerPriority: z.array(z.enum(['eastmoney', 'sina', 'tencent'])).min(1),
  autoLaunch: z.boolean(),
  dataDir: z.string().min(1).optional(),
})

export const DEFAULT_SETTINGS: AppSettings = {
  pollIntervalSec: 30,
  sensitivity: 'BALANCED',
  alertLevelOffset: 0,
  quietHours: [],
  respectFullscreen: true,
  // 顺序即降级顺序（docs/03 §2.2、ADR-0002）：主源在前
  providerPriority: ['eastmoney', 'tencent', 'sina'],
  autoLaunch: false,
}

export interface SanitizeResult {
  settings: AppSettings
  /** 被退回默认值的字段及原因，供日志与面板展示 —— 不静默（docs/02 §7） */
  repaired: { field: string; reason: string }[]
}

/**
 * 逐字段校验：坏字段回默认值，好字段保留。
 * 整份 parse 失败就整份丢弃是最省事的写法，但对手改配置的用户最不友好。
 */
export function sanitizeSettings(raw: unknown): SanitizeResult {
  const repaired: SanitizeResult['repaired'] = []
  const input: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object) } : {}

  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    repaired.push({ field: '(整份)', reason: 'settings.json 不是一个对象，已全部回到默认值' })
  }

  const settings = { ...DEFAULT_SETTINGS }
  const shape = AppSettingsSchema.shape

  for (const key of Object.keys(shape) as (keyof AppSettings)[]) {
    if (!(key in input)) continue
    const field = shape[key]
    const result = field.safeParse(input[key])
    if (result.success) {
      // 逐字段赋值，类型由上面的 schema 与 AppSettings 对齐保证
      ;(settings as Record<string, unknown>)[key] = result.data
    } else {
      repaired.push({ field: key, reason: result.error.issues[0]?.message ?? '取值非法' })
    }
  }

  // dataDir 缺省时不要留一个 undefined 键：exactOptionalPropertyTypes 下它与「没有这个键」不等价
  if (settings.dataDir === undefined) delete settings.dataDir

  return { settings, repaired }
}

// 编译期把 zod 的推断形状与 AppSettings 钉在一起：
// 任一侧加字段而另一侧忘了，typecheck 立刻失败
type SchemaShape = z.infer<typeof AppSettingsSchema>

/**
 * 可选字段里的 `| undefined` 在两侧写法不同：zod 的 `.optional()` 推断成
 * `dataDir?: string | undefined`，而 AppSettings 写的是 `dataDir?: string`。
 * exactOptionalPropertyTypes 下这两者互不可赋值 —— 那是写法差异，不是契约差异，
 * 先归一化再比，否则这道守卫会永远红着，反而没人敢改它。
 */
type Normalized<T> = { [K in keyof T]: Exclude<T[K], undefined> }

export const _SCHEMA_MATCHES_SETTINGS: Normalized<SchemaShape> extends Normalized<AppSettings>
  ? Normalized<AppSettings> extends Normalized<SchemaShape>
    ? true
    : false
  : false = true
