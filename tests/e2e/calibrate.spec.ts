/**
 * E2E：「校正费率」的整条路（017）。
 *
 * ## 这条用例存在的理由
 *
 * 2026-09-03 用户报「第二次校正的时候，无法输入 —— 输入框点不进去、敲了没字」，
 * 而当时**自动化复现不出来**。原因很具体：那一版的确认走 `window.confirm`，
 * 是一个**原生模态框**，而 **Playwright 会把 `window.confirm` 拦掉**
 * —— 从头到尾根本没有真的弹过原生框，也就测不到它关掉之后的焦点行为。
 *
 * 结论不是「再想办法测原生框」，是**把它从关键路径上拿掉**：
 * 后果清单（改写几笔、清掉几条止损线、逐只列出受影响的持仓）本来就画在表单里，
 * 原生框只是把同样的话再说一遍，还中间插了一次模态。改成页内两步之后，
 * 这条用例能覆盖全程 —— 包括**「第二次」**那一段。
 *
 * ## 四条断言
 *
 * 1. **全程零原生模态框**（`nativeDialogs === 0`）—— 这是上面那件事的闸门：
 *    谁再把 `window.confirm` 加回这条路，这里会红。
 * 2. 反解够不到目标时**拒绝并指向那个勾**，不给一个能让数字对上的荒唐费率。
 * 3. 应用走**页内两步**：先「应用到全部标的」，再「确认，重算整个账本」。
 * 4. **应用完之后能立刻再校正一次** —— 输入框真的能用真键盘敲进字。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test.describe('校正费率', () => {
  let userData = ''
  let app: ElectronApplication | null = null

  test.beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'gp-e2e-calibrate-'))
    // 预先写好设置跳过引导：这一组测的不是引导
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ disclaimerAcceptedAt: Date.now() }),
      'utf8'
    )
  })

  test.afterEach(async () => {
    await app?.close().catch(() => {})
    app = null
    rmSync(userData, { recursive: true, force: true })
  })

  test('页内两步确认 · 零原生模态框 · 应用完还能立刻再校正一次', async () => {
    app = await electron.launch({ args: [MAIN, `--user-data-dir=${userData}`], env: env() })
    const bar = await app.waitForEvent('window', { predicate: (p) => p.url().includes('bar') })
    await bar.evaluate(async () => {
      const gp = (window as unknown as { gp: { invoke: (c: string) => Promise<unknown> } }).gp
      await gp.invoke('panel:toggle')
    })
    const panel: Page = await app.waitForEvent('window', {
      predicate: (p) => p.url().includes('panel'),
    })

    /*
      ⚠ 这个计数器是本条用例的主断言。**别把它换成 `once('dialog')`**：
      不挂 handler 的话 Playwright 会自动 dismiss 并且悄无声息，
      而「悄无声息」正是这条路上一次出问题的形状。
    */
    let nativeDialogs = 0
    panel.on('dialog', (d) => {
      nativeDialogs += 1
      void d.dismiss()
    })

    // 播一点账本：一买一卖，金额够大 ⇒ 佣金率是可辨识的（不会全被最低佣金盖住）
    await panel.evaluate(async () => {
      const gp = (window as unknown as {
        gp: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> }
      }).gp
      await gp.invoke('watchlist:add', 'SH600000')
      const day = (d: string): number => Date.parse(`${d}T04:00:00Z`)
      await gp.invoke('trade:add', {
        code: 'SH600000',
        side: 'BUY',
        price: 10,
        shares: 10000,
        tradedAt: day('2026-08-01'),
      })
      await gp.invoke('trade:add', {
        code: 'SH600000',
        side: 'SELL',
        price: 11,
        shares: 5000,
        tradedAt: day('2026-08-05'),
      })
    })
    // 自选是启动时读的一次快照，播完要重载才看得见
    await panel.reload()
    await panel.getByTitle('持仓与成交录入').first().click()

    const entry = panel.getByText(/手续费与券商对不上/)
    await expect(entry).toBeVisible()
    await entry.click()

    const input = panel.getByPlaceholder('累计税费')
    await expect(input).toBeVisible()

    // ── ② 够不到的目标：拒绝，并先指向「免最低」那个勾 ──────────────
    await input.fill('1')
    await panel.getByRole('button', { name: '反解' }).click()
    await expect(panel.getByText(/免 5 元最低佣金/)).toBeVisible()
    await expect(panel.getByRole('button', { name: '应用到全部标的' })).toHaveCount(0)

    // ── ③ 够得到的目标：页内两步 ───────────────────────────────────
    await input.fill('50')
    await panel.getByRole('button', { name: '反解' }).click()
    const applyBtn = panel.getByRole('button', { name: '应用到全部标的' })
    await expect(applyBtn).toBeVisible()
    await applyBtn.click()
    // 第二步必须**另有一个按钮**：一步到位的「应用」会让误点直接改写全库
    const confirmBtn = panel.getByRole('button', { name: /确认，重算整个账本/ })
    await expect(confirmBtn).toBeVisible()
    await expect(panel.getByRole('button', { name: '再想想' })).toBeVisible()
    await confirmBtn.click()

    // ── ④ 应用完之后，立刻再校正一次 —— 用**真键盘**敲，不是 fill() ──
    // `fill()` 是程序赋值，测不出焦点问题；而用户报的正是「点不进去、敲了没字」
    const again = panel.getByText(/手续费与券商对不上/)
    await expect(again).toBeVisible({ timeout: 15_000 })
    await again.click()
    const input2 = panel.getByPlaceholder('累计税费')
    await expect(input2).toBeVisible()
    await input2.click()
    await expect(input2).toBeFocused()
    await panel.keyboard.type('42', { delay: 30 })
    await expect(input2).toHaveValue('42')
    await expect(panel.getByRole('button', { name: '反解' })).toBeEnabled()

    // ── ① 全程一次原生模态框都没有 ────────────────────────────────
    expect(nativeDialogs, '这条路上不许再出现 window.confirm').toBe(0)
  })
})
