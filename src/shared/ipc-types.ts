/**
 * 主进程 ↔ 渲染层的类型化契约（见 docs/02 §5）。
 *
 * 渲染层不允许直接 ipcRenderer.invoke 字符串通道 —— 一律经 preload 暴露的窄接口。
 * 骨架阶段：仅类型，无实现。
 */

import type { AlertLevel, Direction, GatedDirection, Regime, SecCode, SignalStage } from '@core/types'

// ─────────────────────────── 视图模型 ───────────────────────────

export interface WatchItem {
  code: SecCode
  name: string
  group: string
  sortOrder: number
  industry?: string
  hasPosition: boolean
}

export interface QuoteTick {
  code: SecCode
  last: number
  changePct: number
  /** 数据陈旧 —— UI 应显示灰态而非假装实时 */
  stale: boolean
}

export interface SignalRecord {
  id: string
  code: SecCode
  name: string
  createdAt: number
  direction: GatedDirection
  /** UI 文案一律称「置信度」，不得称「胜率」（见 docs/04 §4.3） */
  score: number
  votes: number
  regime: Regime
  stage: SignalStage
  priceAt: number
  level: AlertLevel
  /** 非空表示该信号被静默及原因，用户可在提醒日志中看到（见 docs/05 §6） */
  suppressedReason?: string
}

export interface SignalEvidence {
  id: string
  subSignals: { id: string; direction: Direction; score: number; weight: number; detail: Record<string, unknown> }[]
  adjustments: { id: string; delta: number }[]
  indicatorsAt: Record<string, number | null>
}

export type PetState = 'SLEEPY' | 'IDLE' | 'WATCHING' | 'EXCITED' | 'ALERT' | 'OFFLINE'

export interface AlertPayload {
  signalId: string
  level: AlertLevel
  headline: string
  reasons: string[]
  code: SecCode
  name: string
  price: number
  changePct: number
  score: number
}

export interface ProviderHealth {
  provider: string
  status: 'OK' | 'DEGRADED' | 'DOWN'
  successRate: number
  p95LatencyMs: number
  lastError?: string
}

export interface EngineStatus {
  session: string
  lastTickAt: number
  watchCount: number
  unreadAlerts: number
  doNotDisturb: boolean
  offline: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ─────────────────────────── 通道契约 ───────────────────────────

/** 请求-响应：渲染层 → 主进程 */
export interface IpcInvokeMap {
  'watchlist:list': () => WatchItem[]
  'watchlist:add': (code: string, group?: string) => WatchItem
  'watchlist:remove': (code: SecCode) => void
  'watchlist:reorder': (codes: SecCode[]) => void
  'position:set': (code: SecCode, shares: number, cost: number) => void
  'position:clear': (code: SecCode) => void
  'signal:history': (query: { code?: SecCode; from?: number; to?: number; limit?: number }) => SignalRecord[]
  'signal:explain': (id: string) => SignalEvidence
  'signal:markRead': (ids: string[]) => void
  'settings:get': () => AppSettings
  'settings:patch': (patch: Partial<AppSettings>) => AppSettings
  'app:providerHealth': () => ProviderHealth[]
  'app:engineStatus': () => EngineStatus
  'pet:setHitRegion': (rects: Rect[]) => void
  'pet:setDoNotDisturb': (until: number | null) => void
  'panel:toggle': () => void
}

/** 推送：主进程 → 渲染层 */
export interface IpcPushMap {
  'push:petState': PetState
  'push:alert': AlertPayload
  'push:quoteTick': QuoteTick[]
  'push:engineStatus': EngineStatus
}

// ─────────────────────────── 设置 ───────────────────────────

export interface AppSettings {
  pollIntervalSec: number
  sensitivity: 'SENSITIVE' | 'BALANCED' | 'CONSERVATIVE'
  alertLevelOffset: -1 | 0 | 1
  soundEnabled: boolean
  quietHours: { start: string; end: string }[]
  respectFullscreen: boolean
  providerPriority: string[]
  autoLaunch: boolean
  skin: string
  minimalMode: boolean
  dataDir?: string
}
