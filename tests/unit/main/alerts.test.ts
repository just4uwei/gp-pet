/**
 * 提醒分发的四道闸门（docs/05 §4）。
 *
 * M3 的出口条件是主观的（「自用一周，没被打扰过也没漏掉重要信号」），
 * 而主观感受**发现不了闸门写错**：漏发的那条信号不会来告诉你它被吃了。
 * 所以四道闸门必须先有单测，再谈自用。
 *
 * 每条用例都对应 docs/05 §4 的一行规定，测的是「该丢的丢、该降的降、该发的发」，
 * 以及两个方向不对称的错误：
 *   多发 → 骚扰，用户会立刻抱怨（能自己发现）
 *   少发 → 漏掉止损，用户不知道自己漏了什么（发现不了）
 * 所以「强制类不受冷却」「降级而不是丢弃」这两条比其他用例更严。
 */

import { describe, expect, it } from 'vitest'
import {
  AlertDispatcher,
  CHANNELS_BY_LEVEL,
  type AlertCandidate,
  type DispatcherOptions,
} from '@main/alerts/dispatcher'
import type { SecCode } from '@core/types'
import { shanghaiDayStartMs } from '@shared/time'

const MIN = 60_000
const HOUR = 60 * MIN
/**
 * 固定基准时刻，绝不读时钟。**刻意取当日 09:00 而不是随便一个整数** ——
 * 原先用的 1_700_000_000_000 落在 UTC 22:13，于是「同日 6 小时后」实际上跨了日，
 * 把 L3 的当日冷却重置掉、用例反而通过不了。基准时刻本身也要挑，别踩边界。
 */
const T0 = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000 + 9 * HOUR

/** 用 UTC 零点算「当日」，让用例不受运行环境时区影响 */
const utcStartOfDay = (ts: number): number => Math.floor(ts / 86_400_000) * 86_400_000

function candidate(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    signalId: 'sig-1',
    code: 'SH600000' as SecCode,
    direction: 'BUY',
    level: 'L2',
    score: 0.8,
    topSubSignalId: 'T1_MA_CROSS',
    ...overrides,
  }
}

function make(options: DispatcherOptions = {}): AlertDispatcher {
  return new AlertDispatcher({ startOfDay: utcStartOfDay, ...options })
}

const calm = { quiet: false }

describe('① 防抖：连续 N 个 tick 才发（docs/05 §4.1）', () => {
  it('第一个 tick 被丢弃，第二个才发出', () => {
    const d = make()
    const first = d.dispatch([candidate()], T0, calm)[0]
    expect(first?.level).toBeNull()
    expect(first?.reason).toContain('防抖')

    const second = d.dispatch([candidate()], T0 + MIN, calm)[0]
    expect(second?.level).toBe('L2')
    expect(second?.reason).toBeNull()
  })

  it('中间断一轮就重新计数 —— 阈值附近抖动是骚扰的最大来源', () => {
    const d = make()
    d.dispatch([candidate()], T0, calm)
    // 这一轮该信号没出现（换了别的标的）
    d.dispatch([candidate({ code: 'SZ000001' as SecCode })], T0 + MIN, calm)
    const back = d.dispatch([candidate()], T0 + 2 * MIN, calm)[0]
    expect(back?.level).toBeNull()
    expect(back?.reason).toContain('1/2')
  })

  it('子信号变了就是另一个键，重新计数', () => {
    const d = make()
    d.dispatch([candidate()], T0, calm)
    const other = d.dispatch([candidate({ topSubSignalId: 'T3_BREAKOUT' })], T0 + MIN, calm)[0]
    expect(other?.level).toBeNull()
  })

  it('持仓强制类不防抖 —— 止损晚一个 tick 是真金白银', () => {
    const d = make()
    const first = d.dispatch([candidate({ level: 'L3', forced: true, lossPct: -0.09 })], T0, calm)[0]
    expect(first?.level).toBe('L3')
  })

  it('收盘确认轮（debounce: false）不防抖 —— 那时没有「连续 tick」可言', () => {
    const d = make()
    const first = d.dispatch([candidate()], T0, { quiet: false, debounce: false })[0]
    expect(first?.level).toBe('L2')
  })
})

