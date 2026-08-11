/**
 * 新浪 provider 的 fixture 回放。fixture 是 2026-08-11 录制的真实响应。
 */

import { describe, expect, it } from 'vitest'
import { USER_AGENT } from '@main/net/http'
import { createSinaProvider } from '@main/providers/sina'
import { FIXED_NOW, fixtureBytes, replay } from './fixtures'

const SNAPSHOT = fixtureBytes('sina', 'snapshot-mixed.gbk.txt')

const CODES = ['SH600000', 'SZ000001', 'SZ300750', 'BJ430047', 'SH510300']

function sina(bytes: Uint8Array | string = SNAPSHOT) {
  const { http, calls } = replay([['hq.sinajs.cn/list=', bytes]])
  return { provider: createSinaProvider({ http, now: () => FIXED_NOW }), calls }
}

/** fixture 是一整批的响应，按代码取那一条 */
async function byCode() {
  const snapshots = await sina().provider.fetchSnapshots(CODES)
  return new Map(snapshots.map((s) => [s.code, s]))
}

describe('sina · 批量快照', () => {
  it('带 Referer 与统一 UA —— 缺 Referer 会 403', async () => {
    const { provider, calls } = sina()
    await provider.fetchSnapshots(['SH600000'])
    expect(calls[0]?.headers['Referer']).toBe('https://finance.sina.com.cn')
    expect(calls[0]?.headers['User-Agent']).toBe(USER_AGENT)
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
      // 8 号字段本来就是股，不需要换算
      volume: 50_942_433,
      amount: 470_381_696,
      suspended: false,
    })
    // 30/31 号字段 '2026-08-11' + '15:34:59'，北京时间
    expect(new Date(pufa?.at ?? 0).toISOString()).toBe('2026-08-11T07:34:59.000Z')
  })

  it('新浪不给涨跌停，全部本地按板块算', async () => {
    const map = await byCode()
    expect(map.get('SH600000')).toMatchObject({ limitUp: 10.22, limitDown: 8.36 })
    expect(map.get('SZ300750')).toMatchObject({ limitUp: 472.64, limitDown: 315.1 })
    expect(map.get('SH510300')).toMatchObject({ limitUp: 5.235, limitDown: 4.283 })
  })

  it('整行 0 的记录整条丢弃 —— 昨收写成 0 会污染涨跌停与止损', async () => {
    const map = await byCode()
    // fixture 里 bj430047 是一整行 0（新浪对长期停牌就这么给）
    expect(map.has('BJ430047')).toBe(false)
    // 其余四条都在 —— 不能因为一条脏记录拖累整批
    expect([...map.keys()]).toEqual(['SH600000', 'SZ000001', 'SZ300750', 'SH510300'])
  })

  it('与腾讯的成交额一致，可用于两源交叉校验', async () => {
    const etf = (await byCode()).get('SH510300')
    // 腾讯 57 号字段 254140.0132 万元 → 2541400132 元
    expect(etf?.amount).toBe(2_541_400_132)
  })

  it('超过 50 只分片', async () => {
    const codes = Array.from({ length: 120 }, (_, i) => `SH60${String(i).padStart(4, '0')}`)
    const { provider, calls } = sina()
    await provider.fetchSnapshots(codes)
    expect(calls).toHaveLength(3)
  })

  it('空代码列表不发请求', async () => {
    const { provider, calls } = sina()
    expect(await provider.fetchSnapshots([])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('sina · 能力边界', () => {
  it('不承担日线，明确报错而不是返回空数组', async () => {
    const { provider } = sina()
    expect(provider.capabilities.daily).toBe(false)
    await expect(provider.fetchDaily('SH600000', '2024-01-01', '2024-02-01', 'qfq')).rejects.toThrow(
      /不提供 日线/
    )
  })

  it('基础信息只有名称与板块（GBK 解码正确）', async () => {
    const profile = await sina().provider.fetchProfile('SH600000')
    expect(profile).toEqual({
      code: 'SH600000',
      name: '浦发银行',
      market: 'SH',
      board: 'MAIN',
      isST: false,
    })
    expect(profile.industry).toBeUndefined()
  })

  it('取不到名称时报错，不返回一个空名字的 profile', async () => {
    const { provider } = sina('var hq_str_sh600000="";')
    await expect(provider.fetchProfile('SH600000')).rejects.toThrow(/没有取到名称/)
  })
})
