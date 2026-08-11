/**
 * 类型化 IPC 出入口（docs/02 §5）。
 *
 * 主进程侧只应通过本文件的 handle / push 与渲染层通信，不直接调用 ipcMain.handle，
 * 这样通道名与签名的唯一真相始终是 shared/ipc-types.ts。
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import log from 'electron-log/main'
import type { IpcInvokeMap, IpcPushMap } from '@shared/ipc-types'
import { INVOKE_CHANNELS, type InvokeChannel } from './channels'

type Handler<K extends keyof IpcInvokeMap> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<IpcInvokeMap[K]>
) => ReturnType<IpcInvokeMap[K]> | Promise<Awaited<ReturnType<IpcInvokeMap[K]>>>

const registered = new Set<InvokeChannel>()

/** 注册一个请求-响应通道。签名与 IpcInvokeMap 不符时编译期即报错。 */
export function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  registered.add(channel)
  ipcMain.handle(channel, (event, ...args) =>
    // 参数由 preload 白名单透传，运行时形状校验留到 M1 各 handler 内部按需做
    (handler as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(event, ...args)
  )
}

/** 向单个窗口推送。窗口已销毁时静默跳过 —— 推送是尽力而为的，不该因为窗口关了就抛错。 */
export function push<K extends keyof IpcPushMap>(
  win: BrowserWindow | null | undefined,
  channel: K,
  payload: IpcPushMap[K]
): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/** 向多个窗口广播。 */
export function broadcast<K extends keyof IpcPushMap>(
  wins: readonly (BrowserWindow | null | undefined)[],
  channel: K,
  payload: IpcPushMap[K]
): void {
  for (const win of wins) push(win, channel, payload)
}

/**
 * 启动自检：登记表里声明了、却没人实现的通道会在这里被喊出来。
 * 骨架阶段大量通道尚未实现属正常，所以是 warn 而非抛错 —— 但不允许静默（docs/02 §7）。
 */
export function reportUnimplementedChannels(): InvokeChannel[] {
  const missing = INVOKE_CHANNELS.filter((c) => !registered.has(c))
  if (missing.length > 0) {
    log.info(`[ipc] 尚未实现的通道（${missing.length}/${INVOKE_CHANNELS.length}）：${missing.join(', ')}`)
  }
  return missing
}
