/**
 * ProviderRegistry：优先级、降级、熔断冷却、健康度、一致性抽检（docs/03 §2.2）。
 *
 * 全部用假 provider —— 不发请求、不碰 fixture。这里测的是编排逻辑，
 * 各源的解析正确性由 tests/integration/providers 负责。
 */

import { describe, expect, it } from 'vitest'
import type { Candle, SecCode, SecProfile, Snapshot } from '@core/types'
import {
  AllProvidersUnavailableError,
  DEFAULT_REGISTRY_OPTIONS,
  createProviderRegistry,
  type HealthSink,
} from '@main/providers/registry'
import { DEFAULT_SETTINGS } from '@main/settings/schema'
import type { HealthRecord, ProviderCapabilities, ProviderId, QuoteProvider } from '@main/providers/types'

const FULL: ProviderCapabilities = {
  daily: true,
  snapshot: true,
  minute: false,
  profile: true,
  calendar: true,
}

interface FakeSpec {
  id: ProviderId
  capabilities?: Partial<ProviderCapabilities>
  /** 每次调用的行为：'ok' | 'fail' | 'empty' | 'hang'，用尽后重复最后一个 */
  script?: ('ok' | 'fail' | 'empty' | 'hang')[]
  last?: number
}

function snapshotOf(code: SecCode, last: number, suspended = false): Snapshot {
  return {
    code,
    at: 0,
    last,
    open: last,
    high: last,
    low: last,
    preClose: last,
    volume: 100,
    amount: 100,
    limitUp: null,
    limitDown: null,
    suspended,
  }
}

function fake(spec: FakeSpec) {
  const calls: string[] = []
  let step = 0

  function next(): 'ok' | 'fail' | 'empty' | 'hang' {
    const script = spec.script ?? ['ok']
    const action = script[Math.min(step, script.length - 1)] ?? 'ok'
    step += 1
    return action
  }

  async function act<T>(label: string, okValue: T, emptyValue: T): Promise<T> {
    calls.push(label)
    const action = next()
    if (action === 'fail') throw new Error(`${spec.id} 挂了`)
    if (action === 'hang') await new Promise((resolve) => setTimeout(resolve, 5_000))
    return action === 'empty' ? emptyValue : okValue
  }

  const provider: QuoteProvider = {
    id: spec.id,
    capabilities: { ...FULL, ...spec.capabilities },
    fetchDaily: () => act<Candle[]>('daily', [BAR], []),
    fetchSnapshots: (codes) =>
      act<Snapshot[]>(
        'snapshot',
        codes.map((code) => snapshotOf(code, spec.last ?? 10)),
        []
      ),
    fetchProfile: (code) =>
      act<SecProfile>(
        'profile',
        { code, name: spec.id, market: 'SH', board: 'MAIN', isST: false },
        { code, name: spec.id, market: 'SH', board: 'MAIN', isST: false }
      ),
    fetchCalendar: () => act('calendar', [{ date: '2026-01-05' as const, isOpen: true }], []),
  }

  return { provider, calls }
}

const BAR: Candle = {
  date: '2026-08-11',
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  openAdj: 1,
  highAdj: 1,
  lowAdj: 1,
  closeAdj: 1,
  volume: 1,
  amount: null,
  provisional: false,
}

function sink() {
  const records: HealthRecord[] = []
  const health: HealthSink = { record: (entry) => records.push(entry) }
  return { health, records }
}

