/**
 * 日志滚动的保留窗口（src/main/logging.ts）。
 *
 * 只测那个纯函数 `expiredLogFiles`，因为它是「改一个比较符就悄悄多删一天」的地方：
 *   - 边界是闭区间（今天往前数 7 天含今天都保留）
 *   - 跨月 / 跨年不能靠字符串减法算错
 *   - **认不出名字的文件一律不删** —— 包括改动前留下的 main.log 与用户自己的文件
 */

import { describe, expect, it } from 'vitest'
import { expiredLogFiles, LOG_KEEP_DAYS } from '@main/logging'

/** 用本地时间造时刻：`localDay` 用的是本地时区，测试也必须用本地时区，否则 CI 换个 TZ 就红 */
function at(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 12, 0, 0).getTime()
}

function name(day: string, archived = false): string {
  return `main-${day}${archived ? '.old' : ''}.log`
}

describe('expiredLogFiles', () => {
  it('保留窗口是闭区间：今天往前数 7 天都留，第 8 天起删', () => {
    const now = at(2026, 8, 13)
    // 8-07 是第 7 天（含今天），8-06 是第 8 天
    const files = ['2026-08-13', '2026-08-07', '2026-08-06'].map((d) => name(d))
    expect(expiredLogFiles(files, now)).toEqual([name('2026-08-06')])
  })

  it('归档件（.old.log）同样在清理范围内 —— 它也占磁盘', () => {
    const now = at(2026, 8, 13)
    const files = [name('2026-08-01', true), name('2026-08-13', true)]
    expect(expiredLogFiles(files, now)).toEqual([name('2026-08-01', true)])
  })

  it('跨月：8-03 的今天要留到 7-28，不能按「日 ≥ 28」这种算法判', () => {
    const now = at(2026, 8, 3)
    const files = ['2026-07-28', '2026-07-27'].map((d) => name(d))
    expect(expiredLogFiles(files, now)).toEqual([name('2026-07-27')])
  })

  it('跨年：1-02 的今天要留到去年 12-27', () => {
    const now = at(2026, 1, 2)
    const files = ['2025-12-27', '2025-12-26'].map((d) => name(d))
    expect(expiredLogFiles(files, now)).toEqual([name('2025-12-26')])
  })

  /**
   * 这一条是刻意的保守：`main.log` 是本次改动之前的文件名，用户自己丢进来的文件也可能在这
   * 目录里。删一个我们认不出的文件，代价可能是删掉别人的东西；不删的代价只是多占几 MB
   * （而且它们各自受 maxSize 约束、数量有限）。
   */
  it('认不出的名字一律不删', () => {
    const now = at(2026, 8, 13)
    const files = [
      'main.log', // 改动前的文件名
      'main.old.log', // 改动前的归档
      'renderer.log',
      'main-2026-8-1.log', // 没有零填充，不是我们写的
      'notes.txt',
      name('2020-01-01'), // 这个认得出，且确实过期
    ]
    expect(expiredLogFiles(files, now)).toEqual([name('2020-01-01')])
  })

  it('空目录不报错', () => {
    expect(expiredLogFiles([], at(2026, 8, 13))).toEqual([])
  })

  it('keepDays = 1 时只留今天', () => {
    const now = at(2026, 8, 13)
    const files = ['2026-08-13', '2026-08-12'].map((d) => name(d))
    expect(expiredLogFiles(files, now, 1)).toEqual([name('2026-08-12')])
  })

  it('出厂保留天数与 docs/03 §4.1 写的 7 天一致', () => {
    expect(LOG_KEEP_DAYS).toBe(7)
  })
})
