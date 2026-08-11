# ADR-0001 · 桌面壳选择 Electron

- **状态**：已接受
- **日期**：2026-08-11

## 背景

需要一个 Windows 桌面客户端，形态是浮动桌宠：透明无边框、置顶、点击穿透、托盘常驻、系统通知、本地存储、免登录。

## 候选

| 方案 | 优势 | 劣势 |
|---|---|---|
| **Electron + React + TS** | 透明/置顶/穿透/托盘 API 成熟且文档充分；桌宠动画用 Web 技术实现成本最低；调试体验最好；`better-sqlite3` 同步 API 适合主进程 | 安装包 ~80MB；空闲内存 200MB+ |
| Tauri 2 + Rust | 包体 ~10MB，内存约为 Electron 的 1/3；Rust 侧做轮询与计算性能好 | Windows 上透明窗口 + 点击穿透坑较多；桌宠动画调试链路长；开发迭代慢 |
| Python + PySide6 | 可直接复用 pandas / TA-Lib / akshare；策略与回测同语言 | 桌宠动画表现力弱；PyInstaller 打包笨重；透明窗口与穿透同样需绕路 |

## 决策

选择 **Electron + React + TypeScript**。

## 理由

1. **风险最高的技术点是零干扰契约（[06 §1](../06-桌宠交互与非干扰设计.md) 的 C1/C2），不是性能。** Electron 在 `transparent` + `focusable:false` + `setIgnoreMouseEvents(forward)` 这条路径上有最多的现成实践，把最大不确定性压到最低。
2. 桌宠是动画密集型 UI，Web 的动画与布局能力是明确优势。
3. 指标计算量很小（100 只 × 300 根日线），性能不是瓶颈，Tauri 的性能优势换不来实际体验差异。
4. 用 TypeScript 写引擎，可与渲染层共享类型，回测 CLI 也复用同一份代码，避免「策略两份实现」的经典陷阱。

## 代价与缓解

| 代价 | 缓解 |
|---|---|
| 内存占用高 | 明确性能预算（[06 §6](../06-桌宠交互与非干扰设计.md)）；Panel 懒加载并 hide 而非 destroy；休市降帧 |
| 包体大 | 只发 Windows；提供 portable 版 |
| 安全面 | `contextIsolation` + `sandbox` + 无 `nodeIntegration` + CSP + 拒绝新窗口 |
| 没有 Python 量化生态 | 指标自行实现并用 Python 脚本做**交叉验证**（[07 §2.1](../07-回测与验证方案.md)），把生态当校验工具而非运行时依赖 |

## 重新评估的触发条件

M0 出口若无法同时满足 C1 与 C2，重新评估 Tauri 或改变产品形态。