describe('② 同键冷却（docs/05 §4.2）', () => {
  /** 跳过防抖：连喂两轮让它发出第一条 */
  function warm(d: AlertDispatcher, c: AlertCandidate, at: number): void {
    d.dispatch([c], at - MIN, calm)
    d.dispatch([c], at, calm)
  }

  it('L2 冷却 2 小时内不重复', () => {
    const d = make()
    warm(d, candidate(), T0)
    const soon = d.dispatch([candidate()], T0 + HOUR, calm)[0]
    expect(soon?.level).toBeNull()
    expect(soon?.reason).toContain('冷却')
    const later = d.dispatch([candidate()], T0 + 2 * HOUR + MIN, calm)[0]
    expect(later?.level).toBe('L2')
  })

  it('L1 冷却 30 分钟', () => {
    const d = make()
    warm(d, candidate({ level: 'L1' }), T0)
    expect(d.dispatch([candidate({ level: 'L1' })], T0 + 20 * MIN, calm)[0]?.level).toBeNull()
    expect(d.dispatch([candidate({ level: 'L1' })], T0 + 31 * MIN, calm)[0]?.level).toBe('L1')
  })

  it('L3 是「当日一次」，不是 24 小时 —— 否则今天 23:00 发过会挡住明天开盘', () => {
    const d = make()
    warm(d, candidate({ level: 'L3' }), T0)
    // 同日 6 小时后仍在冷却
    expect(d.dispatch([candidate({ level: 'L3' })], T0 + 6 * HOUR, calm)[0]?.reason).toContain('今日已发过')
    // 跨到次日就放行
    const nextDay = utcStartOfDay(T0) + 86_400_000 + 9 * HOUR
    expect(d.dispatch([candidate({ level: 'L3' })], nextDay, calm)[0]?.level).toBe('L3')
  })

  it('反方向是另一个键，不共享冷却', () => {
    const d = make()
    warm(d, candidate(), T0)
    const sell = candidate({ direction: 'SELL', topSubSignalId: 'T2_MACD_ZERO_CROSS' })
    warm(d, sell, T0 + 2 * MIN)
    expect(d.dispatch([sell], T0 + 3 * MIN, calm)[0]?.reason).toContain('冷却')
    // 上一行说明 SELL 自己已经发过了（否则不会有冷却），即两个方向互不影响
  })

  it('强制类不受冷却，但跌幅要每扩大 2% 才再提醒一次', () => {
    const d = make()
    const forced = (lossPct: number): AlertCandidate =>
      candidate({ level: 'L3', forced: true, lossPct })
    expect(d.dispatch([forced(-0.08)], T0, calm)[0]?.level).toBe('L3')
    // 只多跌 1%：压住
    const small = d.dispatch([forced(-0.09)], T0 + 5 * MIN, calm)[0]
    expect(small?.level).toBeNull()
    expect(small?.reason).toContain('台阶')
    // 再扩大到 2% 以上：必须重发（漏掉止损是发现不了的错误）
    expect(d.dispatch([forced(-0.105)], T0 + 10 * MIN, calm)[0]?.level).toBe('L3')
  })
})

