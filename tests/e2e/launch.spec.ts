/**
 * E2E：应用真的能起来吗（docs/08 M4）。
 *
 * 这一组用例的价值不在覆盖率，而在于它们抓的是 **typecheck + build 全绿也照样炸**
 * 的那一类问题。CLAUDE.md 记了两个真实案例：
 *   - 漏外置 `electron` → `import { app }` 解析到 npm 上那个「返回 exe 路径」的启动器包
 *   - preload 打成 ESM → `sandbox: true` 下加载失败，窗口起来但 `window.gp` 是 undefined
 * 两者都是「构建成功、启动即崩」，只有真启一次才看得见。
 *
 * ## 每个用例都自带一个干净的 userData 目录
 *
 * 不共用是刻意的：首次启动引导只在 `disclaimerAcceptedAt` 缺省时出现，
 * 用例之间共享目录会让「第二次跑就不弹了」变成随机失败。
 * 顺带也避免动到开发者本机的真实数据（`%APPDATA%/gp-pet`）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const MAIN = join(process.cwd(), 'out', 'main', 'index.js')

interface Launched {
  app: ElectronApplication
  userData: string
}

/**
 * 启一个隔离的实例。
 *
 * `--user-data-dir` 走 Chromium 的开关而不是环境变量：`app.getPath('userData')`
 * 认它，于是 settings.json 与 market.db 都落在临时目录里。
 *
 * `ELECTRON_RUN_AS_NODE` **必须显式删掉**：agent / CI 的 shell 常设它，
 * 一旦带着它启动，Electron 以纯 Node 模式跑，`protocol.registerSchemesAsPrivileged`
 * 那一行就会炸在 undefined 上（CLAUDE.md 里那条「这不是代码问题」）。
 */
async function launch(): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'gp-e2e-'))
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userData}`],
    env: env as Record<string, string>,
  })
  return { app, userData }
}

async function shutdown(launched: Launched | null): Promise<void> {
  if (!launched) return
  try {
    await launched.app.close()
  } finally {
    rmSync(launched.userData, { recursive: true, force: true })
  }
}

/** 悬浮条（bar）与面板（panel）都靠 URL 区分 —— 三个入口是三个 html */
async function windowFor(app: ElectronApplication, route: string): Promise<Page> {
  for (const page of app.windows()) {
    if (page.url().includes(route)) return page
  }
  return app.waitForEvent('window', {
    predicate: (page) => page.url().includes(route),
  })
}

test.describe('启动', () => {
  let launched: Launched | null = null

  test.afterEach(async () => {
    await shutdown(launched)
    launched = null
  })

  test('主进程起得来，悬浮条窗口存在且不抢焦点（C1 的落点）', async () => {
    launched = await launch()
    const bar = await windowFor(launched.app, 'bar')
    await expect(bar.locator('body')).toBeVisible()

    // C1：常驻置顶窗口**永不**成为焦点窗口。`focusable: false` 不得改动（约束 3）
    const flags = await launched.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('bar'))
      return win === undefined
        ? null
        : {
            focusable: win.isFocusable(),
            alwaysOnTop: win.isAlwaysOnTop(),
            skipTaskbar: !win.isVisibleOnAllWorkspaces() || true,
            size: win.getSize(),
          }
    })
    expect(flags).not.toBeNull()
    expect(flags?.focusable).toBe(false)
    expect(flags?.alwaysOnTop).toBe(true)

    /*
     * 悬浮条的标称尺寸是 300×38（`OVERLAY_SIZE`，docs/06 §2.1），但**高度不能断言相等**。
     *
     * 实测（2026-08-13，150% 缩放的 2560×1440）：`getSize()` 报 300×40。
     * 缩放比不是 100% 时 Electron 要在 DIP 与物理像素之间来回换算、两个方向都按
     * 「包住」取整，于是标称高度会被抬 1–2 DIP —— 这就是 CLAUDE.md 里
     * 「移动 overlay 不要用 setPosition」那一条的同源现象。
     *
     * 这**不影响 C2**：命中区在渲染层按 `window.innerHeight` 实测重算（bar/App.tsx），
     * 不读这个常量，所以窗口被抬高多少，命中区就跟着盖多少。
     * 断言因此写成「宽度精确、高度在 DPI 取整容差内」——
     * 写死 38 会让这条用例在任何非 100% 缩放的机器上红，而它想守的不是那个数。
     */
    expect(flags?.size?.[0]).toBe(300)
    expect(flags?.size?.[1]).toBeGreaterThanOrEqual(38)
    expect(flags?.size?.[1]).toBeLessThanOrEqual(42)
  })

  test('preload 暴露的是窄接口，未登记的通道被拦掉', async () => {
    launched = await launch()
    const bar = await windowFor(launched.app, 'bar')

    // 登记过的通道通得过（app:ping 是 M0 那条连通性探针）
    const pong = await bar.evaluate(async () => {
      const gp = (window as unknown as { gp: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).gp
      return gp.invoke('app:ping', 'hello')
    })
    expect(pong).toMatchObject({ pong: 'hello' })

    // 没登记的通道必须被 preload 拒掉，而不是透传给 ipcMain
    const rejected = await bar.evaluate(async () => {
      const gp = (window as unknown as { gp: { invoke: (c: string) => Promise<unknown> } }).gp
      try {
        await gp.invoke('app:definitelyNotRegistered')
        return 'RESOLVED'
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(rejected).toContain('未登记')

    // 渲染层拿不到 Node 与 ipcRenderer（contextIsolation + sandbox 的落点）
    const leaked = await bar.evaluate(() => ({
      require: 'require' in window,
      process: 'process' in window,
      ipcRenderer: 'ipcRenderer' in window,
    }))
    expect(leaked).toEqual({ require: false, process: false, ipcRenderer: false })
  })

  test('第二个实例拿不到单实例锁，第一个实例照常活着并打开面板', async () => {
    launched = await launch()
    await windowFor(launched.app, 'bar')

    /*
     * 同一个 userData 目录再启一个进程。**不用 `electron.launch`**：
     * 那个 API 会等一个可用的 CDP 端点，而拿不到锁的实例在建任何窗口之前就 `app.quit()` 了
     * —— 于是 Playwright 报「进程退出得太早」，而那恰恰是**正确行为**。
     * 直接 spawn 才能观察到「exit 0 且不建窗口」这件事本身。
     */
    const { spawn } = await import('node:child_process')
    const electronBin = (await import('electron')).default as unknown as string
    const env = { ...process.env }
    delete env['ELECTRON_RUN_AS_NODE']
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(electronBin, [MAIN, `--user-data-dir=${(launched as Launched).userData}`], {
        env,
        stdio: 'ignore',
      })
      child.on('exit', (exitCode) => resolve(exitCode))
    })
    // 拿不到锁不是错误：它是刻意的、正常的退出（src/main/index.ts 的头注释）
    expect(code).toBe(0)

    // 第一个实例必须还活着；且它收到 second-instance 后会把面板打开（不显示悬浮条）
    const windows = await launched.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL())
    )
    expect(windows.some((url) => url.includes('bar'))).toBe(true)
    expect(windows.some((url) => url.includes('panel'))).toBe(true)
  })
})
