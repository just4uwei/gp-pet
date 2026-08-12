// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'release/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // ADR-0004 的铁律由此强制：src/core 是纯 TS 库
    // 不碰 Electron、不碰 Node IO、不反向依赖 src/main
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*'], message: 'src/core 不得依赖 Electron（见 ADR-0004）' },
            { group: ['node:*', 'fs', 'path', 'http', 'https', 'net'], message: 'src/core 不得做 IO（见 ADR-0004）' },
            { group: ['@main/*', '../main/*', '**/main/**'], message: '依赖方向必须是 main → core（见 ADR-0004）' },
          ],
        },
      ],
      // 引擎里禁止读时钟：时间必须由调用方传入，否则回测不可复现
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'src/core 不得读时钟，时间由调用方作为参数传入（见 ADR-0004）' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'src/core 不得读时钟（见 ADR-0004）' },
      ],
    },
  },
  {
    // 构建期工具：纯 Node 脚本，不参与打包，也不受 src 的分层约束
    files: ['tools/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  }
)
