/**
 * 开机自启（docs/08 M4）。
 *
 * `AppSettings.autoLaunch` 在 M1 就进了 schema，但**一直没有实现** ——
 * 一个改了不生效的开关比没有这个开关更糟：用户勾上它、重启电脑、发现没起来，
 * 然后就再也不信任设置页里的任何一项了。这个文件补上它。
 *
 * ## 三条取舍
 *
 * 1. **开发期不写注册表。** `process.execPath` 在 `pnpm dev` 里是
 *    `node_modules/electron/dist/electron.exe`，注册进去等于让用户开机启动一个裸 Electron
 *    （打开的是一个「找不到入口」的空壳），而且卸载应用也带不走它。
 *    所以未打包时一律跳过并留一行日志说明。
 *
 * 2. **只在与当前状态不一致时才写。** 每次启动无条件写一遍注册表能跑，但会掩盖一件事：
 *    用户可能在「任务管理器 → 启动」里手动禁用过。那时系统里的状态是「已禁用」，
 *    我们无条件覆盖回去等于跟用户对着干。先读后比，不一致才写。
 *
 * 3. **失败不抛。** 注册表被组策略锁住、权限不足都是真实场景，
 *    而它们的后果只是「开机不自启」，不该让设置保存失败或启动崩掉。
 */

import { app } from 'electron'

/** 要不要真的去写。返回 null 表示「不需要动」 */
export function autoLaunchAction(input: {
  desired: boolean
  current: boolean
  packaged: boolean
}): { openAtLogin: boolean } | { skipped: 'unpackaged' | 'already' } {
  if (!input.packaged) return { skipped: 'unpackaged' }
  if (input.desired === input.current) return { skipped: 'already' }
  return { openAtLogin: input.desired }
}

export interface AutoLaunchDeps {
  getOpenAtLogin: () => boolean
  setOpenAtLogin: (openAtLogin: boolean) => void
  packaged: boolean
  log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/** 把设置里的取值同步到系统。返回是否真的写了 */
export function syncAutoLaunch(desired: boolean, deps: AutoLaunchDeps): boolean {
  try {
    const action = autoLaunchAction({
      desired,
      current: deps.getOpenAtLogin(),
      packaged: deps.packaged,
    })
    if ('skipped' in action) {
      if (action.skipped === 'unpackaged') {
        deps.log.info(`[autolaunch] 未打包，跳过（设置里的取值是 ${desired}，打包后才生效）`)
      }
      return false
    }
    deps.setOpenAtLogin(action.openAtLogin)
    deps.log.info(`[autolaunch] 开机自启 → ${action.openAtLogin ? '开' : '关'}`)
    return true
  } catch (error) {
    // 组策略锁注册表、权限不足 —— 后果只是不自启，不该连带把设置保存也弄失败
    deps.log.warn('[autolaunch] 设置失败：', error)
    return false
  }
}

/**
 * 生产依赖。
 *
 * **不传 `args`**：启动路径本来就只拉起悬浮条 + 托盘、不开面板，所以不需要
 * 「静默启动」这类开关。加一个没人读的命令行参数与「加一个改了不生效的设置」
 * 是同一种毛病。
 */
export function electronAutoLaunchDeps(logger: AutoLaunchDeps['log']): AutoLaunchDeps {
  return {
    getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
    setOpenAtLogin: (openAtLogin) => {
      app.setLoginItemSettings({ openAtLogin })
    },
    packaged: app.isPackaged,
    log: logger,
  }
}
