/**
 * 个人配置的导入导出（备份 / 换机器）。
 *
 * 「个人配置」= **只有用户自己能产生、丢了就得重来一遍的东西**：
 * settings.json、自选股（含分组与排序）、手工录入的持仓。
 * 日线、指标、信号、提醒日志一概不导 —— 它们是可再生的派生物，
 * 而且带到另一台机器上会与本机行情对不上（提醒日志里写的是「那台机器当时发没发」）。
 *
 * ## 三条纪律
 *
 * 1. **解析不是全有全无。** 与 `sanitizeSettings()` 同一取向（见 schema.ts）：
 *    坏字段退回默认值、坏行丢掉并留一条 warning，而不是整份拒绝 ——
 *    一个手改坏的持仓行不该让 40 只自选一起导不进来。warning 必须回到界面上，
 *    不允许静默吞掉（docs/02 §7）。
 * 2. **持仓有外键指向自选**（`foreign_keys = ON`）。所以持仓行只在其代码同时出现在
 *    导入的自选里时才写；否则丢弃并留 warning。顺序也必须是先自选后持仓。
 * 3. **本模块不碰 Electron、不碰文件系统、不读时钟。** 时间与仓储由调用方传入，
 *    这样「覆盖导入把旧自选清干净了没有」能写成用例，而不是靠手工点一遍。
 */

import { z } from 'zod'
import { isSTName } from '@core/code'
import type { SecCode, SecProfile } from '@core/types'
import type { AppSettings } from '@shared/ipc-types'
import { sanitizeSettings } from './schema'
import type { AppSettingsSchema } from './schema'

/**
 * 文件头。改了不兼容的结构就升 version，读的时候按 version 分支。
 *
 * **`gp-pet-config` 这个字符串不跟着产品改名走**（2026-08-14 改名「蹲点」时刻意留下）：
 * 它是导出文件里的兼容标记，改掉等于让改名前导出的每一份配置都被判成
 * 「这不是蹲点的配置文件」，而那条报错的本意是拦住「压根不是本应用的文件」。
 */
export const CONFIG_BUNDLE_FORMAT = 'gp-pet-config'
export const CONFIG_BUNDLE_VERSION = 1

export interface ConfigWatchEntry {
  code: SecCode
  name: string
  market: 'SH' | 'SZ' | 'BJ'
  board: 'MAIN' | 'GEM' | 'STAR' | 'BSE' | 'ETF' | 'INDEX'
  industry?: string
  group: string
  sortOrder: number
  createdAt: number
}

export interface ConfigPositionEntry {
  code: SecCode
  shares: number
  cost: number
  peakPrice: number
  openedAt: number
}

export interface ConfigBundle {
  format: typeof CONFIG_BUNDLE_FORMAT
  version: number
  exportedAt: number
  appVersion: string
  settings: AppSettings
  watchlist: ConfigWatchEntry[]
  positions: ConfigPositionEntry[]
}

// ── 校验 ──────────────────────────────────────────────────────────────

const WatchEntrySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  market: z.enum(['SH', 'SZ', 'BJ']),
  board: z.enum(['MAIN', 'GEM', 'STAR', 'BSE', 'ETF', 'INDEX']),
  industry: z.string().min(1).optional(),
  group: z.string().min(1),
  sortOrder: z.number().int().min(0),
  createdAt: z.number().int().min(0),
})

const PositionEntrySchema = z.object({
  code: z.string().min(1),
  shares: z.number().int().positive(),
  cost: z.number().positive(),
  peakPrice: z.number().positive(),
  openedAt: z.number().int().min(0),
})

