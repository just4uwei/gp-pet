/**
 * contextBridge 窄接口（docs/02 §5）。
 *
 * 这里是渲染层能够触达主进程的**全部**表面积：两个方法 + 一张白名单。
 * 渲染层拿不到 ipcRenderer、拿不到 Node、也无法凭字符串访问未登记的通道。
 *
 * 安全基线：contextIsolation: true / nodeIntegration: false / sandbox: true。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '../main/ipc/channels'

const invokable = new Set<string>(INVOKE_CHANNELS)
const pushable = new Set<string>(PUSH_CHANNELS)

const bridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!invokable.has(channel)) {
      return Promise.reject(new Error(`[gp] 未登记的 invoke 通道：${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  /** 返回取消订阅函数 —— 组件卸载时必须调用，否则窗口 hide/show 反复后会重复累积监听 */
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!pushable.has(channel)) {
      throw new Error(`[gp] 未登记的 push 通道：${channel}`)
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.off(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('gp', bridge)
