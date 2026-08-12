/**
 * 主进程入口（docs/02 §6 生命周期）。
 *
 * 启动顺序有硬性约束：
 *   1. registerSchemesAsPrivileged 必须在 app ready **之前**
 *   2. protocol.handle 必须在 app ready **之后**
 *   3. 窗口创建在协议就绪之后 —— 否则首帧的 res:// 请求会落空
 */

import { app, powerMonitor } from 'electron'
import { AppController } from './controller'
import { createDataLayer } from './data-layer'
import { registerHandlers } from './ipc/handlers'
import { reportUnimplementedChannels } from './ipc/router'
import { initLogging, log } from './logging'
import { registerResourceProtocol, registerResourceScheme, resourcesRoot } from './resources'
import { TrayController } from './tray/TrayController'

initLogging()
registerResourceScheme()

let controller: AppController | null = null
let tray: TrayController | null = null

void app.whenReady().then(() => {
  registerResourceProtocol()

  controller = new AppController()
  tray = new TrayController(controller)
  controller.onChange = () => tray?.refresh()

  registerHandlers(controller)
  reportUnimplementedChannels()

  controller.start()
  tray.start()

  // 数据层装配是异步的（开库 + undici），故意排在窗口与托盘之后：
  // 装配失败时用户至少还能看到桌宠与托盘菜单，而不是双击图标毫无反应
  void createDataLayer({
    userDataDir: app.getPath('userData'),
    resourcesRoot: resourcesRoot(),
    log: { info: (...args) => log.info(...args), warn: (...args) => log.warn(...args) },
    onQuotes: () => controller?.onQuotes(),
    onSignals: () => controller?.onSignals(),
  })
    .then((layer) => {
      controller?.attachDataLayer(layer)
      layer.start()
      log.info(
        `[app] 数据层与引擎就绪（${layer.signals.engineVersion}）。M2：有信号与面板列表，尚无提醒分发。`
      )
    })
    .catch((error: unknown) => {
      // 数据层起不来是「行情离线」，不是崩溃 —— engineStatus 会如实报 offline
      log.error('[app] 数据层装配失败，将以离线状态运行：', error)
    })

  // 休眠唤醒后重新校验窗口位置：合盖期间可能换过显示器拓扑（docs/02 §6）
  powerMonitor.on('resume', () => {
    log.info('[power] resume')
    controller?.revalidatePetPosition()
  })

  log.info('[app] 就绪。M0 骨架：无数据源、无引擎、无提醒。')
})

// 桌宠隐藏或面板关闭后不退出 —— 退出只走托盘菜单（docs/02 §6）
app.on('window-all-closed', () => {
  // 故意留空：托盘常驻
})

// C10：进程退出前主动销毁窗口，不留残影置顶窗口。
// 挂在 before-quit 而非菜单回调里，是为了让 OS 关机、任务管理器结束等路径也能走到清理。
app.on('before-quit', () => {
  tray?.destroy()
  tray = null
  controller?.dispose()
  controller = null
})
