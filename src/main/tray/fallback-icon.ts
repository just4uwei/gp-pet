/**
 * 托盘图标的兜底位图。
 *
 * 为什么必须有：`resources/icons/app/` 是磁盘上的静态文件，一份不完整的 clone、
 * 一次打包配置写错、或用户自己换图标换坏了，都会让它读不到。
 * 托盘拿不到图就可能建不出来，而 C9「悬浮条可完全隐藏、功能不减」整条逃生通道都挂在托盘上 ——
 * 托盘不存在时用户将无法退出应用，也无法把隐藏的悬浮条调回来。
 *
 * 造型就是 `tray.png` 本身（16×16 角色头像），字节由 `tools/logo/make-ico.mjs` 打印后贴进来 ——
 * 这样即便在缺资源状态下，托盘看起来也仍属于这个产品，而不是一个来历不明的方块。
 * 改了图标记得连这一串一起换（那个脚本每次都会把它打在最后）。
 *
 * **兜底只有常态这一版**：免打扰状态下拿不到 `tray-muted.png` 时也用它。
 * 多带一张图会让这个文件变成两份美术资产的副本，而这里的目标只是「托盘建得出来」。
 */

import { nativeImage } from 'electron'

/** 16×16 RGBA PNG，内联为 base64 避免再引入一个必须存在的文件 */
const FALLBACK_TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAADzElEQVR42j2TW0xTdwDGv3PoOBQKLa2AUKiIULCDzHJZuVhQgxEQ2Qwo2bKryLaY4GL2MJO5ZA/gw6I8LBGymMVkLhsRp3NANgNjwMymh4srBZWblNJy6A2Enp5TStv/wpLtl3xvX37J9/BRx2tqQVHUv7Gt2BEKhbAVDMPt9sC36SmIVyg7mCgpXVCgr5ZERLhtdgcoABWHDyIU3IYEwP+CZesy9uflVhXpDzTotFmG9HRNbmXV8Z0KwiT8V6nBcInjuAKagkwUhbYohrFLaJpGBE3juWUJda/Xtbc0n72gTlQhIT0TE4O/4T+slsVMH893UaARDgcxZTI/UMQrv6d53geL1YaSsuKOb65fvxBHUXjhcUNc5yCTy/DeqUYcNh7C+/Wn4fNugIBAKo0OyGRxc1JpNFBTcwIZ+7QGJ2cjJOAlDssMWZ1/SqxP/iYksEG2XXZCwkFim3xMlLEKAoBEx8Qsnj//Ma51doJOTUtDYWH+uYTdaqy5nPCsbUKmUuGlyEg4nB5Q8lh4V61Q5+mQptEgRiqD4PNpfrx7d0AQhEhaEEVUVJSV7OwUNn2YfjQGJjYGUbIYDNy4CfPDCWwECLC1DaOxFFEMg9N1J2m5XG7qv/9riDZNmeP2pKQkIOyHfckGOJYw+ScLXggiLTMN/PIMRnt64eY4nPuwCW2fXcSVy1+Q4qKiK9bllRCtz3u5PDkpSeGyr8LrXEFDy7tIiSJ4MjqOvdoMHHyzCXpdCni/H4xrCWVl+fCFKcrFrXTJFfGgdTn7Sfft2/CHQkjfq4ZpZhH3hoaRp8/A3PxzfH31MlSZWWAkEpgeT2LLJ2JgeHjE698SjaWvnqB5Uegzzyy0tbd/td43zEJKU6isPopkdQIMxmKcrK/Bgzu9cLs8WJEoIY9VIVEZ5xREv0en1dbS7OgEHBv8Jcuzp+u0P4DZ5TUkpOcgKPDw8y/QPziGX9hpZOfmIY4AHMchS5dbHxlBlfQPjXRg1+5UqJLUana4n7A9vaTx2GukukRPCg/Vki/bvyXHjjSQn2/9QB6yY+Tt2jfIT50dZIfW1tYemone+QLBmbcarxaVV6L7xi3s0cwhemEW3JwVBVPbyNYokL1PjT/unUJSUjzszmIMdXeh5aOztaNj43WSHG1W1eefftI4w7Jw8m5YTRs4eiADDckKbDpMYGJfgXWEhXLajV3xCoTlDAbv/45nqw580HymS2IozK8Wea/4yDwlzvf0QcbaEVGUD5QnwnLNB9ptxvioDUccGvj5WQQuLkhSc7LXv+u+M9Tc9I7xH2LzuDudR9CTAAAAAElFTkSuQmCC'

export function fallbackTrayIcon(): Electron.NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(FALLBACK_TRAY_PNG_BASE64, 'base64'))
}
