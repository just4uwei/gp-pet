/**
 * 设置存储：%APPDATA%/gp-pet/settings.json（docs/03 §4.1）。
 *
 * 写入走「临时文件 + rename」：进程在写一半时被杀掉是常态（关机、任务管理器），
 * 直接覆写会留下一个截断的 JSON，下次启动整份配置报废。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { AppSettings } from '@shared/ipc-types'
import { DEFAULT_SETTINGS, sanitizeSettings } from './schema'

export class SettingsStore {
  private current: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void = () => {}
  ) {}

  /** 读盘并修复。文件不存在是正常情况（首次启动），不报错也不立刻落盘。 */
  load(): AppSettings {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        this.log(`[settings] 读取失败，使用默认值：${String(error)}`)
      }
      this.current = { ...DEFAULT_SETTINGS }
      return this.get()
    }

    const { settings, repaired } = sanitizeSettings(raw)
    for (const item of repaired) {
      this.log(`[settings] ${item.field} 已回到默认值：${item.reason}`)
    }
    this.current = settings
    return this.get()
  }

  get(): AppSettings {
    // 返回副本：渲染层拿到的对象不该成为主进程状态的别名
    return structuredClone(this.current)
  }

  /** 合并补丁 → 校验 → 落盘。非法字段被忽略（回到原值），返回最终生效的设置。 */
  patch(patch: Partial<AppSettings>): AppSettings {
    const merged = { ...this.current, ...patch }
    const { settings, repaired } = sanitizeSettings(merged)
    for (const item of repaired) {
      this.log(`[settings] 忽略非法补丁字段 ${item.field}：${item.reason}`)
    }
    this.current = settings
    this.save()
    return this.get()
  }

  save(): void {
    const tmp = join(dirname(this.file), `.settings.json.${process.pid}.tmp`)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      // 设置写不进去不该让应用停下来：内存里的值仍然生效，只是下次启动会丢
      this.log(`[settings] 写入失败：${String(error)}`)
    }
  }
}
