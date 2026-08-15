import { describe, expect, it } from 'vitest'
import { SHANGHAI_OFFSET_MS, shanghaiDayStartMs } from '@shared/time'

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
