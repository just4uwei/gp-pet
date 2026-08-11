import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // e2e 由 Playwright 单独驱动，不走 Vitest
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      // 限定扩展名：不加的话 v8 会去解析 src/main/providers/README.md 并报一个吓人的 parse error
      include: ['src/core/**/*.ts', 'src/main/**/*.ts'],
      // 排除的都是「只有跑起 Electron 才能验证」的胶水层：窗口、托盘、协议、入口、
      // IPC 登记。它们的正确性靠 docs/06 §1 的手工验收清单，不靠行覆盖率。
      // 判据类逻辑一律下沉到 src/main/util 与 src/main/skin，那两处不在排除名单里。
      exclude: [
        'src/main/windows/**',
        'src/main/tray/**',
        'src/main/ipc/**',
        'src/main/index.ts',
        'src/main/controller.ts',
        'src/main/logging.ts',
        'src/main/resources.ts',
        // 类型契约文件，编译后无可执行语句
        'src/core/types.ts',
        'src/main/providers/types.ts',
      ],
      thresholds: {
        // src/core 是全部策略逻辑所在，门槛更高（见 docs/07 §5）
        'src/core/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        lines: 60,
        functions: 60,
        branches: 55,
        statements: 60,
      },
    },
  },
})
