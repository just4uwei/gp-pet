/**
 * 配置导入导出的 Electron 侧：文件对话框 + 读写盘 + 覆盖确认。
 *
 * 与 `transfer.ts` 分开的理由和 `src/core` 与 `src/main` 分开是同一条：
 * 那边是纯逻辑（能测），这边全是 Electron 副作用（只能真机验）。
 * 这里**不做任何判断**，只负责问路径、读字节、弹确认框。
 *
 * 覆盖确认必须走系统模态框而不是面板里的一个 checkbox：
 * 导入会把现有自选与持仓整份清掉，这是不可撤销的，得让用户在真正动手前看到条数。
 */

import { app, dialog, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * dundian-config-20260814.json —— 带日期，同一天多次导出会被系统的「(1)」后缀区分开。
 *
 * 只有**文件名**跟着改名走。文件**内部**的 `format` 标记仍是 `gp-pet-config`
 * （`transfer.ts` 的 `CONFIG_BUNDLE_FORMAT`）—— 那是兼容标记，改了会让改名前导出的
 * 文件一律被判成「这不是蹲点的配置文件」。
 */
export function defaultExportName(now: number): string {
  const at = new Date(now)
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `dundian-config-${y}${m}${d}.json`
}

const FILTERS = [{ name: '蹲点配置', extensions: ['json'] }]

/** 用户取消返回 null */
export async function askSavePath(win: BrowserWindow | null, now: number): Promise<string | null> {
  const defaultPath = join(app.getPath('documents'), defaultExportName(now))
  const result = win
    ? await dialog.showSaveDialog(win, { title: '导出个人配置', defaultPath, filters: FILTERS })
    : await dialog.showSaveDialog({ title: '导出个人配置', defaultPath, filters: FILTERS })
  return result.canceled || !result.filePath ? null : result.filePath
}

/** 用户取消返回 null */
export async function askOpenPath(win: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '导入个人配置',
    filters: FILTERS,
    properties: ['openFile'],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const picked = result.filePaths[0]
  return result.canceled || picked === undefined ? null : picked
}

/**
 * 覆盖前的最后一道确认。默认按钮是「取消」（cancelId = defaultId）——
 * 这个对话框可能在用户没看清的情况下被回车掉，而它清掉的东西找不回来。
 */
export async function confirmOverwrite(
  win: BrowserWindow | null,
  summary: { incomingWatch: number; incomingPositions: number; currentWatch: number; currentPositions: number }
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: '覆盖导入',
    message: '导入会整份替换现有的自选股与持仓',
    detail:
      `现有 ${summary.currentWatch} 只自选、${summary.currentPositions} 条持仓将被清除，\n` +
      `替换为文件里的 ${summary.incomingWatch} 只自选、${summary.incomingPositions} 条持仓。\n` +
      `设置也会整份写入。此操作不可撤销。`,
    buttons: ['覆盖导入', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

/**
 * 通用的「不可撤销动作」确认框（M4 设置页：清空影子记录）。
 *
 * 与 `confirmOverwrite` 同一条纪律：**默认按钮是取消**。
 * 这类框会被回车掉，而它清掉的东西找不回来。
 */
export async function confirmDestructive(
  win: BrowserWindow | null,
  spec: { title: string; message: string; detail: string; confirmLabel: string }
): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: spec.title,
    message: spec.message,
    detail: spec.detail,
    buttons: [spec.confirmLabel, '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return result.response === 0
}

/** 选一个目录（换数据目录用）。用户取消返回 null */
export async function askDirectory(win: BrowserWindow | null, defaultPath: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择数据目录',
    defaultPath,
    // createDirectory 让用户能在对话框里新建一个 —— 否则得先去资源管理器建好再回来
    properties: ['openDirectory', 'createDirectory'],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const picked = result.filePaths[0]
  return result.canceled || picked === undefined ? null : picked
}

export function writeTextFile(path: string, text: string): void {
  writeFileSync(path, text, 'utf8')
}

/**
 * 读一份 JSON。
 *
 * 解析失败时换掉原始错误：`Unexpected token } in JSON at position 412` 对用户毫无意义，
 * 而这个界面上唯一有用的信息是「这个文件读不了」+ 路径。
 */
export function readJsonFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`读不了这个文件：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    // 原始的 SyntaxError 挂在 cause 上：界面不显示它，但日志里要留得住
    throw new Error('文件内容不是合法的 JSON，可能在编辑或传输时被改坏了', { cause: error })
  }
}

export function appVersion(): string {
  return app.getVersion()
}
