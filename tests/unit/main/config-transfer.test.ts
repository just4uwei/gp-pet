/**
 * 个人配置导入导出（src/main/settings/transfer.ts）。
 *
 * 这里钉住的都是「错了以后用户会丢数据、而且当场看不出来」的性质：
 * 覆盖导入有没有把旧自选清干净、坏行是不是被丢掉且**留了痕**、
 * 持仓的外键前提有没有被守住、往返一趟排序会不会变。
 */

import { describe, expect, it } from 'vitest'
import type { SecCode, SecProfile } from '@core/types'
import { DEFAULT_SETTINGS } from '@main/settings/schema'
import {
  applyConfigBundle,
  buildConfigBundle,
  CONFIG_BUNDLE_FORMAT,
  CONFIG_BUNDLE_VERSION,
  parseConfigBundle,
  serializeConfigBundle,
  type ConfigApplyStores,
  type ConfigPositionEntry,
  type ConfigWatchEntry,
} from '@main/settings/transfer'

function watchEntry(code: string, sortOrder: number, extra: Partial<ConfigWatchEntry> = {}): ConfigWatchEntry {
  return {
    code,
    name: `名称${code}`,
    market: code.startsWith('SH') ? 'SH' : 'SZ',
    board: 'MAIN',
    group: '自选',
    sortOrder,
    createdAt: 1_700_000_000_000,
    ...extra,
  }
}

function positionEntry(code: string, extra: Partial<ConfigPositionEntry> = {}): ConfigPositionEntry {
  return { code, shares: 1000, cost: 10, peakPrice: 12, openedAt: 1_700_000_000_000, ...extra }
}

// ── 假仓储：结构上满足 WatchlistRepo / PositionRepo 的那几个方法 ──────────

interface FakeStores extends ConfigApplyStores {
  watch: Map<string, { profile: SecProfile; group: string; createdAt: number; sortOrder: number }>
  held: Map<string, { shares: number; cost: number; peak: number; openedAt: number }>
}

function fakeStores(
  seedWatch: readonly string[] = [],
  seedPositions: readonly string[] = []
): FakeStores {
  const watch = new Map<string, { profile: SecProfile; group: string; createdAt: number; sortOrder: number }>()
  const held = new Map<string, { shares: number; cost: number; peak: number; openedAt: number }>()

  for (const [i, code] of seedWatch.entries()) {
    watch.set(code, {
      profile: { code, name: `旧${code}`, market: 'SH', board: 'MAIN', isST: false },
      group: '旧分组',
      createdAt: 1,
      sortOrder: i,
    })
  }
  for (const code of seedPositions) held.set(code, { shares: 1, cost: 1, peak: 1, openedAt: 1 })

  return {
    watch,
    held,
    watchlist: {
      codes: () => [...watch.keys()].sort((a, b) => (watch.get(a)?.sortOrder ?? 0) - (watch.get(b)?.sortOrder ?? 0)),
      remove: (code: SecCode) => {
        // 真仓储的 remove 会连带清持仓（外键），假的也照做，否则测不出真实行为
        held.delete(code)
        return watch.delete(code)
      },
      add: (profile: SecProfile, group: string, now: number) => {
        watch.set(profile.code, { profile, group, createdAt: now, sortOrder: watch.size })
        return undefined
      },
      reorder: (codes: SecCode[]) => {
        codes.forEach((code, index) => {
          const row = watch.get(code)
          if (row) row.sortOrder = index
        })
      },
    },
    positions: {
      codes: () => new Set(held.keys()),
      clear: (code: SecCode) => held.delete(code),
      set: (code: SecCode, shares: number, cost: number, now: number) => {
        held.set(code, { shares, cost, peak: cost, openedAt: now })
      },
      bumpPeak: (code: SecCode, price: number) => {
        const row = held.get(code)
        if (row) row.peak = Math.max(row.peak, price)
      },
    },
  }
}