describe('③ 频率上限：超限降级而不是丢弃（docs/05 §4.3）', () => {
  /** 造 n 个互不同键的候选，全部已过防抖 */
  function burst(d: AlertDispatcher, n: number, at: number, level: AlertCandidate['level'] = 'L2'): void {
    for (let i = 0; i < n; i++) {
      const c = candidate({ code: `SH60000${i}` as SecCode, level, topSubSignalId: `S${i}` })
      d.dispatch([c], at - MIN, calm)
      d.dispatch([c], at, calm)
    }
  }

  it('全局每小时 L2+L3 ≤ 6，第 7 条降为 L1 而不是消失', () => {
    const d = make()
    burst(d, 6, T0)
    const c = candidate({ code: 'SZ000001' as SecCode, topSubSignalId: 'S9' })
    d.dispatch([c], T0 + MIN, calm)
    const seventh = d.dispatch([c], T0 + 2 * MIN, calm)[0]
    expect(seventh?.level).toBe('L1')
    expect(seventh?.reason).toContain('每小时')
    // 降级了也要有渠道（进面板与角标），不是黑洞
    expect(seventh?.channels).toEqual(CHANNELS_BY_LEVEL.L1)
  })

  it('用滑动窗口而不是整点桶 —— 否则 10:59 六条 + 11:00 六条 = 两分钟十二条', () => {
    const d = make()
    burst(d, 6, T0)
    const c = candidate({ code: 'SZ000001' as SecCode, topSubSignalId: 'S9' })
    d.dispatch([c], T0 + 30 * MIN, calm)
    // 距第一批不到一小时：仍然受限
    expect(d.dispatch([c], T0 + 31 * MIN, calm)[0]?.level).toBe('L1')
    // 满一小时后配额自然释放
    const d2 = make()
    burst(d2, 6, T0)
    const c2 = candidate({ code: 'SZ000002' as SecCode, topSubSignalId: 'S8' })
    d2.dispatch([c2], T0 + HOUR + MIN, calm)
    expect(d2.dispatch([c2], T0 + HOUR + 2 * MIN, calm)[0]?.level).toBe('L2')
  })

  it('同一轮里配额给得分最高的那条（不是先到先得）', () => {
    const d = make({ hourlyLimit: 1 })
    const low = candidate({ code: 'SH600001' as SecCode, score: 0.62, topSubSignalId: 'A' })
    const high = candidate({ code: 'SH600002' as SecCode, score: 0.94, topSubSignalId: 'B' })
    // 先过防抖
    d.dispatch([low, high], T0, calm)
    const round = d.dispatch([low, high], T0 + MIN, calm)
    const byCode = new Map(round.map((r) => [r.candidate.code, r]))
    expect(byCode.get('SH600002' as SecCode)?.level).toBe('L2')
    expect(byCode.get('SH600001' as SecCode)?.level).toBe('L1')
  })

  it('单标的每日 L2+L3 ≤ 4', () => {
    const d = make({ cooldownMs: { L1: 0, L2: 0, L3: 0 } })
    const code = 'SH600000' as SecCode
    for (let i = 0; i < 4; i++) {
      const c = candidate({ code, topSubSignalId: `S${i}` })
      d.dispatch([c], T0 + i * MIN, calm)
      d.dispatch([c], T0 + i * MIN + 1000, calm)
    }
    const fifth = candidate({ code, topSubSignalId: 'S9' })
    d.dispatch([fifth], T0 + 10 * MIN, calm)
    const got = d.dispatch([fifth], T0 + 11 * MIN, calm)[0]
    expect(got?.level).toBe('L1')
    expect(got?.reason).toContain('今日 L2+L3')
  })

  it('全局每日 L3 ≤ 10（L2 不受这一条限制）', () => {
    const d = make({ cooldownMs: { L1: 0, L2: 0, L3: 0 }, hourlyLimit: 999, perCodeDailyLimit: 999 })
    for (let i = 0; i < 10; i++) {
      const c = candidate({ code: `SH60${String(i).padStart(4, '0')}` as SecCode, level: 'L3', topSubSignalId: `S${i}` })
      d.dispatch([c], T0 + i * MIN, calm)
      d.dispatch([c], T0 + i * MIN + 1000, calm)
    }
    const eleventh = candidate({ code: 'SZ000001' as SecCode, level: 'L3', topSubSignalId: 'S99' })
    d.dispatch([eleventh], T0 + 20 * MIN, calm)
    expect(d.dispatch([eleventh], T0 + 21 * MIN, calm)[0]?.reason).toContain('今日 L3')
    // 同样条件下的 L2 仍然放行
    const l2 = candidate({ code: 'SZ000002' as SecCode, level: 'L2', topSubSignalId: 'S98' })
    d.dispatch([l2], T0 + 22 * MIN, calm)
    expect(d.dispatch([l2], T0 + 23 * MIN, calm)[0]?.level).toBe('L2')
  })

  it('被降级成 L1 的不占用 L2/L3 的额度 —— 只有实际发出的才记账', () => {
    const d = make({ hourlyLimit: 1, cooldownMs: { L1: 0, L2: 0, L3: 0 } })
    const a = candidate({ code: 'SH600001' as SecCode, topSubSignalId: 'A' })
    const b = candidate({ code: 'SH600002' as SecCode, topSubSignalId: 'B', score: 0.5 })
    d.dispatch([a, b], T0, calm)
    d.dispatch([a, b], T0 + MIN, calm) // a 发 L2，b 降 L1
    // 一小时后配额释放，只应释放 1 条（a 那条），b 从未占用
    const later = d.dispatch([b], T0 + HOUR + 2 * MIN, calm)[0]
    expect(later?.level).toBe('L2')
  })
})

