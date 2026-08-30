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
import type { Board, SecCode, SecProfile } from '@core/types'
import { shanghaiDate } from '@shared/time'
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

/** `IndustryHistoryRepo` 结构上就满足它 */
export interface IndustryStore {
  record(code: SecCode, observedDate: string, industry: string): 'FIRST' | 'CHANGE' | 'UNCHANGED'
}

export interface WatchlistServiceDeps {
  repo: WatchlistStore
  positions?: PositionCodes
  /** 缺省或取数失败时用代码占位，不阻塞添加 */
  registry?: Pick<ProviderRegistry, 'fetchProfile'>
  /**
   * 行业留痕（014）。不传就只更新 `watchlist.industry` 那一列，不记历史 ——
   * 回测与测试里用不着，但**真机上必须传**，见下面 `profileOf` 的头注释。
   */
  industries?: IndustryStore
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
  /**
   * 还缺行业、而且**本来应该有**行业的自选代码（`tick.ts` 每日补一次的入参）。
   *
   * ⚠ **必须按板块筛**：ETF 与指数结构上就没有行业，把它们留在这张单子里
   * 会让那趟 pass 每天都为同一批标的白打十几个请求，且永远清不空。
   */
  pendingIndustry(): SecCode[]
}

/** 有行业分类的板块。ETF / INDEX 结构上没有，见 `pendingIndustry` */
const INDUSTRY_BOARDS: ReadonlySet<Board> = new Set<Board>(['MAIN', 'GEM', 'STAR', 'BSE'])

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
    industries,
    now = () => Date.now(),
    maxItems = MAX_WATCH_ITEMS,
    log = () => {},
  } = deps

  const held = (): Set<SecCode> => positions?.codes() ?? new Set<SecCode>()

  /**
   * 数据源给的资料优先，拿不到就用代码前缀推出来的最小可用资料。
   *
   * ## ⚠ 为什么这里要为 `industry` 单独重试一次（2026-08-22）
   *
   * 真机上 `watchlist.industry` **79/79 全空**，而链路每一段都是通的
   * （东财在取 `f127` · `refreshProfiles` 挂在休市维护 · 写库那句有 `COALESCE`）。
   * 根因是**降级链把这个字段静默吃掉了**：`provider_health` 里 13 次
   * `profile …: other side closed` 全是 eastmoney（它的间歇性症状），
   * 而每次紧跟一条 tencent 成功 —— 腾讯的 `fetchProfile` 明写着「industry 不提供」。
   * 于是拿到一个**有名字、没行业**的 profile，`fromProvider = true`，刷新报「成功」，
   * 而行业永远是空。**系统在按设计工作，少的那一块没有任何人看得见。**
   *
   * ⚠ **修法不是把腾讯判成失败** —— 那会连名字一起丢，而且与
   * `fetchMinutes` / `fetchAnnouncements` 那条「空结果不算失败」的纪律冲突
   * （方向相反但同一类：拿整体的成败去判一个字段）。
   *
   * 这里做的是**按字段重试，且只在真有机会时重试**：
   *   · 只在**主源这一轮真的被试过并且失败了**时重试（判据见下）——
   *     主源自己给了空行业说明它就是没有，再问一次纯属浪费预算；
   *   · 只在**存量也没有**行业时重试 —— 拿到过一次就被 `COALESCE` 保住了；
   *   · 只重试**一次**。台账写着 eastmoney 是间歇性的、重试能过，
   *     再多就该去查熔断而不是在这里堆重试。
   *
   * ## ⚠ 上面这个修法 2026-08-22 → 2026-08-30 之间**一次都没有触发过**
   *
   * 判据原本写的是 `result.degraded`，而它当时的实现是 `attempts.length > 1`
   * ⇒ **主源在冷却里被跳过**时它是 `false`。真机 2026-08-26 11:35:23：
   * eastmoney 连续三次失败触发 5 分钟冷却，每周一次的 `refreshProfiles()`
   * 恰好在同一秒开跑 ⇒ 79 只全部由腾讯服务、`degraded === false` ⇒ 重试一次都没发生
   * ⇒ `industry` 仍然 79/79 全空、`industry_history`（014）**一行都没有**。
   * `registry.ts` 的 `degraded` 已改成「值不来自主源」，但**这里不能直接用它**：
   *
   *   · `degraded && attempts.length > 1` = 主源试过、这次失败了 ⇒ **立刻重试有机会**
   *     （eastmoney 是间歇性的）⇒ 就是下面这条路；
   *   · `degraded && attempts.length === 1` = 主源在冷却里、压根没试 ⇒
   *     **立刻重试必然还是备源**（`ordered()` 把冷却中的排到最后）⇒ 重试等于白烧一个请求
   *     ⇒ 交给 `tick.ts` 那趟每日补行业的 pass，等冷却过去再说。
   *
   * ⇒ **「重试」与「稍后再来」是两种失败，别用一个布尔盖住。**
   */
  async function profileOf(
    fallback: SecProfile
  ): Promise<{ profile: SecProfile; fromProvider: boolean }> {
    if (!registry) return { profile: fallback, fromProvider: false }

    const once = async (): Promise<{
      profile: SecProfile
      fromProvider: boolean
      /** 主源这一轮**被试过并且失败了** —— 与「主源在冷却里没被试」是两回事，见头注释 */
      primaryFailedNow: boolean
    }> => {
      const result = await registry.fetchProfile(fallback.code)
      const value = result.value
      // 名称是唯一必须来自数据源的字段。空名称当作没拿到，否则面板会出现一行空白
      if (!value.name.trim()) return { profile: fallback, fromProvider: false, primaryFailedNow: false }
      return {
        profile: value,
        fromProvider: true,
        primaryFailedNow: result.degraded && result.attempts.length > 1,
      }
    }

    try {
      const first = await once()
      const missingIndustry = !first.profile.industry && !fallback.industry
      if (!first.fromProvider || !missingIndustry || !first.primaryFailedNow) {
        return { profile: first.profile, fromProvider: first.fromProvider }
      }
      // 主源这次没服务成，而我们缺的恰好是只有它给的字段 ⇒ 再问一次
      const retry = await once()
      if (retry.fromProvider && retry.profile.industry) {
        log(`[watchlist] ${fallback.code} 行业字段降级丢失，重试后补上：${retry.profile.industry}`)
        return { profile: retry.profile, fromProvider: true }
      }
      return { profile: first.profile, fromProvider: first.fromProvider }
    } catch (error) {
      log(`[watchlist] ${fallback.code} 基础信息取不到，先用代码占位：${String(error)}`)
      return { profile: fallback, fromProvider: false }
    }
  }

  /**
   * 行业留痕：只在**变化时**写行（仓储自己判重）。
   *
   * 空行业**一个字都不写** —— 「这次没取到」与「行业变成了空」是两件事，
   * 后者不存在。写进去会在变更日志里造出一次假的行业调整。
   */
  function traceIndustry(profile: SecProfile): void {
    if (!industries || !profile.industry) return
    const outcome = industries.record(profile.code, shanghaiDate(now()), profile.industry)
    if (outcome === 'CHANGE') {
      log(`[watchlist] ${profile.code} 行业变更 → ${profile.industry}`)
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
      // 添加那一刻也是一次合法观测 —— 不记的话，一只票的历史会从它第一次
      // 赶上休市维护才开始，而那可能是几天之后
      traceIndustry(profile)
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

    pendingIndustry() {
      return repo
        .list()
        .filter(
          (entry) =>
            INDUSTRY_BOARDS.has(entry.profile.board) && !entry.profile.industry?.trim()
        )
        .map((entry) => entry.profile.code)
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
        traceIndustry(profile)
        updated += 1
      }
      return updated
    },
  }
}
