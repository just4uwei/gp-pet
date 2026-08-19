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
        'trade_log',
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

  /*
    「用户确认接受的那一段亏损」（009_position_stop.sql）。

    最要紧的是**清空的时机**：加仓会改摊薄成本，旧的那条线与新成本不再是同一个判断。
    不清的话结果是静默少发止损提醒 —— 而少发的错误用户当时察觉不到、事后也归不了因。
  */
  it('acceptLoss 存下线与「当时接受了多大一段」', () => {
    storage.positions.set('SH600000', 1000, 11, 1)
    expect(storage.positions.acceptLoss('SH600000', 9.2, -9.1, 555)).toBe(true)

    // 风控只要 stopFloor
    expect(storage.positions.get('SH600000')?.stopFloor).toBeCloseTo(9.2, 6)
    // 界面要那三项 —— 「止损线 9.2」离开「他当时是在 −9.1% 确认的」就读不出意思
    expect(storage.positions.stopAck('SH600000')).toMatchObject({
      stopFloor: 9.2,
      ackAt: 555,
      ackLossPct: -9.1,
    })
  })

  /*
    **重画止损线不碰任何交易数据。**

    它改的只是「什么价位再提醒我」，不是「我这笔买入是多少钱」。
    成本、股数、建仓时刻、峰值价、`trade_log` 全部原样 —— 一列都不许动：
    成本一旦被改，`realized`（已实现盈亏）、影子运行的对照、
    以及用户自己对账用的那张成交表就全错了，而错法是静默的。

    判据用逐字段比较而不是「跑完没报错」：`acceptLoss` 是一条 UPDATE，
    日后有人往 SET 里多加一列（比如「顺手把 peak_price 重置一下」）时，
    这一条会红。
  */
  it('acceptLoss 只改止损线，成本 / 股数 / 建仓时刻 / 峰值价一律不动', () => {
    storage.positions.set('SH600000', 1000, 11, 1)
    const before = storage.positions.get('SH600000')

    storage.positions.acceptLoss('SH600000', 9.2, -9.1, 555)
    const after = storage.positions.get('SH600000')

    expect(after?.shares).toBe(before?.shares)
    expect(after?.cost).toBe(before?.cost)
    expect(after?.openedAt).toBe(before?.openedAt)
    expect(after?.peakPrice).toBe(before?.peakPrice)
    // 变的只有这一样
    expect(after?.stopFloor).toBeCloseTo(9.2, 6)
  })

  it('acceptLoss 不写 trade_log —— 它不是一笔成交', () => {
    storage.positions.set('SH600000', 1000, 11, 1)
    const before = storage.trades.listByCode('SH600000').length

    storage.positions.acceptLoss('SH600000', 9.2, -9.1, 555)

    expect(storage.trades.listByCode('SH600000')).toHaveLength(before)
  })

  it('没有这行持仓时 acceptLoss 什么都不做 —— 不给不存在的持仓建止损线', () => {
    expect(storage.positions.acceptLoss('SH600000', 9.2, -9, 1)).toBe(false)
    expect(storage.positions.stopAck('SH600000')).toBeNull()
  })

  it('**加仓（set）必须清掉止损确认**：成本变了，旧那条线不再是同一个判断', () => {
    storage.positions.set('SH600000', 1000, 11, 1)
    storage.positions.acceptLoss('SH600000', 9.2, -9.1, 555)
    storage.positions.set('SH600000', 2000, 10, 2)

    expect(storage.positions.stopAck('SH600000')).toBeNull()
    expect(storage.positions.get('SH600000')?.stopFloor).toBeUndefined()
  })

  it('清仓后再建仓不带着旧的线 —— 否则下次会莫名其妙地不提醒', () => {
    storage.positions.set('SH600000', 1000, 11, 1)
    storage.positions.acceptLoss('SH600000', 9.2, -9.1, 555)
    storage.positions.clear('SH600000')
    storage.positions.set('SH600000', 1000, 11, 9)

    expect(storage.positions.get('SH600000')?.stopFloor).toBeUndefined()
  })

  it('clearStop 撤销确认，回到按百分比判定', () => {
    storage.positions.set('SH600000', 1000, 11, 1)
    storage.positions.acceptLoss('SH600000', 9.2, -9.1, 555)
    expect(storage.positions.clearStop('SH600000')).toBe(true)
    expect(storage.positions.get('SH600000')?.stopFloor).toBeUndefined()
  })

  it('没确认过时 stopFloor 是 undefined，**不是 0**（约束 4）', () => {
    // 0 会被风控读成「跌到 0 才止损」，等于静默关掉整条规则
    storage.positions.set('SH600000', 1000, 11, 1)
    expect(storage.positions.get('SH600000')?.stopFloor).toBeUndefined()
    expect('stopFloor' in (storage.positions.get('SH600000') ?? {})).toBe(false)
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

describe('TradeRepo（007）', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  const T = 1_700_000_000_000
  const seedWatch = (): void => {
    storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', T)
  }

  it('迁移那条 INSERT…SELECT 把持仓补成一笔期初建仓 —— 否则「现持 1000 股、历史成交 0 笔」', () => {
    // 迁移是建库时跑的（那时 position 还是空的），所以这里验的是那条语句的**形状**：
    // 给一条持仓，按 007 里那句话补，应该得到一笔 OPENING
    seedWatch()
    storage.positions.set('SH600000', 1000, 10.5, T)
    storage.db
      .prepare(
        `INSERT INTO trade_log (id, code, side, traded_at, price, shares, fee, realized, note, created_at)
         SELECT 'opening-' || code, code, 'OPENING', opened_at, cost, shares, 0, NULL, '期初', opened_at
         FROM position`
      )
      .run()

    const seeded = storage.trades.listByCode('SH600000')
    expect(seeded).toHaveLength(1)
    expect(seeded[0]?.side).toBe('OPENING')
    expect(seeded[0]?.shares).toBe(1000)
    expect(seeded[0]?.price).toBe(10.5)
    // fee = 0 是「不知道」，不是「没有」—— 迁移时无从得知当时的费用
    expect(seeded[0]?.fee).toBe(0)
    // 期初没有已实现盈亏：**缺省，不是 0**（约束 4）
    expect(seeded[0]?.realized).toBeUndefined()
  })

  it('listByCode 升序（重放要的顺序），同一时刻按录入先后兜底', () => {
    seedWatch()
    const base = { code: 'SH600000' as const, price: 10, shares: 100, fee: 1 }
    storage.trades.insert({ ...base, id: 'b', side: 'BUY', tradedAt: T, createdAt: 2 })
    storage.trades.insert({ ...base, id: 'a', side: 'BUY', tradedAt: T, createdAt: 1 })
    storage.trades.insert({ ...base, id: 'c', side: 'SELL', tradedAt: T + 1000, createdAt: 3 })
    expect(storage.trades.listByCode('SH600000').map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('已实现盈亏与手续费按标的求和；没有卖出时是 0（这里的 0 是对的）', () => {
    seedWatch()
    storage.trades.insert({
      id: 't1', code: 'SH600000', side: 'BUY', tradedAt: T, price: 10, shares: 100, fee: 5, createdAt: T,
    })
    expect(storage.trades.sumRealized('SH600000')).toBe(0)
    storage.trades.insert({
      id: 't2', code: 'SH600000', side: 'SELL', tradedAt: T + 1, price: 12, shares: 100, fee: 6, realized: 189, createdAt: T,
    })
    expect(storage.trades.sumRealized('SH600000')).toBe(189)
    expect(storage.trades.sumFees('SH600000')).toBe(11)
  })

  /**
   * T+1 的锁定股数（`Position.lockedShares` 的来源）。
   *
   * 两条容易写错的：**只数 BUY**（`OPENING` 按定义是老仓，把它算进来会让
   * 刚导入配置的用户一整天卖不出任何东西），以及**日界是闭区间下界**
   * （`>= sinceMs`，恰好落在日界那一刻的成交算今天的）。
   */
  it('boughtSharesSince 只数买入，且不含期初建仓', () => {
    seedWatch()
    const base = { code: 'SH600000' as const, price: 10, fee: 1, createdAt: T }
    storage.trades.insert({ ...base, id: 'old', side: 'BUY', tradedAt: T - 1, shares: 700 })
    storage.trades.insert({ ...base, id: 'opening', side: 'OPENING', tradedAt: T + 10, shares: 5000 })
    storage.trades.insert({ ...base, id: 'today1', side: 'BUY', tradedAt: T, shares: 300 })
    storage.trades.insert({ ...base, id: 'today2', side: 'BUY', tradedAt: T + 100, shares: 200 })
    storage.trades.insert({ ...base, id: 'sell', side: 'SELL', tradedAt: T + 200, shares: 400 })

    // 日界那一刻的成交算「今天的」；更早的那笔不算；期初与卖出都不数
    expect(storage.trades.boughtSharesSince('SH600000', T)).toBe(500)
    expect(storage.trades.boughtSharesSince('SH600000', T - 1)).toBe(1200)
    expect(storage.trades.boughtSharesSince('SH600000', T + 1000)).toBe(0)
  })

  it('boughtSharesSince 按标的隔离，且没有流水时是 0', () => {
    seedWatch()
    storage.trades.insert({
      id: 'x', code: 'SZ000001', side: 'BUY', tradedAt: T, price: 10, shares: 100, fee: 1, createdAt: T,
    })
    expect(storage.trades.boughtSharesSince('SH600000', 0)).toBe(0)
  })

  it('移出自选**不**连带删账本 —— 卖光之后把票删掉，赚了多少不该跟着消失', () => {
    seedWatch()
    storage.trades.insert({
      id: 't1', code: 'SH600000', side: 'SELL', tradedAt: T, price: 12, shares: 100, fee: 6, realized: 189, createdAt: T,
    })
    storage.watchlist.remove('SH600000')
    expect(storage.trades.listByCode('SH600000')).toHaveLength(1)
    expect(storage.trades.sumRealized('SH600000')).toBe(189)
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

  /*
    `latest` 只服务一件事：重启之后先把上次看到的价显示出来。

    快照缓存在内存里，重启即空；而休市时段 `needsQuotes` 为 false ⇒ 不会有任何一轮 tick
    去补 ⇒ 晚上/周末重启之后，面板与悬浮条一直空到下一个交易日 09:00。
  */
  it('latest 每只票取最后一行，没有留痕的那只不出现在结果里', () => {
    storage.quoteTicks.record([
      { code: 'SH600000', ts: T, last: 10, preClose: 9.9 },
      { code: 'SH600000', ts: T + 2000, last: 11, preClose: 9.9 },
      { code: 'SZ000001', ts: T + 1000, last: 5, preClose: null },
    ])

    const latest = storage.quoteTicks.latest(['SH600000', 'SZ000001', 'SZ300750'])

    expect(latest.get('SH600000')).toEqual({ ts: T + 2000, last: 11, preClose: 9.9 })
    // 昨收缺失时是 null 而不是 0 —— 调用方据此给 0 涨跌幅，而不是算出一个 +∞
    expect(latest.get('SZ000001')).toEqual({ ts: T + 1000, last: 5, preClose: null })
    expect(latest.has('SZ300750')).toBe(false)
  })

  it('latest 传空数组时一条查询都不发', () => {
    expect(storage.quoteTicks.latest([]).size).toBe(0)
  })
})

describe('AiExplainRepo（008）', () => {
  let storage: Storage
  beforeEach(async () => {
    storage = await openMemory()
  })
  afterEach(() => storage.close())

  const T = 1_700_000_000_000
  const row = (id: string, code: string, createdAt: number, signalId = `sig-${id}`) => ({
    id,
    signalId,
    code,
    createdAt,
    elapsedMs: 12_000,
    text: `正文 ${id}`,
    model: 'qwen-max',
    protocol: 'openai' as const,
    direction: 'BUY' as const,
    stage: 'CONFIRMED' as const,
    score: 0.78,
    priceAt: 10.5,
    signalAt: createdAt - 60_000,
  })

  it('按 code 倒序（新的在上），与提醒日志、信号列表同向', () => {
    storage.aiExplains.insert(row('a', 'SH600000', T))
    storage.aiExplains.insert(row('c', 'SH600000', T + 2000))
    storage.aiExplains.insert(row('b', 'SH600000', T + 1000))
    storage.aiExplains.insert(row('x', 'SZ000001', T + 3000))

    expect(storage.aiExplains.listByCode('SH600000').map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(storage.aiExplains.countByCode('SH600000')).toBe(3)
  })

  it('latestOf 取该信号最近一次 —— **防重复计费走它**', () => {
    storage.aiExplains.insert(row('old', 'SH600000', T, 'sig-1'))
    storage.aiExplains.insert(row('new', 'SH600000', T + 5000, 'sig-1'))
    // 「重新生成」会在同一条信号下多留一行，旧的不删；读的时候取最新那条
    expect(storage.aiExplains.latestOf('sig-1')?.id).toBe('new')
    expect(storage.aiExplains.latestOf('没解读过的信号')).toBeNull()
  })

  it('拿不到当时价时是 undefined，**不是 0**（约束 4）', () => {
    const withPrice = row('a', 'SH600000', T)
    delete (withPrice as { priceAt?: number }).priceAt
    storage.aiExplains.insert(withPrice)
    expect(storage.aiExplains.get('a')?.priceAt).toBeUndefined()
  })

  it('信号被裁掉之后这一行照样活着 —— 它没有指向 signal 的外键', () => {
    storage.db
      .prepare(
        `INSERT INTO signal (id, code, created_at, trade_date, direction, score, votes, regime, stage, price_at, evidence, engine_version)
         VALUES ('sig-1', 'SH600000', ?, '2020-01-02', 'BUY', 0.7, 3, 'RANGE', 'CONFIRMED', 10, '{}', 'v')`
      )
      .run(T - 800 * 24 * 3600_000)
    storage.aiExplains.insert(row('a', 'SH600000', T, 'sig-1'))

    pruneAll(storage.db, T, DEFAULT_RETENTION)

    // 原信号没了，解读还在 —— 而且方向/置信/当时价都读得出来（那组字段是冗余存的）
    expect(storage.db.prepare(`SELECT COUNT(*) AS n FROM signal`).get<{ n: number }>()?.n).toBe(0)
    expect(storage.aiExplains.get('a')).toMatchObject({ direction: 'BUY', score: 0.78, priceAt: 10.5 })
  })

  it('**裁剪一行都不碰它** —— 它是花过钱的记录，不是可再生的派生物', () => {
    // 两年前的一条：任何按天算的保留策略都会想删它
    storage.aiExplains.insert(row('ancient', 'SH600000', T - 900 * 24 * 3600_000))
    pruneAll(storage.db, T, DEFAULT_RETENTION)
    expect(storage.aiExplains.get('ancient')).not.toBeNull()
  })

  it('把票移出自选也不影响它（没有指向 watchlist 的外键）', () => {
    storage.watchlist.add(profile('SH600000', '浦发银行'), '自选', T)
    storage.aiExplains.insert(row('a', 'SH600000', T))
    storage.watchlist.remove('SH600000')
    expect(storage.aiExplains.countByCode('SH600000')).toBe(1)
  })

  it('remove 是删除的唯一入口', () => {
    storage.aiExplains.insert(row('a', 'SH600000', T))
    expect(storage.aiExplains.remove('a')).toBe(true)
    expect(storage.aiExplains.remove('a')).toBe(false)
    expect(storage.aiExplains.get('a')).toBeNull()
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
