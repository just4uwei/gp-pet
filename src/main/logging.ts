/**
 * 日志与崩溃兜底（docs/02 §7、docs/03 §4.1）。
 *
 * 原则：主进程未捕获异常写入本地日志，**不上报任何远端**。
 * 本产品无服务端、无账号，任何外发遥测都与产品定位冲突。
 *
 * ## 滚动策略：按天分文件 + 保留 7 天
 *
 * electron-log 自带的滚动是**按大小**的，而且只留一份归档（`main.log` → `main.old.log`）——
 * 那意味着「昨天发生了什么」随时可能被今天的一次刷屏挤掉，而排查提醒漏发这类问题
 * 恰恰要翻前几天的日志。所以改成 `main-YYYY-MM-DD.log`：
 *
 * - `resolvePathFn` **每写一条都会被调用**（见 electron-log 的 file transport），
 *   所以跨过午夜后自然就写进新文件，不需要任何定时器。日期串按天缓存，避免每条日志都算一遍。
 * - `maxSize` 仍然保留，作为**单日**的硬上限：一个刷屏的循环能在一天内填满磁盘，
 *   按天分文件挡不住这件事。超限时 electron-log 归档成 `main-YYYY-MM-DD.old.log`，
 *   那个名字也在下面的清理范围内。
 * - 清理在启动时做一次（`pruneOldLogs`）。**认不出名字的文件一律不删** ——
 *   包括本次改动之前留下的 `main.log` / `main.old.log`，以及用户自己丢进来的东西。
 *   它们各自受 `maxSize` 约束、数量有限，留着比误删安全。
 */

import { readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import log from 'electron-log/main'

/** 保留天数。docs/03 §4.1 写的就是 7 天 */
export const LOG_KEEP_DAYS = 7

/** 单个日志文件的硬上限。按天分文件之后这只是兜住「一天内刷屏」的极端情况 */
const MAX_SIZE_BYTES = 5 * 1024 * 1024

/** `main-2026-08-13.log` / `main-2026-08-13.old.log` —— 归档件也要能被认出来 */
const LOG_NAME_RE = /^main-(\d{4})-(\d{2})-(\d{2})(?:\.old)?\.log$/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地日期串。刻意用本地时区：用户说「昨天的日志」指的是他那边的昨天 */
function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * 哪些文件已经过期。
 *
 * 纯函数（只吃文件名与当前时刻），因为「7 天到底含不含今天」「跨月怎么算」
 * 是那种改一个 `<` 就悄悄多删一天的地方，必须能写成用例。
 * 边界取**闭区间**：今天往前数 7 天（含今天）都保留，第 8 天起删。
 */
export function expiredLogFiles(
  names: readonly string[],
  now: number,
  keepDays = LOG_KEEP_DAYS
): string[] {
  const today = new Date(now)
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  cutoff.setDate(cutoff.getDate() - (keepDays - 1))
  const oldest = localDay(cutoff)

  return names.filter((name) => {
    const match = LOG_NAME_RE.exec(name)
    // 认不出的一律不动（历史的 main.log、用户自己的文件）
    if (!match) return false
    const [, y, m, d] = match
    // 日期串是零填充的定宽格式，字典序等于时间序
    return `${y}-${m}-${d}` < oldest
  })
}

/**
 * 删掉过期日志。失败只记一行 warn —— 日志清理失败不该影响启动，
 * 而它最可能的成因（文件被别的进程按住）下次启动就自己好了。
 */
export function pruneOldLogs(dir: string, now: number): number {
  let removed = 0
  try {
    const expired = expiredLogFiles(readdirSync(dir), now)
    for (const name of expired) {
      try {
        unlinkSync(join(dir, name))
        removed += 1
      } catch (error) {
        log.warn('[log] 删除过期日志失败：', name, error)
      }
    }
  } catch (error) {
    log.warn('[log] 读取日志目录失败：', dir, error)
  }
  return removed
}

/** 必须在 app ready 之前调用（错误捕获要尽早装上） */
export function initLogging(): void {
  log.initialize()
  log.transports.file.level = 'info'
  log.transports.console.level = 'debug'
  log.transports.file.maxSize = MAX_SIZE_BYTES

  // 每条日志都会走这里，所以日期串按天缓存
  let cachedDay = ''
  let cachedName = ''
  log.transports.file.resolvePathFn = (vars) => {
    const day = localDay(new Date())
    if (day !== cachedDay) {
      cachedDay = day
      cachedName = `main-${day}.log`
    }
    return join(vars.libraryDefaultDir, cachedName)
  }

  log.errorHandler.startCatching({
    showDialog: false, // 不弹错误框（docs/02 §7）
    onError: ({ error }) => {
      log.error('[uncaught]', error)
    },
  })
}

/**
 * 启动时清一次过期日志。**必须在 app ready 之后调用**：
 * 目录是从 electron-log 自己解析出来的（`getFile().path`），而那需要 `app.getPath`。
 *
 * 从 electron-log 反推目录而不是自己算 `app.getPath('logs')`：两者在 Windows 上确实
 * 是同一个位置，但「确实是」是一个会变的事实，而写错的后果是**静默地什么都没清**。
 */
export function pruneLogsOnStartup(now: number): void {
  try {
    const dir = dirname(log.transports.file.getFile().path)
    const removed = pruneOldLogs(dir, now)
    if (removed > 0) log.info(`[log] 清理过期日志 ${removed} 个（保留 ${LOG_KEEP_DAYS} 天）`)
  } catch (error) {
    log.warn('[log] 日志清理跳过：', error)
  }
}

export { log }
