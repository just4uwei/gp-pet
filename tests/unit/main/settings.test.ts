import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, sanitizeSettings } from '@main/settings/schema'
import { SettingsStore } from '@main/settings/store'
import { DEFAULT_COSTS } from '../../../src/backtest/costs'

describe('sanitizeSettings', () => {
  it('空输入即出厂默认值', () => {
    expect(sanitizeSettings(undefined).settings).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({}).repaired).toEqual([])
  })

  it('非对象整份回默认并留痕', () => {
    const result = sanitizeSettings([1, 2, 3])
    expect(result.settings).toEqual(DEFAULT_SETTINGS)
    expect(result.repaired[0]?.field).toBe('(整份)')
  })

  it('坏字段单独回默认，好字段保留 —— 不因一项错误丢弃整份配置', () => {
    const result = sanitizeSettings({
      pollIntervalSec: 3, // 低于 10s 是对免费接口的滥用
      sensitivity: 'CONSERVATIVE', // 合法，应保留
      autoLaunch: 'yes', // 类型错
    })
    expect(result.settings.pollIntervalSec).toBe(DEFAULT_SETTINGS.pollIntervalSec)
    expect(result.settings.sensitivity).toBe('CONSERVATIVE')
    expect(result.settings.autoLaunch).toBe(false)
    expect(result.repaired.map((r) => r.field).sort()).toEqual(['autoLaunch', 'pollIntervalSec'])
  })

  it('轮询频率上下界 10–120s', () => {
    expect(sanitizeSettings({ pollIntervalSec: 10 }).settings.pollIntervalSec).toBe(10)
    expect(sanitizeSettings({ pollIntervalSec: 120 }).settings.pollIntervalSec).toBe(120)
    expect(sanitizeSettings({ pollIntervalSec: 121 }).repaired).toHaveLength(1)
    expect(sanitizeSettings({ pollIntervalSec: 30.5 }).repaired).toHaveLength(1)
  })

  it('静默时段必须是 HH:MM', () => {
    const ok = sanitizeSettings({ quietHours: [{ start: '09:00', end: '17:30' }] })
    expect(ok.repaired).toEqual([])
    expect(ok.settings.quietHours).toHaveLength(1)
    expect(sanitizeSettings({ quietHours: [{ start: '9:00', end: '17:30' }] }).repaired).toHaveLength(1)
    expect(sanitizeSettings({ quietHours: [{ start: '25:00', end: '17:30' }] }).repaired).toHaveLength(1)
  })

  it('数据源优先级只认已实现的三个源，且不允许为空', () => {
    expect(sanitizeSettings({ providerPriority: ['sina', 'tencent'] }).settings.providerPriority).toEqual([
      'sina',
      'tencent',
    ])
    expect(sanitizeSettings({ providerPriority: [] }).repaired).toHaveLength(1)
    expect(sanitizeSettings({ providerPriority: ['xueqiu'] }).repaired).toHaveLength(1)
  })

  it('dataDir 缺省时不留 undefined 键', () => {
    expect('dataDir' in sanitizeSettings({}).settings).toBe(false)
    expect(sanitizeSettings({ dataDir: 'D:/gp' }).settings.dataDir).toBe('D:/gp')
    expect(sanitizeSettings({ dataDir: '' }).repaired).toHaveLength(1)
  })
})

