/**
 * 指标缓存与信号表（M2 新增的两个仓储）。
 *
 * 驱动用 node:sqlite，理由同 storage.test.ts。
 *
 * 重点验两件事：
 *   - `engine_version` 作为缓存键：参数一改，旧值不再命中，并且能被清掉（docs/03 §4.2）
 *   - 坏数据不让整个列表崩掉：evidence 字段是 JSON，损坏时要退化而不是抛错
 */

import { describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import type { SignalEvidencePayload, SignalRow } from '@main/storage/repositories/signal'

const DRIVER = 'node:sqlite' as const

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function evidence(overrides: Partial<SignalEvidencePayload> = {}): SignalEvidencePayload {
  return {
    level: 'L2',
    headline: '均线金叉 · 上升趋势',
    reasons: ['均线金叉'],
    suppressed: false,
    subSignals: [
      { id: 'T1_MA_CROSS', strategy: 'TREND', direction: 'BUY', score: 0.8, weight: 0.2, evidence: { ma5: 10 } },
    ],
    adjustments: [{ id: 'M2_WEEK_ADX_CONFIRM', direction: 'BUY', delta: 0.1 }],
    verdicts: [],
    scoreByDirection: { BUY: 0.7, SELL: 0.1 },
    indicatorsAt: { ma5: 10, bbwPct: null },
    regimeEvidence: { adx: 30 },
    sufficiency: { bars: 400, limited: false, penalty: 1, note: null },
    ...overrides,
  }
}

function row(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id: 'sig-1',
    code: 'SH600000',
    createdAt: 1_700_000_000_000,
    tradeDate: '2026-08-11',
    direction: 'BUY',
    score: 0.72,
    votes: 3,
    regime: 'TREND_UP',
    stage: 'PROVISIONAL',
    priceAt: 10.24,
    engineVersion: '0.2.0-unvalidated+aaaa1111',
    evidence: evidence(),
    ...overrides,
  }
}

describe('指标缓存（indicator_daily）', () => {
  it('同版本命中，异版本不命中', async () => {
    const storage = await openMemory()
    storage.indicators.put('SH600000', '2026-08-11', { ma5: 10 }, 'v1')
    expect(storage.indicators.get('SH600000', '2026-08-11', 'v1')).toEqual({ ma5: 10 })
    expect(storage.indicators.get('SH600000', '2026-08-11', 'v2')).toBeNull()
    storage.close()
  })

  it('同一 (code, date) 重复写入是覆盖而非报错 —— 版本变化时要能就地更新', async () => {
    const storage = await openMemory()
    storage.indicators.put('SH600000', '2026-08-11', { ma5: 10 }, 'v1')
    storage.indicators.put('SH600000', '2026-08-11', { ma5: 11 }, 'v2')
    expect(storage.indicators.count()).toBe(1)
    expect(storage.indicators.get('SH600000', '2026-08-11', 'v2')).toEqual({ ma5: 11 })
    storage.close()
  })

  it('清理非当前版本的缓存', async () => {
    const storage = await openMemory()
    storage.indicators.put('SH600000', '2026-08-10', {}, 'v1')
    storage.indicators.put('SH600000', '2026-08-11', {}, 'v2')
    expect(storage.indicators.purgeOtherVersions('v2')).toBe(1)
    expect(storage.indicators.count()).toBe(1)
    storage.close()
  })

  it('损坏的 JSON 当未命中处理，不抛错', async () => {
    const storage = await openMemory()
    storage.db
      .prepare(`INSERT INTO indicator_daily (code, trade_date, payload, engine_version) VALUES (?,?,?,?)`)
      .run('SH600000', '2026-08-11', '{不是 JSON', 'v1')
    expect(storage.indicators.get('SH600000', '2026-08-11', 'v1')).toBeNull()
    storage.close()
  })

  it('按标的裁剪，只留最近 N 根', async () => {
    const storage = await openMemory()
    for (const day of ['09', '10', '11']) {
      storage.indicators.put('SH600000', `2026-08-${day}`, {}, 'v1')
    }
    expect(storage.indicators.prune('SH600000', 2)).toBe(1)
    expect(storage.indicators.get('SH600000', '2026-08-09', 'v1')).toBeNull()
    expect(storage.indicators.get('SH600000', '2026-08-11', 'v1')).not.toBeNull()
    storage.close()
  })
})

