/**
 * 存储层集成测试（docs/07 §5：迁移、裁剪、并发读写）。
 *
 * 驱动用 node:sqlite 而非 better-sqlite3：后者的 .node 一旦按 Electron ABI 重建，
 * 在 Vitest（Node）里加载会直接段错误。被测的是我们的 SQL 与迁移逻辑，
 * 那部分与驱动无关 —— 驱动本身的可用性靠 `pnpm dev` 真启一次来验（CLAUDE.md）。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Candle, SecProfile } from '@core/types'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import { openNodeSqlite } from '@main/storage/driver'
import { LATEST_SCHEMA_VERSION } from '@main/storage/migrations'
import { DEFAULT_RETENTION, pruneAll, pruneIfDue } from '@main/storage/retention'
import { percentile } from '@main/storage/repositories/health'
import { META_KEYS } from '@main/storage/repositories/meta'

const DRIVER = 'node:sqlite' as const

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function profile(code: string, name: string, over: Partial<SecProfile> = {}): SecProfile {
  return { code, name, market: 'SH', board: 'MAIN', isST: false, ...over }
}

function candle(date: string, close: number, over: Partial<Candle> = {}): Candle {
  return {
    date,
    open: close,
    high: close,
    low: close,
    close,
    openAdj: close,
    highAdj: close,
    lowAdj: close,
    closeAdj: close,
    volume: 1000,
    amount: close * 1000,
    ...over,
  }
}

describe('迁移', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gp-db-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('空目录首次启动即建库并落到最新版本', async () => {
    const file = join(dir, 'market.db')
    const db = await openDatabase({ file, driver: DRIVER })
    expect(db.schemaVersion).toBe(LATEST_SCHEMA_VERSION)

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all<{ name: string }>()
      .map((r) => r.name)
    // docs/03 §4.2 的全部表都要在 M1 一次建好
    expect(tables).toEqual(
      expect.arrayContaining([
        'alert_log',
        'indicator_daily',
        'kline_daily',
        'meta',
        'position',
        'provider_health',
        'quote_tick',
        'watch_point',
        'signal',
        'trade_calendar',
        'watchlist',
      ])
    )
    db.close()
  })

  it('重复打开是幂等的，不重复建表也不重复备份', async () => {
    const file = join(dir, 'market.db')
    const first = await openDatabase({ file, driver: DRIVER })
    first.close()
    const second = await openDatabase({ file, driver: DRIVER })
    expect(second.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    second.close()
    expect(readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([])
  })

  it('从更早的 schema 迁移时先备份，且只保留 1 份', async () => {
    const file = join(dir, 'market.db')
    // 造一个「有数据但没有版本号」的库：绕开迁移直接建表，模拟迁移体系之前的历史形态
    const legacy = await openNodeSqlite(file)
    legacy.exec(`CREATE TABLE legacy (x INTEGER)`)
    legacy.exec(`INSERT INTO legacy VALUES (1)`)
    legacy.close()

    writeFileSync(join(dir, 'market.db.bak-stale'), 'stale')
    const migrated = await openDatabase({ file, driver: DRIVER })
    expect(migrated.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    migrated.close()

    const backups = readdirSync(dir).filter((f) => f.startsWith('market.db.bak-'))
    expect(backups).toHaveLength(1)
  })

  it('库的版本高于本版支持时拒绝打开而不是硬用', async () => {
    const file = join(dir, 'market.db')
    const db = await openDatabase({ file, driver: DRIVER })
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run('999')
    db.close()

    await expect(openDatabase({ file, driver: DRIVER })).rejects.toThrow(/高于本版/)
  })

  it('删掉 market.db 后启动自动重建（docs/07 §6）', async () => {
    const file = join(dir, 'market.db')
    const db = await openDatabase({ file, driver: DRIVER })
    createStorage(db).watchlist.add(profile('SH600000', '浦发银行'), '自选', 1)
    db.close()

    rmSync(file, { force: true })
    rmSync(`${file}-wal`, { force: true })
    rmSync(`${file}-shm`, { force: true })
    expect(existsSync(file)).toBe(false)

    const rebuilt = await openDatabase({ file, driver: DRIVER })
    expect(rebuilt.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(createStorage(rebuilt).watchlist.count()).toBe(0)
    rebuilt.close()
  })
})

describe('WatchlistRepo', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('新增按加入顺序排序，重复添加刷新名称而不报错', () => {
    storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', 100)
    storage.watchlist.add(profile('SZ000001', '平安银行', { market: 'SZ' }), '银行', 200)
    expect(storage.watchlist.codes()).toEqual(['SH600000', 'SZ000001'])

    const again = storage.watchlist.add(profile('SH600000', '浦发银行A', { industry: '银行' }), '别的组', 300)
    expect(storage.watchlist.count()).toBe(2)
    expect(again.profile.name).toBe('浦发银行A')
    // 分组与排序不被重复添加覆盖
    expect(again.group).toBe('自选')
    expect(again.sortOrder).toBe(0)
    expect(again.profile.industry).toBe('银行')
  })

  it('行业为空时不覆盖已有行业', () => {
    storage.watchlist.add(profile('SH600000', '浦发银行', { industry: '银行' }), '自选', 1)
    const updated = storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', 2)
    expect(updated.profile.industry).toBe('银行')
  })

  it('ST 由名称推出，不单独存字段', () => {
    const entry = storage.watchlist.add(profile('SH600001', '*ST 某某'), '自选', 1)
    expect(entry.profile.isST).toBe(true)
  })

  it('reorder 把未列出的代码排在其后', () => {
    for (const [code, name] of [
      ['SH600000', 'A'],
      ['SH600001', 'B'],
      ['SH600002', 'C'],
    ] as const) {
      storage.watchlist.add(profile(code, name), '自选', 1)
    }
    storage.watchlist.reorder(['SH600002'])
    expect(storage.watchlist.codes()).toEqual(['SH600002', 'SH600000', 'SH600001'])
  })

  it('删除自选股会连带清掉持仓（外键指向 watchlist）', () => {
    storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', 1)
    storage.positions.set('SH600000', 1000, 9.5, 1)
    expect(storage.positions.get('SH600000')).not.toBeNull()

    expect(storage.watchlist.remove('SH600000')).toBe(true)
    expect(storage.positions.get('SH600000')).toBeNull()
    expect(storage.watchlist.remove('SH600000')).toBe(false)
  })
})

describe('PositionRepo', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
    storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', 1)
    storage.watchlist.add(profile('SZ000001', '平安银行', { market: 'SZ' }), '自选', 1)
  })
  afterEach(() => storage.close())

  it('成本价按不复权价原样存，股数取整', () => {
    storage.positions.set('SH600000', 1000.6, 9.53, 1_700_000_000_000)
    const position = storage.positions.get('SH600000')

    expect(position?.shares).toBe(1001)
    expect(position?.cost).toBeCloseTo(9.53, 6)
    // 持有期最高价缺省等于成本价：至少是买入时付的钱
    expect(position?.peakPrice).toBeCloseTo(9.53, 6)
    expect(position?.openedAt).toBe(1_700_000_000_000)
  })

  it('重复录入更新股数与成本，但不重置建仓时间', () => {
    storage.positions.set('SH600000', 1000, 9.5, 100)
    storage.positions.set('SH600000', 2000, 8.8, 999)

    const position = storage.positions.get('SH600000')
    expect(position?.shares).toBe(2000)
    expect(position?.cost).toBeCloseTo(8.8, 6)
    expect(position?.openedAt).toBe(100)
  })

  it('bumpPeak 只允许上调 —— 回撤提醒的基准不能被一次下跌抹掉', () => {
    storage.positions.set('SH600000', 1000, 10, 1)
    storage.positions.bumpPeak('SH600000', 12)
    expect(storage.positions.get('SH600000')?.peakPrice).toBeCloseTo(12, 6)

    storage.positions.bumpPeak('SH600000', 9)
    expect(storage.positions.get('SH600000')?.peakPrice).toBeCloseTo(12, 6)
  })

  it('list 按代码排序，codes 给出持仓集合，clear 幂等', () => {
    storage.positions.set('SZ000001', 500, 11, 1)
    storage.positions.set('SH600000', 1000, 9.5, 1)

    expect(storage.positions.list().map((p) => p.code)).toEqual(['SH600000', 'SZ000001'])
    expect(storage.positions.codes()).toEqual(new Set(['SH600000', 'SZ000001']))

    expect(storage.positions.clear('SH600000')).toBe(true)
    expect(storage.positions.clear('SH600000')).toBe(false)
    expect(storage.positions.codes()).toEqual(new Set(['SZ000001']))
  })
})

describe('KlineRepo', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('provisional K 线不落库 —— 历史不允许被盘中值改写', () => {
    const written = storage.klines.upsertMany(
      'SH600000',
      [candle('2024-01-08', 10), candle('2024-01-09', 10.5, { provisional: true })],
      'tencent'
    )
    expect(written).toBe(1)
    expect(storage.klines.lastDate('SH600000')).toBe('2024-01-08')
  })

  it('同日重复写入是更新而非插入，并保留 hasGap', () => {
    storage.klines.upsertMany('SH600000', [candle('2024-01-08', 10)], 'tencent')
    storage.klines.upsertMany('SH600000', [candle('2024-01-08', 11, { hasGap: true })], 'eastmoney')
    const rows = storage.klines.recent('SH600000', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ close: 11, hasGap: true })
  })

  it('recent 升序返回且只取最近 N 根', () => {
    const days = ['2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11']
    storage.klines.upsertMany(
      'SH600000',
      days.map((d, i) => candle(d, 10 + i)),
      'tencent'
    )
    expect(storage.klines.recent('SH600000', 2).map((c) => c.date)).toEqual(['2024-01-10', '2024-01-11'])
    expect(storage.klines.recent('SH600000', 0)).toEqual([])
    expect(storage.klines.range('SH600000', '2024-01-09', '2024-01-10').map((c) => c.date)).toEqual([
      '2024-01-09',
      '2024-01-10',
    ])
    expect(storage.klines.count('SH600000')).toBe(4)
  })

  it('amount 缺失存 null 而不是 0', () => {
    storage.klines.upsertMany('SH600000', [candle('2024-01-08', 10, { amount: null })], 'tencent')
    expect(storage.klines.recent('SH600000', 1)[0]?.amount).toBeNull()
  })

  it('adj_factor 由两套价格反算并落库', () => {
    storage.klines.upsertMany(
      'SH600000',
      [candle('2024-01-08', 10, { closeAdj: 5, openAdj: 5, highAdj: 5, lowAdj: 5 })],
      'tencent'
    )
    const row = storage.db
      .prepare(`SELECT adj_factor FROM kline_daily WHERE code = ?`)
      .get<{ adj_factor: number }>('SH600000')
    expect(row?.adj_factor).toBeCloseTo(0.5, 10)
  })

  it('deleteAll 用于复权口径变化后的整只重拉', () => {
    storage.klines.upsertMany('SH600000', [candle('2024-01-08', 10), candle('2024-01-09', 10)], 'tencent')
    expect(storage.klines.deleteAll('SH600000')).toBe(2)
    expect(storage.klines.lastDate('SH600000')).toBeNull()
  })
})

describe('CalendarRepo', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('未收录的日期返回 null，而不是当成休市', () => {
    storage.calendar.upsertMany(
      [
        { date: '2024-02-08', isOpen: true },
        { date: '2024-02-09', isOpen: false },
      ],
      'eastmoney'
    )
    expect(storage.calendar.isOpen('2024-02-08')).toBe(true)
    expect(storage.calendar.isOpen('2024-02-09')).toBe(false)
    expect(storage.calendar.isOpen('2024-02-10')).toBeNull()
    expect(storage.calendar.openDays('2024-01-01', '2024-12-31')).toEqual(['2024-02-08'])
    expect(storage.calendar.coverageEnd()).toBe('2024-02-09')
    expect(storage.calendar.count()).toBe(2)
  })

  it('重复刷新覆盖旧值', () => {
    storage.calendar.upsertMany([{ date: '2024-02-09', isOpen: false }], 'fallback')
    storage.calendar.upsertMany([{ date: '2024-02-09', isOpen: true }], 'eastmoney')
    expect(storage.calendar.isOpen('2024-02-09')).toBe(true)
    expect(storage.calendar.upsertMany([], 'eastmoney')).toBe(0)
  })
})

describe('ProviderHealthRepo', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('滑动窗口成功率与 p95 只算成功请求的延迟', () => {
    const now = 1_700_000_000_000
    storage.health.record({ provider: 'eastmoney', at: now - 1000, ok: true, latencyMs: 100 })
    storage.health.record({ provider: 'eastmoney', at: now - 900, ok: true, latencyMs: 900 })
    storage.health.record({ provider: 'eastmoney', at: now - 800, ok: false, error: '超时' })
    // 窗口外的记录不参与统计
    storage.health.record({ provider: 'eastmoney', at: now - 10 * 60_000, ok: false, error: '旧错误' })
    storage.health.record({ provider: 'sina', at: now - 500, ok: true, latencyMs: 50 })

    const stats = storage.health.stats(now - 60_000)
    const eastmoney = stats.find((s) => s.provider === 'eastmoney')
    expect(eastmoney).toMatchObject({ total: 3, okCount: 2, lastError: '超时' })
    expect(eastmoney?.successRate).toBeCloseTo(2 / 3, 6)
    expect(eastmoney?.p95LatencyMs).toBe(900)
    expect(stats.find((s) => s.provider === 'sina')?.successRate).toBe(1)
  })

  it('全成功时没有 lastError 字段', () => {
    const now = 1_700_000_000_000
    storage.health.record({ provider: 'sina', at: now, ok: true, latencyMs: 10 })
    expect(storage.health.stats(now - 1000)[0]?.lastError).toBeUndefined()
  })

  it('percentile 在样本稀疏时退化为最大值而不假装精度', () => {
    expect(percentile([], 0.95)).toBe(0)
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
  })
})

describe('新增列（005 / 006）', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('watch_point 的 verdict / verdict_text 可空可读写', () => {
    const cols = storage.db
      .prepare(`SELECT name FROM pragma_table_info('watch_point')`)
      .all<{ name: string }>()
      .map((r) => r.name)
    expect(cols).toEqual(expect.arrayContaining(['verdict', 'verdict_text']))
  })

  it('alert_log 的 repeat_count 对既有行默认 1，bumpRepeat 递增且不动 read_at', () => {
    storage.db
      .prepare(
        `INSERT INTO signal (id, code, created_at, trade_date, direction, score, votes, regime, stage, price_at, evidence, engine_version)
         VALUES ('sig', 'SH600000', 0, '2024-01-02', 'BUY', 0.7, 3, 'RANGE', 'CONFIRMED', 10, '{}', 'v')`
      )
      .run()
    storage.alerts.insert({
      id: 'a1',
      signalId: 'sig',
      level: 'L2',
      channels: ['BUBBLE'],
      suppressedReason: null,
      readAt: 123,
      createdAt: 100,
    })
    expect(storage.alerts.get('a1')?.repeatCount).toBe(1)

    expect(storage.alerts.bumpRepeat('a1', 200)).toBe(true)
    expect(storage.alerts.bumpRepeat('a1', 300)).toBe(true)
    const row = storage.alerts.get('a1')
    expect(row?.repeatCount).toBe(3)
    expect(row?.lastAt).toBe(300)
    // 已读的行不该因为这个状态还在持续就变回未读
    expect(row?.readAt).toBe(123)
  })

  it('bumpRepeat 对不存在的行返回 false —— 调用方据此退回插新行', () => {
    expect(storage.alerts.bumpRepeat('nope', 1)).toBe(false)
  })
})

describe('QuoteTickRepo', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  const T = 1_700_000_000_000

  it('主键 (code, ts) 就是幂等闸门 —— 同一时刻写两次只留一行', () => {
    // 盘后还会跑好几轮 tick，快照时刻不变时不该攒出新点。
    // 少了这道闸门，净值…不，折线图上「点多了」这件事完全看不出来
    expect(storage.quoteTicks.record([{ code: 'SH600000', ts: T, last: 10, preClose: 9.9 }])).toBe(1)
    expect(storage.quoteTicks.record([{ code: 'SH600000', ts: T, last: 10.5, preClose: 9.9 }])).toBe(0)
    expect(storage.quoteTicks.series('SH600000', T - 1000, T + 1000)).toEqual([{ ts: T, last: 10 }])
  })

  it('series 按 ts 升序，且只取区间内的点', () => {
    storage.quoteTicks.record([
      { code: 'SH600000', ts: T + 2000, last: 11, preClose: 9.9 },
      { code: 'SH600000', ts: T, last: 10, preClose: 9.9 },
      { code: 'SH600000', ts: T + 9999, last: 12, preClose: 9.9 },
      { code: 'SZ000001', ts: T, last: 5, preClose: 4.9 },
    ])
    expect(storage.quoteTicks.series('SH600000', T, T + 5000)).toEqual([
      { ts: T, last: 10 },
      { ts: T + 2000, last: 11 },
    ])
  })

  it('last 非有限值的行被跳过，preClose 缺失存 null 而不是 0（约束 4）', () => {
    // preClose 填 0 会让图上的基准线跑到坐标轴底下，把整张图的纵轴压扁
    expect(storage.quoteTicks.record([{ code: 'SH600000', ts: T, last: Number.NaN, preClose: 1 }])).toBe(0)
    storage.quoteTicks.record([{ code: 'SH600000', ts: T + 1, last: 10, preClose: null }])
    expect(storage.quoteTicks.preCloseOf('SH600000', T, T + 100)).toBeNull()
  })

  it('preCloseOf 取区间里最后一个非空值 —— 跨日时晚的那个才是当天的昨收', () => {
    storage.quoteTicks.record([
      { code: 'SH600000', ts: T, last: 10, preClose: 9.9 },
      { code: 'SH600000', ts: T + 1000, last: 10, preClose: null },
      { code: 'SH600000', ts: T + 2000, last: 10, preClose: 10.4 },
    ])
    expect(storage.quoteTicks.preCloseOf('SH600000', T, T + 5000)).toBe(10.4)
  })
})

describe('裁剪', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('按策略裁剪日线、信号、提醒与健康度', () => {
    const now = 1_700_000_000_000
    const bars: Candle[] = []
    for (let i = 0; i < 20; i++) {
      bars.push(candle(`2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, 10))
    }
    storage.klines.upsertMany('SH600000', bars, 'tencent')
    storage.health.record({ provider: 'sina', at: now - 40 * 24 * 3600_000, ok: true, latencyMs: 10 })
    storage.health.record({ provider: 'sina', at: now, ok: true, latencyMs: 10 })

    storage.db
      .prepare(
        `INSERT INTO signal (id, code, created_at, trade_date, direction, score, votes, regime, stage, price_at, evidence, engine_version)
         VALUES (?, 'SH600000', ?, '2020-01-02', 'BUY', 0.7, 3, 'RANGE', 'CONFIRMED', 10, '{}', 'v')`
      )
      .run('old-signal', now - 800 * 24 * 3600_000)
    storage.db
      .prepare(`INSERT INTO alert_log (id, signal_id, level, channel, created_at) VALUES (?, ?, 'L2', 'BUBBLE', ?)`)
      .run('old-alert', 'old-signal', now - 800 * 24 * 3600_000)

    // 分时留痕按 7 天滚动：一个 8 天前的点该被删，今天的留下
    storage.quoteTicks.record([
      { code: 'SH600000', ts: now - 8 * 24 * 3600_000, last: 10, preClose: 9.9 },
      { code: 'SH600000', ts: now, last: 10, preClose: 9.9 },
    ])

    const report = pruneAll(storage.db, now, { ...DEFAULT_RETENTION, klineBars: 5 })
    expect(report.klineDeleted).toBe(15)
    expect(storage.klines.count('SH600000')).toBe(5)
    expect(report.signalDeleted).toBe(1)
    expect(report.alertDeleted).toBe(1)
    expect(report.healthDeleted).toBe(1)
    expect(report.quoteTickDeleted).toBe(1)
    expect(storage.quoteTicks.series('SH600000', 0, now)).toHaveLength(1)
    expect(storage.meta.getNumber(META_KEYS.lastPruneAt)).toBe(now)
  })

  it('pruneIfDue 在间隔内跳过', () => {
    const now = 1_700_000_000_000
    expect(pruneIfDue(storage.db, now)).not.toBeNull()
    expect(pruneIfDue(storage.db, now + 1000)).toBeNull()
    expect(pruneIfDue(storage.db, now + 25 * 3600_000)).not.toBeNull()
  })
})

describe('事务', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  it('抛错即整体回滚', () => {
    storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', 1)
    expect(() =>
      storage.db.transaction(() => {
        storage.watchlist.add(profile('SH600001', 'B'), '自选', 2)
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(storage.watchlist.codes()).toEqual(['SH600000'])
  })

  // 仓储方法自带事务是常态（reorder 就是），上层想把几个调用凑成一个原子操作
  // 不该被「这个方法里面有没有事务」绊倒 —— SQLite 的嵌套 BEGIN 直接报错
  it('可重入：嵌套事务并入外层，不再发一次 BEGIN', () => {
    storage.db.transaction(() => {
      storage.watchlist.add(profile('SH600000', 'A'), '自选', 1)
      storage.watchlist.add(profile('SH600001', 'B'), '自选', 2)
      // reorder 内部自己也开事务
      storage.watchlist.reorder(['SH600001', 'SH600000'])
    })
    expect(storage.watchlist.codes()).toEqual(['SH600001', 'SH600000'])
  })

  it('内层抛错时整体回滚到最外层之前', () => {
    storage.watchlist.add(profile('SH600000', 'A'), '自选', 1)
    expect(() =>
      storage.db.transaction(() => {
        storage.watchlist.add(profile('SH600001', 'B'), '自选', 2)
        storage.db.transaction(() => {
          throw new Error('inner boom')
        })
      })
    ).toThrow('inner boom')
    expect(storage.watchlist.codes()).toEqual(['SH600000'])
  })

  it('回滚后仍能继续开新事务（深度计数没有卡在 >0）', () => {
    expect(() =>
      storage.db.transaction(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    storage.db.transaction(() => storage.watchlist.add(profile('SH600002', 'C'), '自选', 3))
    expect(storage.watchlist.codes()).toEqual(['SH600002'])
  })
})
