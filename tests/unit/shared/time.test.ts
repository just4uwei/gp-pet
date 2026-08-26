import { describe, expect, it } from 'vitest'
import {
  SHANGHAI_OFFSET_MS,
  shanghaiDate,
  shanghaiDayStartMs,
  shanghaiHhmm,
  shanghaiHhmmss,
  shanghaiMdHhmm,
  shanghaiMsFrom,
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

/**
 * `shanghaiMsFrom` 是表单那一侧的入口（成交日期 + 可选时刻 → epoch）。
 *
 * 它替掉的是 `TradePanel` 里那个 `new Date('2026-08-26T12:00:00')` ——
 * 后者按**宿主本地时区**解析：UTC+8 上恰好对，本机（UTC+7）上无害（同一个北京日），
 * 但极西时区上会落到**前一个**北京日，而 `TradeRepo.boughtSharesSince` 拿它卡
 * T+1 卖出锁定 ⇒ 昨天的买入被算成今天的，多锁一天（016 / trade.ts 头注释）。
 */
describe('shanghaiMsFrom', () => {
  it('不给时刻时取北京 12:00 —— 与宿主时区无关', () => {
    // 北京 2026-08-15 12:00 = UTC 2026-08-15 04:00
    expect(shanghaiMsFrom('2026-08-15')).toBe(Date.UTC(2026, 7, 15, 4, 0, 0))
  })

  it('给了时刻就按北京时间解析', () => {
    expect(shanghaiMsFrom('2026-08-15', '09:47')).toBe(Date.UTC(2026, 7, 15, 1, 47, 0))
    // 北京 00:05 落在前一个 UTC 日 —— 这正是本地时区解析会出错的那一档
    expect(shanghaiMsFrom('2026-08-15', '00:05')).toBe(Date.UTC(2026, 7, 14, 16, 5, 0))
  })

  /**
   * 这一条是这个函数存在的理由：**往返必须闭合**。
   * `shanghaiDate(shanghaiMsFrom(d)) === d` 在任何宿主时区都成立，
   * 而旧写法在 UTC−5 上会把 `'2026-08-15'` 变成北京 8-16 的凌晨。
   */
  it('与 shanghaiDate 往返闭合', () => {
    for (const d of ['2026-01-01', '2026-08-15', '2026-12-31', '2024-02-29']) {
      const ms = shanghaiMsFrom(d)
      expect(ms).not.toBeNull()
      expect(shanghaiDate(ms as number)).toBe(d)
    }
  })

  /**
   * 非法输入给 `null`，**不许退成 `Date.now()`** —— 一个悄悄变成「现在」的时刻
   * 会被当作真实成交时刻记进账本，而那是编出来的数据（016 头注释那条纪律）。
   */
  it('非法输入给 null，而不是悄悄退成某个时刻', () => {
    expect(shanghaiMsFrom('')).toBeNull()
    expect(shanghaiMsFrom('2026-8-15')).toBeNull()
    expect(shanghaiMsFrom('2026-13-01')).toBeNull()
    // 2 月 31 日：Date.UTC 会滚到 3 月 3 日 —— 往返比对把它挡下来
    expect(shanghaiMsFrom('2026-02-31')).toBeNull()
    expect(shanghaiMsFrom('2026-08-15', '9:47')).toBeNull()
    expect(shanghaiMsFrom('2026-08-15', '24:00')).toBeNull()
    expect(shanghaiMsFrom('2026-08-15', '12:60')).toBeNull()
  })

  it('空时刻串等同于「没给」—— 表单里清空时间框不该变成非法', () => {
    expect(shanghaiMsFrom('2026-08-15', '')).toBe(shanghaiMsFrom('2026-08-15'))
  })
})
