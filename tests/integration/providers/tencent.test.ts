/**
 * 腾讯 provider 的 fixture 回放。fixture 是 2026-08-11 录制的真实响应。
 *
 * 断言里写死了真实数值（9.21、470381696、10.22…）—— 这是刻意的：
 * 腾讯改字段顺序时，测试要能指出「第几个字段的含义变了」，而不是只报一句「解析失败」。
 */

import { describe, expect, it } from 'vitest'
import { createTencentProvider } from '@main/providers/tencent'
import { FIXED_NOW, fixtureBytes, fixtureText, replay } from './fixtures'

const SNAPSHOT = fixtureBytes('tencent', 'snapshot-mixed.gbk.txt')
const KLINE_RAW = fixtureText('tencent', 'kline-day-raw-sh600000.json')
const KLINE_QFQ = fixtureText('tencent', 'kline-day-qfq-sh600000.json')

const CODES = ['SH600000', 'SZ000001', 'SZ300750', 'BJ430047', 'SH510300']

function provider(routes: [string, Uint8Array | string][]) {
  const { http, calls } = replay(routes)
  return { provider: createTencentProvider({ http, now: () => FIXED_NOW }), calls }
}

function snapshotProvider() {
  return provider([['qt.gtimg.cn/q=', SNAPSHOT]])
}

/** fixture 是一整批的响应，按代码取那一条 */
async function byCode() {
  const snapshots = await snapshotProvider().provider.fetchSnapshots(CODES)
  return new Map(snapshots.map((s) => [s.code, s]))
}

