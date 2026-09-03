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

/**
 * 用户自己的交易费率（017）。**settings.json 里没有编辑框对应的入口** ——
 * 它由「校正成本」反解写入（`CostCalibration`）。但文件是用户可以手改的，
 * 所以照样要逐项校验。
 *
 * 上界不是洁癖，是防手滑：把「万 2.5」当成「2.5」填进去（差 10000 倍）会让
 * 每一笔买入的成本价变成天文数字，而那个数会一路进止损线 ——
 * 有上界时它回退到默认值并留一行痕，没有上界时它静默生效。
 *
 * 下界一律 `min(0)` 而不是 `positive()`：**0 都是合法取值** ——
 * 券商可以免最低佣金，场内基金本来就免印花税与过户费。
 *
 * `COMMISSION_RATE_MAX` 同时是反解的搜索上界，两处必须是同一个数：
 * schema 放过一个反解够不到的值，会让「手改 settings.json → 校正一次 → 数字回跳」
 * 变成一个查不清的现象。
 */
export const COMMISSION_RATE_MAX = 0.005

const TradeFeeRatesSchema = z.object({
  // 千 5 已经比 2000 年代的水平还高，真实档位在万 0.85 ~ 万 3
  commissionRate: z
    .number()
    .min(0)
    .max(COMMISSION_RATE_MAX, '佣金率不该超过千分之五，检查一下是不是多了几个 0'),
  minCommission: z.number().min(0).max(100, '单笔最低佣金不该超过 100 元'),
  stampTaxRate: z.number().min(0).max(0.005, '印花税率不该超过千分之五'),
  transferFeeRate: z.number().min(0).max(0.001, '过户费率不该超过万分之十'),
})

/** 费率的来路。整块坏掉时只丢来路、不丢费率（见 `AppSettings.tradeCostsSource`） */
const TradeFeeSourceSchema = z.object({
  code: z.string().min(1),
  targetFeeTotal: z.number().min(0),
  throughMs: z.number().int().positive(),
  commissionRate: z.number().min(0).max(COMMISSION_RATE_MAX),
  minCommission: z.number().min(0).max(100),
  at: z.number().int().positive(),
})

export const AppSettingsSchema = z.object({
  // 10–120s：低于 10s 对免费接口是滥用（docs/03 §2.4）
  pollIntervalSec: z.number().int().min(10).max(120),
  tradeCosts: TradeFeeRatesSchema,
  tradeCostsSource: TradeFeeSourceSchema.optional(),
  sensitivity: z.enum(['SENSITIVE', 'BALANCED', 'CONSERVATIVE']),
  alertLevelOffset: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  quietHours: z.array(z.object({ start: TimeSchema, end: TimeSchema })),
  respectFullscreen: z.boolean(),
  providerPriority: z.array(z.enum(['eastmoney', 'sina', 'tencent'])).min(1),
  autoLaunch: z.boolean(),
  dataDir: z.string().min(1).optional(),
  // 免责声明确认时刻。正整数毫秒 —— 0 或负数按「没确认过」处理，会再弹一次引导，
  // 那比信一个明显坏掉的时间戳安全（多看一次声明的代价远小于漏看）
  disclaimerAcceptedAt: z.number().int().positive().optional(),
})

export const DEFAULT_SETTINGS: AppSettings = {
  pollIntervalSec: 30,
  /*
    出厂费率**逐位等于** `backtest/costs.ts` 的 `DEFAULT_COSTS` 对应四项
    ⇒ 没校正过的用户，账本行为一个字不变。

    ⚠ 这里刻意**写字面量而不是 import `DEFAULT_COSTS`**：那份是回测与影子的固定假设，
    两者从此是两个独立的数（见 `TradeFeeRates` 头注释）。import 会造出一条
    「改了回测假设就悄悄改了所有用户的账本费率」的耦合，而它谁都不会想到去查。
    `tests/unit/main/settings.test.ts` 有一条用例钉着两者眼下相等 ——
    它变红是提醒你「两份数分叉了，确认是有意的」，不是让你把这里改成 import。
  */
  tradeCosts: {
    commissionRate: 0.00025,
    minCommission: 5,
    stampTaxRate: 0.001,
    transferFeeRate: 0.00001,
  },
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

  // 可选字段缺省时不要留一个 undefined 键：
  // exactOptionalPropertyTypes 下它与「没有这个键」不等价
  if (settings.dataDir === undefined) delete settings.dataDir
  if (settings.disclaimerAcceptedAt === undefined) delete settings.disclaimerAcceptedAt
  if (settings.tradeCostsSource === undefined) delete settings.tradeCostsSource

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