describe('信号表（signal）', () => {
  it('写入后可按 id 读回，evidence 往返不丢字段', async () => {
    const storage = await openMemory()
    storage.signals.insert(row())
    const loaded = storage.signals.get('sig-1')
    expect(loaded?.direction).toBe('BUY')
    expect(loaded?.evidence.subSignals[0]?.id).toBe('T1_MA_CROSS')
    expect(loaded?.evidence.indicatorsAt['bbwPct']).toBeNull()
    storage.close()
  })

  it('同 id 再次写入是更新（确认轮会改写同一条）', async () => {
    const storage = await openMemory()
    storage.signals.insert(row())
    storage.signals.insert(row({ score: 0.9, stage: 'CONFIRMED' }))
    expect(storage.signals.query({}).length).toBe(1)
    expect(storage.signals.get('sig-1')?.stage).toBe('CONFIRMED')
    storage.close()
  })

  it('阶段推进：PROVISIONAL → CONFIRMED / INVALIDATED', async () => {
    const storage = await openMemory()
    storage.signals.insert(row())
    expect(storage.signals.updateStage('sig-1', 'INVALIDATED')).toBe(true)
    expect(storage.signals.get('sig-1')?.stage).toBe('INVALIDATED')
    expect(storage.signals.updateStage('missing', 'CONFIRMED')).toBe(false)
    storage.close()
  })

  it('按代码与时间区间查询，按时间倒序并受 limit 约束', async () => {
    const storage = await openMemory()
    storage.signals.insert(row({ id: 'a', createdAt: 100 }))
    storage.signals.insert(row({ id: 'b', createdAt: 200 }))
    storage.signals.insert(row({ id: 'c', code: 'SZ000001', createdAt: 300 }))

    expect(storage.signals.query({}).map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(storage.signals.query({ code: 'SH600000' }).map((r) => r.id)).toEqual(['b', 'a'])
    expect(storage.signals.query({ from: 150, to: 250 }).map((r) => r.id)).toEqual(['b'])
    expect(storage.signals.query({ limit: 1 }).map((r) => r.id)).toEqual(['c'])
    storage.close()
  })

  it('取某日最后一条（确认轮的比对依据）', async () => {
    const storage = await openMemory()
    storage.signals.insert(row({ id: 'a', createdAt: 100 }))
    storage.signals.insert(row({ id: 'b', createdAt: 200 }))
    expect(storage.signals.latestOfDay('SH600000', '2026-08-11')?.id).toBe('b')
    expect(storage.signals.latestOfDay('SH600000', '2026-08-10')).toBeNull()
    expect(storage.signals.countOfDay('2026-08-11')).toBe(2)
    storage.close()
  })

  it('被抑制的信号也入库，且带上原因（docs/05 §4：不制造信息黑洞）', async () => {
    const storage = await openMemory()
    storage.signals.insert(
      row({ id: 'sup', evidence: evidence({ suppressed: true, suppressedReason: '已涨停，买不到' }) })
    )
    expect(storage.signals.get('sup')?.evidence.suppressedReason).toBe('已涨停，买不到')
    storage.close()
  })

  /**
   * `perCode`：一只刷屏的票不许把别的票挤出窗口（2026-08-14）。
   *
   * 这不是假想的：那天三只跌破止损线的票一天落了 664 行（成因是签名里混了连续量，
   * 已在 `signalSignature` 修掉），于是 200 行的窗口只覆盖了 82 分钟，
   * 上午的信号在面板与悬浮条上**根本不存在** —— 而界面不会报错，只是少了东西。
   *
   * 窗口函数写错不会抛异常，只会**少给行**，所以这几条必须在真库上跑。
   */
  describe('perCode：单只票不许吃光全局 limit', () => {
    /** 一只刷屏的票 + 一只只出了一条的票。刷屏那只的时间**全部更晚** —— 这才构成挤出 */
    async function noisyAndQuiet(): Promise<Storage> {
      const storage = await openMemory()
      storage.signals.insert(row({ id: 'quiet-1', code: 'SZ000001', createdAt: 1_000 }))
      for (let i = 0; i < 50; i++) {
        storage.signals.insert(row({ id: `noisy-${i}`, code: 'SH600000', createdAt: 10_000 + i }))
      }
      return storage
    }

    it('不传 perCode 时行为不变 —— 安静那只确实会被挤出去', async () => {
      const storage = await noisyAndQuiet()
      const rows = storage.signals.query({ limit: 10 })
      expect(rows).toHaveLength(10)
      expect(rows.every((r) => r.code === 'SH600000')).toBe(true)
      storage.close()
    })

    it('传了之后每只票各取最近 N 条，安静那只回来了', async () => {
      const storage = await noisyAndQuiet()
      const rows = storage.signals.query({ limit: 10, perCode: 3 })
      expect(rows.filter((r) => r.code === 'SH600000')).toHaveLength(3)
      expect(rows.filter((r) => r.code === 'SZ000001')).toHaveLength(1)
      storage.close()
    })

    it('每只票取的是**最近**的那几条，不是最早的', async () => {
      const storage = await noisyAndQuiet()
      const ids = storage.signals
        .query({ perCode: 2 })
        .filter((r) => r.code === 'SH600000')
        .map((r) => r.id)
      expect(ids).toEqual(['noisy-49', 'noisy-48'])
      storage.close()
    })

    it('总量上限仍然生效 —— perCode 不是「把闸门拆了」', async () => {
      const storage = await noisyAndQuiet()
      expect(storage.signals.query({ limit: 2, perCode: 20 })).toHaveLength(2)
      storage.close()
    })

    it('整体仍按时间倒序返回（分组是取数口径，不是展示顺序）', async () => {
      const storage = await noisyAndQuiet()
      const rows = storage.signals.query({ perCode: 3 })
      const times = rows.map((r) => r.createdAt)
      expect(times).toEqual([...times].sort((a, b) => b - a))
      storage.close()
    })

    it('与 from / code 过滤同时生效', async () => {
      const storage = await noisyAndQuiet()
      const rows = storage.signals.query({ from: 10_040, perCode: 2 })
      expect(rows.map((r) => r.id)).toEqual(['noisy-49', 'noisy-48'])
      storage.close()
    })
  })

  it('evidence 损坏时该行仍能列出（只是依据是空壳），不让整个列表崩掉', async () => {
    const storage = await openMemory()
    storage.db
      .prepare(
        `INSERT INTO signal (id, code, created_at, trade_date, direction, score, votes, regime, stage,
           price_at, evidence, engine_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run('bad', 'SH600000', 1, '2026-08-11', 'BUY', 0.7, 3, 'TREND_UP', 'CONFIRMED', 10, '{坏', 'v1')
    const loaded = storage.signals.get('bad')
    expect(loaded?.direction).toBe('BUY')
    expect(loaded?.evidence.headline).toContain('解析失败')
    storage.close()
  })
})
