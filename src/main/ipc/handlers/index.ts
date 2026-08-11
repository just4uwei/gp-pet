/**
 * 通道实现登记（docs/02 §5）。
 *
 * 骨架阶段只实现桌宠交互与连通性探针所需的通道；其余通道尚未实现，
 * 由 reportUnimplementedChannels() 在启动日志里列出 —— 缺口要看得见，不静默（docs/02 §7）。
 */

import { Menu } from 'electron'
import type { AppController } from '../../controller'
import { buildContextMenu } from '../../tray/menu'
import { handle } from '../router'

export function registerHandlers(controller: AppController): void {
  // M0 的连通性探针：验证 preload → ipcMain → 回传这条链路（docs/08 M0）
  handle('app:ping', (_event, payload) => ({ pong: payload, at: Date.now() }))

  handle('app:engineStatus', () => controller.engineStatus())

  handle('pet:getSkin', () => controller.currentSkin)

  handle('pet:setHitRegion', (_event, rects) => controller.setHitRects(rects))

  handle('pet:setInteractive', (_event, interactive) => controller.setPetInteractive(interactive))

  handle('pet:dragBy', (_event, dx, dy) => controller.dragPetBy(dx, dy))

  handle('pet:dragEnd', () => controller.endPetDrag())

  handle('pet:contextMenu', () => {
    // 桌宠右键与托盘右键共用同一份菜单（docs/06 §4）
    buildContextMenu(controller).popup()
  })

  handle('pet:setDoNotDisturb', (_event, until) => controller.setQuietUntil(until))

  handle('pet:toggleDoNotDisturb', () => controller.toggleQuiet())

  handle('panel:toggle', () => controller.togglePanel())

  // 桌宠窗口 focusable: false，拿不到键盘 —— 但 Panel 是正常窗口，
  // 没有菜单栏时 Ctrl+R / F12 也一并没了。开发期保留默认菜单，打包时再收（M4）。
  if (!process.env['ELECTRON_RENDERER_URL']) Menu.setApplicationMenu(null)
}
