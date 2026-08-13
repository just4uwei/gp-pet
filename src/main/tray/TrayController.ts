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

/** 图标闪烁的节奏（docs/08 M3「托盘角标 + 图标闪烁」） */
const FLASH_INTERVAL_MS = 380
const FLASH_TOGGLES = 6

export class TrayController {
  private tray: Tray | null = null
  /** 图标每次 refresh 都会重取，缺图的日志只报一次，免得刷屏 */
  private warnedMissingIcon = false
  /** 托盘角标：未读提醒数（docs/05 §3，L1 也累加） */
  private unread = 0
  private flashTimer: NodeJS.Timeout | null = null

  constructor(private readonly controller: AppController) {}

  start(): void {
    const icon = this.iconFor(this.controller.quiet)
    this.tray = new Tray(icon)
    // 左键单击托盘 = 打开面板，与单击桌宠一致
    this.tray.on('click', () => this.controller.showPanel())
    this.refresh()
  }

  /**
   * 图标闪烁一小会儿（L3 到达时）。
   *
   * 在「正常图标」与「静音图标（去饱和版）」之间交替，**不需要新素材**。
   * 会不会与免打扰状态混淆？不会：L3 只在**非免打扰**时才发得出去
   * （免打扰会把它降为 L1，见 dispatcher 闸门④），所以闪烁期间的静止态一定是正常图标。
   */
  flash(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    this.stopFlash()
    let left = FLASH_TOGGLES
    let muted = false
    this.flashTimer = setInterval(() => {
      if (!this.tray || this.tray.isDestroyed() || left <= 0) {
        this.stopFlash()
        return
      }
      muted = !muted
      this.tray.setImage(this.iconFor(muted))
      left -= 1
    }, FLASH_INTERVAL_MS)
  }

  private stopFlash(): void {
    if (this.flashTimer) {
      clearInterval(this.flashTimer)
      this.flashTimer = null
    }
    if (this.tray && !this.tray.isDestroyed()) this.tray.setImage(this.iconFor(this.controller.quiet))
  }

  /**
   * 角标（docs/05 §3、§4.3「超限时托盘角标仍累加」）。
   *
   * Windows 的托盘没有数字角标这种东西，只有图标与 tooltip —— 所以数字放 tooltip，
   * 「有新东西」这件事靠闪烁表达。**不做红点叠加**：那需要在运行时合成位图，
   * 而主进程里没有画布，为此引入一个图形库不值得。
   */
  private applyTooltip(): void {
    if (!this.tray || this.tray.isDestroyed()) return
    this.unread = this.controller.unreadAlerts
    const parts = ['GP Pet']
    if (this.unread > 0) parts.push(`${this.unread} 条未读提醒`)
    if (this.controller.quiet) parts.push('免打扰中')
    this.tray.setToolTip(parts.join(' · '))
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
    // 闪烁进行中就别抢图标：抢了会让闪烁看起来是「卡了一下」
    if (!this.flashTimer) this.tray.setImage(this.iconFor(this.controller.quiet))
    this.applyTooltip()
    this.tray.setContextMenu(buildContextMenu(this.controller))
  }

  destroy(): void {
    if (this.flashTimer) {
      clearInterval(this.flashTimer)
      this.flashTimer = null
    }
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }
}
