/**
 * 面板窗口（docs/06 §2.4）。
 *
 * 正常窗口：有边框、可聚焦、出现在任务栏。它是「主动查看」的场所，
 * 不受零干扰契约约束 —— 需要键盘输入的场景（搜股票、改设置）都放在这里，
 * 这样 Pet 窗口才敢一直保持 focusable: false。
 *
 * 懒加载：首次打开才创建；关闭时 hide() 而非 destroy()，避免反复重建 React 应用。
 */

import { BrowserWindow, nativeImage } from 'electron'
import { join } from 'node:path'
import { resourcesRoot } from '../resources'
import { enableDevShortcuts, hardenWindow, loadRoute, PRELOAD_PATH } from './load-route'

/**
 * 任务栏与标题栏图标。
 *
 * 不设它，开发期任务栏显示的是 **Electron 的原子徽标** —— 打包后 electron-builder 会把
 * exe 图标塞进去，所以这个问题只在 dev 里暴露，很容易被当成「反正打包就好了」而留着。
 * 取 `icons/default/`（不跟皮肤走）：托盘图标按皮肤换是 docs/09 §6.2 的规定，
 * 但任务栏图标是**应用身份**，跟着皮肤变只会让用户在 Alt-Tab 里找不到自己的窗口。
 * 缺图返回 undefined，交给 Electron 的默认行为，不为了图标让窗口建不出来。
 */
function appIcon(): Electron.NativeImage | undefined {
  const image = nativeImage.createFromPath(join(resourcesRoot(), 'icons', 'default', 'icon.png'))
  return image.isEmpty() ? undefined : image
}

/**
 * 顶栏配色 —— 与 `src/renderer/panel/styles.css` 的 `--gp-surface` / 正文色**必须一致**。
 *
 * 系统标题栏在浅色 Windows 主题下是白的，压在一整屏暗色面板上格外突兀，而
 * `nativeTheme.themeSource = 'dark'` 只能换来系统那个近黑灰（#1f1f1f 一类），仍然与面板差一档。
 * 所以走 `titleBarStyle: 'hidden'` + `titleBarOverlay`：**标题栏区域交给页面自己画**，
 * 只把最小化/最大化/关闭三颗按钮留给系统绘制（自绘窗口控件在 Windows 上永远差一口气：
 * 悬停高亮、Snap Layouts、高对比度主题都得自己补）。
 *
 * 代价与约束：
 * - 页面必须自己提供拖拽区（渲染层头部的 `-webkit-app-region: drag`），否则窗口拖不动。
 * - 右上角那块（Win11 三颗控件约 3×46px，高 `TITLE_BAR_HEIGHT`）归系统，页面内容不能放进去
 *   —— 渲染层头部那一行因此留了 `pr-[144px]` 的右内边距。**两处一起改，别只改一个。**
 */
const TITLE_BAR_COLOR = '#161a21'
const TITLE_BAR_SYMBOL_COLOR = '#eceef2'
const TITLE_BAR_HEIGHT = 40

export class PanelWindow {
  private win: BrowserWindow | null = null

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win

    const icon = appIcon()
    const win = new BrowserWindow({
      width: 920,
      height: 640,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'GP Pet',
      ...(icon ? { icon } : {}),
      backgroundColor: '#101216',
      // 顶栏交给页面画，只保留系统的窗口控件（见 TITLE_BAR_COLOR 上面那段）
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: TITLE_BAR_COLOR,
        symbolColor: TITLE_BAR_SYMBOL_COLOR,
        height: TITLE_BAR_HEIGHT,
      },
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    hardenWindow(win)
    // 应用菜单被无条件收掉了，Ctrl+R / F12 在这里挂回来（仅 dev）
    enableDevShortcuts(win)
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
