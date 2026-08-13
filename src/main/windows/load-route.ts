/**
 * 三个渲染入口的加载与安全基线（docs/02 §5）。
 */

import { shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'

/** `bar` 是常驻悬浮条（唯一形态，见 OverlayWindow），另两个是面板与气泡 */
export type RendererRoute = 'bar' | 'panel' | 'bubble'

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

/**
 * 渲染层加载失败要留下证据。
 *
 * 打包版最典型的坏结局是「主进程日志一切正常、窗口一片空白」：路径错一层、
 * CSP 把 file:// 下的相对资源拦掉、preload 抛异常 —— 这三件事都不会让主进程报错，
 * 而悬浮条与气泡**没有开发者工具**（`focusable: false` 收不到键盘，打包版也没挂快捷键），
 * 于是现场只剩「它就是不显示」。这四个事件是那种情况下唯一的线索，别删。
 */
function logLoadFailures(win: BrowserWindow, route: RendererRoute): void {
  const { webContents } = win

  webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    log.error(`[window] ${route} 加载失败 code=${code} ${description} url=${url} main=${isMainFrame}`)
  })

  webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`[window] ${route} preload 异常 ${preloadPath}`, error)
  })

  webContents.on('render-process-gone', (_event, details) => {
    log.error(`[window] ${route} 渲染进程退出 reason=${details.reason} code=${details.exitCode}`)
  })

  // CSP 拦截、模块加载失败都只体现在渲染层控制台里 —— 只转发 error 级，不做日志噪音
  webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      log.error(`[window] ${route} 控制台错误：${details.message} (${details.sourceId}:${details.lineNumber})`)
    }
  })
}

export function loadRoute(win: BrowserWindow, route: RendererRoute): void {
  logLoadFailures(win, route)

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(`${devServer}/${route}/index.html`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${route}/index.html`))
  }
}
