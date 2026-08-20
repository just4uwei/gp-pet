/**
 * 指标目录的三条不变量。
 *
 * 这个文件的价值不在「测代码」，在**测文案** —— 那一屏是全应用唯一一处
 * 逐个解释指标的地方，而它离「金叉看涨」这类话只有一行之隔。
 *
 * 1. **完整性**：`snapshotOfIndicators()` 产出的每个键都要有条目。
 *    漏一个的症状是界面上少一行，而没有任何人会发现。
 * 2. **措辞纪律**（CLAUDE.md）：不许出现「必涨 / 抄底 / 稳赚 / 牛股」，
 *    也不许把置信度叫「胜率」或「概率」。
 * 3. **口径差异不许漏**：ADX / ATR / MACD 柱 / 布林带这四个与国内平台口径不同或
 *    刻意选了国内口径，2026-08-19 的第三方对照（M2 §5.38）逐个量过 ——
 *    它们必须带 `caveat`，否则用户拿软件对着行情软件看会以为我们算错了。
 */

import { describe, expect, it } from 'vitest'
import { INDICATOR_BY_KEY, INDICATOR_CATALOG } from '@shared/indicator-catalog'
import { snapshotOfIndicators } from '@main/engine/signals'
import { computeIndicators } from '@core/indicators'
import { DEFAULT_PARAMS } from '@core/params'
import { buildCandles, rampCloses } from '../../fixtures/klines'

describe('指标目录', () => {
  it('snapshotOfIndicators 的每个键都有文案（加了指标不许忘）', () => {
    const candles = buildCandles(rampCloses(320, 10, 0.004))
    const indicators = computeIndicators(candles, DEFAULT_PARAMS, { sentiment: 0.5, intradayProgress: 1 })
    const snapshot = snapshotOfIndicators(indicators, candles.length - 1)

    const missing = Object.keys(snapshot).filter((key) => INDICATOR_BY_KEY[key] === undefined)
    expect(missing).toEqual([])
  })

  it('目录里不许有快照给不出的键（写了文案却没有数 ⇒ 界面永远显示 —）', () => {
    const candles = buildCandles(rampCloses(320, 10, 0.004))
    const indicators = computeIndicators(candles, DEFAULT_PARAMS, { sentiment: 0.5, intradayProgress: 1 })
    const snapshot = snapshotOfIndicators(indicators, candles.length - 1)

    const orphan = INDICATOR_CATALOG.filter((meta) => !(meta.key in snapshot)).map((m) => m.key)
    expect(orphan).toEqual([])
  })

  /**
   * 措辞纪律（CLAUDE.md 那一节）。「胜率」在**回测报告**里是可以的（那是回测事实），
   * 但在面向用户的指标解释里不行 —— 那一屏没有任何统计口径能支撑这个词。
   */
  it('文案不出现禁用词（必涨 / 抄底 / 稳赚 / 牛股 / 胜率 / 概率）', () => {
    const banned = ['必涨', '抄底', '稳赚', '牛股', '胜率', '概率']
    const offenders: string[] = []
    for (const meta of INDICATOR_CATALOG) {
      const text = `${meta.label}${meta.definition}${meta.caveat ?? ''}`
      for (const word of banned) {
        if (text.includes(word)) offenders.push(`${meta.key}: ${word}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('与国内平台口径不同的四个指标必须带口径说明', () => {
    for (const key of ['adx', 'atr', 'hist', 'bbw']) {
      expect(INDICATOR_BY_KEY[key]?.caveat, `${key} 缺 caveat`).toBeTruthy()
    }
  })

  it('引用的参数路径都是真实存在的叶子（写错路径 ⇒ 那一档标定状态静默消失）', () => {
    const leaves = new Set<string>()
    const walk = (prefix: string, value: unknown): void => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) {
          walk(prefix === '' ? key : `${prefix}.${key}`, child)
        }
        return
      }
      leaves.add(prefix)
    }
    walk('', DEFAULT_PARAMS)

    const bad = INDICATOR_CATALOG.flatMap((meta) => meta.paramPaths ?? []).filter(
      (path) => !leaves.has(path)
    )
    expect(bad).toEqual([])
  })
})
