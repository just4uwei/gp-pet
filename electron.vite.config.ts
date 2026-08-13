import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer'),
}

/**
 * 主进程 / preload 的外置依赖。
 *
 * 两类东西**必须**外置，而且两类的失败都是「构建通过、运行时才炸」：
 *   1. electron 本身 —— 它是 devDependency，不外置就会被打进 bundle 并解析到 npm 上那个
 *      「返回 electron.exe 路径」的启动器包，于是 app / BrowserWindow 全成了 undefined。
 *   2. dependencies 里的运行时包 —— better-sqlite3 是原生模块（.node 根本没法打包），
 *      electron-log 要在运行时定位日志目录。
 *
 * 从 package.json 派生而不是手写清单：加一个 dependency 就自动生效，不会漏。
 * 注意别用 rollupOptions.external 覆盖 externalizeDepsPlugin —— 那正是本项目踩过的坑，
 * 所以干脆不用插件，只留这一处唯一真相。
 */
const externalPackages = ['electron', ...Object.keys(pkg.dependencies)]
const external = (id: string): boolean =>
  externalPackages.some((name) => id === name || id.startsWith(`${name}/`))

/**
 * 主进程与 preload 一律输出 CJS：
 *   - package.json 的 main 指向 out/main/index.js
 *   - **sandbox: true 的 preload 不支持 ESM**（docs/02 §5 的安全基线要求 sandbox）
 * electron-vite 5 默认输出 ESM，所以这里必须显式指定，不能靠默认值。
 */
const nodeOutput = { format: 'cjs' as const, entryFileNames: '[name].js' }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        external,
        input: { index: resolve('src/main/index.ts') },
        output: nodeOutput,
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        external,
        input: { index: resolve('src/preload/index.ts') },
        output: nodeOutput,
      },
    },
  },
  // 四个渲染入口。bar / pet / bubble 走透明窗口，panel 是常规窗口，详见 docs/06。
  // bar 与 pet 是同一个悬浮窗口的两种形态（AppSettings.appearance），不会同时存在。
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          // bar 是出厂默认形态，pet 是可切换形态（AppSettings.appearance）
          bar: resolve('src/renderer/bar/index.html'),
          pet: resolve('src/renderer/pet/index.html'),
          panel: resolve('src/renderer/panel/index.html'),
          bubble: resolve('src/renderer/bubble/index.html'),
        },
      },
    },
  },
})