describe('④ 免打扰：L2/L3 降为 L1（docs/05 §4.4）', () => {
  it('免打扰期间降级并写明原因，仍然进面板与状态点', () => {
    const d = make()
    const c = candidate({ level: 'L3' })
    d.dispatch([c], T0, { quiet: true, quietReason: '全屏应用' })
    const got = d.dispatch([c], T0 + MIN, { quiet: true, quietReason: '全屏应用' })[0]
    expect(got?.level).toBe('L1')
    expect(got?.reason).toContain('全屏应用')
    // 降级的核心后果：不弹气泡（气泡是唯一的可见渠道），但状态点仍然点亮
    expect(got?.channels).not.toContain('BUBBLE')
    expect(got?.channels).toContain('PET')
  })

  it('免打扰期间的降级不占 L3 的每日额度', () => {
    const d = make({ cooldownMs: { L1: 0, L2: 0, L3: 0 } })
    const quiet = { quiet: true }
    for (let i = 0; i < 12; i++) {
      const c = candidate({ code: `SH60${String(i).padStart(4, '0')}` as SecCode, level: 'L3', topSubSignalId: `S${i}` })
      d.dispatch([c], T0 + i * MIN, quiet)
      d.dispatch([c], T0 + i * MIN + 1000, quiet)
    }
    // 解除免打扰后，L3 额度应当还是满的
    const after = candidate({ code: 'SZ000009' as SecCode, level: 'L3', topSubSignalId: 'S99' })
    d.dispatch([after], T0 + 30 * MIN, calm)
    expect(d.dispatch([after], T0 + 31 * MIN, calm)[0]?.level).toBe('L3')
  })

  /*
    2026-08-17 真机日志掉出来的漏报，钉死它。

    那天开盘第一轮（09:30:05）屏幕锁定，三只跌破止损线的持仓（浮亏 −7.8%）被降为 L1
    —— 降级本身是本节的设计。但台阶**照样被记成 −7.8%**，于是解锁之后跌到 −8.4%
    也再不提醒（要再扩大 2%）：整天 0 条气泡、1580 行「台阶未扩大」。
    §4.2 那句「既不骚扰又不漏报」当天只剩后半句被打穿。

    判据是「解除之后必须补上」，而不是「降级那一轮要不要发」—— 后者是设计，前者是缺陷。
  */
  it('免打扰期间的降级不消耗强制类台阶 —— 解除后同一笔浮亏必须补上那条气泡', () => {
    const d = make()
    const forced = (lossPct: number): AlertCandidate =>
      candidate({ level: 'L3', forced: true, lossPct })

    const locked = d.dispatch([forced(-0.078)], T0, { quiet: true, quietReason: '屏幕已锁定' })[0]
    expect(locked?.level).toBe('L1')
    expect(locked?.channels).not.toContain('BUBBLE')

    // 解除免打扰，跌幅只多了 0.6pp（远够不上 2% 的台阶）—— 仍然必须发
    const after = d.dispatch([forced(-0.084)], T0 + 30 * MIN, calm)[0]
    expect(after?.level).toBe('L3')
    expect(after?.channels).toContain('BUBBLE')
  })

  it('频率上限造成的降级同样不消耗台阶（同一条纪律，另一道闸门）', () => {
    const d = make({ hourlyLimit: 1 })
    // 先用掉本小时唯一的额度
    const other = candidate({ code: 'SZ000001' as SecCode, topSubSignalId: 'X' })
    d.dispatch([other], T0 - MIN, calm)
    d.dispatch([other], T0, calm)

    const forced = (lossPct: number): AlertCandidate =>
      candidate({ level: 'L3', forced: true, lossPct })
    expect(d.dispatch([forced(-0.078)], T0 + MIN, calm)[0]?.level).toBe('L1')
    // 一小时后配额释放：同一笔浮亏只多跌 0.6pp，仍然必须发
    expect(d.dispatch([forced(-0.084)], T0 + HOUR + 2 * MIN, calm)[0]?.level).toBe('L3')
  })

  it('L1 在免打扰下不再降级（已经是最低档），也不报原因', () => {
    const d = make()
    const c = candidate({ level: 'L1' })
    d.dispatch([c], T0, { quiet: true })
    const got = d.dispatch([c], T0 + MIN, { quiet: true })[0]
    expect(got?.level).toBe('L1')
    expect(got?.reason).toBeNull()
  })
})

