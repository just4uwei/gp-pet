/**
 * 面板窗口（docs/06 §2.4）。
 *
 * 正常窗口：有边框、可聚焦、出现在任务栏。它是「主动查看」的场所，
 * 不受零干扰契约约束 —— 需要键盘输入的场景（搜股票、改设置）都放在这里，
 * 这样 Pet 窗口才敢一直保持 focusable: false。
 *
 * 懒加载：首次打开才创建；关闭时 hide() 而非 destroy()，避免反复重建 React 应用。
 */

import { BrowserWindow } from 'electron'
import { hardenWindow, loadRoute, PRELOAD_PATH } from './load-route'

export class PanelWindow {
  private win: BrowserWindow | null = null

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const win = new BrowserWindow({
      width: 920,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'GP Pet',
      backgroundColor: '#101216',
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    hardenWindow(win)
    loadRoute(win, 'panel')

    win.once('ready-to-show', () => win.show())
    // 关闭按钮不退出进程（docs/02 §6：退出只走托盘菜单）
    win.on('close', (event) => {
      if (!win.isDestroyed()) {
        event.preventDefault()
        win.hide()
      }
    })

    this.win = win
    return win
  }

  toggle(): void {
    const win = this.ensure()
    if (win.isVisible()) {
      win.hide()
    } else {
      win.show()
      win.focus()
    }
  }

  show(): void {
    const win = this.ensure()
    win.show()
    win.focus()
  }

  /** 尚未创建时返回 null —— 推送不该把懒加载的窗口强行唤起来 */
  get browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.removeAllListeners('close')
      this.win.destroy()
    }
    this.win = null
  }
}
