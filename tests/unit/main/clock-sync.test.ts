import { describe, expect, it } from 'vitest'
import { createClockSync } from '@main/scheduler/clock-sync'

/** 固定的本地钟，测试里手动推进 —— 与 src/core 同一条纪律：不读真时钟 */
function fakeLocalClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** 造一个「服务器比本地快 offset 毫秒」的样本，往返 rtt */
function sampleAt(localSentAt: number, offset: number, rtt = 100) {
  return {
    sentAt: localSentAt,
    receivedAt: localSentAt + rtt,
    serverDateMs: localSentAt + rtt / 2 + offset,
  }
}

describe('createClockSync', () => {
  it('没有任何样本时等同本地钟，且如实报 NONE（不假装校准过）', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now })

    expect(clock.now()).toBe(local.now())
    expect(clock.report()).toEqual({ offsetMs: null, samples: 0, source: 'NONE', syncedAt: null })
  })

  it('首个样本直接采用 —— 那一刻冷却表是空的，跳多远都无害', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now })

    clock.observe(sampleAt(local.now(), 180_000))

    expect(clock.report().offsetMs).toBe(180_000)
    expect(clock.report().source).toBe('HTTP_DATE')
    expect(clock.now()).toBe(local.now() + 180_000)
  })

  /*
    这一条钉的是整个模块最重要的纪律。冷却窗口、每小时配额、跨日重置全部假设
    now 单调递增；一次几分钟的回拨会让刚发过的提醒重新变成「冷却已过」，
    于是同一条提醒弹两次，而两行日志都显示自己守规矩。
  */
  it('首次之后每轮最多挪 maxStepMs，绝不一步跳回去', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now, maxStepMs: 2000 })

    clock.observe(sampleAt(local.now(), 0))
    expect(clock.report().offsetMs).toBe(0)

    // 服务器时间突然变成「本地慢了 10 分钟」，每次只能追 2s
    for (const expected of [2000, 4000, 6000]) {
      local.advance(30_000)
      clock.observe(sampleAt(local.now(), 600_000))
      expect(clock.report().offsetMs).toBe(expected)
    }
  })

  it('反方向同样限幅：不会一次性回拨', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now, maxStepMs: 2000, sampleSize: 1 })

    clock.observe(sampleAt(local.now(), 0))
    local.advance(30_000)
    clock.observe(sampleAt(local.now(), -600_000))

    expect(clock.report().offsetMs).toBe(-2000)
  })

  it('取中位数：单个离群样本不能带偏', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now, maxStepMs: 10_000_000 })

    for (const offset of [5000, 5000, 5000]) {
      local.advance(30_000)
      clock.observe(sampleAt(local.now(), offset))
    }
    local.advance(30_000)
    clock.observe(sampleAt(local.now(), 9_000_000))

    // 4 个样本 [5000,5000,5000,9000000] 的中位数仍是 5000
    expect(clock.report().offsetMs).toBe(5000)
  })

  it('RTT 超限的样本丢弃：往返太久，中点估计不可信', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now, maxRttMs: 2000 })

    clock.observe(sampleAt(local.now(), 5000, 9000))

    expect(clock.report()).toMatchObject({ offsetMs: null, samples: 0, source: 'NONE' })
  })

  it('负 RTT（请求中途本地钟被改过）与非有限值一并丢弃', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now })

    clock.observe({ sentAt: local.now(), receivedAt: local.now() - 500, serverDateMs: local.now() })
    clock.observe({ sentAt: local.now(), receivedAt: local.now() + 10, serverDateMs: Number.NaN })

    expect(clock.report().samples).toBe(0)
    expect(clock.now()).toBe(local.now())
  })

  it('滑动窗口只保留最近 sampleSize 个样本', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now, sampleSize: 3, maxStepMs: 10_000_000 })

    for (const offset of [1000, 1000, 1000, 8000, 8000, 8000]) {
      local.advance(30_000)
      clock.observe(sampleAt(local.now(), offset))
    }

    // 老的三个 1000 已经滚出窗口，中位数是 8000
    expect(clock.report().offsetMs).toBe(8000)
  })

  it('syncedAt 记的是本地钟，用来回答「多久没校过了」', () => {
    const local = fakeLocalClock()
    const clock = createClockSync({ localNow: local.now })

    local.advance(5000)
    const sentAt = local.now()
    clock.observe(sampleAt(sentAt, 1000, 100))

    expect(clock.report().syncedAt).toBe(sentAt + 100)
  })
})
