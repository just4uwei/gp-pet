/**
 * 回测 CLI 的参数解析。
 *
 * 重点是**拼错的参数必须报错**：`--slipage 0.002` 被静默忽略，
 * 会让人以为跑了一次含滑点的回测，而报告上什么都看不出来。
 */

import { describe, expect, it } from 'vitest'
import { SENSITIVITY_PRESETS, USAGE, parseArgs } from '@backtest/args'

function parse(...argv: string[]): ReturnType<typeof parseArgs> {
  return parseArgs(argv)
}

describe('parseArgs', () => {
  it('最小可用参数', () => {
    const options = parse('--codes', 'SH600000,sz000001')
    expect(options).not.toBe('help')
    if (options === 'help') return
    expect(options.codes).toEqual(['SH600000', 'sz000001'])
    expect(options.benchmark).toBe('SH000300')
    expect(options.fixedWeights).toBe(true)
  })

  it('吃掉裸 `--`：pnpm 11 会把分隔符原样传进来', () => {
    const options = parse('--', '--codes', 'SH600000', '--fixtures', './fx')
    expect(options).not.toBe('help')
    if (options === 'help') return
    expect(options.codes).toEqual(['SH600000'])
    expect(options.fixtures).toBe('./fx')
  })

  it('区间、数据源、成本与输出', () => {
    const options = parse(
      '--codes', 'SH600000',
      '--from', '2020-01-01',
      '--to', '2024-12-31',
      '--fixtures', './fx',
      '--slippage', '0.002',
      '--commission', '0.0003',
      '--min-commission', '5',
      '--stamp-tax', '0.001',
      '--transfer-fee', '0.00002',
      '--capital', '50000',
      '--lookback', '400',
      '--warmup', '350',
      '--out', './r.json',
      '--params', './p.json',
      '--grid', './g.json',
      '--json',
      '--quiet',
      '--no-fixed-weights'
    )
    if (options === 'help') throw new Error('不该是 help')
    expect(options.from).toBe('2020-01-01')
    expect(options.fixtures).toBe('./fx')
    expect(options.costs.slippage).toBe(0.002)
    expect(options.costs.transferFeeRate).toBe(0.00002)
    expect(options.capital).toBe(50_000)
    expect(options.warmup).toBe(350)
    expect(options.fixedWeights).toBe(false)
    expect(options.json).toBe(true)
    expect(options.quiet).toBe(true)
    expect(options.grid).toBe('./g.json')
  })

  it('--benchmark none 表示不用基准', () => {
    const options = parse('--codes', 'SH600000', '--benchmark', 'none')
    if (options === 'help') throw new Error('不该是 help')
    expect(options.benchmark).toBeNull()
  })

  it('三档灵敏度映射到 docs/04 §4.2 的阈值组合', () => {
    const options = parse('--codes', 'SH600000', '--sensitivity', 'Conservative')
    if (options === 'help') throw new Error('不该是 help')
    expect(options.sensitivity).toBe('CONSERVATIVE')
    expect(SENSITIVITY_PRESETS.CONSERVATIVE).toEqual({ scoreThreshold: 0.72, voteThreshold: 4 })
    expect(SENSITIVITY_PRESETS.SENSITIVE.voteThreshold).toBeLessThan(
      SENSITIVITY_PRESETS.BALANCED.voteThreshold
    )
  })

  it('--help 返回 help，且用法里写明了数据来源二选一', () => {
    expect(parse('--help')).toBe('help')
    expect(parse('-h')).toBe('help')
    expect(USAGE).toContain('--fixtures')
  })

  it('拼错的参数直接报错，不静默忽略', () => {
    expect(() => parse('--codes', 'SH600000', '--slipage', '0.002')).toThrow(/无法识别/)
  })

  it('缺少必填与非法取值都报错', () => {
    expect(() => parse()).toThrow(/--codes/)
    expect(() => parse('--codes')).toThrow(/缺少取值/)
    expect(() => parse('--codes', 'SH600000', '--capital', 'abc')).toThrow(/非负数字/)
    expect(() => parse('--codes', 'SH600000', '--sensitivity', 'crazy')).toThrow(/sensitive/)
  })

  it('区间倒挂与数据源冲突要早发现', () => {
    expect(() => parse('--codes', 'SH600000', '--from', '2024-01-01', '--to', '2023-01-01')).toThrow(/晚于/)
    expect(() => parse('--codes', 'SH600000', '--db', 'a.db', '--fixtures', './fx')).toThrow(/只能选一个/)
  })
})
