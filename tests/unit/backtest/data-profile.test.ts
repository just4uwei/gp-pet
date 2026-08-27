/**
 * fixture 源的 `SecProfile` 装配（`src/backtest/data.ts`，缺陷记录见 M2 §5.66/§5.67）。
 *
 * **为什么单独一个文件钉这几行**：`openFixtureSource` 曾经调 `fallbackProfile(code)`
 * **不传名字** ⇒ `isSTName(code)` 恒 `false` ⇒ **所有 fixture 一律按非 ST（±10%）算涨跌停**，
 * 而 549 份 fixture 里 225 份名称带 ST/退（退市池 **212/233 = 91%**）。
 *
 * 这个缺陷的形状值得记住：**它不报错、不少行、不改建仓数量级** ——
 * 只是让本该被涨跌停挡住的委托放行，报告上完全看不出来。实测把它修掉，
 * 退市池全期收益从 **−2.4028% 变成 −2.1929%**（0.21pp）。
 *
 * `fallbackProfile` 的原注释写着「缺时……**并在报告里注明**」，而报告里从来没有那一行
 * ⇒ **写下一条纪律不等于装上一道闸门**。这个文件就是那道闸门。
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Candle, SecCode, TradeDate } from '@core/types'
import { openFixtureSource, fallbackProfile } from '../../../src/backtest/data'

const code = (s: string): SecCode => s as SecCode
const RANGE = { from: '2018-01-01' as TradeDate, to: '2026-12-31' as TradeDate }

const dir = mkdtempSync(join(tmpdir(), 'gp-fixture-profile-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function bar(date: string): Candle {
  return {
    date: date as TradeDate,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    openAdj: 10,
    highAdj: 10,
    lowAdj: 10,
    closeAdj: 10,
    volume: 1000,
    amount: null,
  }
}

function writeFixture(name: string, body: unknown): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(body), 'utf8')
}

describe('openFixtureSource 的 profile 装配', () => {
  it('把 _meta.nameAtFetch 传进 profile —— 缺了它 ST 标记恒为 false', () => {
    writeFixture('SH600070', {
      _meta: { nameAtFetch: '*ST富润' },
      candles: [bar('2020-01-02')],
    })
    const loaded = openFixtureSource(dir, RANGE).load(code('SH600070'))
    expect(loaded).not.toBeNull()
    expect(loaded?.profile.name).toBe('*ST富润')
    // 这一条才是要害：±5% vs ±10% 的涨跌停判定全挂在它上面
    expect(loaded?.profile.isST).toBe(true)
  })

  it('名字里没有 ST 时不误判', () => {
    writeFixture('SH600000', {
      _meta: { nameAtFetch: '浦发银行' },
      candles: [bar('2020-01-02')],
    })
    const loaded = openFixtureSource(dir, RANGE).load(code('SH600000'))
    expect(loaded?.profile.isST).toBe(false)
  })

  it('没有 _meta 的旧 fixture 仍能读，但名字退化成代码（= 名字未知的标志）', () => {
    writeFixture('SZ000001', { candles: [bar('2020-01-02')] })
    const loaded = openFixtureSource(dir, RANGE).load(code('SZ000001'))
    expect(loaded?.profile.name).toBe('SZ000001')
    expect(loaded?.profile.isST).toBe(false)
  })

  it('裸数组 fixture（最老的那种形状）不回归', () => {
    writeFixture('SZ000002', [bar('2020-01-02')])
    const loaded = openFixtureSource(dir, RANGE).load(code('SZ000002'))
    expect(loaded?.candles).toHaveLength(1)
    expect(loaded?.profile.code).toBe('SZ000002')
  })

  it('显式给了 profile 时以它为准，_meta 不许覆盖它', () => {
    const explicit = fallbackProfile(code('SH600070'), '富润股份')
    writeFixture('SH600071', {
      profile: explicit,
      _meta: { nameAtFetch: '*ST富润' },
      candles: [bar('2020-01-02')],
    })
    const loaded = openFixtureSource(dir, RANGE).load(code('SH600071'))
    expect(loaded?.profile.name).toBe('富润股份')
    expect(loaded?.profile.isST).toBe(false)
  })
})
