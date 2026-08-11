# CLAUDE.md

本文件为在此仓库工作的 AI 助手提供上下文。**设计细节以 [`docs/`](./docs/README.md) 为准，本文件只讲「动手前必须知道的事」。**

## 这是什么

GP Pet：Windows 桌面桌宠，跟踪用户自选的 A 股，用量化策略判断买卖时机并以不打断工作的方式提醒。
Electron + React + TypeScript · 本地 SQLite · 免登录 · 无服务端 · **不接券商、不下单**。

当前处于 **M0（工程骨架）代码就绪、等待真机验收**。已实现：Pet/Panel 窗口、点击穿透、托盘、类型化 IPC、皮肤加载。
`src/core`、`src/main/providers`、`src/main/storage`、`src/backtest` 仍只有类型契约与占位。里程碑见 [docs/08](./docs/08-开发路线图.md)。

## 五条不可违反的约束

1. **`src/core` 是纯函数库。** 不得 import Electron、Node IO 模块、或 `src/main` 的任何东西；不得读时钟（`Date.now()` 一律禁止，时间由调用方传入）。ESLint 已强制，违反即 CI 失败。理由见 [ADR-0004](./docs/adr/ADR-0004-核心引擎与-electron-解耦.md) —— 这是回测与实盘同源、且无未来函数的架构保证。

2. **参数值不是事实。** [`src/core/params.ts`](./src/core/params.ts) 里所有数值（MACD 12/17/9、8% 止损、0.6 得分阈值…）均来自需求文档的网络转述，**未经任何验证**。不要在文档、UI 或注释里把它们写成「经过验证的最优参数」。见 [ADR-0003](./docs/adr/ADR-0003-来源文档数值不作为出厂默认.md)。

3. **零干扰契约是硬指标。** [docs/06 §1](./docs/06-桌宠交互与非干扰设计.md) 的 C1–C10，尤其 C1（永不抢焦点）与 C2（点击穿透）。任何为视觉效果牺牲它们的方案一律否决。Pet/Bubble 窗口的 `focusable: false` 不得改动。

4. **指标序列的未定义值填 `null`，绝不填 0。** 用 0 冒充未预热的指标值是回测失真的经典来源。`noUncheckedIndexedAccess` 已开启，这会让指标代码写起来啰嗦一些 —— 那是刻意的。

5. **不新增未在文档中论证的指标。** 信号质量问题优先从数据质量、参数标定、提醒策略三处找原因。加指标几乎总是错误的应对方式（[docs/08 §关键决策点](./docs/08-开发路线图.md)）。

## 常用命令

```bash
pnpm dev              # 启动开发环境（electron-vite）
pnpm test             # 单元 + 集成测试（Vitest，不需要启动 Electron）
pnpm test:cov         # 覆盖率；src/core 门槛 90%，其余 60%
pnpm typecheck        # 双 tsconfig（node / web）分别校验
pnpm lint
pnpm backtest -- --codes SH600000 --from 2020-01-01 --to 2026-06-30
pnpm package          # electron-builder 打包 Windows
```

## 分层与依赖方向

```
src/core     纯引擎：指标 → 市场状态 → 策略 → 组合 → 风控。零依赖、可回测
src/main     Electron 主进程：窗口、调度、数据源、存储、提醒编排
src/preload  contextBridge 窄接口
src/renderer pet / panel / bubble 三个独立入口
src/shared   主/渲染共享的纯类型
src/backtest 回测 CLI，复用 src/core
```

依赖方向单向：`main → core`、`renderer → shared`。反向依赖一律禁止。

## 上手前先读

| 要做的事 | 先读 |
|---|---|
| 写指标或策略 | [docs/04](./docs/04-指标与信号引擎.md)（公式与口径都在这，含与来源文档的差异说明） |
| 接数据源 | [docs/03](./docs/03-数据源与存储设计.md) + [src/main/providers/README.md](./src/main/providers/README.md) |
| 改窗口或交互 | [docs/06](./docs/06-桌宠交互与非干扰设计.md) |
| 做或验收美术资源 | [docs/09](./docs/09-美术资源规格.md)（形象无关的规格与验收标准；具体形象的设定放 `docs/skins/<skinName>.md`。资源是外包件，不在仓库里手搓） |
| 改提醒逻辑 | [docs/05](./docs/05-风控与提醒规则.md) |
| 写测试或回测 | [docs/07](./docs/07-回测与验证方案.md)（回测陷阱清单必读） |

## 容易踩的坑

- **复权**：指标用前复权（`*Adj` 字段），展示与持仓成本用不复权。混用会伪造出金叉死叉。
- **盘中 K 线是临时的**：`Candle.provisional` 为 true 时指标会抖，信号只能是 `PROVISIONAL`，最高 L2 提醒，收盘确认轮再定论。
- **盘中量比必须按时间归一化**，否则上午永远显示「缩量」。
- **MACD 柱用 `2×(DIF−DEA)`**（国内平台口径），与来源文档的 `DIF−DEA` 不同，但不影响任何穿越判定。
- **布林带标准差除 n 而非 n−1**（国内平台口径）。
- **穿越只在相邻两根间判定一次**，不做「N 日内曾金叉」的模糊匹配；去重是提醒层的职责，不是指标层的。
- **better-sqlite3 是原生模块**，需在 Electron ABI 下重建（`electron-rebuild`）。`pnpm-workspace.yaml` 里已显式跳过它的默认构建。
- **主进程/preload 的外置依赖清单在 `electron.vite.config.ts`**，从 `package.json` 的 `dependencies` 派生。别用 `rollupOptions.external` 去覆盖它 —— 漏外置 `electron` 会让 `import { app } from 'electron'` 解析到 npm 上那个「返回 exe 路径」的启动器包，**构建照样成功，启动才炸**。
- **preload 必须打成 CJS**：安全基线要求 `sandbox: true`，而沙箱化的 preload 不支持 ESM。electron-vite 5 默认输出 ESM，配置里已显式改回。
- **改完主进程要真启一次**（`pnpm dev`）。typecheck + build 全绿也可能启动即崩 —— 上面两条就是这么发现的。
- **默认皮肤「小猫」是生成件**，源在 `tools/asset-build/`，改素材要改代码再 `pnpm assets:build && pnpm verify:assets`，不要直接手改 PNG（下次重出就被覆盖）。
- **仍然不要假设皮肤存在**：缺资源时走占位皮肤 + 兜底托盘图标的降级路径，测试不许拿 `resources/pet/<skin>/` 当 fixture（用户皮肤、第三方皮肤都可能缺）。

## 措辞纪律

面向用户的文案中：
- 置信度**不得**称为「胜率」或「概率」
- **不得**出现「必涨」「抄底」「稳赚」「牛股」等词
- **不得**展示任何未经本地回测验证的绩效数字
- 每条提醒底部固定小字：**仅供参考，非投资建议**
