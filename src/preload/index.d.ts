/**
 * 渲染层看到的 window.gp 类型。
 *
 * tsconfig.web.json 通过 `src/preload/*.d.ts` 把它并入渲染层的类型空间；
 * 渲染层因此拿得到完整签名，却拿不到任何 Electron 实体。
 */

import type { GpBridge } from '@shared/ipc-types'

declare global {
  interface Window {
    gp: GpBridge
  }
}

export {}
