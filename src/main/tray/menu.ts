/**
 * 上下文菜单（docs/06 §4）。
 *
 * 托盘右键与悬浮条右键共用同一份菜单 —— 两处菜单不一致是最常见的桌面应用毛病，
 * 而这里的每一项都是「不进设置就能做到」的逃生通道（C8 一键静默、C9 完全隐藏）。
 *
 * 悬浮条形态下双击是「开面板」而不是「切免打扰」（见 renderer/bar/App.tsx 的纪律 5），
 * 所以 C8 的落点**只有这份菜单**里的「免打扰」子菜单，不能把它挪走。
 */

import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppController } from '../controller'

/**
 * 标签用**手动**免打扰而不是聚合结论：静默时段或全屏应用也会让 `quiet` 为真，
 * 但那两者不是这个菜单项管的，写成「免打扰（至 15:00）」会让用户以为是自己开的。
 */
function quietLabel(controller: AppController): string {
  if (!controller.manualQuiet) return '免打扰'
  const until = controller.quietUntilTs
  if (until === null) return '免打扰'
  const at = new Date(until)
  const hh = String(at.getHours()).padStart(2, '0')
  const mm = String(at.getMinutes()).padStart(2, '0')
  return `免打扰（至 ${hh}:${mm}）`
}

export function buildContextMenu(controller: AppController): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: '打开面板', click: () => controller.showPanel() },
    { type: 'separator' },
    {
      label: quietLabel(controller),
      submenu: [
        { label: '30 分钟', click: () => controller.setQuietPreset('min30') },
        { label: '2 小时', click: () => controller.setQuietPreset('hour2') },
        { label: '至收盘', click: () => controller.setQuietPreset('untilClose') },
        { type: 'separator' },
        {
          label: '解除免打扰',
          enabled: controller.manualQuiet,
          click: () => controller.setQuietUntil(null),
        },
      ],
    },
    {
      // C9 的入口
      label: `${controller.overlayVisible ? '隐藏' : '显示'}悬浮条`,
      click: () => controller.setOverlayVisible(!controller.overlayVisible),
    },
    { type: 'separator' },
    // 设置页属 M4；这里留位置而不留假入口
    { label: '设置…', enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => controller.quit() },
  ]
  return Menu.buildFromTemplate(template)
}
