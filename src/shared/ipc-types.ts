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

/**
 * 悬浮条左端那颗**状态点**的语义（docs/06 §3）。
 *
 * 名字里的 `Pet` 是历史（本项目起初是桌宠形态）—— 桌宠已移除，判定者仍是
 * `PetStateMachine`，而它只接受**过了四道闸门**的提醒。渲染层不许自己从
 * `signal:history` 推断这个值：那是一条绕过冷却与免打扰的旁路。
 */
export type PetState = 'SLEEPY' | 'IDLE' | 'WATCHING' | 'EXCITED' | 'ALERT' | 'OFFLINE'

/** 气泡与系统通知的展示载荷。四段结构见 docs/05 §5 */
export interface AlertPayload {
  signalId: string
  level: AlertLevel
  direction: GatedDirection
  headline: string
  reasons: string[]
  code: SecCode
  name: string
  price: number
  changePct: number
  score: number
  /** 触发时刻（墙上时间），气泡第四行显示 */
  at: number
}

/**
 * 分发渠道。与 `src/main/alerts/dispatcher.ts` 的 `AlertChannel` 同一集合。
 *
 * 只剩两个（2026-08-13）：`PET` 是悬浮条上的状态点（名字是历史，见 PetState），
 * `BUBBLE` 是气泡。托盘角标（`TRAY`）与系统通知（`OS_NOTIFY`）已移除 ——
 * 提醒的唯一可见出口是气泡。**历史库里仍有带这两个值的行**，
 * 提醒日志按原样显示即可（见 storage/repositories/alert.ts）。
 */
export type AlertChannelName = 'PET' | 'BUBBLE'

/**
 * 提醒日志的一行（docs/05 §6）。
 *
 * **每一条候选都有一行**，包括被丢弃的 —— 用户要能回答「它是不是漏提醒了」。
 * `channels` 为空表示这条根本没发出去，`reason` 写明是被哪道闸门挡的。
 */
export interface AlertRecord {
  id: string
  signalId: string
  code: SecCode
  name: string
  createdAt: number
  direction: GatedDirection
  /** UI 文案一律称「置信度」，不得称「胜率」（见 docs/04 §4.3） */
  score: number
  regime: Regime
  stage: SignalStage
  headline: string
  /** 最终生效的级别；`channels` 为空时是它**本来**要发的级别 */
  level: AlertLevel
  channels: AlertChannelName[]
  /** 非空 = 被丢弃或被降级及原因 */
  reason?: string
  read: boolean
}

/** 用户手工录入的持仓（docs/03 §4.2）。成本价是**不复权**真实成交价 */
export interface PositionView {
  code: SecCode
  shares: number
  cost: number
  peakPrice: number
  openedAt: number
}

/**
 * 配置导入导出的结果（src/main/settings/transfer.ts）。
 *
 * `warnings` 是**必须显示**的：解析时坏字段退回默认值、坏行被丢掉都记在这里，
 * 静默吞掉会让用户以为整份配置都原样搬过来了（docs/02 §7）。
 */
export interface ConfigTransferResult {
  /** DONE 真的写了 / 导入了；CANCELED 用户在系统对话框里取消；FAILED 出错，看 error */
  status: 'DONE' | 'CANCELED' | 'FAILED'
  /** 导出时是落盘路径；导入时是来源文件 */
  path?: string
  /** 导出/导入涉及的条数 */
  counts?: { watchlist: number; positions: number }
  /** 导入时被清掉的旧数据条数 */
  removed?: { watchlist: number; positions: number }
  warnings: string[]
  error?: string
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
  /** 免打扰的成因（静默时段 / 全屏应用 / 手动…）。面板据此解释「为什么没弹」 */
  doNotDisturbReason?: string
  offline: boolean
  /** 日历依据不硬（内置表未核对，或退化到「周一至周五」），UI 应提示日历可能过期（docs/03 §3） */
  calendarUncertain?: boolean
  /** 最近一轮行情取自缓存 —— UI 显示灰态而非假装实时（docs/03 §2.2） */
  stale?: boolean
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
  /** 骨架阶段的连通性探针（docs/08 M0） */
  'app:ping': (payload: string) => { pong: string; at: number }
  'watchlist:list': () => WatchItem[]
  'watchlist:add': (code: string, group?: string) => WatchItem
  'watchlist:remove': (code: SecCode) => void
  'watchlist:reorder': (codes: SecCode[]) => void
  'position:list': () => PositionView[]
  'position:set': (code: SecCode, shares: number, cost: number) => void
  'position:clear': (code: SecCode) => void
  'signal:history': (query: { code?: SecCode; from?: number; to?: number; limit?: number }) => SignalRecord[]
  'signal:explain': (id: string) => SignalEvidence
  /** 提醒日志（docs/05 §6）：含被丢弃与被降级的条目 */
  'alert:history': (query: { code?: SecCode; from?: number; to?: number; limit?: number }) => AlertRecord[]
  /** 标记已读。空数组 = 全部已读（用户打开日志视图即视为看过） */
  'alert:markRead': (ids: string[]) => number
  'settings:get': () => AppSettings
  'settings:patch': (patch: Partial<AppSettings>) => AppSettings
  /**
   * 个人配置导出：设置 + 自选（含分组与排序）+ 持仓。路径由系统保存对话框选。
   * 行情、信号、提醒日志不导 —— 它们是可再生的派生物。
   */
  'config:export': () => ConfigTransferResult
  /** 个人配置导入：**覆盖式**，动手前会弹一个系统确认框报出将被清除的条数 */
  'config:import': () => ConfigTransferResult
  'app:providerHealth': () => ProviderHealth[]
  'app:engineStatus': () => EngineStatus
  'pet:setHitRegion': (rects: Rect[]) => void
  /**
   * 渲染层完成命中判定后上报：鼠标是否落在悬浮条本体上。
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

/**
 * 常驻悬浮窗口只有一种形态：**悬浮条**（300×38，配托盘）。
 *
 * 2026-08-13 起桌宠形态与整套皮肤系统已移除，`appearance` / `skin` / `minimalMode`
 * 三个字段随之删掉 —— 旧 settings.json 里残留的这几个键会被 `sanitizeSettings` 忽略
 * （它只认 schema 里有的键），不需要迁移。
 */
export interface AppSettings {
  pollIntervalSec: number
  sensitivity: 'SENSITIVE' | 'BALANCED' | 'CONSERVATIVE'
  alertLevelOffset: -1 | 0 | 1
  quietHours: { start: string; end: string }[]
  respectFullscreen: boolean
  /** 与 src/main/providers/types.ts 的 ProviderId 同集合（同一 union，跨层不引用） */
  providerPriority: ('eastmoney' | 'sina' | 'tencent')[]
  autoLaunch: boolean
  dataDir?: string
}