describe('tencent · 批量快照', () => {
  it('五个品种全部解析出来，代码回填成内部形态', async () => {
    const snapshots = await snapshotProvider().provider.fetchSnapshots(CODES)
    expect(snapshots.map((s) => s.code)).toEqual(CODES)
  })

  it('沪主板：价格、量额、时间戳', async () => {
    const pufa = (await byCode()).get('SH600000')
    expect(pufa).toMatchObject({
      code: 'SH600000',
      last: 9.21,
      preClose: 9.29,
      open: 9.27,
      high: 9.34,
      low: 9.18,
      suspended: false,
    })
    // 6 号字段是 509424 手 —— 统一到股
    expect(pufa?.volume).toBe(50_942_400)
    // 57 号字段 47038.1696 万元，与新浪给的元值 470381696 完全一致
    expect(pufa?.amount).toBe(470_381_696)
    // 30 号字段 20260811155746 是北京时间，与本机时区无关
    expect(new Date(pufa?.at ?? 0).toISOString()).toBe('2026-08-11T07:57:46.000Z')
  })

  it('涨跌停按板块本地算，不用源里那两个字段', async () => {
    const map = await byCode()
    // 主板 ±10%：源里也是 10.22/8.36，两者一致
    expect(map.get('SH600000')).toMatchObject({ limitUp: 10.22, limitDown: 8.36 })
    // 创业板 ±20%
    expect(map.get('SZ300750')).toMatchObject({ limitUp: 472.64, limitDown: 315.1 })
    // ETF ±10%，且档位是 3 位小数
    expect(map.get('SH510300')).toMatchObject({ limitUp: 5.235, limitDown: 4.283 })
    // 北交所 ±30%：源里给的是 -1，只能本地算
    expect(map.get('BJ430047')).toMatchObject({ limitUp: 10.62, limitDown: 5.72 })
  })

  it('停牌股：整行 0 不当成「跌到 0」，标 suspended 并用昨收兜底', async () => {
    expect((await byCode()).get('BJ430047')).toMatchObject({
      code: 'BJ430047',
      suspended: true,
      last: 8.17,
      preClose: 8.17,
      volume: 0,
      amount: 0,
    })
  })

  it('超过 50 只分片请求，结果合并', async () => {
    const codes = Array.from({ length: 51 }, (_, i) => `SH60${String(i).padStart(4, '0')}`)
    const { provider: p, calls } = snapshotProvider()
    await p.fetchSnapshots(codes)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url.split(',')).toHaveLength(50)
    expect(calls[1]?.url.split(',')).toHaveLength(1)
  })

  it('无法识别的代码在拼 URL 前就被剔掉，不让整批失败', async () => {
    const { provider: p, calls } = snapshotProvider()
    await p.fetchSnapshots(['SH600000', '不是代码'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://qt.gtimg.cn/q=sh600000')
  })

  it('全是非法代码时一个请求都不发', async () => {
    const { provider: p, calls } = snapshotProvider()
    expect(await p.fetchSnapshots(['不是代码'])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('tencent · 日线', () => {
  // 复权段留空 = 不复权；两条路由靠 param 尾部有没有 qfq 区分（%2C 是逗号）
  const routes: [string, string][] = [
    ['%2Cqfq', KLINE_QFQ],
    ['fqkline/get', KLINE_RAW],
  ]

  it('不复权：只发一次请求，复权字段等于原价', async () => {
    const { provider: p, calls } = provider(routes)
    const candles = await p.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'none')
    expect(calls).toHaveLength(1)
    expect(candles).toHaveLength(25)
    expect(candles[0]).toMatchObject({
      date: '2024-01-02',
      open: 6.63,
      close: 6.6,
      high: 6.65,
      low: 6.6,
      openAdj: 6.63,
      closeAdj: 6.6,
    })
  })

  it('列序是「开、收、高、低」：最高价必须是四个价里最大的', async () => {
    const candles = await provider(routes).provider.fetchDaily(
      'SH600000',
      '2024-01-02',
      '2024-02-05',
      'none'
    )
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close, c.low))
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close, c.high))
    }
  })

  it('前复权：两次请求按日期对齐，原价与复权价并存', async () => {
    const { provider: p, calls } = provider(routes)
    const candles = await p.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'qfq')
    expect(calls).toHaveLength(2)
    expect(candles).toHaveLength(25)
    expect(candles[0]).toMatchObject({ date: '2024-01-02', close: 6.6, closeAdj: 5.449 })
  })

  it('腾讯的前复权是「减价差」而非「乘比例」—— 差额恒定，比值不恒定', async () => {
    const candles = await provider(routes).provider.fetchDaily(
      'SH600000',
      '2024-01-02',
      '2024-02-05',
      'qfq'
    )
    // 这一段（2024-01 至 02）浦发没有除权。若是比例复权，closeAdj/close 应当恒定；
    // 实测恒定的是 close − closeAdj = 1.151，比值从 0.8229 漂到 0.8330。
    // 这不影响任何指标（指标只吃 *Adj 一条序列），但意味着 kline_daily.adj_factor
    // 是个「每根都不同的派生值」，不能当作复权系数去反推原价。见 NOTES.md。
    const diffs = candles.map((c) => Number((c.close - c.closeAdj).toFixed(3)))
    expect(new Set(diffs)).toEqual(new Set([1.151]))

    const ratios = candles.map((c) => c.closeAdj / c.close)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.005)
  })

  it('成交量换算成股；成交额腾讯不给，是 null 而不是 0', async () => {
    const candles = await provider(routes).provider.fetchDaily(
      'SH600000',
      '2024-01-02',
      '2024-02-05',
      'qfq'
    )
    expect(candles[0]?.volume).toBe(22_066_700)
    expect(candles[0]?.amount).toBeNull()
  })

  it('日期升序，且区间外的行被丢掉', async () => {
    const candles = await provider(routes).provider.fetchDaily(
      'SH600000',
      '2024-01-10',
      '2024-01-20',
      'none'
    )
    const dates = candles.map((c) => c.date)
    expect(dates).toEqual([...dates].sort())
    expect(dates[0]).toBe('2024-01-10')
    expect(dates.at(-1)).toBe('2024-01-19')
  })

  it('返回体不是预期结构时报 ProviderDataError，而不是解析出空数组', async () => {
    const { provider: p } = provider([['fqkline/get', '{"code":0,"data":{}}']])
    await expect(p.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'none')).rejects.toThrow(
      /没有 sh600000/
    )
  })
})

describe('tencent · 基础信息与日历', () => {
  it('取到名称与板块（GBK 解码正确）；行业留空由主源补', async () => {
    const profile = await snapshotProvider().provider.fetchProfile('SH600000')
    expect(profile).toEqual({
      code: 'SH600000',
      name: '浦发银行',
      market: 'SH',
      board: 'MAIN',
      isST: false,
    })
    expect(profile.industry).toBeUndefined()
  })

  it('日历由基准指数日线反推：有数据即开市，之后的日期不做判断', async () => {
    // fixture 是浦发的，把 data 的键换成指数代码即可复用它的日期序列
    const indexKline = KLINE_RAW.replaceAll('sh600000', 'sh000001')
    const { provider: p, calls } = provider([['fqkline/get', indexKline]])
    const days = await p.fetchCalendar?.(2024)
    expect(calls[0]?.url).toContain('sh000001')

    const open = days?.filter((d) => d.isOpen).map((d) => d.date) ?? []
    expect(open).toHaveLength(25)
    expect(open[0]).toBe('2024-01-02')
    // 元旦休市、春节前最后一天之后不做判断
    expect(days?.find((d) => d.date === '2024-01-01')?.isOpen).toBe(false)
    expect(days?.at(-1)?.date).toBe('2024-02-05')
    expect(days?.some((d) => d.date > '2024-02-05')).toBe(false)
  })
})