describe('SettingsStore', () => {
  let dir: string
  let file: string
  const logs: string[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gp-settings-'))
    file = join(dir, 'settings.json')
    logs.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const store = (): SettingsStore => new SettingsStore(file, (m) => logs.push(m))

  it('文件不存在时静默用默认值（首次启动不是错误）', () => {
    expect(store().load()).toEqual(DEFAULT_SETTINGS)
    expect(logs).toEqual([])
  })

  it('坏 JSON 记一条日志后回默认值', () => {
    writeFileSync(file, '{ 这不是 json', 'utf8')
    expect(store().load()).toEqual(DEFAULT_SETTINGS)
    expect(logs.join()).toContain('读取失败')
  })

  it('patch 落盘，重新 load 能读回', () => {
    const first = store()
    first.load()
    const patched = first.patch({ pollIntervalSec: 60, autoLaunch: true })
    expect(patched.pollIntervalSec).toBe(60)

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(persisted['pollIntervalSec']).toBe(60)
    expect(store().load().autoLaunch).toBe(true)
  })

  it('非法补丁被忽略且不污染已有取值', () => {
    const s = store()
    s.load()
    s.patch({ pollIntervalSec: 60 })
    const after = s.patch({ pollIntervalSec: 1 } as Partial<{ pollIntervalSec: number }>)
    expect(after.pollIntervalSec).toBe(DEFAULT_SETTINGS.pollIntervalSec)
    expect(logs.join()).toContain('忽略非法补丁字段')
  })

  it('get 返回副本，外部改动不会渗回主进程状态', () => {
    const s = store()
    s.load()
    const snapshot = s.get()
    snapshot.quietHours.push({ start: '00:00', end: '01:00' })
    expect(s.get().quietHours).toEqual([])
  })

  it('写入失败不抛错（内存值继续生效）', () => {
    const broken = new SettingsStore(join(dir, 'no-such-dir', '\u0000bad', 'settings.json'), (m) =>
      logs.push(m)
    )
    broken.load()
    expect(() => broken.patch({ autoLaunch: true })).not.toThrow()
    expect(broken.get().autoLaunch).toBe(true)
    expect(logs.join()).toContain('写入失败')
  })
})

/**
 * 免责声明确认时刻（M4，docs/01 §8）。
 *
 * 存**时刻**而不是布尔值：声明文本将来若实质性变更，可以按时间戳判断
 * 「他确认的是哪一版」，而 `true` 什么都答不了。
 */
describe('disclaimerAcceptedAt', () => {
  it('缺省时**不留 undefined 键** —— exactOptionalPropertyTypes 下它与「没有这个键」不等价', () => {
    const { settings } = sanitizeSettings({})
    expect('disclaimerAcceptedAt' in settings).toBe(false)
  })

  it('正整数毫秒被保留', () => {
    const at = Date.UTC(2026, 7, 13)
    expect(sanitizeSettings({ disclaimerAcceptedAt: at }).settings.disclaimerAcceptedAt).toBe(at)
  })

  it('0 / 负数 / 小数一律回到「没确认过」—— 会再弹一次引导，那比信一个坏时间戳安全', () => {
    for (const bad of [0, -1, 1.5]) {
      const result = sanitizeSettings({ disclaimerAcceptedAt: bad })
      expect('disclaimerAcceptedAt' in result.settings).toBe(false)
      expect(result.repaired.map((r) => r.field)).toContain('disclaimerAcceptedAt')
    }
  })

  it('确认过之后 patch 别的字段不会把它抹掉', () => {
    const at = Date.UTC(2026, 7, 13)
    const home = mkdtempSync(join(tmpdir(), 'gp-disclaimer-'))
    try {
      const s = new SettingsStore(join(home, 'settings.json'))
      s.load()
      s.patch({ disclaimerAcceptedAt: at })
      expect(s.patch({ pollIntervalSec: 45 }).disclaimerAcceptedAt).toBe(at)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

/**
 * 交易费率（017）。**settings.json 里没有编辑框对应的入口** —— 它由「校正成本」
 * 反解写入。但文件是用户可以手改的，所以照样要逐项校验。
 */
describe('sanitizeSettings · tradeCosts', () => {
  it('出厂费率**逐位等于** DEFAULT_COSTS 的对应四项 —— 没校正过的用户账本行为不变', () => {
    /*
      ⚠ 这条用例变红不是让你把 schema.ts 改成 import DEFAULT_COSTS。
      两份数是**刻意分开**的（一份是回测与影子的固定假设，一份是用户自己的费率），
      它变红是在提醒你：两者分叉了，确认这是有意的。
    */
    expect(DEFAULT_SETTINGS.tradeCosts).toEqual({
      commissionRate: DEFAULT_COSTS.commissionRate,
      minCommission: DEFAULT_COSTS.minCommission,
    })
    // **没有 slippage** —— 记账绝不套滑点，少这一项让它在类型上就做不成
    expect('slippage' in DEFAULT_SETTINGS.tradeCosts).toBe(false)
    /*
      ⚠ **也没有印花税与过户费**（2026-09-03 订正）：那两项是国家与交易所的规定，
      带生效日期住 `backtest/costs.ts`。把规则当成可配的数写进设置，
      就会出现 2026-09-03 那个缺陷：印花税 2023-08-28 起已减半，而设置里躺着一个
      过期一倍的 0.001 —— 用户每一笔卖出多扣一倍，且反解把那 2 倍误差
      整个折算进了佣金率，给出一个看起来精确、实际虚构的结论。
    */
    expect('stampTaxRate' in DEFAULT_SETTINGS.tradeCosts).toBe(false)
    expect('transferFeeRate' in DEFAULT_SETTINGS.tradeCosts).toBe(false)
  })

  it('0 是合法取值 —— 券商可以免最低手续费', () => {
    const zeroed = { commissionRate: 0, minCommission: 0 }
    const result = sanitizeSettings({ tradeCosts: zeroed })
    expect(result.settings.tradeCosts).toEqual(zeroed)
    expect(result.repaired).toEqual([])
  })

  it('把「万 2.5」当成 2.5 填进去（差 10000 倍）会回默认并留痕，不静默生效', () => {
    // 不挡的话每一笔买入的成本价都会变成天文数字，而那个数一路进止损线
    const result = sanitizeSettings({
      tradeCosts: { ...DEFAULT_SETTINGS.tradeCosts, commissionRate: 2.5 },
    })
    expect(result.settings.tradeCosts).toEqual(DEFAULT_SETTINGS.tradeCosts)
    expect(result.repaired.map((r) => r.field)).toContain('tradeCosts')
  })

  it('负费率一律拒绝', () => {
    const result = sanitizeSettings({
      tradeCosts: { ...DEFAULT_SETTINGS.tradeCosts, minCommission: -1 },
    })
    expect(result.settings.tradeCosts).toEqual(DEFAULT_SETTINGS.tradeCosts)
  })

  it('2026-09-03 之前写进文件的印花税/过户费被静默剥掉 —— 那是过期一倍的规则', () => {
    const legacy = {
      commissionRate: 0.0001,
      minCommission: 0,
      stampTaxRate: 0.001, // 已经过期：2023-08-28 起是 0.0005
      transferFeeRate: 0.00001,
    }
    const result = sanitizeSettings({ tradeCosts: legacy })
    expect(result.settings.tradeCosts).toEqual({ commissionRate: 0.0001, minCommission: 0 })
    // 剥掉不算「修复」—— 它不是坏值，只是不该由设置管
    expect(result.repaired.map((r) => r.field)).not.toContain('tradeCosts')
  })

  it('来路（tradeCostsSource）坏掉时**只丢来路，不丢费率**', () => {
    // 单独一个顶层键就是为了这个：sanitizeSettings 是逐顶层键修的，
    // 塞进 tradeCosts 里的话一个坏掉的来路会把校正对了的费率一起丢掉
    const rates = { ...DEFAULT_SETTINGS.tradeCosts, commissionRate: 0.0001 }
    const result = sanitizeSettings({ tradeCosts: rates, tradeCostsSource: { code: '' } })
    expect(result.settings.tradeCosts).toEqual(rates)
    expect('tradeCostsSource' in result.settings).toBe(false)
    expect(result.repaired.map((r) => r.field)).toContain('tradeCostsSource')
  })

  it('合法的来路原样保留', () => {
    const source = {
      code: 'SH600000',
      targetFeeTotal: 85.11,
      throughMs: 1_699_900_000_000,
      commissionRate: 0.0001,
      minCommission: 0,
      at: 1_700_000_000_000,
    }
    expect(sanitizeSettings({ tradeCostsSource: source }).settings.tradeCostsSource).toEqual(source)
  })
})
