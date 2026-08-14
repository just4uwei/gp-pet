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
import { parseWatchSuggestions } from '../../watch/suggestion'
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

  // ── 日 K 与成交流水（007_trade_log.sql）───────────────────────────
  // code 一律先过 normalizeCode：渲染层可以传 600000 / sh600000 / SH600000

  handle('kline:daily', (_event, query) =>
    controller.dailyBars({
      code: normalizeCode(query.code),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })
  )

  handle('trade:list', (_event, query) => controller.tradeLedger(normalizeCode(query.code)))

  handle('trade:preview', (_event, draft) =>
    controller.previewTrade({ ...draft, code: normalizeCode(draft.code) })
  )

  handle('trade:add', (_event, draft) =>
    controller.addTrade({ ...draft, code: normalizeCode(draft.code) })
  )

  handle('trade:remove', (_event, id) => controller.removeTrade(id))

  // 当日分时。**只在用户打开抽屉「行情」页时才被调**，且是全应用唯一一处
  // 由用户交互直接触发取数的通道 —— 缓存与降级都在数据层（data-layer 的 minuteCache
  // 与 engine/intraday.ts），这里只透传。
  handle('quote:intraday', (_event, query) =>
    controller.intradaySeries({
      code: normalizeCode(query.code),
      from: query.from,
      ...(query.to === undefined ? {} : { to: query.to }),
    })
  )

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

  // ── 个人配置导入导出 ──────────────────────────────────────────────
  // 两条都不抛错：文件对话框被取消、文件读坏、版本太新都是**用户能看懂的正常结局**，
  // 走返回值告诉面板（status + warnings），比让渲染层去解 Electron 包装过的 Error 好

  handle('config:export', () => controller.exportConfig())

  handle('config:import', () => controller.importConfig())

  // ── 影子运行（M4，docs/07 §2.3）───────────────────────────────────
  // 只读两条 + 一条重置。**推进不走 IPC**：它挂在 tick 上，因为
  // 「一个交易日推进一次」是数据层的节奏，给渲染层一个「推进」按钮
  // 等于让界面能凭空多造一根净值点

  handle('shadow:summary', () => controller.shadowSummary())

  handle('shadow:trades', (_event, query) => controller.shadowTrades(query.limit))

  handle('shadow:reset', () => controller.resetShadow())

  // ── 设置页与数据维护（M4，docs/01 §5.5）───────────────────────────
  // 四条维护动作都**不抛错**，走 MaintenanceResult 的 status + message：
  // 取消、文件已存在、组策略锁目录都是用户能看懂的正常结局（与 config:* 同一做法）

  handle('app:params', () => controller.paramRows())

  handle('app:about', () => controller.about())

  handle('app:backupDatabase', () => controller.backupDatabase())

  handle('app:clearCache', () => controller.clearCache())

  handle('app:chooseDataDir', () => controller.chooseDataDir())

  handle('app:revealPath', (_event, which) => controller.revealPath(which))

  // ── AI 解读（P2，docs/08 §后续）───────────────────────────────────
  // 只读的解释层：结果不回流到信号、闸门、状态点或影子运行。
  // `ai:config` / `ai:setConfig` 的返回值里**没有明文 API key** —— 明文只能单向流入。

  handle('ai:config', () => controller.aiConfig())

  handle('ai:setConfig', (_event, patch) => controller.setAiConfig(patch))

  handle('ai:test', () => controller.testAi())

  handle('ai:explain', (_event, signalId, force) => controller.explainWithAi(signalId, force ?? false))

  handle('ai:cancel', (_event, requestId) => controller.cancelAi(requestId))

  // 历史解读（008_ai_explain.sql）。**永不自动裁剪**，删除只有 ai:remove 一条路 ——
  // 花过钱、且重新生成还要再花一次钱的东西，不该被任何保留策略静默删掉
  handle('ai:history', (_event, query) =>
    controller.aiHistory({
      code: normalizeCode(query.code),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    })
  )

  handle('ai:remove', (_event, id) => controller.removeAiExplain(id))

  // ── 观察点（P2 续）─────────────────────────────────────────────────
  // 用户确认的一次性盯盘条件。**不是策略参数** —— 边界见 003_watch.sql 的头注释。
  // `watch:suggest` 只做解析（纯函数），不落库：数值要经过用户在表单里确认才算。

  handle('watch:list', (_event, query) => controller.watchPoints(query ?? {}))

  handle('watch:create', (_event, draft) => controller.createWatchPoint(draft))

  handle('watch:remove', (_event, id) => controller.removeWatchPoint(id))

  handle('watch:suggest', (_event, text) => parseWatchSuggestions(text))

  handle('pet:setHitRegion', (_event, rects) => controller.setHitRects(rects))

  handle('pet:setInteractive', (_event, interactive) => controller.setOverlayInteractive(interactive))

  handle('pet:dragBy', (_event, dx, dy) => controller.dragOverlayBy(dx, dy))

  handle('pet:dragEnd', () => controller.endOverlayDrag())

  handle('pet:contextMenu', () => {
    // 悬浮条右键与托盘右键共用同一份菜单（docs/06 §4）
    buildContextMenu(controller).popup()
  })

  handle('pet:setDoNotDisturb', (_event, until) => controller.setQuietUntil(until))

  handle('panel:toggle', () => controller.togglePanel())

  // **无条件**收掉 Electron 的默认菜单（2026-08-13）。
  //
  // 以前这里只在打包后收，开发期留着它换 Ctrl+R / F12 —— 代价是 `pnpm dev` 的面板顶着
  // 一整条 File/Edit/View/Window/Help，里面还有 "Learn More" 直通 electronjs.org。
  // 那是**用户会看到的界面**（面板是唯一的常规窗口），不是开发者的调试面板。
  // 开发期的两个快捷键改由 `enableDevShortcuts()` 显式注册，不靠菜单栏（见 load-route.ts）。
  Menu.setApplicationMenu(null)
}