describe('不制造信息黑洞（docs/05 §4 开头）', () => {
  it('每一个候选都有一条裁决，丢弃的也带原因', () => {
    const d = make()
    const a = candidate({ code: 'SH600001' as SecCode, topSubSignalId: 'A' })
    const b = candidate({ code: 'SH600002' as SecCode, topSubSignalId: 'B' })
    const round = d.dispatch([a, b], T0, calm)
    expect(round).toHaveLength(2)
    for (const decision of round) {
      expect(decision.reason).not.toBeNull()
      expect(decision.level).toBeNull()
    }
  })

  it('跨日重置当日计数与强制类台阶', () => {
    const d = make({ cooldownMs: { L1: 0, L2: 0, L3: 0 }, hourlyLimit: 999 })
    const code = 'SH600000' as SecCode
    for (let i = 0; i < 4; i++) {
      const c = candidate({ code, topSubSignalId: `S${i}` })
      d.dispatch([c], T0 + i * MIN, calm)
      d.dispatch([c], T0 + i * MIN + 1000, calm)
    }
    const nextDay = utcStartOfDay(T0) + 86_400_000 + 9 * HOUR
    const c = candidate({ code, topSubSignalId: 'S9' })
    d.dispatch([c], nextDay, calm)
    expect(d.dispatch([c], nextDay + MIN, calm)[0]?.level).toBe('L2')
  })

  /*
    默认日界是**北京时间**，不是宿主本地时区（2026-08-15）。

    上面那些用例都注入了 `utcStartOfDay`，所以它们测不到默认值 —— 而默认值正是
    生产在用的那个。原先默认是 `new Date(y, m, d)`：在 UTC−5 上本机 00:00 是北京 13:00，
    「每日 L2+L3 ≤ 4」会在午盘开盘那一刻重置，多发的配额没有任何人看得见。

    判据是**跨北京日界的那一对时刻**：北京 23:59 仍受限、北京次日 00:01 已重置。
    按本地日实现的话这一对在几乎任何时区都落在同一个本地日里（UTC+7 上是
    本机 22:59 与 23:01，UTC+0 上是 15:59 与 16:01），于是第二条断言必红。
  */
  it('默认日界走北京时间，不受宿主时区影响', () => {
    const d = new AlertDispatcher({ cooldownMs: { L1: 0, L2: 0, L3: 0 }, hourlyLimit: 999 })
    const code = 'SH600000' as SecCode
    // 北京时间某日 14:00
    const dayStart = shanghaiDayStartMs(T0)
    const base = dayStart + 14 * HOUR

    for (let i = 0; i < 4; i++) {
      const c = candidate({ code, topSubSignalId: `S${i}` })
      d.dispatch([c], base + i * MIN, calm)
      d.dispatch([c], base + i * MIN + 1000, calm)
    }

    const beforeMidnight = candidate({ code, topSubSignalId: 'S9' })
    const lateAt = dayStart + 23 * HOUR + 59 * MIN
    d.dispatch([beforeMidnight], lateAt, calm)
    expect(d.dispatch([beforeMidnight], lateAt + 1000, calm)[0]?.level).toBe('L1')

    const afterMidnight = candidate({ code, topSubSignalId: 'S10' })
    const earlyAt = dayStart + 86_400_000 + MIN
    d.dispatch([afterMidnight], earlyAt, calm)
    expect(d.dispatch([afterMidnight], earlyAt + 1000, calm)[0]?.level).toBe('L2')
  })
})

