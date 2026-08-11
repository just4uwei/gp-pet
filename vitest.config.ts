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
      include: ['src/core/**', 'src/main/**'],
      exclude: ['src/main/windows/**', 'src/main/tray/**'],
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
