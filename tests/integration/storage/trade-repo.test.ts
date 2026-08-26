/**
 * 成交流水仓储的 016 那四列：**真实成交时刻**与**照哪条提醒做的**。
 *
 * 这四列存在的全部理由是「NULL 与有值必须分得开」——
 * 「不记得几点成交」被写成「中午 12 点成交」之后，implementation shortfall
 * 会把那个假时刻当成真实时刻用，而报告上完全看不出来（M2 §5.53 / 016 头注释）。
 * 所以这里每一条用例钉的都是同一件事的不同侧面。
 *
 * 驱动用 node:sqlite，理由同 storage.test.ts。
 */

import { describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import type { TradeRow } from '@main/storage/repositories/trade'

const DRIVER = 'node:sqlite' as const
const T0 = 1_700_000_000_000

async function openMemory(): Promise<Storage> {
  return createStorage(await openDatabase({ file: ':memory:', driver: DRIVER, backup: false }))
}

function trade(id: string, overrides: Partial<TradeRow> = {}): TradeRow {
  return {
    id,
    code: 'SH600000',
    side: 'BUY',
    tradedAt: T0,
    price: 12.34,
    shares: 1000,
    fee: 8.09,
    createdAt: T0,
    ...overrides,
  }
}

describe('TradeRepo 的 016 四列', () => {
  it('不填时四列全是 undefined —— 缺省不许被补成 0 或 tradedAt', async () => {
    const storage = await openMemory()
    storage.trades.insert(trade('t-1'))

    const row = storage.trades.get('t-1')
    expect(row).not.toBeNull()
    // 逐个断言「这个键不存在」，而不是断言它等于某个值
    expect(row?.tradedAtExact).toBeUndefined()
    expect(row?.signalId).toBeUndefined()
    expect(row?.decisionAt).toBeUndefined()
    expect(row?.decisionPrice).toBeUndefined()
    // 尤其是这一条：拿 tradedAt 顶替就是把「不知道分钟」写成「中午 12 点成交」
    expect(row?.tradedAtExact).not.toBe(row?.tradedAt)
  })

  it('填了就原样往返，包括 0 附近的边界（决策价不会被当成缺省）', async () => {
    const storage = await openMemory()
    const exact = T0 + 9 * 3600_000 + 47 * 60_000
    storage.trades.insert(
      trade('t-2', {
        tradedAtExact: exact,
        signalId: 'sig-42',
        decisionAt: T0 + 9 * 3600_000 + 31 * 60_000,
        decisionPrice: 12.301,
      })
    )

    const row = storage.trades.get('t-2')
    expect(row?.tradedAtExact).toBe(exact)
    expect(row?.signalId).toBe('sig-42')
    expect(row?.decisionAt).toBe(T0 + 9 * 3600_000 + 31 * 60_000)
    expect(row?.decisionPrice).toBeCloseTo(12.301, 10)
  })

  /**
   * **不加指向 `signal(id)` 的外键**（016 头注释）：`signal` 按 2 年裁剪，
   * 而 `trade_log` 永不裁剪 —— 加外键会让裁剪那天要么删不掉 signal、要么连带毁账本。
   * 所以一个指不到任何信号的 `signal_id` 在**仓储这一层**必须插得进去。
   *
   * ⚠ 这不是说「随便写什么都行」：校验在 `controller.addTrade`
   * （查不到就报错，不静默落 NULL）。两层的分工别混 ——
   * 仓储放行是为了让**旧行在信号被裁剪之后仍然读得出来**。
   */
  it('signal_id 指向一条不存在的信号也插得进去 —— 那是刻意不加外键', async () => {
    const storage = await openMemory()
    expect(() =>
      storage.trades.insert(trade('t-3', { signalId: 'sig-已被裁剪', decisionPrice: 9.99 }))
    ).not.toThrow()
    expect(storage.trades.get('t-3')?.signalId).toBe('sig-已被裁剪')
    // 冗余快照的意义就在这：原信号没了，决策价还在
    expect(storage.trades.get('t-3')?.decisionPrice).toBeCloseTo(9.99, 10)
  })

  it('016 之前的行读出来四列为空 —— 迁移不猜、不回填', async () => {
    const storage = await openMemory()
    // 直接按 007 的列集插一行，模拟老数据
    storage.db
      .prepare(
        `INSERT INTO trade_log (id, code, side, traded_at, price, shares, fee, realized, note, created_at)
         VALUES ('old-1', 'SH600000', 'BUY', ?, 10, 100, 5, NULL, NULL, ?)`
      )
      .run(T0, T0)

    const row = storage.trades.get('old-1')
    expect(row?.tradedAt).toBe(T0)
    expect(row?.tradedAtExact).toBeUndefined()
    expect(row?.signalId).toBeUndefined()
  })

  it('listByCode 也带出这四列 —— 少一处映射就等于静默丢数据', async () => {
    const storage = await openMemory()
    storage.trades.insert(trade('t-4', { tradedAtExact: T0 + 60_000, signalId: 'sig-7' }))
    const rows = storage.trades.listByCode('SH600000')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tradedAtExact).toBe(T0 + 60_000)
    expect(rows[0]?.signalId).toBe('sig-7')
  })
})
