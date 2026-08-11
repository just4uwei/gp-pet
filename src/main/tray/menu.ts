/**
 * 上下文菜单（docs/06 §4）。
 *
 * 托盘右键与桌宠右键共用同一份菜单 —— 两处菜单不一致是最常见的桌面应用毛病，
 * 而这里的每一项都是「不进设置就能做到」的逃生通道（C8 一键静默、C9 完全隐藏）。
 */

import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { AppController } from '../controller'

function quietLabel(controller: AppController): string {
  if (!controller.quiet) return '免打扰'
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
          enabled: controller.quiet,
          click: () => controller.setQuietUntil(null),
        },
      ],
    },
    {
      label: controller.petVisible ? '隐藏桌宠' : '显示桌宠',
      click: () => controller.setPetVisible(!controller.petVisible),
    },
    { type: 'separator' },
    // 设置页属 M4；这里留位置而不留假入口
    { label: '设置…', enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => controller.quit() },
  ]
  return Menu.buildFromTemplate(template)
}
