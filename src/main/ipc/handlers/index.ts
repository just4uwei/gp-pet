/**
 * 通道实现登记（docs/02 §5）。
 *
 * M1 补齐了自选股、设置与健康度；M2 补齐了 signal:history / signal:explain；
 * M3 补齐了 alert:history / alert:markRead / position:list。
 * 仍由 reportUnimplementedChannels() 在启动日志里列出缺口，不静默（docs/02 §7）。
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

  handle('position:list', () => controller.positions())

  handle('watchlist:reorder', (_event, codes) =>
    controller.reorderWatch(codes.map((code) => normalizeCode(code)))
  )

  handle('position:set', (_event, code, shares, cost) =>
    controller.setPosition(normalizeCode(code), shares, cost)
  )

  handle('position:clear', (_event, code) => controller.clearPosition(normalizeCode(code)))

  // ── 信号（M2）─────────────────────────────────────────────────────
  // 「今日信号」列表与依据展开都走这两条；提醒日志（含被抑制条目）复用同一份数据，
  // 因为被抑制的信号也在 signal 表里（docs/05 §4：不制造信息黑洞）

  handle('signal:history', (_event, query) =>
    controller.signalHistory({
      ...(query.code === undefined ? {} : { code: normalizeCode(query.code) }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })
  )

  handle('signal:explain', (_event, id) => controller.explainSignal(id))

  // ── 提醒日志（M3，docs/05 §6）─────────────────────────────────────
  // 与「今日信号」是两张表两件事：signal 表回答「引擎判了什么」，
  // alert_log 回答「它有没有真的提醒我，没提醒是被哪道闸门挡的」

  handle('alert:history', (_event, query) =>
    controller.alertHistory({
      ...(query.code === undefined ? {} : { code: normalizeCode(query.code) }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })
  )

  handle('alert:markRead', (_event, ids) => controller.markAlertsRead(ids))

  // ── 设置 ─────────────────────────────────────────────────────────

  handle('settings:get', () => controller.getSettings())

  handle('settings:patch', (_event, patch) => controller.patchSettings(patch))

  handle('pet:getSkin', () => controller.currentSkin)

  handle('pet:setHitRegion', (_event, rects) => controller.setHitRects(rects))

  handle('pet:setInteractive', (_event, interactive) => controller.setOverlayInteractive(interactive))

  handle('pet:dragBy', (_event, dx, dy) => controller.dragOverlayBy(dx, dy))

  handle('pet:dragEnd', () => controller.endOverlayDrag())

  handle('pet:contextMenu', () => {
    // 桌宠右键与托盘右键共用同一份菜单（docs/06 §4）
    buildContextMenu(controller).popup()
  })

  handle('pet:setDoNotDisturb', (_event, until) => controller.setQuietUntil(until))

  handle('pet:toggleDoNotDisturb', () => controller.toggleQuiet())

  handle('panel:toggle', () => controller.togglePanel())

  // **无条件**收掉 Electron 的默认菜单（2026-08-13）。
  //
  // 以前这里只在打包后收，开发期留着它换 Ctrl+R / F12 —— 代价是 `pnpm dev` 的面板顶着
  // 一整条 File/Edit/View/Window/Help，里面还有 "Learn More" 直通 electronjs.org。
  // 那是**用户会看到的界面**（面板是唯一的常规窗口），不是开发者的调试面板。
  // 开发期的两个快捷键改由 `enableDevShortcuts()` 显式注册，不靠菜单栏（见 load-route.ts）。
  Menu.setApplicationMenu(null)
}
