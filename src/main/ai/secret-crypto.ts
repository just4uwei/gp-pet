/**
 * `SecretCrypto` 的生产实现：Electron 的 `safeStorage`（Windows 下走 DPAPI，
 * 密文绑定当前 Windows 用户账户）。
 *
 * 单独成文件是为了让 config.ts 不 import Electron —— 与 `settings/transfer.ts`
 * 和 `transfer-io.ts` 的拆法一致，好让配置解析能在 Vitest 里直接跑。
 *
 * `isEncryptionAvailable()` 在 Linux 上可能因为没有 keyring 而返回 false；
 * Windows 上正常情况恒 true，但**不假设**它 —— 调用方（AiConfigStore）在 false 时
 * 拒绝保存 key 而不是退化成明文。
 */

import { safeStorage } from 'electron'
import type { SecretCrypto } from './types'

export function electronSecretCrypto(): SecretCrypto {
  return {
    available() {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt(plain) {
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(cipherB64) {
      return safeStorage.decryptString(Buffer.from(cipherB64, 'base64'))
    },
  }
}
