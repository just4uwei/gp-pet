/**
 * 看板的「数据有没有跨过一个新交易日」判据（`tools/iterate/session.ts`）。
 *
 * 钉住的是**分桶方向**，不是文案：这个判据错一次的成本是一整个会话的时间
 * （2026-08-16 周日那次，两项时间受限的事被报成「现在就能做」，
 * 人去查库、翻 git log、读 settle.ts，才发现最后一个交易日是上周五）。
 *
 * 最重要的一条在最后一组：**「不知道」必须留在原桶**。
 * 猜成「没跨过」会让真的复发被静默压住 —— 那是这里唯一不可接受的错误方向。
 */

import { describe, expect, it } from 'vitest'
import type { TradeDate } from '@core/types'
import { isWeekend } from '@core/date'
import type { CalendarSource, DayVerdict, TradingCalendar } from '@main/scheduler/calendar'
import { dataFreshness, lastClosedSession, shanghaiDateOf, sinceFixLanded } from '../../../tools/iterate/session'

/** 北京时间 `YYYY-MM-DD HH:mm` → epoch ms */
const cst = (date: TradeDate, hour: number, minute = 0): number =>
  Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)

/** 周末休市、工作日开市的假日历。`overrides` 用来造节假日与「依据不够硬」的情形 */
function fakeCalendar(overrides: Record<string, Partial<DayVerdict>> = {}): TradingCalendar {
  return {
    resolve(date): DayVerdict {
      const base: DayVerdict = {
        date,
        isOpen: !isWeekend(date),
        source: 'db' as CalendarSource,
        uncertain: false,
      }
      return { ...base, ...overrides[date] }
    },
    builtinUpdatedAt: () => null,
    coverageEnd: () => null,
    refresh: async () => [],
    markObserved: () => {},
  }
}

describe('shanghaiDateOf', () => {
  it('按北京时间切日界，不看宿主时区', () => {
    // UTC 2026-08-15T16:00 = 北京 2026-08-16T00:00 —— 已经是新的一天
    expect(shanghaiDateOf(Date.parse('2026-08-15T16:00:00Z'))).toBe('2026-08-16')
    expect(shanghaiDateOf(Date.parse('2026-08-15T15:59:00Z'))).toBe('2026-08-15')
  })
})

describe('lastClosedSession', () => {
  const cal = fakeCalendar()

  it('周日往回找到上周五', () => {
    expect(lastClosedSession(cst('2026-08-16', 12), cal)?.date).toBe('2026-08-14')
  })

  it('交易日 15:00 之前不算今天这一场 —— 盘中数据本来就还在写', () => {
    // 周一上午：今天还没收盘，最后一个已收盘的是上周五
    expect(lastClosedSession(cst('2026-08-17', 10), cal)?.date).toBe('2026-08-14')
    // 同一天 15:00 整，今天这一场收了
    expect(lastClosedSession(cst('2026-08-17', 15), cal)?.date).toBe('2026-08-17')
  })

  it('跨过长假也能找回去', () => {
    const holidays = Object.fromEntries(
      ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'].map((d) => [d, { isOpen: false }])
    )
    expect(lastClosedSession(cst('2026-10-07', 20), fakeCalendar(holidays))?.date).toBe('2026-09-30')
  })

  it('日历连着判休市时返回 null，不硬凑一个日子出来', () => {
    const alwaysClosed: TradingCalendar = { ...cal, resolve: (date) => ({ date, isOpen: false, source: 'db', uncertain: false }) }
    expect(lastClosedSession(cst('2026-08-16', 12), alwaysClosed)).toBeNull()
  })
})

describe('dataFreshness', () => {
  const cal = fakeCalendar()

  it('数据停在最后一个已收盘交易日 ⇒ CAUGHT_UP（时间问题，不是工程问题）', () => {
    // 复现 2026-08-16 周日那次：signal 最新 08-14，最后一场也是 08-14
    const f = dataFreshness({ now: cst('2026-08-16', 13), latest: '2026-08-14', calendar: cal })
    expect(f.kind).toBe('CAUGHT_UP')
    if (f.kind === 'CAUGHT_UP') expect(f.session.date).toBe('2026-08-14')
  })

  it('中间真的开过盘而数据没动 ⇒ STALE，并数出落后几场', () => {
    // 数据停在上上周五，现在是下周三收盘后：周一、周二、周三共 3 场
    const f = dataFreshness({ now: cst('2026-08-19', 16), latest: '2026-08-14', calendar: cal })
    expect(f.kind).toBe('STALE')
    if (f.kind === 'STALE') {
      expect(f.session.date).toBe('2026-08-19')
      expect(f.sessionsBehind).toBe(3)
    }
  })

  it('一行数据都没有时不谎报陈旧 —— 那是另一个问题', () => {
    const f = dataFreshness({ now: cst('2026-08-19', 16), latest: null, calendar: cal })
    expect(f.kind).toBe('UNKNOWN')
  })

  it('⚠ 日历依据不够硬时判 UNKNOWN，绝不降级成 CAUGHT_UP（它只用于文案，不参与分桶）', () => {
    // 若把 uncertain 的结论当真，这一项会被压进「只能靠时间」而没人去查 —— 最坏的失败方向
    const shaky = fakeCalendar({ '2026-08-14': { isOpen: true, source: 'weekday', uncertain: true } })
    const f = dataFreshness({ now: cst('2026-08-16', 13), latest: '2026-08-14', calendar: shaky })
    expect(f.kind).toBe('UNKNOWN')
    if (f.kind === 'UNKNOWN') expect(f.why).toContain('weekday')
  })
})

/**
 * 这一组是分桶的真正判据。第二条与第三条**必须同时成立** ——
 * 只满足「不误报」的规则可以退化成「永远说等着」，那比原来的误报更糟：
 * 误报浪费一次排查，永久静默让真的复发再也不报。
 */
describe('sinceFixLanded', () => {
  it('全部数据都在落地日当天及以前 ⇒ NOT_YET（现在查不出东西）', () => {
    // 复现 2026-08-16：settle.ts 08-14 落地，signal 最新也是 08-14
    expect(sinceFixLanded({ latest: '2026-08-14', landedOn: '2026-08-14' })).toBe('NOT_YET')
    // 011 是 08-15 落地，比全部 alert 行都晚
    expect(sinceFixLanded({ latest: '2026-08-14', landedOn: '2026-08-15' })).toBe('NOT_YET')
  })

  it('⚠ 落地之后产生过新数据而症状还在 ⇒ OBSERVED —— 规则必须能重新报警', () => {
    expect(sinceFixLanded({ latest: '2026-08-17', landedOn: '2026-08-14' })).toBe('OBSERVED')
    expect(sinceFixLanded({ latest: '2026-08-17', landedOn: '2026-08-15' })).toBe('OBSERVED')
  })

  it('落地日当天不算「之后」—— 那天盘前那一跳早就过去了', () => {
    expect(sinceFixLanded({ latest: '2026-08-15', landedOn: '2026-08-15' })).toBe('NOT_YET')
    expect(sinceFixLanded({ latest: '2026-08-16', landedOn: '2026-08-15' })).toBe('OBSERVED')
  })

  it('没有数据时不冒充结论', () => {
    expect(sinceFixLanded({ latest: null, landedOn: '2026-08-14' })).toBe('NO_DATA')
  })
})
