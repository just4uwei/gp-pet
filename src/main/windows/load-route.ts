/**
 * 三个渲染入口的加载与安全基线（docs/02 §5）。
 */

import { shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'

export type RendererRoute = 'pet' | 'panel' | 'bubble'

export const PRELOAD_PATH = join(__dirname, '../preload/index.js')

/**
 * 安全基线：拒绝一切新窗口，外链交给系统浏览器；禁止导航到本应用之外的地址。
 * 桌宠是常驻置顶窗口，一旦被导航走会以最高层级显示任意页面 —— 这条必须在每个窗口上都装。
 */
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current) event.preventDefault()
  })
}

export function loadRoute(win: BrowserWindow, route: RendererRoute): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(`${devServer}/${route}/index.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${route}/index.html`))
  }
}