/** 顶层只校验到「能不能往下走」；settings 交给 sanitizeSettings 逐字段修 */
const EnvelopeSchema = z.object({
  format: z.literal(CONFIG_BUNDLE_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.number().int().min(0).optional(),
  appVersion: z.string().optional(),
  settings: z.unknown().optional(),
  watchlist: z.array(z.unknown()).optional(),
  positions: z.array(z.unknown()).optional(),
})

export interface ParsedConfigBundle {
  bundle: ConfigBundle
  /** 被修复或丢弃的内容，逐条回到界面上 —— 不静默 */
  warnings: string[]
}

// ── 导出 ──────────────────────────────────────────────────────────────

export interface ConfigExportInput {
  settings: AppSettings
  watchlist: readonly ConfigWatchEntry[]
  positions: readonly ConfigPositionEntry[]
  now: number
  appVersion: string
}

export function buildConfigBundle(input: ConfigExportInput): ConfigBundle {
  return {
    format: CONFIG_BUNDLE_FORMAT,
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: input.now,
    appVersion: input.appVersion,
    settings: structuredClone(input.settings),
    // 排序按 sortOrder 落地：导入端照这个顺序重建，用户排好的次序不能在往返中丢
    watchlist: [...input.watchlist].sort((a, b) => a.sortOrder - b.sortOrder),
    positions: [...input.positions],
  }
}

export function serializeConfigBundle(bundle: ConfigBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

// ── 导入 ──────────────────────────────────────────────────────────────

/**
 * 解析一份导出文件。
 *
 * 抛错只在「这压根不是本应用的配置文件」时发生 —— 那种情况继续往下走只会
 * 把用户的自选清空成 0 条。其余问题一律降级成 warning。
 */
export function parseConfigBundle(raw: unknown): ParsedConfigBundle {
  const envelope = EnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    throw new Error('这不是蹲点的配置文件（缺少 format 标记或结构不符）')
  }
  if (envelope.data.version > CONFIG_BUNDLE_VERSION) {
    throw new Error(
      `配置文件版本 ${envelope.data.version} 比当前应用（${CONFIG_BUNDLE_VERSION}）新，请先升级蹲点`
    )
  }

  const warnings: string[] = []

  const { settings, repaired } = sanitizeSettings(envelope.data.settings)
  for (const item of repaired) {
    warnings.push(`设置 ${item.field} 已回到默认值：${item.reason}`)
  }
  if (envelope.data.settings === undefined) {
    warnings.push('文件里没有设置项，设置保持不变')
  }

  const watchlist: ConfigWatchEntry[] = []
  const seen = new Set<string>()
  for (const [index, row] of (envelope.data.watchlist ?? []).entries()) {
    const parsed = WatchEntrySchema.safeParse(row)
    if (!parsed.success) {
      warnings.push(`自选第 ${index + 1} 行已丢弃：${parsed.error.issues[0]?.message ?? '格式不符'}`)
      continue
    }
    if (seen.has(parsed.data.code)) {
      warnings.push(`自选 ${parsed.data.code} 重复出现，只保留第一条`)
      continue
    }
    seen.add(parsed.data.code)
    const entry: ConfigWatchEntry = {
      code: parsed.data.code,
      name: parsed.data.name,
      market: parsed.data.market,
      board: parsed.data.board,
      group: parsed.data.group,
      sortOrder: parsed.data.sortOrder,
      createdAt: parsed.data.createdAt,
    }
    // exactOptionalPropertyTypes：没有行业就不要这个键，而不是塞 undefined
    if (parsed.data.industry !== undefined) entry.industry = parsed.data.industry
    watchlist.push(entry)
  }
  watchlist.sort((a, b) => a.sortOrder - b.sortOrder)

  const positions: ConfigPositionEntry[] = []
  for (const [index, row] of (envelope.data.positions ?? []).entries()) {
    const parsed = PositionEntrySchema.safeParse(row)
    if (!parsed.success) {
      warnings.push(`持仓第 ${index + 1} 行已丢弃：${parsed.error.issues[0]?.message ?? '格式不符'}`)
      continue
    }
    // position.code 外键指向 watchlist：不在自选里的持仓写不进去，先丢掉并说明
    if (!seen.has(parsed.data.code)) {
      warnings.push(`持仓 ${parsed.data.code} 不在导入的自选里，已丢弃`)
      continue
    }
    positions.push({
      code: parsed.data.code,
      shares: parsed.data.shares,
      cost: parsed.data.cost,
      // 持有期最高价至少是成本价（与 PositionRepo 的兜底同一口径）
      peakPrice: Math.max(parsed.data.peakPrice, parsed.data.cost),
      openedAt: parsed.data.openedAt,
    })
  }

  return {
    bundle: {
      format: CONFIG_BUNDLE_FORMAT,
      version: envelope.data.version,
      exportedAt: envelope.data.exportedAt ?? 0,
      appVersion: envelope.data.appVersion ?? '未知',
      settings,
      watchlist,
      positions,
    },
    warnings,
  }
}

// ── 覆盖写入 ──────────────────────────────────────────────────────────

/** WatchlistRepo 结构上就满足它 */
export interface ConfigWatchlistStore {
  codes(): SecCode[]
  remove(code: SecCode): boolean
  add(profile: SecProfile, group: string, now: number): unknown
  reorder(codes: SecCode[]): void
}

/** PositionRepo 结构上就满足它 */
export interface ConfigPositionStore {
  codes(): Set<SecCode>
  clear(code: SecCode): boolean
  set(code: SecCode, shares: number, cost: number, now: number): void
  bumpPeak(code: SecCode, price: number): void
}

export interface ConfigApplyStores {
  watchlist: ConfigWatchlistStore
  positions: ConfigPositionStore
}

export interface ConfigApplyResult {
  watchlist: number
  positions: number
  /** 被清掉的旧数据条数，供确认框与结果提示如实报数 */
  removedWatchlist: number
  removedPositions: number
}

/**
 * 覆盖式导入：整份替换自选与持仓（设置由调用方另行 patch —— 那一步有换肤/换形态的副作用）。
 *
 * 顺序是有讲究的：**先清持仓再清自选**（外键），**先写自选再写持仓**（同一个外键）。
 * `WatchlistRepo.remove()` 自带前一半，这里仍显式清一遍持仓，
 * 因为「自选被删干净了但持仓表还剩几行」在别的实现下就会发生。
 */
export function applyConfigBundle(bundle: ConfigBundle, stores: ConfigApplyStores): ConfigApplyResult {
  const oldPositions = [...stores.positions.codes()]
  for (const code of oldPositions) stores.positions.clear(code)

  const oldWatch = stores.watchlist.codes()
  for (const code of oldWatch) stores.watchlist.remove(code)

  for (const entry of bundle.watchlist) {
    const profile: SecProfile = {
      code: entry.code,
      name: entry.name,
      market: entry.market,
      board: entry.board,
      // isST 是从名称推出来的，不进文件：导出时的 ST 状态到导入时可能已经摘帽
      isST: isSTName(entry.name),
    }
    if (entry.industry !== undefined) profile.industry = entry.industry
    stores.watchlist.add(profile, entry.group, entry.createdAt)
  }
  // add() 按插入顺序发号，但用户排好的次序必须原样还原，显式重排一次更稳
  stores.watchlist.reorder(bundle.watchlist.map((entry) => entry.code))

  for (const held of bundle.positions) {
    stores.positions.set(held.code, held.shares, held.cost, held.openedAt)
    // set() 把 peak_price 置为成本价，持有期最高价要单独抬上去（bumpPeak 只升不降）
    stores.positions.bumpPeak(held.code, held.peakPrice)
  }

  return {
    watchlist: bundle.watchlist.length,
    positions: bundle.positions.length,
    removedWatchlist: oldWatch.length,
    removedPositions: oldPositions.length,
  }
}

// 编译期守卫：settings 块的形状必须与 AppSettingsSchema 一致。
// 加了设置字段却忘了让导出带上它，会让「导入后设置回到默认值」这种事静默发生
type BundleSettings = ConfigBundle['settings']
export const _BUNDLE_SETTINGS_MATCHES_SCHEMA: BundleSettings extends z.infer<typeof AppSettingsSchema>
  ? true
  : false = true