describe('ProviderRegistry · 优先级与降级', () => {
  it('第一优先级成功时不碰备源', async () => {
    const em = fake({ id: 'eastmoney' })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
    })

    const result = await registry.fetchSnapshots(['SH600000'])
    expect(result.provider).toBe('eastmoney')
    expect(result.degraded).toBe(false)
    expect(sina.calls).toHaveLength(0)
  })

  it('主源失败即降级到下一个，并标记 degraded', async () => {
    const em = fake({ id: 'eastmoney', script: ['fail'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
    })

    const result = await registry.fetchSnapshots(['SH600000'])
    expect(result.provider).toBe('sina')
    expect(result.degraded).toBe(true)
    expect(result.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['eastmoney', false],
      ['sina', true],
    ])
  })

  it('不声明该能力的源直接跳过，不浪费一次请求', async () => {
    // 新浪不做日线（capabilities.daily = false）
    const sina = fake({ id: 'sina', capabilities: { daily: false } })
    const tencent = fake({ id: 'tencent' })
    const registry = createProviderRegistry({
      providers: { sina: sina.provider, tencent: tencent.provider },
    })

    const result = await registry.fetchDaily('SH600000', '2026-01-01', '2026-08-11', 'qfq')
    expect(result.provider).toBe('tencent')
    // 跳过不算「尝试过」—— 否则健康度里会出现一堆假的失败
    expect(result.attempts).toHaveLength(1)
    expect(sina.calls).toHaveLength(0)
    expect(result.degraded).toBe(false)
  })

  it('全部失败时抛 AllProvidersUnavailableError，绝不返回空数组', async () => {
    const em = fake({ id: 'eastmoney', script: ['fail'] })
    const sina = fake({ id: 'sina', script: ['fail'] })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
    })

    await expect(registry.fetchSnapshots(['SH600000'])).rejects.toBeInstanceOf(
      AllProvidersUnavailableError
    )
    // 错误信息要能看出每个源分别怎么挂的
    await expect(registry.fetchSnapshots(['SH600000'])).rejects.toThrow(/eastmoney 挂了/)
  })

  it('一个源都没装配时也是抛错而不是静默返回', async () => {
    const registry = createProviderRegistry({ providers: {} })
    await expect(registry.fetchProfile('SH600000')).rejects.toThrow(/没有可用的数据源/)
  })

  it('快照拿回 0 条视为失败并继续降级 —— 空快照会被上层当成「没有行情」', async () => {
    const em = fake({ id: 'eastmoney', script: ['empty'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
    })

    const result = await registry.fetchSnapshots(['SH600000'])
    expect(result.provider).toBe('sina')
    expect(result.attempts[0]?.error).toContain('返回空结果')
  })

  it('日线返回空不算失败 —— 区间内真的可能没有交易日', async () => {
    const tencent = fake({ id: 'tencent', script: ['empty'] })
    const registry = createProviderRegistry({ providers: { tencent: tencent.provider } })

    const result = await registry.fetchDaily('SH600000', '2026-01-01', '2026-01-02', 'qfq')
    expect(result.value).toEqual([])
    expect(result.provider).toBe('tencent')
  })

  it('空代码列表不发请求', async () => {
    const em = fake({ id: 'eastmoney' })
    const registry = createProviderRegistry({ providers: { eastmoney: em.provider } })
    const result = await registry.fetchSnapshots([])
    expect(result.value).toEqual([])
    expect(em.calls).toHaveLength(0)
  })

  it('声明了 calendar 却没实现方法 —— 暴露装配错误而不是返回空日历', async () => {
    const broken: QuoteProvider = { ...fake({ id: 'tencent' }).provider }
    delete (broken as { fetchCalendar?: unknown }).fetchCalendar
    const registry = createProviderRegistry({ providers: { tencent: broken } })
    await expect(registry.fetchCalendar(2026)).rejects.toThrow(/声明了 calendar 但未实现/)
  })
})

