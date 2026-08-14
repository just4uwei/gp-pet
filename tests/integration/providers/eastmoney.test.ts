/**
 * 东方财富 provider 的回放测试。
 *
 * ⚠ 这里的 fixture 是**手写**的（开发机访问不到 push2 接口，详见
 * tests/fixtures/providers/eastmoney/README.md）。因此本文件验证的是
 * 「解析器对这个形状的输入是否正确」，**不构成**对真实响应形状的验证。
 * 首次能联网的机器上必须先 `pnpm fixtures:record -- --provider eastmoney` 并人工比对差异。
 *
 * **例外：`trends2-*.json` 已按真实响应核对过（2026-08-14）** —— 字段名、列序、
 * 数值全部来自当天真实拉到的 trends2 返回，是这批 fixture 里唯一有真机依据的。
 * push2his 那台主机在开发机上是**间歇**可用的（`other side closed`，重试能过），
 * 与文件头这段「访问不到」的旧结论不符 —— 见 NOTES.md 的 2026-08-12 更正。
 */

import { describe, expect, it } from 'vitest'
import { createEastmoneyProvider, fromSecId, toSecId } from '@main/providers/eastmoney'
import { FIXED_NOW, fixtureText, replay } from './fixtures'

const SNAPSHOT = fixtureText('eastmoney', 'snapshot-mixed.json')
const SNAPSHOT_OBJ = fixtureText('eastmoney', 'snapshot-diff-object.json')
const KLINE_RAW = fixtureText('eastmoney', 'kline-day-raw-sh600000.json')
const KLINE_QFQ = fixtureText('eastmoney', 'kline-day-qfq-sh600000.json')
const KLINE_EMPTY = fixtureText('eastmoney', 'kline-empty.json')
const PROFILE = fixtureText('eastmoney', 'profile-sh600000.json')
const TRENDS = fixtureText('eastmoney', 'trends2-sh600000.json')
const TRENDS_EMPTY = fixtureText('eastmoney', 'trends2-empty.json')

const CODES = ['SH600000', 'SZ000001', 'SZ300750', 'BJ430047', 'SH510300']

function eastmoney(routes: [string, string][]) {
  const { http, calls } = replay(routes)
  return { provider: createEastmoneyProvider({ http, now: () => FIXED_NOW }), calls }
}

const ALL: [string, string][] = [
  ['fqt=1', KLINE_QFQ],
  ['fqt=0', KLINE_RAW],
  ['ulist.np/get', SNAPSHOT],
  ['stock/get', PROFILE],
]

describe('eastmoney · secid 转换', () => {
  it('沪市 1、深市与北交所都是 0', () => {
    expect(toSecId('SH600000')).toBe('1.600000')
    expect(toSecId('SH000001')).toBe('1.000001')
    expect(toSecId('SZ000001')).toBe('0.000001')
    expect(toSecId('BJ430047')).toBe('0.430047')
    expect(toSecId('不是代码')).toBeNull()
  })

  it('回填时市场号 0 靠代码段区分深市与京市', () => {
    expect(fromSecId(1, '600000')).toBe('SH600000')
    expect(fromSecId(0, '000001')).toBe('SZ000001')
    expect(fromSecId(0, '430047')).toBe('BJ430047')
    expect(fromSecId(0, '999999')).toBeNull()
  })
})

