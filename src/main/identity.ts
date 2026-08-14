/**
 * 应用身份标识。
 *
 * **为什么要单独一个文件**：这个字符串必须在三处保持一致，而它们互相看不见 ——
 *   1. `app.setAppUserModelId()`（主进程运行时，见 index.ts）
 *   2. `electron-builder.yml` 的 `appId`（打包时）
 *   3. 安装包在注册表里写的 AUMID
 * 不一致的后果只在**打包后**才看得出来：Windows 会把任务栏归组、跳转列表挂到
 * 「electron.app.Electron」名下或干脆不显示应用名，而这条路径在 `pnpm dev` 里不会暴露。
 *
 * **不要用它去调 `app.setName()`**：`app.getPath('userData')` 是按 name 算的
 * （`%APPDATA%/gp-pet`），改名等于把整个数据目录搬走 —— 已有用户的 market.db、
 * settings.json、日志会全部「消失」，而回测 CLI 的默认库路径也写着 gp-pet
 * （`src/backtest/cli.ts` 的 `defaultDbPath`）。name 由 package.json 的 `name` 决定，就这样。
 *
 * **2026-08-14 产品改名「蹲点」时，改的是 APP_ID 而不是 name。** 两者的代价不对称：
 * 换 APP_ID 丢的是任务栏归组与已固定的磁贴（用户重新固定一次即可），
 * 换 name 丢的是**数据**。所以 `%APPDATA%/gp-pet` 这个路径**留着不动** ——
 * 它现在是个历史名字，别为了「统一」去改它。
 */

/** 反写域名式的唯一标识。改它等于换一个应用身份，会丢掉已注册的固定磁贴与任务栏归组 */
export const APP_ID = 'com.dundian.desktop'
