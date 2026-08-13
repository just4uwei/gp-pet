/**
 * 托盘图标的兜底位图。
 *
 * 为什么必须有：`resources/icons/app/` 是磁盘上的静态文件，一份不完整的 clone、
 * 一次打包配置写错、或用户自己换图标换坏了，都会让它读不到。
 * 托盘拿不到图就可能建不出来，而 C9「悬浮条可完全隐藏、功能不减」整条逃生通道都挂在托盘上 ——
 * 托盘不存在时用户将无法退出应用，也无法把隐藏的悬浮条调回来。
 *
 * 造型是一颗带描边的圆点（#FDFBF5 填充 + #2A2028 描边），与悬浮条左端的状态点同源，
 * 而不是随便一个方块 —— 这样即便在缺资源状态下，托盘看起来也仍属于这个产品。
 */

import { nativeImage } from 'electron'

/** 16×16 RGBA PNG，内联为 base64 避免再引入一个必须存在的文件 */
const FALLBACK_TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAR0lEQVR4nGNgoCXQUtD4D8JkacKFidL89/dXrBivIYQ0EzSEGM3IhlDXAGKdj9MbFBsw8GFAlWikOCGhG0JWUsZlGEmaSAUAPPWkJMcvvt4AAAAASUVORK5CYII='

export function fallbackTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(FALLBACK_TRAY_PNG_BASE64, 'base64'))
}