describe('buildConfigBundle', () => {
  it('带上格式标记与版本号 —— 导入端靠它认出这是不是本应用的文件', () => {
    const bundle = buildConfigBundle({
      settings: DEFAULT_SETTINGS,
      watchlist: [],
      positions: [],
      now: 1_700_000_000_000,
      appVersion: '0.1.0',
    })
    expect(bundle.format).toBe(CONFIG_BUNDLE_FORMAT)
    expect(bundle.version).toBe(CONFIG_BUNDLE_VERSION)
    expect(bundle.exportedAt).toBe(1_700_000_000_000)
  })

  it('反解出来的费率与它的来路都跟着走 —— 换机器不该让账本的成本重新偏掉', () => {
    // `tradeCosts` 是 017 加的：它决定 `position.cost` 与 `realized`，
    // 不带走的话新机器上按出厂档重算一遍，成本价与旧机器对不上而没人会想到是这里
    const settings = {
      ...DEFAULT_SETTINGS,
      tradeCosts: { ...DEFAULT_SETTINGS.tradeCosts, commissionRate: 0.0001 },
      tradeCostsSource: {
        code: 'SH600000',
        targetFeeTotal: 85.11,
        throughMs: 1_699_900_000_000,
        commissionRate: 0.0001,
        minCommission: 0,
        at: 1_700_000_000_000,
      },
    }
    const bundle = buildConfigBundle({
      settings,
      watchlist: [],
      positions: [],
      now: 0,
      appVersion: '0.1.0',
    })
    expect(bundle.settings.tradeCosts.commissionRate).toBe(0.0001)
    // 往返一趟之后两样都还在
    const parsed = parseConfigBundle(JSON.parse(JSON.stringify(bundle)))
    expect(parsed.bundle.settings.tradeCosts.commissionRate).toBe(0.0001)
    expect(parsed.bundle.settings.tradeCostsSource?.code).toBe('SH600000')
  })

  it('自选按 sortOrder 落地，用户排好的次序不在往返中丢', () => {
    const bundle = buildConfigBundle({
      settings: DEFAULT_SETTINGS,
      watchlist: [watchEntry('SH600000', 2), watchEntry('SZ000001', 0), watchEntry('SH601919', 1)],
      positions: [],
      now: 0,
      appVersion: '0.1.0',
    })
    expect(bundle.watchlist.map((w) => w.code)).toEqual(['SZ000001', 'SH601919', 'SH600000'])
  })

  it('settings 是深拷贝：导出后改动 bundle 不会渗回设置', () => {
    const settings = { ...DEFAULT_SETTINGS, quietHours: [{ start: '12:00', end: '13:00' }] }
    const bundle = buildConfigBundle({
      settings,
      watchlist: [],
      positions: [],
      now: 0,
      appVersion: '0.1.0',
    })
    bundle.settings.quietHours.push({ start: '00:00', end: '01:00' })
    expect(settings.quietHours).toHaveLength(1)
  })

  /**
   * AI 的 API key 不在 `AppSettings` 里，它单独住 ai.json（见 src/main/ai/config.ts）。
   * 这条用例是那个决定的**回归闸门**：谁哪天为了「配置导出更完整」把 AI 字段搬进
   * AppSettings，导出文件里就会多出一把能直接花钱的钥匙 —— 而导出文件的用途
   * 恰恰是「发给另一台机器」。
   */
  it('导出文件里不含任何 AI 字段（key 单独存 ai.json，绝不进配置导出）', () => {
    const bundle = buildConfigBundle({
      settings: DEFAULT_SETTINGS,
      watchlist: [],
      positions: [],
      now: 0,
      appVersion: '0.1.0',
    })
    const raw = serializeConfigBundle(bundle)
    for (const forbidden of ['apiKey', 'apiKeyEnc', 'baseUrl', 'sk-']) {
      expect(raw, `导出文件里出现了 ${forbidden}`).not.toContain(forbidden)
    }
    expect(Object.keys(bundle.settings)).not.toContain('ai')
  })
})

