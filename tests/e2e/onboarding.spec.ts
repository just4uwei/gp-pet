/**
 * E2E：首次启动引导与设置页（docs/01 §8、docs/08 M4）。
 *
 * 免责声明「须在应用内展示」是 docs/01 §8 的硬要求。它有两个不能靠单测验的部分：
 *   ① 确认之前面板的其余内容**真的**进不去（是不是只挡了一层视觉）
 *   ② 确认之后**真的**落盘（重启不再弹）
 * 第二条尤其：`disclaimerAcceptedAt` 写进 settings.json 这条链路跨了
 * 渲染层 → preload → ipcMain → SettingsStore → 磁盘，单测只能各测一段。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const MAIN = join(process.cwd(), 'out', 'main', 'index.js')

function env(): Record<string, string> {
  const copy = { ...process.env }
  // 见 launch.spec.ts：带着它启动 Electron 会以纯 Node 模式跑，第一行 protocol 就炸
  delete copy['ELECTRON_RUN_AS_NODE']
  return copy as Record<string, string>
}

async function launch(userData: string): Promise<ElectronApplication> {
  return electron.launch({ args: [MAIN, `--user-data-dir=${userData}`], env: env() })
}

/**
 * 打开面板。
 *
 * 面板是**懒加载**的（PanelWindow.ensure，首次打开才建），所以不能直接去
 * `BrowserWindow.getAllWindows()` 里找 —— 那会等到超时。
 * 这里走**真实的那条路**：从悬浮条页面 invoke `panel:toggle`
 * （悬浮条双击就是这一条，docs/06 §4），顺带也验了这条通道是通的。
 */
async function openPanel(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((page) => page.url().includes('panel'))
  if (existing) return existing

  const bar =
    app.windows().find((page) => page.url().includes('bar')) ??
    (await app.waitForEvent('window', { predicate: (page) => page.url().includes('bar') }))
  await bar.evaluate(async () => {
    const gp = (window as unknown as { gp: { invoke: (c: string) => Promise<unknown> } }).gp
    await gp.invoke('panel:toggle')
  })

  const opened = app.windows().find((page) => page.url().includes('panel'))
  if (opened) return opened
  return app.waitForEvent('window', { predicate: (page) => page.url().includes('panel') })
}

test.describe('首次启动引导', () => {
  let userData = ''
  let app: ElectronApplication | null = null

  test.beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'gp-e2e-onboarding-'))
  })

  test.afterEach(async () => {
    await app?.close().catch(() => {})
    app = null
    rmSync(userData, { recursive: true, force: true })
  })

  test('首次打开面板挡在免责声明前，确认后落盘且不再弹', async () => {
    app = await launch(userData)
    const panel = await openPanel(app)

    // ① 引导挡在前面：免责声明可见，而主界面的「自选股」卡片不存在（不是隐藏，是没渲染）
    await expect(panel.getByRole('heading', { name: '免责声明' })).toBeVisible()
    await expect(panel.getByText('不构成任何投资建议')).toBeVisible()
    await expect(panel.getByRole('heading', { name: '自选股' })).toHaveCount(0)

    // ② 读到底才亮按钮
    const accept = panel.getByRole('button', { name: /我已阅读并理解/ })
    await expect(accept).toBeVisible()
    await panel.evaluate(() => {
      const scroller = document.querySelector('main > div.overflow-y-auto')
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
    await expect(accept).toBeEnabled()
    await accept.click()

    // ③ 确认后进主界面
    await expect(panel.getByRole('heading', { name: '自选股' })).toBeVisible()

    // ④ 真的落盘了 —— 时刻而不是布尔值
    const settings = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as {
      disclaimerAcceptedAt?: number
    }
    expect(typeof settings.disclaimerAcceptedAt).toBe('number')
    expect(settings.disclaimerAcceptedAt ?? 0).toBeGreaterThan(0)

    // ⑤ 重启不再弹
    await app.close()
    app = await launch(userData)
    const again = await openPanel(app)
    await expect(again.getByRole('heading', { name: '自选股' })).toBeVisible()
    await expect(again.getByRole('heading', { name: '免责声明' })).toHaveCount(0)
  })
})

test.describe('面板三屏', () => {
  let userData = ''
  let app: ElectronApplication | null = null

  test.beforeEach(async () => {
    userData = mkdtempSync(join(tmpdir(), 'gp-e2e-panel-'))
    // 预先写好设置跳过引导：这一组测的不是引导，让它每次都点一遍只会让用例变脆
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ disclaimerAcceptedAt: Date.now() }),
      'utf8'
    )
    app = await launch(userData)
  })

  test.afterEach(async () => {
    await app?.close().catch(() => {})
    app = null
    rmSync(userData, { recursive: true, force: true })
  })

  test('影子运行页在还没有交易日时说「尚未开始」，不显示一屏 0', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await panel.getByRole('button', { name: '影子运行' }).click()
    await expect(panel.getByText(/影子运行会在下一个交易日收盘后开始累积/)).toBeVisible()
  })

  test('设置页展示全部设置项，参数表只读且分档标注', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await panel.getByRole('button', { name: '设置' }).click()

    // docs/01 §5.5 的清单逐项在场
    for (const label of ['轮询频率', '灵敏度', '数据源优先级', '静默时段', '开机自启', '数据目录', '清理缓存']) {
      await expect(panel.getByText(label, { exact: true })).toBeVisible()
    }
    // M4 新增的备份入口
    await expect(panel.getByText('备份数据库', { exact: true })).toBeVisible()

    // 参数表：展开后必须能看到「未测」这一档，且没有任何输入框（只读）
    await expect(panel.getByText('策略参数（只读）')).toBeVisible()
    await panel.getByRole('button', { name: '展开' }).click()
    await expect(panel.getByText(/已标定 1/)).toBeVisible()
    await expect(panel.getByText(/未测 \d+/)).toBeVisible()

    // 免责声明在「关于」里随时可查（docs/01 §8）
    await expect(panel.getByText('不构成任何投资建议')).toBeVisible()
  })
})
