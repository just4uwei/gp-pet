/**
 * 分时图的取舍规则（src/main/engine/intraday.ts）。
 *
 * 这里每一条钉的都是「错了之后图上完全看不出来」的那一类 ——
 * 一条日期错位的曲线、一条被两种采样口径拼出来的锯齿线、一条从 0% 起步的涨跌幅轴，
 * 在截图上都长得像正常的分时图。
 */

import { describe, expect, it } from 'vitest'
import {
  createMinuteCache,
  mergeIntraday,
  shanghaiTradeDate,
  type LocalIntraday,
} from '@main/engine/intraday'
import type { MinuteSeries } from '@main/providers'

/** 北京时间 2026-08-11 的那一天 */
const DAY = Date.UTC(2026, 7, 11) - 8 * 60 * 60_000
const at = (hh: number, mm: number): number => DAY + (hh * 60 + mm) * 60_000
const WINDOW = { from: DAY, to: DAY + 15 * 60 * 60_000 }

const REMOTE: MinuteSeries = {
  tradeDate: '2026-08-11',
  preClose: 9.28,
  points: [
    { ts: at(9, 30), last: 9.3, avg: 9.3 },
    { ts: at(11, 30), last: 9.34, avg: 9.323 },
    { ts: at(15, 0), last: 9.42, avg: 9.356 },
  ],
}

const LOCAL: LocalIntraday = {
  preClose: 9.28,
  points: [
    { ts: at(13, 2), last: 9.36 },
    { ts: at(13, 3), last: 9.37 },
  ],
}

const EMPTY_LOCAL: LocalIntraday = { preClose: null, points: [] }

describe('分时取舍 · 远端优先', () => {
  it('远端有点就用远端，本机留痕整份让开', () => {
    const series = mergeIntraday('SH600000', LOCAL, REMOTE, WINDOW)
    expect(series.source).toBe('REMOTE')
    expect(series.tradeDate).toBe('2026-08-11')
    expect(series.points).toHaveLength(3)
    // 两份数据**不合并**：本机那两个 13:02/13:03 的点不许混进来。
    // 分钟收盘价与 30s 快照是两种采样口径，拼在一条线上会出现肉眼可见的锯齿，
    // 而用户没有任何办法看出那是两个来源
    expect(series.points.map((p) => p.ts)).not.toContain(at(13, 2))
  })

  it('均价原样带出来 —— 它是画均价线的唯一依据', () => {
    const series = mergeIntraday('SH600000', EMPTY_LOCAL, REMOTE, WINDOW)
    expect(series.points.map((p) => p.avg)).toEqual([9.3, 9.323, 9.356])
  })
})

describe('分时取舍 · 降级', () => {
  it('远端整个拿不到（null）→ 退回本机留痕，source 必须如实是 LOCAL', () => {
    const series = mergeIntraday('SH600000', LOCAL, null, WINDOW)
    expect(series.source).toBe('LOCAL')
    expect(series.points).toHaveLength(2)
  })

  it('远端返回了但一个点都没有（停牌）→ 同样降级，不是「试过就算 REMOTE」', () => {
    const series = mergeIntraday('SH600000', LOCAL, { ...REMOTE, points: [] }, WINDOW)
    expect(series.source).toBe('LOCAL')
  })

  it('本机留痕没有均价，**不插值补一条出来**', () => {
    const series = mergeIntraday('SH600000', LOCAL, null, WINDOW)
    expect(series.points.map((p) => p.avg)).toEqual([null, null])
  })

  it('两边都空：tradeDate 为 null，渲染层据此给「今天还没有分时数据」', () => {
    const series = mergeIntraday('SH600000', EMPTY_LOCAL, null, WINDOW)
    expect(series).toEqual({
      code: 'SH600000',
      tradeDate: null,
      source: 'LOCAL',
      preClose: null,
      points: [],
    })
  })
})

