/**
 * res:// 自定义协议 —— 渲染层加载 resources/ 下静态资源的唯一通道。
 *
 * 为什么不用 file://：渲染进程开着 sandbox + contextIsolation，
 * 直接放开 file:// 等于把整个磁盘暴露给渲染层。自定义协议把可读范围钉死在 resources/ 内，
 * 并在这里做一次路径穿越检查。
 *
 * URL 形如 res://assets/pet/marshal/idle.png
 *                 ^host  ^相对 resources/ 的路径
 */

import { app, net, protocol } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RES_SCHEME = 'res'
const RES_HOST = 'assets'

/** 必须在 app ready 之前调用 */
export function registerResourceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RES_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ])
}

/** resources/ 的绝对路径。打包后由 electron-builder 放进 process.resourcesPath */
export function resourcesRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
}

/** 把 resources/ 内的相对路径转成渲染层可加载的 URL */
export function resUrl(relativePath: string): string {
  const clean = relativePath.split(sep).join('/').replace(/^\/+/, '')
  return `${RES_SCHEME}://${RES_HOST}/${clean}`
}

/** 必须在 app ready 之后调用 */
export function registerResourceProtocol(): void {
  const root = normalize(resourcesRoot())

  protocol.handle(RES_SCHEME, async (request) => {
    let relative: string
    try {
      relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    } catch {
      return new Response('bad request', { status: 400 })
    }

    const target = normalize(join(root, relative))
    // 路径穿越防护：解析后必须仍在 resources/ 内
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403 })
    }

    return net.fetch(pathToFileURL(target).toString())
  })
}
