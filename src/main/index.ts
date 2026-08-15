/**
 * 主进程入口（docs/02 §6 生命周期）。
 *
 * 启动顺序有硬性约束：
 *   1. 单实例锁必须在**做任何事之前**判 —— 第二个实例一旦跑到开库那一步就来不及了
 *   2. registerSchemesAsPrivileged 与 setAppUserModelId 必须在 app ready **之前**
 *   3. protocol.handle 必须在 app ready **之后**
 *   4. 窗口创建在协议就绪之后 —— 否则首帧的 res:// 请求会落空
 */

import { app, powerMonitor } from 'electron'
import { syncAutoLaunch, electronAutoLaunchDeps } from './auto-launch'
import { AppController } from './controller'
import { APP_ID } from './identity'
import { createDataLayer } from './data-layer'
import { registerHandlers } from './ipc/handlers'
import { reportUnimplementedChannels } from './ipc/router'
import { initLogging, log, pruneLogsOnStartup } from './logging'
import { registerResourceProtocol, registerResourceScheme, resourcesRoot } from './resources'
import { TrayController } from './tray/TrayController'

initLogging()

let controller: AppController | null = null
let tray: TrayController | null = null

/**
 * 单实例锁 —— **不是**「体验优化」，是数据完整性。
 *
 * `market.db` 只有一个写者的假设写进了整个存储层：WAL + 5s busy_timeout 能让两个进程
 * 都不报错地跑下去，然后互相覆盖对方那一轮 tick 的 K 线与信号。更隐蔽的是提醒层 ——
 * `AlertDispatcher` 的冷却与配额**全在内存里**（见它的头注释），两个实例各有一份，
 * 于是「每小时最多 6 条」在用户那里变成 12 条，而日志里两边都显示自己守规矩。
 *
 * 拿不到锁的那个立刻退出，什么都不初始化：不开库、不建窗口、不注册协议。
 */
if (!app.requestSingleInstanceLock()) {
  log.info('[app] 已有实例在运行，本次启动退出（面板由已有实例打开）')
  app.quit()
} else {
  // 用户再次双击图标 / 点开始菜单时，Electron 把参数交给**已在运行**的这个实例。
  // 正确的回应是把面板叫到前面，而**不是**把悬浮条也显示出来 ——
  // 条子若是被用户主动隐藏的（C9），替他打开等于否决他的选择。
  app.on('second-instance', () => {
    log.info('[app] 收到第二次启动请求，打开面板')
    controller?.showPanel()
  })

  bootstrap()
}

function bootstrap(): void {
  registerResourceScheme()
  // Windows 用 AUMID 认应用身份（任务栏归组、跳转列表都看它）。
  // **不要顺手加 app.setName()**：userData 目录是按 name 算的，改名等于搬走整个数据目录。
  app.setAppUserModelId(APP_ID)

  void app.whenReady().then(() => {
    registerResourceProtocol()
    // 日志目录要 app.getPath，所以清理排在 ready 之后（保留 7 天，见 logging.ts）
    pruneLogsOnStartup(Date.now())

    controller = new AppController()
    tray = new TrayController(controller)
    // 走回调而不是让 controller 直接持有 Tray：窗口与托盘的生命周期不同，
    // controller 认识 Tray 会让退出顺序变得难以推理
    controller.onChange = () => tray?.refresh()

    registerHandlers(controller)
    reportUnimplementedChannels()

    controller.start()
    tray.start()

    // 数据层装配是异步的（开库 + undici），故意排在窗口与托盘之后：
    // 装配失败时用户至少还能看到悬浮条与托盘菜单，而不是双击图标毫无反应
    void createDataLayer({
      userDataDir: app.getPath('userData'),
      resourcesRoot: resourcesRoot(),
      log: { info: (...args) => log.info(...args), warn: (...args) => log.warn(...args) },
      onQuotes: () => controller?.onQuotes(),
      onSignals: (ctx, outcomes) => controller?.onSignals(ctx, outcomes),
    })
      .then((layer) => {
        controller?.attachDataLayer(layer)
        layer.start()
        // 设置这时才读得到，把开机自启与系统里的实际状态对一次
        // （用户可能在「任务管理器 → 启动」里手动改过，见 auto-launch.ts）
        syncAutoLaunch(layer.settings.get().autoLaunch, electronAutoLaunchDeps(log))
        log.info(`[app] 数据层、引擎与提醒分发就绪（${layer.signals.engineVersion}）。`)
        // 校时探一次。休市时段一个请求都不发 ⇒ 没有样本，而「现在几点」在第一跳就要用
        void layer.syncClock()
      })
      .catch((error: unknown) => {
        // 数据层起不来是「行情离线」，不是崩溃 —— engineStatus 会如实报 offline
        log.error('[app] 数据层装配失败，将以离线状态运行：', error)
      })

    // 休眠唤醒后重新校验窗口位置：合盖期间可能换过显示器拓扑（docs/02 §6）
    powerMonitor.on('resume', () => {
      log.info('[power] resume')
      controller?.revalidateOverlayPosition()
      // 唤醒是本地钟最容易偏的时刻（长待机、虚拟机挂起）。探测自带 5 分钟节流
      void controller?.syncClock()
    })

    // 这一行只说「窗口与托盘已起来」。数据层是异步装配的，它自己会再打一行 ——
    // 两行分开打是有用的：只看到这一行就说明装配还没回来或失败了
    log.info('[app] 窗口与托盘就绪，数据层装配中…')
  })

  // 悬浮条隐藏或面板关闭后不退出 —— 退出只走托盘菜单（docs/02 §6）
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
}