describe('eastmoney · 批量快照', () => {
  it('必须带 fltt=2，否则价格会是放大 100 倍的整数', async () => {
    const { provider, calls } = eastmoney(ALL)
    await provider.fetchSnapshots(['SH600000'])
    expect(calls[0]?.url).toContain('fltt=2')
    expect(calls[0]?.url).toContain('f124')
  })

  it('五个品种解析并回填内部代码', async () => {
    const snapshots = await eastmoney(ALL).provider.fetchSnapshots(CODES)
    expect(snapshots.map((s) => s.code)).toEqual(CODES)
  })

  it('成交量按手换算成股，时间戳按 unix 秒换算', async () => {
    const [pufa] = await eastmoney(ALL).provider.fetchSnapshots(['SH600000'])
    expect(pufa).toMatchObject({ last: 9.21, preClose: 9.29, volume: 50_942_400 })
    expect(new Date(pufa?.at ?? 0).toISOString()).toBe('2026-08-11T07:57:46.000Z')
  })

  it('停牌股的 "-" 解析成缺失而不是 0，涨跌停回落到本地计算', async () => {
    const byCode = new Map((await eastmoney(ALL).provider.fetchSnapshots(CODES)).map((s) => [s.code, s]))
    expect(byCode.get('BJ430047')).toMatchObject({
      suspended: true,
      last: 8.17,
      preClose: 8.17,
      // 源里给的是 "-"，本地按北交所 ±30% 算
      limitUp: 10.62,
      limitDown: 5.72,
    })
  })

  it('diff 为对象形态时也能解析', async () => {
    const { provider } = eastmoney([['ulist.np/get', SNAPSHOT_OBJ]])
    const snapshots = await provider.fetchSnapshots(['SH600000', 'SZ000001'])
    expect(snapshots.map((s) => s.code)).toEqual(['SH600000', 'SZ000001'])
  })

  it('rc 非 0 报 ProviderDataError', async () => {
    const { provider } = eastmoney([['ulist.np/get', '{"rc":1,"data":null}']])
    await expect(provider.fetchSnapshots(['SH600000'])).rejects.toThrow(/rc=1/)
  })

  it('返回体不是 JSON 时报错并带上片段，便于判断是不是被挡了', async () => {
    const { provider } = eastmoney([['ulist.np/get', '<html>403 Forbidden</html>']])
    await expect(provider.fetchSnapshots(['SH600000'])).rejects.toThrow(/不是 JSON.*403/s)
  })
})

describe('eastmoney · 日线', () => {
  it('不复权发 fqt=0 一次；复权再发 fqt=1', async () => {
    const noAdjust = eastmoney(ALL)
    await noAdjust.provider.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'none')
    expect(noAdjust.calls).toHaveLength(1)
    expect(noAdjust.calls[0]?.url).toContain('fqt=0')
    expect(noAdjust.calls[0]?.url).toContain('beg=20240102')
    expect(noAdjust.calls[0]?.url).toContain('end=20240205')

    const qfq = eastmoney(ALL)
    await qfq.provider.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'qfq')
    expect(qfq.calls.map((c) => (c.url.includes('fqt=0') ? 0 : 1))).toEqual([0, 1])
  })

  it('后复权走 fqt=2', async () => {
    const { provider, calls } = eastmoney([...ALL, ['fqt=2', KLINE_QFQ]])
    await provider.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'hfq')
    expect(calls[1]?.url).toContain('fqt=2')
  })

  it('CSV 列序是 date,open,close,high,low,volume,amount', async () => {
    const candles = await eastmoney(ALL).provider.fetchDaily(
      'SH600000',
      '2024-01-02',
      '2024-02-05',
      'none'
    )
    expect(candles).toHaveLength(25)
    expect(candles[0]).toMatchObject({
      date: '2024-01-02',
      open: 6.63,
      close: 6.6,
      high: 6.65,
      low: 6.6,
      volume: 22_066_700,
    })
    // 与腾讯不同，东财日线给成交额
    expect(candles[0]?.amount).toBeGreaterThan(0)
    for (const c of candles) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close, c.low))
    }
  })

  it('复权双轨按日期对齐', async () => {
    const candles = await eastmoney(ALL).provider.fetchDaily(
      'SH600000',
      '2024-01-02',
      '2024-02-05',
      'qfq'
    )
    expect(candles).toHaveLength(25)
    expect(candles[0]).toMatchObject({ close: 6.6, closeAdj: 5.45 })
    expect(candles.at(-1)).toMatchObject({ close: 6.89, closeAdj: 5.74 })
  })

  it('data 为 null（代码不存在）返回空数组，不报错', async () => {
    const { provider } = eastmoney([['fqt=0', KLINE_EMPTY]])
    expect(await provider.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'none')).toEqual([])
  })

  it('klines 不是数组时报错，而不是静默返回空', async () => {
    const { provider } = eastmoney([['fqt=0', '{"rc":0,"data":{"klines":"oops"}}']])
    await expect(provider.fetchDaily('SH600000', '2024-01-02', '2024-02-05', 'none')).rejects.toThrow(
      /klines 不是数组/
    )
  })
})

