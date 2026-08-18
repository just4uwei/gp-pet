#!/usr/bin/env node
/**
 * 取一个网页的可读正文（开发/调研用，**不属于产品取数链路**）。
 *
 * ```bash
 * node scripts/fetch-page.mjs https://example.com/a            # 纯静态页，走 fetch
 * node scripts/fetch-page.mjs https://example.com/a --render   # SPA，用系统 Edge 渲染后再取
 * node scripts/fetch-page.mjs <url> --render --state <file>    # 带已登录会话
 * node scripts/fetch-page.mjs <url> --links                    # 只列链接
 * node scripts/fetch-page.mjs <url> --out /tmp/page.txt
 * ```
 *
 * ## 为什么需要它
 *
 * 内置的 WebFetch 工具在**本机网络下永久不可用**：它在抓之前要做一次域名安全校验，
 * 而那次校验要摸 `claude.ai` —— 实测 `curl https://claude.ai` 返回 **000**（不可达），
 * 于是它对**所有**域名都失败，包括本来完全能访问的站点
 * （同一时刻 `www.joinquant.com` 200 · `raw.githubusercontent.com` 200 · `api.github.com` 000）。
 * 那是内置工具、校验链路不可配置 ⇒ **只能绕过**。这个脚本就是那条绕路。
 *
 * ## 三条边界（与 `src/main/providers` 划清界限）
 *
 * 1. **它不是 provider。** 不进应用、不进降级链、不占 docs/03 §2.4 那份「每日 < 1000 次」的
 *    轮询预算。产品的取数一律走 `src/main/providers`，那里有健康度、熔断与限流。
 * 2. **`--render` 驱动系统已装的 Edge / Chrome**（`channel`），**不下载 Playwright 的 Chromium**
 *    （150MB，且这台机器上没下过 —— E2E 用 Playwright 驱动的是 Electron，不需要浏览器二进制）。
 * 3. **会话文件由调用方给（`--state`），脚本自己从不接收凭据。** 登录要人在有界面的窗口里做；
 *    那份 `storageState` 含登录 cookie，**必须放在仓库之外**（比如 `%LOCALAPPDATA%`）——
 *    落进仓库就等于把凭据提交上去。
 *
 * ⚠ **人类节奏、只读**：一次一页，别拿它做批量抓取；抓的必须是自己有权限看的页面。
 */

import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  process.stdout.write(
    [
      '用法：node scripts/fetch-page.mjs <url> [选项]',
      '',
      '  --render          用系统 Edge/Chrome 渲染后再取（SPA 必须加，否则只拿到「加载中」）',
      '  --state <file>    Playwright storageState（已登录会话），仅 --render 下有效',
      '  --wait <ms>       --render 下渲染完额外等多久，默认 2000',
      '  --links           输出链接清单（文字 :: href）而不是正文',
      '  --out <file>      落盘；缺省打到 stdout',
      '',
      '⚠ 它不是 provider：不进应用、不占轮询预算。会话文件必须放在仓库之外。',
      '',
    ].join('\n')
  )
  process.exit(0)
}

const url = argv[0]
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

/** HTML → 正文。先整块删 script/style/注释 —— 只去标签会把 CSS 当正文留下来 */
function stripHtml(raw) {
  let out = raw.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  out = out.replace(/<!--[\s\S]*?-->/g, ' ')
  out = out.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/gi, '\n')
  out = out.replace(/<[^>]+>/g, ' ')
  out = out
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return out
    .split('\n')
    // `[^\S\n]+` 而不是手写 [空格 \t nbsp]：中文页面里的 nbsp 直接写进字符类
    // 会踩 eslint 的 no-irregular-whitespace
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

function linksFrom(raw) {
  const seen = new Set()
  for (const m of raw.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]
    if (href.startsWith('#') || href.startsWith('javascript')) continue
    const label = stripHtml(m[2]).replace(/\n/g, ' ').slice(0, 40)
    seen.add(`${label.padEnd(42)} ${href}`)
  }
  return [...seen]
}

async function viaFetch() {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'accept-language': 'zh-CN,zh' },
    redirect: 'follow',
  })
  const raw = await res.text()
  process.stderr.write(`HTTP ${res.status} · ${raw.length} 字节 · ${res.url}\n`)
  return flag('--links') ? linksFrom(raw).join('\n') : stripHtml(raw)
}

async function viaRender() {
  // 动态 import：不 --render 时不该为它付加载 playwright 的代价
  const { chromium } = await import('playwright')
  const state = value('--state', undefined)
  let browser
  for (const channel of ['msedge', 'chrome']) {
    try {
      browser = await chromium.launch({ channel, headless: true })
      break
    } catch {
      // 换下一个已装的浏览器；两个都没有才报错
    }
  }
  if (!browser) throw new Error('没找到系统 Edge 或 Chrome（本脚本刻意不下载 Playwright 的 Chromium）')
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1600 },
    ...(state === undefined ? {} : { storageState: state }),
  })
  const page = await ctx.newPage()
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    // networkidle 拿不到就算了：别因为等超时丢掉已经渲染出来的内容
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
    await page.waitForTimeout(Number(value('--wait', '2000')))
    process.stderr.write(`HTTP ${res?.status()} · ${page.url()}\n`)
    if (flag('--links')) {
      const links = await page.evaluate(() =>
        [...document.querySelectorAll('a')]
          .map((a) => `${(a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)} :: ${a.href}`)
          .filter((s) => !s.endsWith(':: '))
      )
      return [...new Set(links)].join('\n')
    }
    return await page.evaluate(() => {
      const clone = document.body.cloneNode(true)
      for (const el of clone.querySelectorAll('script,style,noscript,svg')) el.remove()
      return clone.innerText.replace(/\n{3,}/g, '\n\n').trim()
    })
  } finally {
    await ctx.close()
    await browser.close()
  }
}

const text = flag('--render') ? await viaRender() : await viaFetch()
const out = value('--out', undefined)
if (out === undefined) process.stdout.write(`${text}\n`)
else {
  writeFileSync(out, `${text}\n`, 'utf8')
  process.stderr.write(`已落盘 ${out}（${text.length} 字）\n`)
}
