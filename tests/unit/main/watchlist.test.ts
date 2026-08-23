/**
 * WatchlistService（docs/03 §5 代码规范化、docs/02 §5 IPC 契约）。
 *
 * 关注点排序：
 *   1. 断网也能加自选（名称先用代码占位），否则离线场景整个应用不可用
 *   2. 输入形态五花八门（600000 / sh600000 / 000001.SZ），入库一律 SH600000
 *   3. 重复添加是无害操作：幂等更新，不占新名额、不改分组与排序
 */

import { describe, expect, it, vi } from 'vitest'
import type { SecCode, SecProfile } from '@core/types'
import {
  DEFAULT_GROUP,
  createWatchlistService,
  toWatchItem,
  type WatchlistStore,
} from '@main/engine'
import type { IndustryStore } from '@main/engine/watchlist'
import type { ProviderRegistry } from '@main/providers'
import type { WatchEntry } from '@main/storage/repositories/watchlist'

/** 内存版仓储：语义与 WatchlistRepo 对齐（幂等 add、行业只增不清） */
function store(): WatchlistStore & { entries: Map<SecCode, WatchEntry> } {
  const entries = new Map<SecCode, WatchEntry>()
  let nextOrder = 0
  return {
    entries,
    list: () => [...entries.values()].sort((a, b) => a.sortOrder - b.sortOrder),
    get: (code) => entries.get(code) ?? null,
    codes: () => [...entries.values()].sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.profile.code),
    count: () => entries.size,
    add(profile, group, now) {
      const existing = entries.get(profile.code)
      const merged: SecProfile = { ...profile }
      if (!merged.industry && existing?.profile.industry) merged.industry = existing.profile.industry
      const entry: WatchEntry = {
        profile: merged,
        group: existing?.group ?? group,
        sortOrder: existing?.sortOrder ?? nextOrder++,
        createdAt: existing?.createdAt ?? now,
      }
      entries.set(profile.code, entry)
      return entry
    },
    remove: (code) => entries.delete(code),
    reorder(codes) {
      codes.forEach((code, index) => {
        const entry = entries.get(code)
        if (entry) entries.set(code, { ...entry, sortOrder: index })
      })
    },
    updateIndustry(code, industry) {
      const entry = entries.get(code)
      if (entry) {
        const profile: SecProfile = { ...entry.profile }
        if (industry) profile.industry = industry
        else delete profile.industry
        entries.set(code, { ...entry, profile })
      }
    },
  }
}

function profileOf(code: SecCode, name: string, industry?: string): SecProfile {
  const profile: SecProfile = { code, name, market: 'SH', board: 'MAIN', isST: false }
  if (industry) profile.industry = industry
  return profile
}

function registryOf(fn: (code: SecCode) => Promise<SecProfile>): Pick<ProviderRegistry, 'fetchProfile'> {
  return {
    fetchProfile: async (code) => ({
      value: await fn(code),
      provider: 'eastmoney',
      degraded: false,
      attempts: [],
    }),
  }
}

