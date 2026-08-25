/**
 * 观察点条件的共用格式化与矛盾检测（src/shared/watch-metrics.ts）。
 *
 * 这几个函数被**五处**共用：提醒文案（alerts/candidates.ts）· 观察点列表 ·
 * 信号时间线里的命中行 · 日报「仍在盯」· 移除确认框。各写一份的症状是同一个
 * 观察点在五个地方读起来像五件事 —— `METRIC_LABELS` 当初搬来 shared 就是为了这个
 * （日报那一处此前甚至直接打印裸键名 `bollMid`）。
 *
 * `impossibleConditions` 是组合条件带来的新失败形状：一个**永远不会命中**的观察点
 * 看起来完全正常，用户会一直等它，到期还会留下一条「没兑现」的假结论。
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_WATCH_CONDITIONS,
  conditionsText,
  hitValuesText,
  impossibleConditions,
} from '@shared/watch-metrics'

describe('conditionsText', () => {
  it('单条：用中文标签，不是裸键名', () => {
    expect(conditionsText([{ metric: 'bollMid', op: 'LTE', threshold: 9.1 }])).toBe('布林中轨 跌破 9.1')
  })

  it('多条用「且」连起来 —— 组合条件的语义只有这一种', () => {
    expect(
      conditionsText([
        { metric: 'PRICE', op: 'LTE', threshold: 8.2 },
        { metric: 'rsi', op: 'GTE', threshold: 70 },
      ])
    ).toBe('价格 跌破 8.2 且 RSI 升破 70')
  })
})

describe('hitValuesText', () => {
  it('逐条给出实际值', () => {
    expect(
      hitValuesText(
        [
          { metric: 'PRICE', op: 'LTE', threshold: 8.2 },
          { metric: 'rsi', op: 'LTE', threshold: 30 },
        ],
        [8.15, 28.5]
      )
    ).toBe('价格 8.15 · RSI 28.5')
  })

  it('值缺失时那一项整个略过，**不编 0** —— 旧行与坏数据都走这条路', () => {
    const conditions = [
      { metric: 'PRICE' as const, op: 'LTE' as const, threshold: 8.2 },
      { metric: 'rsi' as const, op: 'LTE' as const, threshold: 30 },
    ]
    expect(hitValuesText(conditions, [8.15])).toBe('价格 8.15')
    expect(hitValuesText(conditions, undefined)).toBe('')
  })
})

describe('impossibleConditions', () => {
  it('同一指标上 ≤8.2 且 ≥9 → 两条都点名', () => {
    expect(
      impossibleConditions([
        { metric: 'PRICE', op: 'LTE', threshold: 8.2 },
        { metric: 'PRICE', op: 'GTE', threshold: 9 },
      ])
    ).toEqual([0, 1])
  })

  it('**取等仍然可满足**（恰好等于 9），不算矛盾', () => {
    expect(
      impossibleConditions([
        { metric: 'PRICE', op: 'LTE', threshold: 9 },
        { metric: 'PRICE', op: 'GTE', threshold: 9 },
      ])
    ).toEqual([])
  })

  it('区间型（≥8 且 ≤9）是正常用法', () => {
    expect(
      impossibleConditions([
        { metric: 'PRICE', op: 'GTE', threshold: 8 },
        { metric: 'PRICE', op: 'LTE', threshold: 9 },
      ])
    ).toEqual([])
  })

  it('跨指标的「矛盾」判不了，也不该猜 —— 只认同一指标上的那一种', () => {
    expect(
      impossibleConditions([
        { metric: 'PRICE', op: 'GTE', threshold: 100 },
        { metric: 'ma20', op: 'LTE', threshold: 1 },
      ])
    ).toEqual([])
  })

  it('同向的两条（≤8.2 且 ≤8.0）只是冗余，不是矛盾', () => {
    expect(
      impossibleConditions([
        { metric: 'PRICE', op: 'LTE', threshold: 8.2 },
        { metric: 'PRICE', op: 'LTE', threshold: 8.0 },
      ])
    ).toEqual([])
  })
})

describe('MAX_WATCH_CONDITIONS', () => {
  it('主进程校验、表单按钮、AI 解析三处共用同一个数', () => {
    expect(MAX_WATCH_CONDITIONS).toBe(3)
  })
})
