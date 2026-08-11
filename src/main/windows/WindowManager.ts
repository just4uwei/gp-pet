/**
 * 窗口生命周期与推送目标的唯一持有者（docs/02 §2）。
 *
 * Bubble 窗口属 M3（提醒层），此处暂不创建 —— 骨架阶段没有可提醒的内容，
 * 提前把空气泡窗口挂上去只会多一个常驻置顶窗口，与 C7「休市零开销」相悖。
 */

import { screen, type BrowserWindow } from 'electron'
import type { IpcPushMap } from '@shared/ipc-types'
import { broadcast } from '../ipc/router'
import { PanelWindow } from './PanelWindow'
import { PetWindow } from './PetWindow'

export class WindowManager {
  private pet: PetWindow | null = null
  private readonly panel = new PanelWindow()
  private onDisplayChange: (() => void) | null = null

  createPet(): PetWindow {
    if (!this.pet) {
      this.pet = new PetWindow()
      this.onDisplayChange = () => this.pet?.revalidatePosition()
      // 拔插外接屏 / 改分辨率后，存下来的坐标可能落在不存在的区域（docs/06 §4）
      screen.on('display-added', this.onDisplayChange)
      screen.on('display-removed', this.onDisplayChange)
      screen.on('display-metrics-changed', this.onDisplayChange)
    }
    return this.pet
  }

  get petWindow(): PetWindow | null {
    return this.pet
  }

  get panelWindow(): PanelWindow {
    return this.panel
  }

  private get targets(): (BrowserWindow | null)[] {
    return [this.pet?.browserWindow ?? null, this.panel.browserWindow]
  }

  push<K extends keyof IpcPushMap>(channel: K, payload: IpcPushMap[K]): void {
    broadcast(this.targets, channel, payload)
  }

  /** C10：进程退出前主动销毁，不留残影置顶窗口 */
  destroyAll(): void {
    if (this.onDisplayChange) {
      screen.off('display-added', this.onDisplayChange)
      screen.off('display-removed', this.onDisplayChange)
      screen.off('display-metrics-changed', this.onDisplayChange)
      this.onDisplayChange = null
    }
    this.pet?.destroy()
    this.pet = null
    this.panel.destroy()
  }
}