describe('createWatchlistService', () => {
  it('把各种输入形态规范化后入库', async () => {
    const repo = store()
    const service = createWatchlistService({ repo, now: () => 1 })

    await service.add('600000')
    await service.add('sz000001')
    await service.add('300750.SZ')

    expect(service.codes()).toEqual(['SH600000', 'SZ000001', 'SZ300750'])
  })

  it('代码不认识时抛出带原因的错误，且不写库', async () => {
    const repo = store()
    const service = createWatchlistService({ repo, now: () => 1 })

    await expect(service.add('不是代码')).rejects.toThrow(/无法识别的代码/)
    expect(repo.count()).toBe(0)
  })

  it('取不到基础信息时用代码占位，添加照样成功', async () => {
    const repo = store()
    const logs: string[] = []
    const service = createWatchlistService({
      repo,
      registry: registryOf(() => Promise.reject(new Error('全部数据源不可用'))),
      now: () => 1,
      log: (m) => logs.push(m),
    })

    const item = await service.add('600000')

    // 名称退化为代码本身，市场/板块仍由前缀推出 —— 这是「离线也能加自选」的下限
    expect(item.name).toBe('SH600000')
    expect(repo.get('SH600000')?.profile.market).toBe('SH')
    expect(logs.join()).toContain('SH600000')
  })

  it('数据源返回空名称等同于没拿到，不写入空白行', async () => {
    const repo = store()
    const service = createWatchlistService({
      repo,
      registry: registryOf((code) => Promise.resolve(profileOf(code, '   '))),
      now: () => 1,
    })

    const item = await service.add('600000')

    expect(item.name).toBe('SH600000')
  })

  it('拿得到基础信息时用数据源的名称与行业', async () => {
    const repo = store()
    const service = createWatchlistService({
      repo,
      registry: registryOf((code) => Promise.resolve(profileOf(code, '浦发银行', '银行'))),
      now: () => 1,
    })

    const item = await service.add('600000')

    expect(item.name).toBe('浦发银行')
    expect(item.industry).toBe('银行')
    expect(item.group).toBe(DEFAULT_GROUP)
  })

  /**
   * 降级链会把 `industry` 静默吃掉（2026-08-22 真机 79/79 全空的根因）：
   * eastmoney 的 profile 端点间歇性失败 → 降级到腾讯 → 腾讯**结构上不提供** industry
   * → 拿到一个「有名字、没行业」的 profile → `fromProvider = true` → 刷新报「成功」。
   *
   * 这一组钉的是**修法本身的三条边界** —— 每一条写反了都会变成另一个缺陷：
   *   · 只在 `degraded` 时重试（主源自己给了空行业 ⇒ 再问一次是白费预算）；
   *   · 只在存量也没有时重试（拿到过一次就被 COALESCE 保住，ETF 这类不该每轮多打一次）；
   *   · 只重试一次。
   */
  describe('industry 字段级重试（降级链会静默吃掉它）', () => {
    /** 可控 degraded 与调用计数的 registry */
    function flakyRegistry(
      results: readonly SecProfile[],
      degraded: readonly boolean[]
    ): { registry: Pick<ProviderRegistry, 'fetchProfile'>; calls: () => number } {
      let n = 0
      return {
        calls: () => n,
        registry: {
          fetchProfile: async (code) => {
            const value = results[Math.min(n, results.length - 1)] ?? profileOf(code, '占位')
            const isDegraded = degraded[Math.min(n, degraded.length - 1)] ?? false
            n += 1
            return { value, provider: 'tencent', degraded: isDegraded, attempts: [] }
          },
        },
      }
    }

    it('降级且行业缺失 ⇒ 重试一次，补上的行业会被采用', async () => {
      const repo = store()
      const code = 'SH600000' as SecCode
      const { registry, calls } = flakyRegistry(
        [profileOf(code, '浦发银行'), profileOf(code, '浦发银行', '银行')],
        [true, false]
      )
      const service = createWatchlistService({ repo, registry, now: () => 1 })

      const item = await service.add('600000')

      expect(calls()).toBe(2)
      expect(item.industry).toBe('银行')
    })

    it('**没降级**时不重试 —— 主源自己说没有，再问一次是白费预算', async () => {
      const repo = store()
      const code = 'SH600000' as SecCode
      const { registry, calls } = flakyRegistry([profileOf(code, '银行ETF')], [false])
      const service = createWatchlistService({ repo, registry, now: () => 1 })

      const item = await service.add('600000')

      expect(calls()).toBe(1)
      expect(item.industry).toBeUndefined()
    })

    it('存量已有行业时不重试 —— COALESCE 已经保住它了', async () => {
      const repo = store()
      const code = 'SH600000' as SecCode
      repo.add(profileOf(code, '浦发银行', '银行'), DEFAULT_GROUP, 1)
      const { registry, calls } = flakyRegistry([profileOf(code, '浦发银行')], [true])
      const service = createWatchlistService({ repo, registry, now: () => 1 })

      await service.add('600000')

      expect(calls()).toBe(1)
    })

    it('重试也没拿到就算了，只重试一次', async () => {
      const repo = store()
      const code = 'SH600000' as SecCode
      const { registry, calls } = flakyRegistry([profileOf(code, '浦发银行')], [true])
      const service = createWatchlistService({ repo, registry, now: () => 1 })

      const item = await service.add('600000')

      expect(calls()).toBe(2)
      expect(item.name).toBe('浦发银行')
      expect(item.industry).toBeUndefined()
    })
  })

  describe('行业留痕', () => {
    /** IndustryHistoryRepo 的最小替身 */
    function tracer(): { store: IndustryStore; rows: Array<[SecCode, string, string]> } {
      const rows: Array<[SecCode, string, string]> = []
      const seen = new Map<SecCode, string>()
      return {
        rows,
        store: {
          record(code, date, industry) {
            if (seen.get(code) === industry) return 'UNCHANGED'
            const first = !seen.has(code)
            seen.set(code, industry)
            rows.push([code, date, industry])
            return first ? 'FIRST' : 'CHANGE'
          },
        },
      }
    }

    it('添加时就记一次 —— 不然历史要等到第一次休市维护才开始', async () => {
      const repo = store()
      const t = tracer()
      const service = createWatchlistService({
        repo,
        registry: registryOf((code) => Promise.resolve(profileOf(code, '浦发银行', '银行'))),
        industries: t.store,
        // 北京时区 2026-08-22 10:00
        now: () => Date.parse('2026-08-22T02:00:00Z'),
      })

      await service.add('600000')

      expect(t.rows).toEqual([['SH600000', '2026-08-22', '银行']])
    })

    it('没有行业时一个字都不写', async () => {
      const repo = store()
      const t = tracer()
      const service = createWatchlistService({
        repo,
        registry: registryOf((code) => Promise.resolve(profileOf(code, '浦发银行'))),
        industries: t.store,
        now: () => Date.parse('2026-08-22T02:00:00Z'),
      })

      await service.add('600000')

      expect(t.rows).toEqual([])
    })

    it('刷新时也记 —— 这才是逐日累积的那条路', async () => {
      const repo = store()
      const t = tracer()
      repo.add(profileOf('SH600000' as SecCode, '浦发银行'), DEFAULT_GROUP, 1)
      const service = createWatchlistService({
        repo,
        registry: registryOf((code) => Promise.resolve(profileOf(code, '浦发银行', '银行'))),
        industries: t.store,
        now: () => Date.parse('2026-08-22T02:00:00Z'),
      })

      await service.refreshProfiles()

      expect(t.rows).toEqual([['SH600000', '2026-08-22', '银行']])
    })
  })

  it('重复添加是幂等更新：不占新名额，保留原分组', async () => {
    const repo = store()
    const service = createWatchlistService({ repo, now: () => 1 })

    await service.add('600000', '长线')
    await service.add('600000', '短线')

    expect(repo.count()).toBe(1)
    expect(repo.get('SH600000')?.group).toBe('长线')
  })

  it('加满后仍允许重复添加已有的代码，只拒绝新代码', async () => {
    const repo = store()
    const service = createWatchlistService({ repo, now: () => 1, maxItems: 1 })

    await service.add('600000')
    await expect(service.add('600000')).resolves.toBeTruthy()
    await expect(service.add('000001')).rejects.toThrow(/最多 1 只/)
  })

  it('list 标出持仓，并按 sortOrder 排列', async () => {
    const repo = store()
    const service = createWatchlistService({
      repo,
      positions: { codes: () => new Set<SecCode>(['SZ000001']) },
      now: () => 1,
    })

    await service.add('600000')
    await service.add('000001')
    service.reorder(['SZ000001', 'SH600000'])

    expect(service.list().map((i) => [i.code, i.hasPosition])).toEqual([
      ['SZ000001', true],
      ['SH600000', false],
    ])
  })

  it('移除不存在的代码只记日志，不抛错', () => {
    const repo = store()
    const logs: string[] = []
    const service = createWatchlistService({ repo, now: () => 1, log: (m) => logs.push(m) })

    expect(() => service.remove('SH600000')).not.toThrow()
    expect(logs.join()).toContain('不在自选里')
  })

  it('refreshProfiles 只统计真正拿到资料的那些', async () => {
    const repo = store()
    const fetchProfile = vi
      .fn<(code: SecCode) => Promise<SecProfile>>()
      .mockRejectedValueOnce(new Error('超时'))
      .mockResolvedValue(profileOf('SZ000001', '平安银行', '银行'))
    const service = createWatchlistService({
      repo,
      registry: registryOf((code) => fetchProfile(code)),
      now: () => 1,
    })

    // 先在无数据源的服务上落两只，避免 add 阶段就把资料补齐
    const offline = createWatchlistService({ repo, now: () => 1 })
    await offline.add('600000')
    await offline.add('000001')

    const updated = await service.refreshProfiles()

    expect(updated).toBe(1)
    expect(repo.get('SH600000')?.profile.name).toBe('SH600000')
    expect(repo.get('SZ000001')?.profile.name).toBe('平安银行')
  })

  it('没有数据源时 refreshProfiles 直接返回 0，不做无谓遍历', async () => {
    const repo = store()
    const service = createWatchlistService({ repo, now: () => 1 })
    await service.add('600000')

    await expect(service.refreshProfiles()).resolves.toBe(0)
  })
})

describe('toWatchItem', () => {
  it('行业缺失时不产生 industry 键（exactOptionalPropertyTypes）', () => {
    const entry: WatchEntry = {
      profile: profileOf('SH600000', '浦发银行'),
      group: DEFAULT_GROUP,
      sortOrder: 0,
      createdAt: 1,
    }

    expect('industry' in toWatchItem(entry, false)).toBe(false)
  })
})
