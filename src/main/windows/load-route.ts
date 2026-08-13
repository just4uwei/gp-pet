/**
 * 三个渲染入口的加载与安全基线（docs/02 §5）。
 */

import { shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'

/** `bar` 是出厂默认的悬浮条形态，`pet` 是可切换的桌宠形态（见 OverlayWindow） */
export type RendererRoute = 'bar' | 'pet' | 'panel' | 'bubble'

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

/**
 * 开发期快捷键：重载与开发者工具。
 *
 * 应用菜单已被无条件收掉（Electron 默认菜单里带 "Learn More" 之类的自家链接，
 * 而 Panel 是用户会看到的界面）。菜单一没，Ctrl+R / F12 这两个默认加速键也跟着没了 ——
 * 所以在这里显式挂回来，只给可聚焦的窗口（Pet / Bar 是 `focusable: false`，收不到键盘）。
 *
 * 判据用 `ELECTRON_RENDERER_URL`（electron-vite 只在 dev 注入它）而不是 `app.isPackaged`：
 * 后者在「未打包但也不是 dev」的场合（比如直接跑 out/）会把工具打开，那不是我们要的。
 */
export function enableDevShortcuts(win: BrowserWindow): void {
  if (!process.env['ELECTRON_RENDERER_URL']) return
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools()
    } else if (key === 'f5' || (input.control && key === 'r')) {
      win.webContents.reload()
    }
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
