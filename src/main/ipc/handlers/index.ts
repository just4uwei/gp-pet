/**
 * 通道实现登记（docs/02 §5）。
 *
 * M1 补齐了自选股、设置与健康度；信号相关通道（signal:*）要等引擎（M2），
 * 仍由 reportUnimplementedChannels() 在启动日志里列出 —— 缺口要看得见，不静默（docs/02 §7）。
 */

import { Menu } from 'electron'
import { normalizeCode } from '@core/code'
import type { AppController } from '../../controller'
import { buildContextMenu } from '../../tray/menu'
import { handle } from '../router'

export function registerHandlers(controller: AppController): void {
  // M0 的连通性探针：验证 preload → ipcMain → 回传这条链路（docs/08 M0）
  handle('app:ping', (_event, payload) => ({ pong: payload, at: Date.now() }))

  handle('app:engineStatus', () => controller.engineStatus())

  handle('app:providerHealth', () => controller.providerHealth())

  // ── 自选股 ───────────────────────────────────────────────────────
  // 代码规范化在这一层做（docs/03 §5）：渲染层可以传 600000 / sh600000 / SH600000，
  // 再往下的仓储与取数层一律只认 SH600000

  handle('watchlist:list', () => controller.watchlist())

  handle('watchlist:add', (_event, code, group) =>
    group === undefined ? controller.addWatch(code) : controller.addWatch(code, group)
  )

  handle('watchlist:remove', (_event, code) => controller.removeWatch(normalizeCode(code)))

  handle('watchlist:reorder', (_event, codes) =>
    controller.reorderWatch(codes.map((code) => normalizeCode(code)))
  )

  handle('position:set', (_event, code, shares, cost) =>
    controller.setPosition(normalizeCode(code), shares, cost)
  )

  handle('position:clear', (_event, code) => controller.clearPosition(normalizeCode(code)))

  // ── 设置 ─────────────────────────────────────────────────────────

  handle('settings:get', () => controller.getSettings())

  handle('settings:patch', (_event, patch) => controller.patchSettings(patch))

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
