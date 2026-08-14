/**
 * 主进程 ↔ 渲染层的类型化契约（见 docs/02 §5）。
 *
 * 渲染层不允许直接 ipcRenderer.invoke 字符串通道 —— 一律经 preload 暴露的窄接口。
 * 骨架阶段：仅类型，无实现。
 */

import type {
  AlertLevel,
  Direction,
  GatedDirection,
  Regime,
  SecCode,
  SignalStage,
  TradeDate,
} from '@core/types'

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

/**
 * 当日分时留痕（004_quote_tick.sql）。面板「今日信号」展开分组时画那张走势图用。
 *
 * **它不是完整的分时。** 覆盖范围 = 应用开着的时段，而且取数失败那几轮不入库
 * （stale 快照是缓存重放，写进去会画出一条其实没有成交的平线）。
 * 所以 `points` **会有洞**：午休那段、以及用户当时没开机的那段。
 * 渲染层必须把洞画成断线并标注覆盖起点，**不许用直线连过去** ——
 * 那条斜线看着像分时线，但那段时间里什么都没被观测到。
 */
export interface IntradaySeries {
  code: SecCode
  /** 昨收，画基准线用。数据源没给时为 null —— 不要用 0 顶替（约束 4） */
  preClose: number | null
  /** 按 ts 升序，**可能有洞**（见上） */
  points: { ts: number; last: number }[]
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
  /**
   * 同一条裁决重复了几轮（006_alert_repeat.sql）。1 = 只发生过一次。
   *
   * 盘中每 30s 一轮都会对同一个持续中的信号造一次候选、被冷却挡一次，
   * 那不是 47 件事而是 1 件事持续了 47 轮 —— 记在同一行上，别在日志里刷 47 行。
   */
  repeatCount: number
  /** 最后一次重复的时刻。`repeatCount === 1` 时缺省 */
  lastAt?: number
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

// ─────────────────────── 影子运行（M4，docs/07 §2.3）───────────────────────

/** 影子组合里一个未平仓的模拟持仓 */
export interface ShadowOpenPosition {
  code: SecCode
  shares: number
  entryDate: TradeDate
  /** 不复权成交价（「我买在多少」） */
  entryPrice: number
  /** 最近一次收盘的前复权价（净值口径） */
  lastPrice: number
  /** 浮动盈亏，元。按前复权算，与净值同口径 */
  unrealized: number
  barsHeld: number
}

/** 影子组合里一笔已平仓的模拟交易。一行 = **一次卖出**（减仓会拆成多行） */
export interface ShadowTradeView {
  id: string
  code: SecCode
  name: string
  entryDate: TradeDate
  exitDate: TradeDate
  entryPrice: number
  exitPrice: number
  shares: number
  pnl: number
  pnlPct: number
  holdingBars: number
  regimeAtEntry: Regime
  /** 子信号 ID、风控规则 ID，或 `WATCHLIST_REMOVED`（移出自选而了结，不是信号让卖的） */
  exitRule: string
  partial: boolean
}

/**
 * 影子运行的绩效汇总。
 *
 * **`seasoned` 为 false 时，UI 不得出现任何正面宣称**（docs/07 §2.3、ADR-0003）：
 * 不许写「跑赢沪深300」「策略有效」「胜率不错」，只能并列数字并注明还在观察期。
 * 一条两周的净值曲线什么都不能证明，但它长得很像证据 —— 这是本项目最容易自欺的地方。
 *
 * 所有「算不出来」的字段一律 null，不用 0 顶替（约束 4 的同一条纪律）。
 */
export interface ShadowSummary {
  /** 尚未开始（还没有任何交易日）时为 null —— 「还没开始」与「持平」是两件事 */
  startedAt: number | null
  startedDate: TradeDate | null
  /** 已累积的交易日数 */
  bars: number
  /** 起点至今的自然日数 */
  calendarDays: number
  /** 已过观察期。false → UI 只能并列数字 */
  seasoned: boolean
  seasoningDays: number
  startCapital: number
  cash: number
  positionValue: number
  equity: number
  totalReturn: number
  /** 交易日不足时为 null */
  annualized: number | null
  maxDrawdown: number
  sharpe: number | null
  /** 同期沪深300 归一化收益；两端缺基准时为 null */
  benchmarkReturn: number | null
  /**
   * 平均资金占用率 0..1（逐日持仓市值 ÷ 当日净值的均值）。
   * **和 `benchmarkReturn` 一起读**：基准是满仓的，缺这个数会把超额读反（M2 §5.13）
   */
  exposure: number | null
  barsPerYear: number
  /** 逐笔口径（一行 = 一次卖出）。看止损止盈规则本身 */
  trades: {
    count: number
    winRate: number | null
    profitFactor: number | null
    weightedPnlPct: number | null
    avgHoldingBars: number | null
    totalPnl: number
    totalCosts: number
  }
  /** 建仓级口径（**用户口径**：一次出手最后赚不赚）。「提高胜率」该盯这一档 */
  entries: {
    count: number
    wins: number
    winRate: number | null
    avgPnl: number | null
    avgReturn: number | null
    payoffRatio: number | null
    /** 中途触发过减仓的建仓数 */
    reduced: number
  }
  open: ShadowOpenPosition[]
  /** 已挂待次日开盘成交的委托数 */
  pendingOrders: number
  /** 因现金池空了而没开的仓数 —— 静默跳过会让「信号密集期的收益」凭空消失 */
  skippedNoCash: number
  /** 因涨停买不到 / 跌停卖不掉而作废或顺延的次数 */
  limitBlocked: number
  engineVersion: string
  /**
   * 非空 = 账本里记的引擎版本与当前不一致，**推进已暂停**。
   * 继续累积会把两套参数的结果混进同一条曲线，而那条曲线不属于任何一套参数。
   */
  stalledEngineVersion: string | null
}

// ─────────────────────── 设置页（M4，docs/01 §5.5）───────────────────────

/**
 * 只读参数表的一行。**设置页不提供参数编辑**（2026-08-13 的取舍）。
 *
 * 理由是 ADR-0003：`params.ts` 里二十来个数值仍是未标定的转述猜测，
 * 让用户在没有回测依据的情况下改它们，只会更快地改出一套更差的参数，
 * 而排查路径是「用户改坏了 → 零信号 → 以为程序坏了」。
 * 可调的只有灵敏度三档（同样标注未标定）与提醒级别偏移。
 */
export interface ParamRow {
  /** 参数块，如 `combine` / `risk` */
  group: string
  key: string
  value: string
  /**
   * 标定状态。五档，对应 M2 验收清单 4.9 的归档位置：
   *   `CALIBRATED` 已标定并写回（**目前只有一项**）
   *   `KEPT`       已上网格、裁决保持出厂值
   *   `INERT`      已判参数惰性或算术无效（改了等于没改）
   *   `UNTESTABLE` 日线回测原理上测不到，依据只能来自影子运行或提醒日志
   *   `GUESS`      **一个网格都没跑过**的转述猜测
   *
   * `GUESS` 不是「大概对」的意思，是「没有任何本地证据」。UI 必须把这一档显式标出来 ——
   * 一张不分档的参数表会让整套数值看起来同等可信（ADR-0003 要防的正是这件事）。
   */
  status: 'CALIBRATED' | 'KEPT' | 'INERT' | 'UNTESTABLE' | 'GUESS'
  note?: string
}

/** 设置页「关于」块。免责声明全文由渲染层持有（DISCLAIMER），这里只给环境事实 */
export interface AboutInfo {
  appVersion: string
  electronVersion: string
  engineVersion: string
  schemaVersion: number
  /** market.db 所在目录（可被 dataDir 覆盖） */
  dataDir: string
  logDir: string
  backupDir: string
}

// ─────────────────────── AI 分析（P2，docs/08 §后续）───────────────────────

/**
 * AI 配置的**渲染层视图**。注意它与主进程存的东西不是一回事：
 * 明文 API key 只能单向流进主进程，**永远不回传**（见 `AiConfigPatch`）。
 *
 * 整块配置也不住在 `AppSettings` 里 —— `config:export` 会把设置原样写进用户选的
 * JSON 文件，key 放进去就等于跟着导出文件走。它单独落 `<数据目录>/ai.json`，
 * key 用 OS 凭据存储加密。
 */
/**
 * 接口协议。**不是「选厂商」，是「选路径形状」** —— 同一家可能两种都提供且路径不同
 * （火山方舟 `…/api/coding` 是 Anthropic、`…/api/coding/v3` 是 OpenAI 兼容）。
 * 填地址时会自动识别，识别结果显示在选择器上，可手动改回。
 */
export type AiProtocolName = 'openai' | 'anthropic'

export interface AiConfigView {
  enabled: boolean
  baseUrl: string
  protocol: AiProtocolName
  /**
   * 实际会 POST 到的完整地址，**由主进程用真正发请求的那段代码算出来**。
   * 不让渲染层自己拼：那样两处逻辑会各自演化，而这一行的全部价值就在于「所见即所发」。
   * 地址为空时是空串。
   */
  endpoint: string
  /**
   * 地址层面的风险提示（不是错误）。目前唯一一条：方舟编程套餐地址按官方说明
   * 只允许在 AI 编程工具里用，用在别处可能被判滥用。非空时界面必须显示。
   */
  advisory?: string
  model: string
  timeoutMs: number
  maxTokens: number
  /** 是否已保存 key。真值本身不回传 */
  hasKey: boolean
  /** 脱敏尾巴（如 `••••4f2a`），仅供用户确认「我存的是哪一把」 */
  keyHint?: string
  /**
   * OS 凭据加密是否可用。false → **拒绝保存 key**，功能整块不可用。
   * 退化成明文落盘是「看起来成功了」的那一类失败，不做。
   */
  encryptionAvailable: boolean
  /** 配置文件被修复或丢弃的字段，必须显示（不静默，docs/02 §7） */
  repaired: string[]
}

/** 配置补丁。缺省的键 = 不动 */
export interface AiConfigPatch {
  enabled?: boolean
  baseUrl?: string
  /** 缺省时按 `baseUrl` 自动识别；显式给了就用给的（那是用户的手动选择） */
  protocol?: AiProtocolName
  model?: string
  timeoutMs?: number
  maxTokens?: number
  /** 明文 key，单向流入。`null` = 清除已存的 key；缺省 = 保持不变 */
  apiKey?: string | null
}

/** 「测试连接」的结果。不抛错 —— 连不上是用户能看懂的正常结局 */
export interface AiTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/**
 * `ai:explain` 的即时返回。正文走 `push:aiChunk` 流式推送 ——
 * 一次 invoke 等 40 秒，界面上就是一个转不完的圈。
 */
export interface AiExplainStart {
  requestId: string
  /** 命中内存缓存时直接给全文，此时不会再有任何 `push:aiChunk` */
  cached?: string
}

/** 流式分片。`done` 与 `error` 互斥，二者之一到达即本次请求结束 */
export interface AiChunk {
  requestId: string
  delta?: string
  done?: boolean
  error?: string
}

// ─────────────────────── 观察点（AI 解读的失效条件落地）───────────────────────

/**
 * 观察点：**用户自己拥有的一次性盯盘条件**。
 *
 * 由 AI 解读的「失效条件」那一段给出建议 → 用户确认（可改数值）→ 引擎每轮机械比较
 * → 命中后走**正常的四道闸门**发提醒。触发时刻不涉及模型，判定是一次纯比较。
 *
 * **它不是策略参数。** `src/core/params.ts` 是引擎的、全局的、长期的，依据必须是本地
 * 回测标定（ADR-0003）；观察点是用户的、单标的、一次性、会过期，依据是「用户确认」。
 * 两者混在一起会污染设置页那张标定状态表。
 */
/**
 * 观察点上记的**方向结论**（005_watch_verdict.sql）。
 *
 * 它是「当时那条 AI 解读判的是什么方向」，由用户在表单里确认过 ——
 * **不是引擎的判断**，也不参与任何判定。它的用处是让一条到期未命中的观察点
 * 变成一个能读的结论：「当时判上涨，失效条件没出现」与
 * 「当时判下跌，失效条件没出现」是两件完全不同的事。
 */
export type WatchVerdict = 'UP' | 'DOWN' | 'RANGE'

export interface WatchPointView {
  id: string
  code: SecCode
  name: string
  /** 来源信号 id。命中提醒复用它当 alert_log 的外键 */
  signalId: string
  source: 'AI_SUGGESTED' | 'USER_EDITED'
  /** `PRICE` 或指标键（白名单见 src/main/watch/metrics.ts） */
  metric: string
  op: 'LTE' | 'GTE'
  threshold: number
  /** 命中意味着什么：原判断失效，还是得到确认 */
  meaning: 'INVALIDATE' | 'CONFIRM'
  note?: string
  /**
   * 建这个观察点时那条解读的**方向结论**，归一化后的值。
   * 认不出时**缺省**（`suggestion.ts` 的白名单归不了类就留空，绝不猜）——
   * 缺省不是错误，`verdictText` 里仍有原文。
   */
  verdict?: WatchVerdict
  /** 判断原文，最多 40 字。回答「当时到底是怎么说的」 */
  verdictText?: string
  createdAt: number
  expiresAt: number
  status: 'ACTIVE' | 'HIT' | 'EXPIRED' | 'CANCELED'
  hitAt?: number
  hitValue?: number
  /**
   * 非空 = 创建时的引擎版本与当前不一致，且这是个**指标类**观察点 ——
   * 换过灵敏度后 rsi 周期一类的东西变了，同一个阈值不再是同一件事。
   * PRICE 类不受影响，所以这里恒为空。
   */
  staleEngineVersion?: string
}

/** 新建观察点的入参。数值一律由用户确认后传入 —— 模型的建议只是表单预填值 */
export interface WatchPointDraft {
  signalId: string
  metric: string
  op: 'LTE' | 'GTE'
  threshold: number
  meaning: 'INVALIDATE' | 'CONFIRM'
  note?: string
  verdict?: WatchVerdict
  verdictText?: string
  /** 有效期天数。缺省按 20 个交易日折算 */
  days?: number
  /** true = 用户改过模型给的数值 */
  edited?: boolean
}

/**
 * 从一段 AI 解读里抽出来的观察点建议，用于**预填表单**。
 * 抽不到就是空数组 —— 那时表单留空让用户自己填，功能仍然可用。
 */
export interface WatchSuggestion {
  metric: string
  op: 'LTE' | 'GTE'
  threshold: number
  meaning: 'INVALIDATE' | 'CONFIRM'
  note?: string
  /** 归一化后的方向结论。整条解读只有一个，同一块里的每条建议都带上它 */
  verdict?: WatchVerdict
  verdictText?: string
}

/** 数据维护动作（清缓存 / 备份 / 选数据目录）的结果 */
export interface MaintenanceResult {
  status: 'DONE' | 'CANCELED' | 'FAILED'
  /** 给用户看的一句话结果，如「已清理 1832 条指标缓存」 */
  message: string
  /** 备份落盘路径 / 新数据目录 */
  path?: string
  /** true = 需要重启才生效（换数据目录） */
  needsRestart?: boolean
  error?: string
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
  /**
   * 当日分时留痕。**只在面板展开某个信号分组时才发** —— 列表平时零额外 IPC。
   * `to` 省略时取「现在」。
   */
  'quote:intraday': (query: { code: SecCode; from: number; to?: number }) => IntradaySeries
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
  /** 影子运行绩效（M4，docs/07 §2.3）。未开始时 `startedAt` 为 null */
  'shadow:summary': () => ShadowSummary
  'shadow:trades': (query: { limit?: number }) => ShadowTradeView[]
  /**
   * 清空影子账本并重新开始。**唯一的正当用途是引擎参数变了** ——
   * 丢掉的是一段无法重建的前向记录（用历史 K 线补出来的那个叫回测）。
   * 因此走系统确认框，不是一个点了就没的按钮。
   */
  'shadow:reset': () => MaintenanceResult
  /** 只读参数表（含每一项的标定状态）。设置页不提供参数编辑，见 ParamRow */
  'app:params': () => ParamRow[]
  /** 立刻备份 market.db（VACUUM INTO，可在运行中做）。返回落盘路径 */
  'app:backupDatabase': () => MaintenanceResult
  /** 清缓存：指标缓存 + 到期裁剪 + VACUUM。**不动** K 线、自选、持仓与影子账本 */
  'app:clearCache': () => MaintenanceResult
  /** 选一个新的数据目录（只影响 market.db，需要重启才生效） */
  'app:chooseDataDir': () => MaintenanceResult
  /** 在文件管理器里打开数据目录 / 日志目录 */
  'app:revealPath': (which: 'data' | 'logs' | 'backups') => void
  /** 版本、数据目录、日志目录、schema 版本 —— 设置页「关于」那一块 */
  'app:about': () => AboutInfo
  /** AI 配置（P2）。**返回值里没有明文 key**，只有 hasKey + 脱敏尾巴 */
  'ai:config': () => AiConfigView
  'ai:setConfig': (patch: AiConfigPatch) => AiConfigView
  /** 拿当前配置发一次最小请求验证连通性。不抛错，走 ok + message */
  'ai:test': () => AiTestResult
  /**
   * 对一条信号求 AI 解读。正文走 `push:aiChunk`。
   * **它是只读的解释层** —— 结果不回流到信号、闸门、状态点或影子运行。
   */
  'ai:explain': (signalId: string, force?: boolean) => AiExplainStart
  'ai:cancel': (requestId: string) => void
  /**
   * 观察点（P2 续）。`create` 的数值一律是**用户确认过**的 ——
   * 模型的建议只走到表单预填那一步，不会自己落库。
   */
  'watch:list': (query?: { status?: WatchPointView['status']; limit?: number }) => WatchPointView[]
  'watch:create': (draft: WatchPointDraft) => WatchPointView
  /**
   * 用户点「不盯了」：**直接删记录**，删之前弹系统确认框。
   * 返回 false = 用户在确认框里取消了，什么都没动。
   */
  'watch:remove': (id: string) => boolean
  /** 从一段解读正文里抽建议，用于预填表单。抽不到返回空数组 */
  'watch:suggest': (text: string) => WatchSuggestion[]
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
  /** AI 解读的流式分片（P2）。与提醒无关，不经过四道闸门 */
  'push:aiChunk': AiChunk
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
  /**
   * 灵敏度三档：得分线与票数线的松紧（`SENSITIVITY_PRESETS`，src/core/params.ts）。
   *
   * **这个字段到 2026-08-13 之前是死设置**（schema 里有、没人读），与 `autoLaunch`
   * 同一类问题。现在真的会重建引擎参数，因此改它会**递增引擎版本**：
   * 指标缓存作废重算，影子运行暂停（两套参数的绩效不可混）。
   * 三档本身**未标定** —— `BALANCED` 恰是出厂值，另两档一格网格都没跑过，
   * UI 上只能说「出信号更多 / 更少」，不许说「更准」。
   */
  sensitivity: 'SENSITIVE' | 'BALANCED' | 'CONSERVATIVE'
  alertLevelOffset: -1 | 0 | 1
  quietHours: { start: string; end: string }[]
  respectFullscreen: boolean
  /** 与 src/main/providers/types.ts 的 ProviderId 同集合（同一 union，跨层不引用） */
  providerPriority: ('eastmoney' | 'sina' | 'tencent')[]
  autoLaunch: boolean
  dataDir?: string
  /**
   * 用户确认免责声明的时刻（docs/01 §8 要求「须在应用内展示」）。
   *
   * 缺省 = 还没确认 → 面板显示首次启动引导，其余内容不可用。
   * 存**时刻**而不是布尔值：声明文本将来若实质性变更，可以按时间戳判断
   * 「他确认的是哪一版」，而 `true` 什么都答不了。
   */
  disclaimerAcceptedAt?: number
}