/*
  双轨提醒的配额（2026-08-17，用户拍板）。

  此前「行业ETF」组整个不进闸门，理由是配额共享会让 15 只观察标的挤掉真持仓的提醒 ——
  而被挤掉的那条止损用户不会知道自己漏了。所以双轨的实现要求是硬的：
  **OBSERVE 轨有自己一份日配额，且不碰 PRIMARY 的任何计数器。**
  这一组的第二条用例是整件事的核心断言 —— 它变红就意味着「不挤占」这条保证破了。
*/
describe('双轨提醒：OBSERVE 轨的独立配额', () => {
  const observe = (i: number): AlertCandidate =>
    candidate({
      code: `SH51288${i}` as SecCode,
      topSubSignalId: `O${i}`,
      track: 'OBSERVE',
    })

  it('OBSERVE 轨用满自己的日配额后降为 L1', () => {
    const d = make({ observeDailyLimit: 2 })
    for (let i = 0; i < 2; i++) {
      d.dispatch([observe(i)], T0 + i * MIN, calm)
      d.dispatch([observe(i)], T0 + i * MIN + 1000, calm)
    }
    const third = observe(9)
    d.dispatch([third], T0 + 10 * MIN, calm)
    const got = d.dispatch([third], T0 + 11 * MIN, calm)[0]
    expect(got?.level).toBe('L1')
    expect(got?.reason).toContain('观察标的今日已达 2 条')
  })

  it('**OBSERVE 用满配额不影响 PRIMARY** —— 这是双轨存在的全部前提', () => {
    const d = make({ observeDailyLimit: 1, hourlyLimit: 6 })
    // 观察轨先把自己那一条用掉，再多来两条（都会被降级）
    for (const i of [0, 1, 2]) {
      d.dispatch([observe(i)], T0 + i * MIN, calm)
      d.dispatch([observe(i)], T0 + i * MIN + 1000, calm)
    }
    // 个股这边应当完全不受影响：六条全额发出
    for (let i = 0; i < 6; i++) {
      const c = candidate({ code: `SH60000${i}` as SecCode, topSubSignalId: `P${i}` })
      d.dispatch([c], T0 + (10 + i) * MIN, calm)
      const got = d.dispatch([c], T0 + (10 + i) * MIN + 1000, calm)[0]
      expect(got?.level).toBe('L2')
    }
  })

  it('反过来也成立：个股用满全局每小时配额，观察轨仍有自己那一份', () => {
    const d = make({ hourlyLimit: 1, observeDailyLimit: 2 })
    const stock = candidate({ code: 'SH600001' as SecCode, topSubSignalId: 'P' })
    d.dispatch([stock], T0, calm)
    d.dispatch([stock], T0 + MIN, calm)
    const o = observe(3)
    d.dispatch([o], T0 + 2 * MIN, calm)
    expect(d.dispatch([o], T0 + 3 * MIN, calm)[0]?.level).toBe('L2')
  })

  it('OBSERVE 的配额跨日重置', () => {
    const d = make({ observeDailyLimit: 1 })
    const o = observe(4)
    d.dispatch([o], T0, calm)
    d.dispatch([o], T0 + MIN, calm)
    const nextDay = utcStartOfDay(T0) + 86_400_000 + 9 * HOUR
    const o2 = observe(5)
    d.dispatch([o2], nextDay, calm)
    expect(d.dispatch([o2], nextDay + MIN, calm)[0]?.level).toBe('L2')
  })

  it('不传 track 时一律按 PRIMARY —— 双轨之前的行为逐位不变', () => {
    const d = make({ observeDailyLimit: 0 })
    const c = candidate()
    d.dispatch([c], T0, calm)
    // observeDailyLimit = 0 若误作用于 PRIMARY，这条会被降成 L1
    expect(d.dispatch([c], T0 + MIN, calm)[0]?.level).toBe('L2')
  })
})