describe('parseConfigBundle', () => {
  const good = (): unknown =>
    JSON.parse(
      serializeConfigBundle(
        buildConfigBundle({
          settings: { ...DEFAULT_SETTINGS, pollIntervalSec: 60 },
          watchlist: [watchEntry('SH600000', 0, { industry: '银行' }), watchEntry('SZ000001', 1)],
          positions: [positionEntry('SH600000')],
          now: 1_700_000_000_000,
          appVersion: '0.1.0',
        })
      )
    ) as unknown

  it('导出 → 序列化 → 解析，内容一字不差地回来', () => {
    const { bundle, warnings } = parseConfigBundle(good())
    expect(warnings).toEqual([])
    expect(bundle.settings.pollIntervalSec).toBe(60)
    expect(bundle.watchlist.map((w) => w.code)).toEqual(['SH600000', 'SZ000001'])
    expect(bundle.watchlist[0]?.industry).toBe('银行')
    expect(bundle.positions).toHaveLength(1)
  })

  it('不是本应用的文件就抛错，而不是当成一份空配置往下走', () => {
    expect(() => parseConfigBundle({ hello: 'world' })).toThrow(/不是蹲点/)
    expect(() => parseConfigBundle(null)).toThrow(/不是蹲点/)
    expect(() => parseConfigBundle('{}')).toThrow(/不是蹲点/)
  })

  it('版本比当前新时拒绝导入（结构可能已经不兼容）', () => {
    expect(() =>
      parseConfigBundle({ format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION + 1 })
    ).toThrow(/比当前应用/)
  })

  it('设置里的坏字段回默认值并留痕，好字段保留', () => {
    const { bundle, warnings } = parseConfigBundle({
      format: CONFIG_BUNDLE_FORMAT,
      version: 1,
      settings: { pollIntervalSec: 3, sensitivity: 'CONSERVATIVE' },
    })
    expect(bundle.settings.pollIntervalSec).toBe(DEFAULT_SETTINGS.pollIntervalSec)
    expect(bundle.settings.sensitivity).toBe('CONSERVATIVE')
    expect(warnings.join()).toContain('pollIntervalSec')
  })

  it('坏的自选行被丢掉，其余照常导入 —— 一行坏数据不该毁掉整份自选', () => {
    const { bundle, warnings } = parseConfigBundle({
      format: CONFIG_BUNDLE_FORMAT,
      version: 1,
      watchlist: [watchEntry('SH600000', 0), { code: 'SZ000001' }, watchEntry('SH601919', 1)],
    })
    expect(bundle.watchlist.map((w) => w.code)).toEqual(['SH600000', 'SH601919'])
    expect(warnings.join()).toContain('自选第 2 行已丢弃')
  })

  it('重复的自选只留第一条', () => {
    const { bundle, warnings } = parseConfigBundle({
      format: CONFIG_BUNDLE_FORMAT,
      version: 1,
      watchlist: [watchEntry('SH600000', 0), watchEntry('SH600000', 1, { name: '后来的' })],
    })
    expect(bundle.watchlist).toHaveLength(1)
    expect(bundle.watchlist[0]?.name).toBe('名称SH600000')
    expect(warnings.join()).toContain('重复出现')
  })

  it('持仓的代码不在自选里就丢掉 —— position.code 是指向 watchlist 的外键', () => {
    const { bundle, warnings } = parseConfigBundle({
      format: CONFIG_BUNDLE_FORMAT,
      version: 1,
      watchlist: [watchEntry('SH600000', 0)],
      positions: [positionEntry('SH600000'), positionEntry('SZ000001')],
    })
    expect(bundle.positions.map((p) => p.code)).toEqual(['SH600000'])
    expect(warnings.join()).toContain('SZ000001 不在导入的自选里')
  })

  it('持有期最高价不低于成本价（与 PositionRepo 的兜底同一口径）', () => {
    const { bundle } = parseConfigBundle({
      format: CONFIG_BUNDLE_FORMAT,
      version: 1,
      watchlist: [watchEntry('SH600000', 0)],
      positions: [positionEntry('SH600000', { cost: 20, peakPrice: 5 })],
    })
    expect(bundle.positions[0]?.peakPrice).toBe(20)
  })

  it('没有 settings 块时设置保持默认，并说明这件事', () => {
    const { bundle, warnings } = parseConfigBundle({ format: CONFIG_BUNDLE_FORMAT, version: 1 })
    expect(bundle.settings).toEqual(DEFAULT_SETTINGS)
    expect(warnings.join()).toContain('没有设置项')
  })
})

describe('applyConfigBundle', () => {
  const bundle = (): ReturnType<typeof buildConfigBundle> =>
    buildConfigBundle({
      settings: DEFAULT_SETTINGS,
      watchlist: [watchEntry('SZ000001', 0), watchEntry('SH600000', 1)],
      positions: [positionEntry('SH600000', { shares: 500, cost: 8, peakPrice: 15 })],
      now: 0,
      appVersion: '0.1.0',
    })

  it('覆盖式：旧自选与旧持仓一条不剩', () => {
    const stores = fakeStores(['SH601919', 'SZ300750'], ['SH601919'])
    const result = applyConfigBundle(bundle(), stores)

    expect([...stores.watch.keys()].sort()).toEqual(['SH600000', 'SZ000001'])
    expect([...stores.held.keys()]).toEqual(['SH600000'])
    expect(result).toEqual({
      watchlist: 2,
      positions: 1,
      removedWatchlist: 2,
      removedPositions: 1,
    })
  })

  it('排序按文件里的次序还原', () => {
    const stores = fakeStores()
    applyConfigBundle(bundle(), stores)
    expect(stores.watchlist.codes()).toEqual(['SZ000001', 'SH600000'])
  })

  it('持仓的持有期最高价被抬到导出时的值，不停在成本价上', () => {
    const stores = fakeStores()
    applyConfigBundle(bundle(), stores)
    expect(stores.held.get('SH600000')).toEqual({
      shares: 500,
      cost: 8,
      peak: 15,
      openedAt: 1_700_000_000_000,
    })
  })

  it('建仓时间取文件里的值，不是导入的当下', () => {
    const stores = fakeStores()
    const b = bundle()
    b.positions[0] = positionEntry('SH600000', { openedAt: 1_600_000_000_000 })
    applyConfigBundle(b, stores)
    expect(stores.held.get('SH600000')?.openedAt).toBe(1_600_000_000_000)
  })

  it('ST 状态从名称重算，不跟着文件走 —— 导出后可能已经摘帽', () => {
    const stores = fakeStores()
    const b = bundle()
    b.watchlist = [watchEntry('SH600000', 0, { name: 'ST 某某' })]
    b.positions = []
    applyConfigBundle(b, stores)
    expect(stores.watch.get('SH600000')?.profile.isST).toBe(true)
  })

  it('空文件等于清空 —— 这正是「覆盖」应有的语义', () => {
    const stores = fakeStores(['SH601919'], ['SH601919'])
    const b = bundle()
    b.watchlist = []
    b.positions = []
    const result = applyConfigBundle(b, stores)
    expect(stores.watch.size).toBe(0)
    expect(stores.held.size).toBe(0)
    expect(result.removedWatchlist).toBe(1)
  })
})