describe('eastmoney · 基础信息与日历', () => {
  it('三个源里只有它给行业与上市日', async () => {
    const profile = await eastmoney(ALL).provider.fetchProfile('SH600000')
    expect(profile).toEqual({
      code: 'SH600000',
      name: '浦发银行',
      market: 'SH',
      board: 'MAIN',
      isST: false,
      industry: '银行',
      listedAt: '1999-11-10',
    })
  })

  it('行业为 "-" 时不写这个键（exactOptionalPropertyTypes）', async () => {
    const { provider } = eastmoney([
      ['stock/get', '{"rc":0,"data":{"f57":"600000","f58":"浦发银行","f127":"-","f189":0}}'],
    ])
    const profile = await provider.fetchProfile('SH600000')
    expect('industry' in profile).toBe(false)
    expect('listedAt' in profile).toBe(false)
  })

  it('日历拉基准指数日线并反推开市日', async () => {
    const { provider, calls } = eastmoney(ALL)
    const days = await provider.fetchCalendar?.(2024)
    expect(calls[0]?.url).toContain('secid=1.000001')
    expect(days?.filter((d) => d.isOpen)).toHaveLength(25)
    expect(days?.find((d) => d.date === '2024-01-01')?.isOpen).toBe(false)
  })
})

describe('eastmoney · 当日分时', () => {
  it('请求带 ndays=1 与 iscr=0（不含集合竞价那段虚价）', async () => {
    const { provider, calls } = eastmoney([['trends2/get', TRENDS]])
    await provider.fetchMinutes?.('SH600000')
    expect(calls[0]?.url).toContain('secid=1.600000')
    expect(calls[0]?.url).toContain('ndays=1')
    expect(calls[0]?.url).toContain('iscr=0')
    // 列序由 fields2 决定，两者必须一起改
    expect(calls[0]?.url).toContain('f51%2Cf53%2Cf56%2Cf58')
  })

  it('时刻按北京时间换算，昨收与均价一起带出来', async () => {
    const { provider } = eastmoney([['trends2/get', TRENDS]])
    const series = await provider.fetchMinutes?.('SH600000')
    expect(series?.tradeDate).toBe('2026-08-14')
    expect(series?.preClose).toBe(9.18)
    expect(series?.points).toHaveLength(9)

    const open = series?.points[0]
    // 北京时间 09:30 = UTC 01:30。用 new Date('2026-08-14 09:30') 解析会按本机时区走，
    // 机器不在 +08 时整体偏掉，而这不会报任何错（本仓库的开发机就是 +07）
    expect(open?.ts).toBe(Date.UTC(2026, 7, 14, 1, 30))
    expect(open).toMatchObject({ last: 9.14, avg: 9.14 })
    // f58 是接口直接给的均价，不用自己除（腾讯那边要除，见它的 NOTES）
    expect(series?.points[1]).toMatchObject({ last: 9.11, avg: 9.132 })
    expect(series?.points.at(-1)).toMatchObject({ last: 9.16, avg: 9.124 })
  })

  it('午休那段本来就没有点 —— 解析器不补，由渲染层断线', async () => {
    const { provider } = eastmoney([['trends2/get', TRENDS]])
    const series = await provider.fetchMinutes?.('SH600000')
    const times = series?.points.map((p) => p.ts) ?? []
    const amClose = Date.UTC(2026, 7, 14, 3, 30)
    const pmOpen = Date.UTC(2026, 7, 14, 5, 0)
    expect(times).toContain(amClose)
    expect(times).toContain(pmOpen)
    expect(times.filter((t) => t > amClose && t < pmOpen)).toEqual([])
  })

  it('data 为 null（代码不存在）返回空序列，不抛错', async () => {
    const { provider } = eastmoney([['trends2/get', TRENDS_EMPTY]])
    const series = await provider.fetchMinutes?.('SH600000')
    expect(series).toEqual({ tradeDate: '', preClose: null, points: [] })
  })

  it('trends 不是数组 = 疑似接口变更，宁可报错也不要静默返回空', async () => {
    const { provider } = eastmoney([['trends2/get', '{"rc":0,"data":{"trends":"9.30"}}']])
    await expect(provider.fetchMinutes?.('SH600000')).rejects.toThrow(/trends 不是数组/)
  })

  it('跨日的返回只保留第一天 —— 两天连起来会在午夜画出一条不存在的长线', async () => {
    const body = JSON.stringify({
      rc: 0,
      data: {
        preClose: 9.28,
        trends: ['2026-08-13 14:59,9.20,10,9.20', '2026-08-14 09:30,9.14,10,9.14'],
      },
    })
    const { provider } = eastmoney([['trends2/get', body]])
    const series = await provider.fetchMinutes?.('SH600000')
    expect(series?.tradeDate).toBe('2026-08-13')
    expect(series?.points).toHaveLength(1)
  })
})
