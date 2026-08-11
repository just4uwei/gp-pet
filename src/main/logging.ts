/**
 * 日志与崩溃兜底（docs/02 §7）。
 *
 * 原则：主进程未捕获异常写入本地日志，**不上报任何远端**。
 * 本产品无服务端、无账号，任何外发遥测都与产品定位冲突。
 */

import log from 'electron-log/main'

export function initLogging(): void {
  log.initialize()
  log.transports.file.level = 'info'
  log.transports.console.level = 'debug'
  // 日志滚动的完整策略（大小上限、保留份数）属 M4；这里先给一个不会撑爆磁盘的上限
  log.transports.file.maxSize = 5 * 1024 * 1024

  log.errorHandler.startCatching({
    showDialog: false, // 不弹错误框（docs/02 §7）
    onError: ({ error }) => {
      log.error('[uncaught]', error)
    },
  })
}

export { log }