describe('ProviderRegistry · 熔断与冷却', () => {
  it('连续失败达阈值后标 DEGRADED 并冷却，期间排到最后', async () => {
    let clock = 1_000
    const em = fake({ id: 'eastmoney', script: ['fail', 'fail', 'fail', 'ok'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      now: () => clock,
    })

    for (let i = 0; i < 3; i++) await registry.fetchSnapshots(['SH600000'])
    expect(registry.statusOf('eastmoney')).toBe('DEGRADED')
    expect(em.calls).toHaveLength(3)

    // 冷却窗口内：主源不再被优先尝试，直接走新浪
    clock += 60_000
    const during = await registry.fetchSnapshots(['SH600000'])
    expect(during.provider).toBe('sina')
    expect(during.degraded).toBe(false)
    expect(em.calls).toHaveLength(3)
  })

  it('冷却到期后半开：试探一次，成功即恢复 OK', async () => {
    let clock = 1_000
    const em = fake({ id: 'eastmoney', script: ['fail', 'fail', 'fail', 'ok'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      now: () => clock,
    })

    for (let i = 0; i < 3; i++) await registry.fetchSnapshots(['SH600000'])
    clock += DEFAULT_REGISTRY_OPTIONS.cooldownMs + 1

    const after = await registry.fetchSnapshots(['SH600000'])
    expect(after.provider).toBe('eastmoney')
    expect(registry.statusOf('eastmoney')).toBe('OK')
    expect(registry.states()[0]?.cooldownUntil).toBe(0)
  })

  it('冷却完再次连续失败 → DOWN，不再当成抖动', async () => {
    let clock = 1_000
    const em = fake({ id: 'eastmoney', script: ['fail'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      now: () => clock,
    })

    for (let i = 0; i < 3; i++) await registry.fetchSnapshots(['SH600000'])
    expect(registry.statusOf('eastmoney')).toBe('DEGRADED')

    clock += DEFAULT_REGISTRY_OPTIONS.cooldownMs + 1
    for (let i = 0; i < 3; i++) await registry.fetchSnapshots(['SH600000'])
    expect(registry.statusOf('eastmoney')).toBe('DOWN')
  })

  it('全部在冷却中时仍然试探，不让软件在冷却窗口里彻底静默', async () => {
    let clock = 1_000
    // 前 3 次失败触发熔断，第 4 次开始恢复
    const em = fake({ id: 'eastmoney', script: ['fail', 'fail', 'fail', 'ok'] })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider },
      now: () => clock,
    })

    for (let i = 0; i < 3; i++) {
      await expect(registry.fetchSnapshots(['SH600000'])).rejects.toThrow()
    }
    expect(registry.statusOf('eastmoney')).toBe('DEGRADED')

    clock += 1_000
    const result = await registry.fetchSnapshots(['SH600000'])
    expect(result.provider).toBe('eastmoney')
  })

  it('一次成功即清零连续失败计数', async () => {
    const em = fake({ id: 'eastmoney', script: ['fail', 'ok', 'fail'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
    })

    await registry.fetchSnapshots(['SH600000'])
    await registry.fetchSnapshots(['SH600000'])
    await registry.fetchSnapshots(['SH600000'])
    expect(registry.states()[0]).toMatchObject({ status: 'OK', consecutiveFailures: 1 })
  })

  it('reset 清空熔断，供用户手动「立即重试」', async () => {
    let clock = 1_000
    const em = fake({ id: 'eastmoney', script: ['fail', 'fail', 'fail', 'ok'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      now: () => clock,
    })

    for (let i = 0; i < 3; i++) await registry.fetchSnapshots(['SH600000'])
    registry.reset('eastmoney')
    expect(registry.statusOf('eastmoney')).toBe('OK')

    clock += 1
    expect((await registry.fetchSnapshots(['SH600000'])).provider).toBe('eastmoney')
  })

  it('挂住不返回的源被 attemptDeadlineMs 掐断，不拖死整个 tick', async () => {
    const em = fake({ id: 'eastmoney', script: ['hang'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      options: { attemptDeadlineMs: 20 },
    })

    const result = await registry.fetchSnapshots(['SH600000'])
    expect(result.provider).toBe('sina')
    expect(result.attempts[0]?.error).toMatch(/超过 20ms 未返回/)
  })
})

describe('ProviderRegistry · 健康度', () => {
  it('成功也写一条 —— 「悄悄换了源」必须留痕', async () => {
    const { health, records } = sink()
    const em = fake({ id: 'eastmoney', script: ['fail'] })
    const sina = fake({ id: 'sina' })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      health,
      now: () => 1_700_000_000_000,
    })

    await registry.fetchSnapshots(['SH600000'])
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ provider: 'eastmoney', ok: false, at: 1_700_000_000_000 })
    expect(records[0]?.error).toContain('snapshot ×1')
    expect(records[1]).toMatchObject({ provider: 'sina', ok: true })
  })

  it('错误信息截断 —— 免费源常返回整页 HTML，别把库撑大', async () => {
    const { health, records } = sink()
    const bad: QuoteProvider = {
      ...fake({ id: 'eastmoney' }).provider,
      fetchProfile: () => Promise.reject(new Error('x'.repeat(2000))),
    }
    const registry = createProviderRegistry({ providers: { eastmoney: bad }, health })

    await expect(registry.fetchProfile('SH600000')).rejects.toThrow()
    expect((records[0]?.error ?? '').length).toBeLessThanOrEqual(340)
    expect(records[0]?.error).toContain('…')
  })

  it('states 按优先级列出，未装配的源不出现', () => {
    const registry = createProviderRegistry({
      providers: { tencent: fake({ id: 'tencent' }).provider, sina: fake({ id: 'sina' }).provider },
    })
    expect(registry.states().map((s) => s.provider)).toEqual(['tencent', 'sina'])
  })
})

