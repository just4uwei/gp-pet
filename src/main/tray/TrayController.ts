/**
 * 托盘（docs/06 §1 C9、§4）。
 *
 * 托盘是「桌宠被隐藏后功能不减」的承载点，因此它不是装饰：
 * 隐藏桌宠、免打扰、退出都必须能只靠托盘完成。
 *
 * 图标随皮肤走（docs/09 §6.2）。@2x 由 Electron 按命名约定自动选取，无需手工判断缩放比例。
 */

import { Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import type { AppController } from '../controller'
import { log } from '../logging'
import { resourcesRoot } from '../resources'
import { fallbackTrayIcon } from './fallback-icon'
import { buildContextMenu } from './menu'

export class TrayController {
  private tray: Tray | null = null
  /** 图标每次 refresh 都会重取，缺图的日志只报一次，免得刷屏 */
  private warnedMissingIcon = false

  constructor(private readonly controller: AppController) {}

  start(): void {
    const icon = this.iconFor(this.controller.quiet)
    this.tray = new Tray(icon)
    this.tray.setToolTip('GP Pet')
    // 左键单击托盘 = 打开面板，与单击桌宠一致
    this.tray.on('click', () => this.controller.showPanel())
    this.refresh()
  }

  private iconFor(quiet: boolean): Electron.NativeImage {
    const file = quiet ? 'tray-muted.png' : 'tray.png'
    const path = join(resourcesRoot(), 'icons', this.controller.currentSkin.id, file)
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return image

    // 缺图不能让托盘建不出来 —— 退出与「显示桌宠」都只有这一条路（C9）
    if (!this.warnedMissingIcon) {
      this.warnedMissingIcon = true
      log.warn('[tray] 托盘图标缺失，改用内置兜底图标：', path)
    }
    return fallbackTrayIcon()
  }

  /** 免打扰状态、桌宠显隐变化后重建菜单与图标 —— 菜单是快照，不会自己刷新 */
  refresh(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    this.tray.setImage(this.iconFor(this.controller.quiet))
    this.tray.setContextMenu(buildContextMenu(this.controller))
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }
}