/*
  闸门状态跨重启（2026-08-19）。

  此前 dispatcher.ts 的头注释写着「刻意不落库」，理由是「落库会让『重启后被冷却挡住、
  什么都不弹』变成一个很难查的问题」。**推翻它的是真机数据**：实测 08-13 启动 14 次、
  08-14 二十七次，那两天「一天 10 条止损气泡」逐条对得上启动时刻。

  下面五条钉的是那条旧顾虑被堵住的方式 —— 少任何一条都不该落库。
*/
describe('跨重启：snapshot / restore', () => {
  /**
   * 模拟一次重启：把状态搬到一个全新实例上。
   *
   * 默认 `debounceTicks: 1` —— 防抖是**闸门①**，它会先于冷却拦下第一轮，
   * 于是 `blockedBy` 报的是 DEBOUNCE，这一组想验的冷却根本轮不到。
   * 唯一例外是下面那条专门验防抖的用例，它自己传 2。
   */
  function restart(from: AlertDispatcher, now: number, options: DispatcherOptions = {}): AlertDispatcher {
    const next = make({ debounceTicks: 1, ...options })
    next.restore(JSON.parse(JSON.stringify(from.snapshot())) as ReturnType<AlertDispatcher['snapshot']>, now)
    return next
  }

  it('冷却活过重启 —— 同一条提醒不会因为重开应用重发一次', () => {
    const d = make({ debounceTicks: 1 })
    const c = candidate()
    expect(d.dispatch([c], T0, calm)[0]?.level).toBe('L2')

    // 30 分钟后重启：L2 的冷却是 2 小时，还没过
    const after = restart(d, T0 + 30 * MIN)
    expect(after.dispatch([c], T0 + 30 * MIN, calm)[0]?.blockedBy).toBe('COOLDOWN')
  })

  it('强制类台阶活过重启 —— 这正是 2026-08-17 那个漏报 bug 的反面', () => {
    const d = make({ debounceTicks: 1 })
    const forced = candidate({ level: 'L3', forced: true, lossPct: -0.08 })
    d.dispatch([forced], T0, calm)

    const after = restart(d, T0 + 10 * MIN)
    /*
      浮亏没再扩大 2%：台阶应当仍然挡着它。
      ⚠ 闸门名是 **`STEP`** 不是 `COOLDOWN`（2026-08-26 分开的）——
      持仓强制类**不受同键冷却**，它受的是这条台阶。两者此前共用一个标签，
      导致 M3 清单 §4.4 那条硬规则（「止损类出现在冷却列 = bug」）在数据上判不了。
    */
    const same = after.dispatch([candidate({ ...forced, lossPct: -0.085 })], T0 + 10 * MIN, calm)
    expect(same[0]?.blockedBy).toBe('STEP')
  })

  it('跨日重启后当日计数清零 —— restore 会立刻按 now 裁剪一遍', () => {
    const d = make({ debounceTicks: 1, dailyL3Limit: 1 })
    d.dispatch([candidate({ level: 'L3' })], T0, calm)

    const nextDay = utcStartOfDay(T0) + 86_400_000 + 9 * HOUR
    const after = restart(d, nextDay, { dailyL3Limit: 1 })
    const other = candidate({ level: 'L3', code: 'SZ000001' as SecCode })
    expect(after.dispatch([other], nextDay, calm)[0]?.level).toBe('L3')
  })

  it('每小时滑动窗口按 now 过期 —— 一份很旧的状态卡不住闸门', () => {
    const d = make({ debounceTicks: 1, hourlyLimit: 1 })
    d.dispatch([candidate()], T0, calm)

    // 两小时后重启：那条 L2 早就滚出滑动窗口了
    const after = restart(d, T0 + 2 * HOUR, { hourlyLimit: 1 })
    const other = candidate({ code: 'SZ000001' as SecCode })
    expect(after.dispatch([other], T0 + 2 * HOUR, calm)[0]?.level).toBe('L2')
  })

  it('防抖计数**不**跨重启 —— 重启跨过一段没有观测的时间，续上等于用不存在的连续性放行', () => {
    const d = make({ debounceTicks: 2 })
    const c = candidate()
    // 第一次只是攒了一个 streak，还没发出
    expect(d.dispatch([c], T0, calm)[0]?.blockedBy).toBe('DEBOUNCE')

    const after = restart(d, T0 + MIN, { debounceTicks: 2 })
    // 若 streak 被恢复，这一轮就会直接发出去
    expect(after.dispatch([c], T0 + MIN, calm)[0]?.blockedBy).toBe('DEBOUNCE')
  })

  it('版本对不上就整份丢弃 —— 猜一个半对的状态比从零开始危险得多', () => {
    const d = make({ debounceTicks: 1 })
    const c = candidate()
    d.dispatch([c], T0, calm)

    const next = make({ debounceTicks: 1 })
    next.restore({ ...d.snapshot(), v: 2 as unknown as 1 }, T0 + MIN)
    // 状态没装进去 ⇒ 冷却不存在，这条照发
    expect(next.dispatch([c], T0 + MIN, calm)[0]?.level).toBe('L2')
  })

  it('restore(null) 是合法的空操作（第一次运行、或状态读不出来）', () => {
    const d = make({ debounceTicks: 1 })
    d.restore(null, T0)
    expect(d.dispatch([candidate()], T0, calm)[0]?.level).toBe('L2')
  })

  it('gateUsage 报的是当前用量，且**不改状态**（一次查询不该影响分发）', () => {
    const d = make({ debounceTicks: 1, hourlyLimit: 6, dailyL3Limit: 10, observeDailyLimit: 2 })
    d.dispatch([candidate()], T0, calm)

    // 两小时后：那条 L2 已滚出滑动窗口
    expect(d.gateUsage(T0 + 2 * HOUR).hourly).toEqual({ used: 0, limit: 6 })
    expect(d.gateUsage(T0 + 2 * HOUR).dailyL3).toEqual({ used: 0, limit: 10 })
    // 上面那次查询没有把 recentHigh 裁掉：换个时刻问，那条又在窗口里了
    expect(d.gateUsage(T0 + 30 * MIN).hourly.used).toBe(1)
  })

  it('clearGates 把冷却清干净 —— 逃生口必须真的能自救', () => {
    const d = make({ debounceTicks: 1 })
    const c = candidate()
    d.dispatch([c], T0, calm)
    expect(d.dispatch([c], T0 + MIN, calm)[0]?.blockedBy).toBe('COOLDOWN')

    d.clearGates()
    expect(d.dispatch([c], T0 + 2 * MIN, calm)[0]?.level).toBe('L2')
  })
})