describe('ProviderRegistry · 一致性抽检', () => {
  it('偏差超过 1% 记告警，且两边都记成 ok=true —— 不知道是谁错，不能降级任何一方', async () => {
    const { health, records } = sink()
    const em = fake({ id: 'eastmoney', last: 10 })
    const sina = fake({ id: 'sina', last: 10.2 })
    const registry = createProviderRegistry({
      providers: { eastmoney: em.provider, sina: sina.provider },
      health,
    })

    const alarms = await registry.crossCheck(['SH600000'])
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toMatchObject({ code: 'SH600000' })
    expect(alarms[0]?.deviation).toBeCloseTo(0.0196, 4)

    expect(records).toHaveLength(2)
    expect(records.every((r) => r.ok)).toBe(true)
    expect(records[0]?.error).toContain('一致性告警')
    // 抽检不影响任何一方的状态
    expect(registry.statusOf('eastmoney')).toBe('OK')
    expect(registry.statusOf('sina')).toBe('OK')
  })

  it('1% 以内不报，也不写记录', async () => {
    const { health, records } = sink()
    const registry = createProviderRegistry({
      providers: {
        eastmoney: fake({ id: 'eastmoney', last: 10 }).provider,
        sina: fake({ id: 'sina', last: 10.05 }).provider,
      },
      health,
    })

    expect(await registry.crossCheck(['SH600000'])).toEqual([])
    expect(records).toHaveLength(0)
  })

  it('停牌股不参与比对 —— 停牌时两源的「最新价」口径本就不同', async () => {
    const suspendedProvider: QuoteProvider = {
      ...fake({ id: 'sina' }).provider,
      fetchSnapshots: (codes) =>
        Promise.resolve(codes.map((code) => snapshotOf(code, 8.17, true))),
    }
    const registry = createProviderRegistry({
      providers: { eastmoney: fake({ id: 'eastmoney', last: 10 }).provider, sina: suspendedProvider },
    })
    expect(await registry.crossCheck(['SH600000'])).toEqual([])
  })

  it('只有一个可用快照源时跳过抽检', async () => {
    const registry = createProviderRegistry({
      providers: { eastmoney: fake({ id: 'eastmoney' }).provider },
    })
    expect(await registry.crossCheck(['SH600000'])).toEqual([])
  })

  it('抽检本身失败不影响主链路，也不记失败', async () => {
    const { health, records } = sink()
    const registry = createProviderRegistry({
      providers: {
        eastmoney: fake({ id: 'eastmoney', script: ['fail'] }).provider,
        sina: fake({ id: 'sina' }).provider,
      },
      health,
    })
    expect(await registry.crossCheck(['SH600000'])).toEqual([])
    expect(records).toHaveLength(0)
    expect(registry.statusOf('eastmoney')).toBe('OK')
  })

  it('优先级可覆盖', async () => {
    const registry = createProviderRegistry({
      providers: {
        eastmoney: fake({ id: 'eastmoney' }).provider,
        tencent: fake({ id: 'tencent' }).provider,
      },
      options: { priority: ['tencent', 'eastmoney'] },
    })
    expect((await registry.fetchSnapshots(['SH600000'])).provider).toBe('tencent')
  })

  it('默认优先级与 settings 的出厂默认一致 —— 两处不同步是最难查的配置坑', () => {
    expect(DEFAULT_REGISTRY_OPTIONS.priority).toEqual(DEFAULT_SETTINGS.providerPriority)
    expect(DEFAULT_REGISTRY_OPTIONS.priority).toEqual(['eastmoney', 'tencent', 'sina'])
    expect(DEFAULT_REGISTRY_OPTIONS.failureThreshold).toBe(3)
    expect(DEFAULT_REGISTRY_OPTIONS.cooldownMs).toBe(300_000)
    expect(DEFAULT_REGISTRY_OPTIONS.globalConcurrency).toBe(4)
    expect(DEFAULT_REGISTRY_OPTIONS.perProviderConcurrency).toBe(2)
  })
})
