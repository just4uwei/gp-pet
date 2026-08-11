import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer'),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  // 三个独立窗口 = 三个渲染入口。
  // pet / bubble 走透明窗口，panel 是常规窗口，详见 docs/06。
  renderer: {
    plugins: [react()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/renderer/pet/index.html'),
          panel: resolve('src/renderer/panel/index.html'),
          bubble: resolve('src/renderer/bubble/index.html'),
        },
      },
    },
  },
})
