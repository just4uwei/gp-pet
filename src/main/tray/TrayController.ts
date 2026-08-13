/**
 * 托盘（docs/06 §1 C9、§4）。
 *
 * 托盘是「悬浮条被隐藏后功能不减」的承载点，因此它不是装饰：
 * 隐藏悬浮条、免打扰、退出都必须能只靠托盘完成。
 *
 * **托盘不参与提醒**（2026-08-13 起）：未读角标与 L3 的图标闪烁都已移除，
 * 提醒的唯一可见出口是气泡。所以这里只剩两件事 —— 画一个随免打扰状态变化的图标，
 * 和挂那份与悬浮条右键共用的菜单。tooltip 因此也是静态的：
 * 让一个常驻图标随行情变文字，本身就是一种低强度的持续打扰。
 *
 * 图标固定取 `resources/icons/app/`（@2x 由 Electron 按命名约定自动选取）。
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
    // 左键单击托盘 = 打开面板，与双击悬浮条一致
    this.tray.on('click', () => this.controller.showPanel())
    this.refresh()
  }

  private applyTooltip(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    this.tray.setToolTip(this.controller.quiet ? 'GP Pet · 免打扰中' : 'GP Pet')
  }

  private iconFor(quiet: boolean): Electron.NativeImage {
    const file = quiet ? 'tray-muted.png' : 'tray.png'
    const path = join(resourcesRoot(), 'icons', 'app', file)
    const image = nativeImage.createFromPath(path)
    if (!image.isEmpty()) return image

    // 缺图不能让托盘建不出来 —— 退出与「显示悬浮条」都只有这一条路（C9）
    if (!this.warnedMissingIcon) {
      this.warnedMissingIcon = true
      log.warn('[tray] 托盘图标缺失，改用内置兜底图标：', path)
    }
    return fallbackTrayIcon()
  }

  /** 免打扰状态、悬浮条显隐变化后重建菜单与图标 —— 菜单是快照，不会自己刷新 */
  refresh(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    this.tray.setImage(this.iconFor(this.controller.quiet))
    this.applyTooltip()
    this.tray.setContextMenu(buildContextMenu(this.controller))
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }
}
