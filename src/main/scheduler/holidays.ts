/**
 * 内置节假日表的加载。IO 单独放一个文件，calendar.ts 因此可以被纯数据测试。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type HolidayTable, parseHolidayTable } from './calendar'

export const HOLIDAY_FILE = join('data', 'holidays.json')

export interface HolidayLoadResult {
  table: HolidayTable | null
  /** 加载失败的原因，供日志与面板展示。null 表示加载成功 */
  error: string | null
}

/**
 * 读 resources/data/holidays.json。
 *
 * 读不到或格式坏了返回 null 而不是抛错：内置表是第二道防线，它自己坏掉不该让应用起不来
 * —— 退到「周一至周五」仍然能工作（多打几次接口而已，见 calendar.ts 的取向说明）。
 */
export function loadHolidayTable(resourcesRoot: string): HolidayLoadResult {
  const path = join(resourcesRoot, HOLIDAY_FILE)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    return { table: null, error: `读取 ${HOLIDAY_FILE} 失败：${(error as Error).message}` }
  }
  const table = parseHolidayTable(raw)
  if (!table) return { table: null, error: `${HOLIDAY_FILE} 结构不合法，已退到「周一至周五」` }
  return { table, error: null }
}
