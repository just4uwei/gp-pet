/**
 * 面板头部的品牌标记 —— 就是托盘那颗睁眼头像（`resources/icons/app/tray.png`，16×16）。
 *
 * 三条：
 *
 * 1. **纯装饰，不表达状态。** 状态点的唯一判定者是主进程的 `PetStateMachine`（CLAUDE.md），
 *    面板上再放一个语义相近的东西只会让两处对不上。所以这里固定用**睁眼**那版，
 *    不跟免打扰走 —— 睁眼 / 闭眼是托盘图标的分工，别把它复制到第二个地方。
 * 2. **按 1:1 显示（16px），不缩放。** 像素画被非整数倍缩放就糊，
 *    `image-rendering: pixelated` 也救不回来 —— 要改大小只能整数倍（32 / 48）。
 * 3. **走 res://**，那是渲染层读 `resources/` 的既定通道（`src/main/resources.ts`），
 *    CSP 的 `img-src` 已放行。读不到就什么都不显示：一个装饰性标记不值得为它加降级路径
 *    （托盘那条才需要，见 `src/main/tray/fallback-icon.ts`）。
 */

export function BrandMark() {
  return (
    <img
      src="res://assets/icons/app/tray.png"
      alt=""
      width={16}
      height={16}
      className="h-4 w-4 shrink-0"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}
