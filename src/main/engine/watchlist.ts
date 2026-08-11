/**
 * 自选股增删改查（docs/03 §5 的代码规范化 + docs/02 §5 的 IPC 契约）。
 *
 * 两条取向：
 *
 * 1. **代码规范化在入口做一次，之后全链路只认 SH600000 形态。**
 *    仓储层明确写了「只信任已规范化的输入」，所以这里是唯一的规范化点。
 *
 * 2. **拿不到基础信息也要能添加。** 名称走数据源，但断网时用户仍应能把代码加进自选
 *    —— 名称先显示代码本身，等下一轮刷新补上。要求「必须联网才能加自选」会让
 *    离线场景下整个应用不可用，而市场/板块本来就能从代码前缀推出来（src/core/code.ts）。
 */

import { parseCode } from '@core/code'
import type { SecCode, SecProfile } from '@core/types'
import type { WatchItem } from '@shared/ipc-types'
import type { ProviderRegistry } from '../providers'
import type { WatchEntry } from '../storage/repositories/watchlist'

/** WatchlistRepo 结构上就满足它 */
export interface WatchlistStore {
  list(): WatchEntry[]
  get(code: SecCode): WatchEntry | null
  codes(): SecCode[]
  count(): number
  add(profile: SecProfile, group: string, now: number): WatchEntry
  remove(code: SecCode): boolean
  reorder(codes: SecCode[]): void
  updateIndustry(code: SecCode, industry: string | null): void
}

/** PositionRepo 结构上就满足它 */
export interface PositionCodes {
  codes(): Set<SecCode>
}

export const DEFAULT_GROUP = '自选'

/**
 * 自选股上限。docs/03 §2.4 的请求预算是按 100 只估的；200 只时盘中每 tick 仍是
 * 4 个快照分片，够用且不至于把免费接口用坏。超过就该考虑分组轮询，那不是 M1 的事。
 */
export const MAX_WATCH_ITEMS = 200

export interface WatchlistServiceDeps {
  repo: WatchlistStore
  positions?: PositionCodes
  /** 缺省或取数失败时用代码占位，不阻塞添加 */
  registry?: Pick<ProviderRegistry, 'fetchProfile'>
  now?: () => number
  maxItems?: number
  log?: (message: string) => void
}

export interface WatchlistService {
  list(): WatchItem[]
  codes(): SecCode[]
  add(input: string, group?: string): Promise<WatchItem>
  remove(code: SecCode): void
  reorder(codes: SecCode[]): void
  /** 每周一次的基础信息刷新（docs/03 §1）。返回补全了名称/行业的代码数 */
  refreshProfiles(codes?: readonly SecCode[]): Promise<number>
}

export function toWatchItem(entry: WatchEntry, hasPosition: boolean): WatchItem {
  const item: WatchItem = {
    code: entry.profile.code,
    name: entry.profile.name,
    group: entry.group,
    sortOrder: entry.sortOrder,
    hasPosition,
  }
  if (entry.profile.industry) item.industry = entry.profile.industry
  return item
}

export function createWatchlistService(deps: WatchlistServiceDeps): WatchlistService {
  const {
    repo,
    positions,
    registry,
    now = () => Date.now(),
    maxItems = MAX_WATCH_ITEMS,
    log = () => {},
  } = deps

  const held = (): Set<SecCode> => positions?.codes() ?? new Set<SecCode>()

  /** 数据源给的资料优先，拿不到就用代码前缀推出来的最小可用资料 */
  async function profileOf(fallback: SecProfile): Promise<{ profile: SecProfile; fromProvider: boolean }> {
    if (!registry) return { profile: fallback, fromProvider: false }
    try {
      const result = await registry.fetchProfile(fallback.code)
      const value = result.value
      // 名称是唯一必须来自数据源的字段。空名称当作没拿到，否则面板会出现一行空白
      if (!value.name.trim()) return { profile: fallback, fromProvider: false }
      return { profile: value, fromProvider: true }
    } catch (error) {
      log(`[watchlist] ${fallback.code} 基础信息取不到，先用代码占位：${String(error)}`)
      return { profile: fallback, fromProvider: false }
    }
  }

  return {
    list() {
      const hold = held()
      return repo.list().map((entry) => toWatchItem(entry, hold.has(entry.profile.code)))
    },

    codes: () => repo.codes(),

    async add(input, group = DEFAULT_GROUP) {
      const parsed = parseCode(input)
      if (!parsed.ok) throw new Error(`无法识别的代码「${input}」：${parsed.reason}`)
      const code = parsed.value.code

      // 已存在时走幂等更新，不占新的名额 —— 否则「加满了」会挡住重复添加这种无害操作
      const existing = repo.get(code)
      if (!existing && repo.count() >= maxItems) {
        throw new Error(`自选股最多 ${maxItems} 只，请先移除一些`)
      }

      const fallback: SecProfile = {
        code,
        name: existing?.profile.name ?? code,
        market: parsed.value.market,
        board: parsed.value.board,
        isST: existing?.profile.isST ?? false,
      }
      if (existing?.profile.industry) fallback.industry = existing.profile.industry

      const { profile } = await profileOf(fallback)
      const entry = repo.add(profile, existing?.group ?? group, now())
      return toWatchItem(entry, held().has(code))
    },

    remove(code) {
      // 已入库的日线不在这里删：用户常常移除后又加回来，重拉 300 根日线纯属浪费。
      // 残留由 retention.ts 按保留策略清理（它会照顾到不在自选里的代码）。
      if (!repo.remove(code)) log(`[watchlist] ${code} 不在自选里，忽略移除`)
    },

    reorder(codes) {
      repo.reorder([...codes])
    },

    async refreshProfiles(codes) {
      if (!registry) return 0
      const targets = codes ? [...codes] : repo.codes()
      let updated = 0
      for (const code of targets) {
        const entry = repo.get(code)
        if (!entry) continue
        const { profile, fromProvider } = await profileOf(entry.profile)
        if (!fromProvider) continue
        repo.add(profile, entry.group, entry.createdAt)
        updated += 1
      }
      return updated
    },
  }
}
