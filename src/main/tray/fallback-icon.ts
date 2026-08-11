/**
 * 托盘图标的兜底位图。
 *
 * 为什么必须有：托盘图标随皮肤走（docs/09 §6.2），而美术资源是外包件，
 * 一份干净的 clone 或 CI 环境里 resources/icons/ 可能是空的。
 * 托盘拿不到图就可能建不出来，而 C9「桌宠可完全隐藏、功能不减」整条逃生通道都挂在托盘上 ——
 * 托盘不存在时用户将无法退出应用，也无法把隐藏的桌宠调回来。
 *
 * 造型沿用 docs/09 §6.1 极简色点的 IDLE 一帧（#FDFBF5 填充 + #2A2028 描边），
 * 而不是随便一个方块 —— 这样即便在缺资源状态下，托盘看起来也仍属于这个产品。
 */

import { nativeImage } from 'electron'

/** 16×16 RGBA PNG，内联为 base64 避免再引入一个必须存在的文件 */
const FALLBACK_TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAR0lEQVR4nGNgoCXQUtD4D8JkacKFidL89/dXrBivIYQ0EzSEGM3IhlDXAGKdj9MbFBsw8GFAlWikOCGhG0JWUsZlGEmaSAUAPPWkJMcvvt4AAAAASUVORK5CYII='

export function fallbackTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(FALLBACK_TRAY_PNG_BASE64, 'base64'))
}
