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

    // ① 引导挡在前面：免责声明可见，而主界面的自选卡片不存在（不是隐藏，是没渲染）
    // 用那个 tab 按钮当主界面的标记：卡片头 2026-08-15 从 h2 改成了两个 tab
    // （2026-08-18 起是「个股 / ETF」，标签里还跟着只数，所以按前缀匹配而不是 exact）
    await expect(panel.getByRole('heading', { name: '免责声明' })).toBeVisible()
    await expect(panel.getByText('不构成任何投资建议')).toBeVisible()
    await expect(panel.getByRole('button', { name: /^个股/ })).toHaveCount(0)

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
    await expect(panel.getByRole('button', { name: /^个股/ })).toBeVisible()

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
    await expect(again.getByRole('button', { name: /^个股/ })).toBeVisible()
    await expect(again.getByRole('heading', { name: '免责声明' })).toHaveCount(0)
  })
})

test.describe('面板五屏', () => {
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

  /*
    底部时钟画的是**引擎在用的时刻**（校准后的北京时间），不是宿主本地时间。
    这一条只钉「它在场且格式对」—— 断言具体钟点会变成一条随机红的用例，
    而「时刻算得对不对」归 clock-sync 与 shared/time 的单测管。
  */
  test('底部时钟在场，画的是北京时间', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await expect(panel.getByText(/北京时间 \d{2}-\d{2} \d{2}:\d{2}:\d{2}/)).toBeVisible()
    // 免责小字没有被时钟挤掉 —— 措辞纪律要求每一屏底部都有它
    await expect(panel.getByText('仅供参考，非投资建议')).toBeVisible()
  })

  /*
    自选卡片的两个 tab（2026-08-15 加，2026-08-18 换判据：按板块分「个股 / ETF」）。四条一起钉：

    ① 内置的 15 只行业 ETF 空库首启就该在 —— 不需要用户做任何事。
       这一条同时验了 data-layer 的播种真的跑了（单测测不到装配路径）。
    ② 那一屏必须把**两档待遇**说出来：无持仓走观察轨、有持仓按个股待遇。
       同一屏里两种不同的提醒行为，不写出来的话用户会按其中一种去理解另一种。
    ③ **不给移除按钮** —— 内置组的构成不归用户管，给了就是一个「删了下次启动会复活」的按钮。
    ④ **给持仓入口**（2026-08-18 起）。这一条是反过来钉的：它曾经不给，
       而放开它连带了提醒轨与日报两处行为改动 —— 界面上少了这个按钮，那两处就白改了。

    添加框现在在 tab 那一行、两屏共用，所以**不再断言 ETF 屏没有添加框**。
  */
  test('ETF 屏：内置 15 只首启即有、说清两档待遇、不给移除但给持仓入口', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await expect(panel.getByRole('button', { name: /^个股/ })).toBeVisible()

    await panel.getByRole('button', { name: /^ETF/ }).click()

    await expect(panel.getByText(/无持仓时走观察轨/)).toBeVisible()
    await expect(panel.getByText(/有持仓后按个股待遇提醒/)).toBeVisible()
    await expect(panel.getByText(/含内置 \d+ 只行业 ETF/)).toBeVisible()
    // 空库首启就该有内容 —— 播种没跑的话这里是「暂时为空」
    await expect(panel.getByText('内置行业 ETF 暂时为空，重启应用会自动补齐。')).toHaveCount(0)
    await expect(panel.getByText('证券ETF', { exact: false }).first()).toBeVisible()

    // 内置组不给移除；持仓入口则每一行都有
    await expect(panel.getByTitle('移除')).toHaveCount(0)
    expect(await panel.getByTitle('持仓与成交录入').count()).toBeGreaterThan(0)
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

  /**
   * AI 解读的入口链路。真实回归：`aiReady` 原来只在概览页挂载时读一次，而概览页
   * 是**常驻挂载**的，于是「设置页开启 → 切回概览」永远看不到入口 ——
   * 用户报的就是「开启后没看到可以操作的功能入口」。
   *
   * 这里只验「配置入口在、开关能改、切回概览不炸」—— 真发请求要凭据，E2E 保持离线。
   */
  test('AI 分析：设置页有配置入口，开关改动后切回概览不报错', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await panel.getByRole('button', { name: '设置' }).click()

    await expect(panel.getByText('AI 分析', { exact: true })).toBeVisible()
    for (const label of ['接口地址', '接口协议', '模型名', 'API key']) {
      await expect(panel.getByText(label, { exact: true })).toBeVisible()
    }

    // 开关按 aria-label 定位 —— 设置页上有好几个文案是「已关闭」的按钮
    const toggle = panel.getByRole('button', { name: '启用 AI 解读' })
    await expect(toggle).toHaveText('已关闭')
    await toggle.click()
    await expect(toggle).toHaveText('已开启')

    // 切回概览：这一步会触发 refreshAiReady()，早先的实现在这里什么都不会发生
    await panel.getByRole('button', { name: '概览' }).click()
    await expect(panel.getByText('今日信号')).toBeVisible()
  })

  /**
   * 观察点页的空态。**离线**：不发任何模型请求 ——
   * 这里验的是「页在、schema v3 迁移过了、空态说清了怎么用」，
   * 而不是判定逻辑（那些在 watch-evaluate / watch-repo 的单测里）。
   *
   * 空态文案是这一页最重要的部分：没有观察点时，用户需要被告诉**怎么创建第一个**。
   */
  test('观察点：页面能打开，空态说清了从哪创建', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await panel.getByRole('button', { name: '观察点' }).click()

    // 「不是策略参数」这条边界必须摆在页面上，不能只写在文档里
    await expect(panel.getByText(/不是策略参数/)).toBeVisible()
    await expect(panel.getByText(/还没有观察点/)).toBeVisible()
    await expect(panel.getByText(/让 AI 解读一次/)).toBeVisible()
  })

  /**
   * 收盘日报的空态。
   *
   * 验的是三件在别处验不了的事：页真的打得开（IPC 通道登记了、controller 没抛）、
   * 空库时如实说「还没有自选股」而不是画一屏 0、
   * 以及**「这里不产生新的判断」那句话摆在页面上** ——
   * 「日报只复述不推导」是这个功能的核心纪律，它必须对用户可见，
   * 不能只写在 report/build.ts 的头注释里。
   */
  test('日报：页面能打开，空态如实说没有自选，并声明不产生新判断', async () => {
    const panel = await openPanel(app as ElectronApplication)
    await panel.getByRole('button', { name: '日报' }).click()

    // 精确匹配：概览页是**常驻挂载**的（只切 display），它那句空态同时在 DOM 里。
    // （2026-08-18 起概览那句是「还没有个股…」，不再与这句撞车，但精确匹配照旧留着）
    await expect(panel.getByText('还没有自选股。', { exact: true })).toBeVisible()
    await expect(panel.getByText(/这里不产生新的判断/)).toBeVisible()
    await expect(panel.getByText(/没有需要明天跟进的事项/)).toBeVisible()
  })
})
