/**
 * IPC 通道登记表（docs/02 §5）。
 *
 * 这里是**唯一**的通道白名单：preload 只透传登记过的通道，主进程只注册登记过的通道。
 * 类型由 src/shared/ipc-types.ts 提供，本文件只做运行时清单 + 编译期穷尽性检查。
 *
 * 本文件必须保持零运行时依赖 —— preload 在 sandbox 下加载它。
 */

import type { IpcInvokeMap, IpcPushMap } from '@shared/ipc-types'

/** 请求-响应通道：渲染层 → 主进程 */
export const INVOKE_CHANNELS = [
  'app:ping',
  'app:providerHealth',
  'app:engineStatus',
  'watchlist:list',
  'watchlist:add',
  'watchlist:remove',
  'watchlist:reorder',
  'position:list',
  'position:set',
  'position:clear',
  'position:acceptLoss',
  'position:clearStop',
  'signal:history',
  'signal:explain',
  'quote:intraday',
  'indicators:current',
  'kline:daily',
  'trade:list',
  'trade:preview',
  'trade:entryCheck',
  'trade:decisionOptions',
  'trade:add',
  'trade:remove',
  'trade:update',
  'trade:costPreview',
  'trade:costApply',
  'alert:history',
  'alert:markRead',
  'alert:gateUsage',
  'alert:clearGates',
  'settings:get',
  'settings:patch',
  'config:export',
  'config:import',
  'shadow:summary',
  'shadow:trades',
  'shadow:journal',
  'shadow:reset',
  'app:params',
  'app:about',
  'ai:config',
  'ai:setConfig',
  'ai:test',
  'ai:explain',
  'ai:cancel',
  'ai:history',
  'ai:remove',
  'watch:list',
  'watch:create',
  'watch:remove',
  'watch:suggest',
  'report:daily',
  'report:preview',
  'report:note',
  'announcement:list',
  'announcement:refresh',
  'brief:daily',
  'app:backupDatabase',
  'app:clearCache',
  'app:chooseDataDir',
  'app:revealPath',
  'pet:setHitRegion',
  'pet:setInteractive',
  'pet:dragBy',
  'pet:dragEnd',
  'pet:contextMenu',
  'pet:setDoNotDisturb',
  'panel:toggle',
] as const satisfies readonly (keyof IpcInvokeMap)[]

/** 推送通道：主进程 → 渲染层 */
export const PUSH_CHANNELS = [
  'push:petState',
  'push:alert',
  'push:quoteTick',
  'push:engineStatus',
  'push:aiChunk',
  'push:overlayPointer',
  'push:intradayT',
] as const satisfies readonly (keyof IpcPushMap)[]

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type PushChannel = (typeof PUSH_CHANNELS)[number]

// ── 编译期穷尽性检查 ────────────────────────────────────────────────
// `satisfies` 只能挡住「登记了不存在的通道」。下面两行挡住反向的
// 「加了通道却忘了登记」—— 漏登记时 true 无法赋给 false，typecheck 直接失败。

export const _INVOKE_CHANNELS_COMPLETE: Exclude<keyof IpcInvokeMap, InvokeChannel> extends never
  ? true
  : false = true

export const _PUSH_CHANNELS_COMPLETE: Exclude<keyof IpcPushMap, PushChannel> extends never
  ? true
  : false = true
