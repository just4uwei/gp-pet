/**
 * Playwright 配置 —— **只跑 Electron E2E**（docs/08 M4）。
 *
 * 与 Vitest 分工明确：Vitest 覆盖纯逻辑与存储层（1000 条用例，不启 Electron），
 * 这里只回答那些「只有真的把应用启起来才能验」的问题：
 *   - 主进程能起来吗（构建配置有没有把 electron 打进 bundle、preload 是不是 CJS）
 *   - 三个窗口的关键属性对不对（悬浮条 `focusable: false` 是 C1 的落点）
 *   - 首次启动引导挡不挡得住、确认之后落不落盘
 *   - preload 白名单是否真的拦掉了未登记的通道
 *
 * ## 两条硬约束，写在这里免得每次重新踩
 *
 * 1. **必须先 `pnpm build`。** Playwright 启的是 `out/main/index.js`，不是源码。
 *    `webServer` 那套机制对 Electron 不适用，所以构建由 `pnpm test:e2e` 脚本串在前面。
 * 2. **必须清掉 `ELECTRON_RUN_AS_NODE`。** agent / CI 的 shell 常设这个变量，
 *    于是 Electron 以纯 Node 模式启动，`require('electron')` 解析到 npm 上那个
 *    「返回 exe 路径」的启动器包，第一个用到 `protocol` / `app` 的地方就炸
 *    （CLAUDE.md 记着这条）。用例里逐个 launch 时都显式删掉它。
 *
 * ## 为什么 workers = 1
 *
 * 单实例锁（`app.requestSingleInstanceLock()`）是这个应用的**数据完整性**保证：
 * 第二个实例拿不到锁会立刻退出。并行跑用例就等于让它们互相抢锁，
 * 后启的那个直接 exit 0，症状是「用例随机超时」。
 */

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // 冷启一个 Electron（开库 + 迁移 + undici）在慢盘上要好几秒
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 见文件头：单实例锁与并行互斥
  workers: 1,
  fullyParallel: false,
  // 失败重跑一次：真机启动偶发的窗口时序问题不该让整条流水线红
  retries: process.env['CI'] === undefined ? 0 : 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
})