describe('分时取舍 · 窗口过滤', () => {
  it('休市日数据源给的是上一个交易日 —— 落在窗口外就整段作废，降级成 LOCAL', () => {
    // 周六打开抽屉：窗口是周六，接口返回的是周五那条曲线
    const saturday = { from: DAY + 5 * 86_400_000, to: DAY + 5 * 86_400_000 + 15 * 60 * 60_000 }
    const series = mergeIntraday('SH600000', EMPTY_LOCAL, REMOTE, saturday)
    // 不许把周五的走势塞进周六的 x 轴 —— 那是一张日期错位却毫无破绽的图
    expect(series.source).toBe('LOCAL')
    expect(series.points).toEqual([])
  })

  it('窗口内的远端点才留下', () => {
    const morning = { from: DAY, to: at(12, 0) }
    const series = mergeIntraday('SH600000', EMPTY_LOCAL, REMOTE, morning)
    expect(series.points.map((p) => p.ts)).toEqual([at(9, 30), at(11, 30)])
  })

  it('本机留痕也照窗口切', () => {
    const morning = { from: DAY, to: at(12, 0) }
    expect(mergeIntraday('SH600000', LOCAL, null, morning).points).toEqual([])
  })
})

describe('分时取舍 · 昨收', () => {
  it('远端优先', () => {
    const remote = { ...REMOTE, preClose: 9.5 }
    expect(mergeIntraday('SH600000', LOCAL, remote, WINDOW).preClose).toBe(9.5)
  })

  it('远端没给才用本机留下的那个', () => {
    const remote = { ...REMOTE, preClose: null }
    expect(mergeIntraday('SH600000', LOCAL, remote, WINDOW).preClose).toBe(9.28)
  })

  it('都没有就是 null —— 绝不拿当日首个价顶替（约束 4）', () => {
    const remote = { ...REMOTE, preClose: null }
    const series = mergeIntraday('SH600000', EMPTY_LOCAL, remote, WINDOW)
    // 顶替的症状是涨跌幅永远从 0% 开始，看起来像今天没波动过
    expect(series.preClose).toBeNull()
  })
})

describe('交易日按北京时间算', () => {
  it('本机时区不参与 —— 09:30 与 15:00 属于同一天', () => {
    expect(shanghaiTradeDate(at(9, 30))).toBe('2026-08-11')
    expect(shanghaiTradeDate(at(15, 0))).toBe('2026-08-11')
  })

  it('北京时间 00:00 与 23:59 分属相邻两天', () => {
    expect(shanghaiTradeDate(DAY)).toBe('2026-08-11')
    expect(shanghaiTradeDate(DAY + 86_400_000 - 1)).toBe('2026-08-11')
    expect(shanghaiTradeDate(DAY + 86_400_000)).toBe('2026-08-12')
  })
})

describe('分时缓存 · 它是这条取数路径自己的请求闸门', () => {
  function harness() {
    let calls = 0
    let clock = 0
    const cache = createMinuteCache(
      async () => {
        calls += 1
        return REMOTE
      },
      () => clock
    )
    return {
      cache,
      calls: () => calls,
      tick: (ms: number) => {
        clock += ms
      },
    }
  }

  it('TTL 内只真发一次 —— 用户来回切页签不该变成连击', async () => {
    const h = harness()
    await h.cache.get('SH600000')
    h.tick(29_000)
    await h.cache.get('SH600000')
    expect(h.calls()).toBe(1)
  })

  it('TTL 过了才重新拉', async () => {
    const h = harness()
    await h.cache.get('SH600000')
    h.tick(30_000)
    await h.cache.get('SH600000')
    expect(h.calls()).toBe(2)
  })

  it('两只票各自缓存，互不顶掉', async () => {
    const h = harness()
    await Promise.all([h.cache.get('SH600000'), h.cache.get('SZ000001')])
    expect(h.calls()).toBe(2)
  })

  it('在途请求合并：连点两次共用同一趟，不是各发一趟', async () => {
    let calls = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cache = createMinuteCache(
      async () => {
        calls += 1
        await gate
        return REMOTE
      },
      () => 0
    )

    const both = Promise.all([cache.get('SH600000'), cache.get('SH600000')])
    release()
    await both
    expect(calls).toBe(1)
  })

  it('失败不进缓存 —— 缓存住一个错误等于把网络抖动钉死 30 秒', async () => {
    let calls = 0
    const cache = createMinuteCache(
      async () => {
        calls += 1
        throw new Error('other side closed')
      },
      () => 0
    )

    await expect(cache.get('SH600000')).rejects.toThrow('other side closed')
    await expect(cache.get('SH600000')).rejects.toThrow('other side closed')
    expect(calls).toBe(2)
  })
})
