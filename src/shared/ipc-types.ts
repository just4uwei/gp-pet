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

// ─────────────────────────── 皮肤（见 docs/06 §5、docs/09） ───────────────────────────

/** 九个动画 key 是跨皮肤契约，缺一即整套皮肤作废（docs/09 §1.2） */
export const PET_ANIMATION_KEYS = [
  'idle',
  'blink',
  'look',
  'watching',
  'excited',
  'alert',
  'sleepy',
  'offline',
  'shush',
] as const

export type PetAnimationKey = (typeof PET_ANIMATION_KEYS)[number]

export interface PetAnimation {
  sheet: string
  frames: number
  fps: number
  loop: boolean
  minHold?: number
  /** 主进程解析出的可加载 URL（res:// 协议）；图集缺失时为 null，渲染层退化为占位形状 */
  url: string | null
  /** @2x 图集（docs/09 §2.1）。缺失时为 null，渲染层退回 @1x 而不是请求一个 404 */
  url2x: string | null
}

/** 主进程投影给渲染层的皮肤视图 —— 渲染层不碰文件系统 */
export interface PetSkinView {
  /** 目录名，等于 AppSettings.skin */
  id: string
  name: string
  canvas: { width: number; height: number }
  anchor: { bubbleX: number; bubbleY: number }
  /** 矩形命中区（docs/06 §2.2 方案 1），坐标相对 canvas 左上角 */
  hitRects: Rect[]
  states: Record<PetAnimationKey, PetAnimation>
  /** true 表示皮肤校验失败已回退到内置占位皮肤。按 docs/06 §5：面板提示，不弹窗 */
  fallback: boolean
  /** 校验失败原因，供面板展示 */
  fallbackReason?: string
}

// ─────────────────────────── 通道契约 ───────────────────────────

/** 请求-响应：渲染层 → 主进程 */
export interface IpcInvokeMap {
  /** 骨架阶段的连通性探针（docs/08 M0） */
  'app:ping': (payload: string) => { pong: string; at: number }
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
  'pet:getSkin': () => PetSkinView
  'pet:setHitRegion': (rects: Rect[]) => void
  /**
   * 渲染层完成命中判定后上报：鼠标是否落在桌宠本体上。
   * true → 主进程关掉点击穿透；false → 恢复穿透（见 docs/06 §2.2）。
   */
  'pet:setInteractive': (interactive: boolean) => void
  /** 拖拽增量（屏幕像素）。用手动拖拽而非 -webkit-app-region，避免拖拽区吞掉命中判定所需的 mousemove */
  'pet:dragBy': (dx: number, dy: number) => void
  /** 拖拽结束：做边缘吸附并持久化位置 */
  'pet:dragEnd': () => void
  /** 右键唤起上下文菜单（与托盘菜单同一份，见 docs/06 §4） */
  'pet:contextMenu': () => void
  'pet:setDoNotDisturb': (until: number | null) => void
  /** 双击桌宠切换免打扰（C8），返回切换后的截止时间 */
  'pet:toggleDoNotDisturb': () => number | null
  'panel:toggle': () => void
}

/** 推送：主进程 → 渲染层 */
export interface IpcPushMap {
  'push:petState': PetState
  'push:alert': AlertPayload
  'push:quoteTick': QuoteTick[]
  'push:engineStatus': EngineStatus
}

/**
 * preload 经 contextBridge 暴露的唯一接口（window.gp）。
 * 渲染层不允许直接 ipcRenderer.invoke 字符串通道（docs/02 §5）。
 */
export interface GpBridge {
  invoke<K extends keyof IpcInvokeMap>(
    channel: K,
    ...args: Parameters<IpcInvokeMap[K]>
  ): Promise<Awaited<ReturnType<IpcInvokeMap[K]>>>
  on<K extends keyof IpcPushMap>(channel: K, listener: (payload: IpcPushMap[K]) => void): () => void
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
