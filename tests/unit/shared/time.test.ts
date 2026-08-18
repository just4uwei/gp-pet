import { describe, expect, it } from 'vitest'
import {
  SHANGHAI_OFFSET_MS,
  shanghaiDate,
  shanghaiDayStartMs,
  shanghaiHhmm,
  shanghaiHhmmss,
  shanghaiMdHhmm,
} from '@shared/time'

/** 北京时间 2026-08-15 00:00:00 = UTC 2026-08-14 16:00:00 */
const AUG15_START = Date.UTC(2026, 7, 14, 16, 0, 0)

describe('shanghaiDayStartMs', () => {
  it('日界是北京 00:00，不是 UTC 00:00', () => {
    // 北京 2026-08-15 09:30
    const at = Date.UTC(2026, 7, 15, 1, 30, 0)
    expect(shanghaiDayStartMs(at)).toBe(AUG15_START)
  })

  it('日界那一毫秒归当天，前一毫秒归昨天', () => {
    expect(shanghaiDayStartMs(AUG15_START)).toBe(AUG15_START)
    expect(shanghaiDayStartMs(AUG15_START - 1)).toBe(AUG15_START - 86_400_000)
  })

  it('北京 23:59 与次日 00:01 分属两天', () => {
    const late = AUG15_START + 23 * 3_600_000 + 59 * 60_000
    const early = AUG15_START + 86_400_000 + 60_000
    expect(shanghaiDayStartMs(late)).toBe(AUG15_START)
    expect(shanghaiDayStartMs(early)).toBe(AUG15_START + 86_400_000)
  })

  /*
    这一条是这个模块存在的理由。原先三处写的是 `new Date(y, m, d)`，
    结果取决于宿主时区：在 UTC−5 上「本机 00:00」是北京 13:00，
    于是提醒配额会在午盘开盘那一刻重置。

    纯算术实现里没有任何一处读时区，所以这里只需要断言它确实是纯算术：
    同一个 epoch 永远得到同一个日界，且日界与偏移常量严格对齐。
  */
  it('不读宿主时区：日界永远落在 UTC 的 16:00（= 北京 00:00）', () => {
    for (const at of [AUG15_START, AUG15_START + 5 * 3_600_000, Date.UTC(2026, 0, 1, 3, 0, 0)]) {
      const start = shanghaiDayStartMs(at)
      expect((start + SHANGHAI_OFFSET_MS) % 86_400_000).toBe(0)
      expect(new Date(start).getUTCHours()).toBe(16)
    }
  })

  it('1970 年之前也不出错（Math.floor 而不是取整截断）', () => {
    const at = Date.UTC(1969, 5, 1, 0, 0, 0)
    const start = shanghaiDayStartMs(at)
    expect(start).toBeLessThanOrEqual(at)
    expect(at - start).toBeLessThan(86_400_000)
  })
})

/*
  展示用的格式化（2026-08-18）。

  这几条钉的是**同一个宿主时区的坑**：面板上六处原先用 `getHours()`，
  在本机（UTC+7）上会把北京 15:00 写成 14:00 —— 而页头那个「北京时间」时钟就在同一屏，
  日报的「今日提醒 09:03」也会与提醒日志的「08:03」对不上。
  所以断言的方式是「换任何一个宿主时区，结果都不变」的那种：只喂 epoch，只比字符串。
*/
describe('展示用格式化：一律北京时间', () => {
  /** 北京 2026-08-18 15:00:07 */
  const CLOSE = Date.UTC(2026, 7, 18, 7, 0, 7)

  it('shanghaiHhmm / shanghaiHhmmss 按北京时间读，不受宿主时区影响', () => {
    expect(shanghaiHhmm(CLOSE)).toBe('15:00')
    expect(shanghaiHhmmss(CLOSE)).toBe('15:00:07')
  })

  it('秒必须有：盘中两轮之间只差 30 秒，只给分钟看不出这一屏动没动', () => {
    expect(shanghaiHhmmss(CLOSE + 30_000)).toBe('15:00:37')
    expect(shanghaiHhmm(CLOSE + 30_000)).toBe(shanghaiHhmm(CLOSE))
  })

  it('shanghaiMdHhmm 带月日 —— 只给 HH:mm 会让昨晚的东西看起来像刚才的', () => {
    expect(shanghaiMdHhmm(CLOSE)).toBe('08-18 15:00')
    // 北京 2026-01-02 09:05（个位月与个位日都要补零）
    expect(shanghaiMdHhmm(Date.UTC(2026, 0, 2, 1, 5, 0))).toBe('01-02 09:05')
  })

  it('shanghaiDate 给的是北京日：北京 00:30 那一刻仍算前一个 UTC 日的次日', () => {
    // 北京 2026-08-19 00:30 = UTC 2026-08-18 16:30
    expect(shanghaiDate(Date.UTC(2026, 7, 18, 16, 30, 0))).toBe('2026-08-19')
    expect(shanghaiDate(CLOSE)).toBe('2026-08-18')
  })
})
