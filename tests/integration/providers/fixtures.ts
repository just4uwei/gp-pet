/**
 * fixture 回放的公共装置。
 *
 * 关键点：**按原始字节喂进 Transport**。若这里先解码成字符串，GBK 那一步就测不到了——
 * 而「GBK 当 UTF-8 读」正是这套接口最容易犯且不会报错的错误（见 net/http.ts）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHttpClient, type HttpClient, type Transport } from '@main/net/http'
import type { ProviderId } from '@main/providers/types'

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'providers')

export function fixtureBytes(provider: ProviderId, file: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_ROOT, provider, file)))
}

export function fixtureText(provider: ProviderId, file: string): string {
  return readFileSync(join(FIXTURE_ROOT, provider, file), 'utf8')
}

export interface Recorded {
  url: string
  headers: Record<string, string>
}

export interface Replay {
  http: HttpClient
  /** 按调用顺序记录，供断言 URL 参数（fqt / param / fields）是否真的发对了 */
  calls: Recorded[]
}

/**
 * 把「URL 片段 → 响应字节」的路由表做成一个假 Transport。
 * 匹配按声明顺序，第一个 `url.includes(fragment)` 命中者胜；没命中就抛错 ——
 * 静默返回空响应会让解析测试变成「什么都没测」。
 */
export function replay(routes: [fragment: string, bytes: Uint8Array | string][]): Replay {
  const calls: Recorded[] = []
  const table = routes.map(
    ([fragment, payload]) =>
      [fragment, typeof payload === 'string' ? new TextEncoder().encode(payload) : payload] as const
  )

  const transport: Transport = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const hit = table.find(([fragment]) => url.includes(fragment))
    if (!hit) throw new Error(`fixture 路由表里没有匹配 ${url} 的项`)
    return { status: 200, bytes: hit[1] }
  }

  return {
    calls,
    http: createHttpClient({ transport, retries: 0, sleep: async () => {}, now: () => 0 }),
  }
}

/** 固定时钟：快照的 at 兜底值需要可断言 */
export const FIXED_NOW = 1_786_435_066_000
