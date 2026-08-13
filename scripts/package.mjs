/**
 * `pnpm package` 的外壳：清空输出目录 → 跑 electron-builder → **失败重试一次**。
 *
 * 为什么不是直接调 electron-builder：
 *
 * electron-builder 把 Electron 解压到 `release/win-unpacked.tmp` 再 rename 成
 * `release/win-unpacked`，而 Windows 上刚落盘的几百个 exe/dll 常被 Defender 之类的东西
 * 按住句柄，rename 就是一句没有上下文的：
 *
 *   ⨯ EPERM: operation not permitted, rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'
 *
 * 它**是间歇性的**（同一份配置，失败一次、原样再跑一次就过），但症状很像配置写错：
 * 首次打包成功、之后连着失败，于是很容易被拿去改 electron-builder.yml —— 那是白改。
 * 清目录 + 重试一次能把这件事挡在人眼之外。两次都失败才是真问题，那时错误原样透出来。
 *
 * 顺带保证产物不掺上一轮的残留（版本号或 target 改过之后尤其要紧）。
 */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = join(root, 'release')

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function attempt(label) {
  rmSync(releaseDir, { recursive: true, force: true })
  console.log(`[package] ${label}：release/ 已清空，开始打包…`)
  const result = spawnSync('electron-builder', ['--win', '--config', 'electron-builder.yml'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  })
  return result.status === 0
}

if (!attempt('第 1 次')) {
  console.log('[package] 打包失败，3 秒后重试一次（多半是 release/ 被杀毒或索引按住了句柄）')
  sleep(3000)
  if (!attempt('第 2 次')) {
    console.error('[package] 两次都失败 —— 这次不是句柄冲突，去看上面的真实报错')
    process.exit(1)
  }
}

console.log('[package] 完成，产物在 release/')
