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
 * 当日分时（抽屉「行情」页那张走势图）。**两种来源，图上必须可分辨**：
 *
 * - `REMOTE` —— 数据源的逐分钟分时，09:30 起覆盖全天。用户打开抽屉时拉一次
 *   （带 30s 缓存，不进 tick 轮询，见 providers/types.ts fetchMinutes）。
 * - `LOCAL` —— 拉不到时退到本机留痕 `quote_tick`（004_quote_tick.sql）。
 *   它**不是完整的分时**：覆盖范围 = 应用开着的时段，取数失败那几轮还不入库
 *   （stale 快照是缓存重放，写进去会画出一条其实没有成交的平线）。
 *
 * 所以 `points` **两种来源都可能有洞**（REMOTE 是午休，LOCAL 还多了「当时没开机」）。
 * 渲染层一律把洞画成断线，**不许用直线连过去** —— 那条斜线看着像分时线，
 * 但那段时间里什么都没被观测到。而 `LOCAL` 还必须额外标注覆盖起点：
 * 一条半截曲线不许看起来像全天。
 */
export interface IntradaySeries {
  code: SecCode
  /**
   * 这串点属于哪个交易日（`YYYY-MM-DD`）。**可能不是今天** —— 休市日打开抽屉时
   * 数据源给的是上一个交易日那条曲线。渲染层按它推 x 轴并在文案里点名，
   * 默认当成今天画会得到一条日期错位、图上却完全看不出来的假曲线。
   * 一个点都没有时为 null。
   */
  tradeDate: TradeDate | null
  source: 'REMOTE' | 'LOCAL'
  /** 昨收，画基准线用。数据源没给时为 null —— 不要用 0 顶替（约束 4） */
  preClose: number | null
  /** 按 ts 升序，**可能有洞**（见上）。`avg` 是当日均价，`LOCAL` 一律 null，不插值补 */
  points: { ts: number; last: number; avg: number | null }[]
}

/**
 * 日 K 图的一根（`kline:daily`）。
 *
 * **价格是不复权的**，与用户的成交价、`position.cost` 同一口径（docs/03 §2.3）——
 * 用前复权画图的话价格轴与他在券商 App 上看到的、以及他自己填的成本价对不上。
 *
 * 代价写在这里，别在图上悄悄抹平：`ma20` / `ma60` 因此也是**画在不复权价上的展示线**，
 * 不是引擎用的那两条（引擎一律用前复权）。除权日不复权价会跳空，这两条线跟着跳 ——
 * **如实呈现，不做接续**。预热不足的那几根是 null，不是 0（约束 4）。
 */
export interface DailyBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  ma20: number | null
  ma60: number | null
}

/** 一笔成交（007_trade_log.sql）。BUY / SELL 是真实成交，OPENING 是迁移或导入补的期初建仓 */
export interface TradeView {
  id: string
  code: SecCode
  side: 'BUY' | 'SELL' | 'OPENING'
  /** 成交时刻（用户填的日期），不是录入时刻 */
  tradedAt: number
  price: number
  shares: number
  fee: number
  /** 卖出结转的已实现盈亏（含费）。买入与期初**缺省** —— 不是 0 */
  realized?: number
  note?: string
}

/** 某只票的账本视图（`trade:list`）。汇总在主进程算，避免渲染层再实现一遍口径 */
export interface TradeLedger {
  code: SecCode
  /** 按成交时刻**倒序**，新的在上 */
  trades: TradeView[]
  /** 已实现盈亏合计。一笔都没卖时是 0，这里的 0 是对的（就是没实现） */
  realizedTotal: number
  /** 手续费合计（含期初那笔的 0 —— 那个 0 是「不知道」，不是「没有」） */
  feeTotal: number
  /** 当前持仓；已清仓为 null */
  position: PositionView | null
}

/**
 * 录入前的试算（`trade:preview`）。
 *
 * **为什么走一趟 IPC 而不在渲染层算**：记账规则住在 `src/main/trades/ledger.ts`，
 * 而 `renderer → main` 是禁止的反向依赖（CLAUDE.md 的分层）。在渲染层照抄一份口径
 * 才是真正的坏选择 —— 症状会是「表单说成本变成 12.34，存完变成 12.31」，
 * 而用户没法判断哪个才对。一次本地纯函数调用的往返可以忽略不计。
 */
export interface TradePreview {
  /** 非空 = 这笔录不进去（超卖、数值非法），原样显示给用户；此时其余字段无意义 */
  error?: string
  fee: number
  amount: number
  /** 录入后的持仓；null = 清仓 */
  position: { shares: number; cost: number } | null
  /** 本笔已实现盈亏；买入为 null（**不是 0**） */
  realized: number | null
}

/** 录一笔成交。价格是**不复权真实成交价**，股数为正整数 */
export interface TradeDraft {
  code: SecCode
  side: 'BUY' | 'SELL'
  price: number
  shares: number
  /** 成交时刻。缺省取现在 */
  tradedAt?: number
  note?: string
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
  /**
   * 用户确认「接受这一段亏损」后重新画的止损线（009_position_stop.sql）。
   *
   * 有它时固定止损按「跌破这个价」判，而不是按 `risk.stopLossPct` 的百分比。
   * **界面上必须把它显示出来**：这是用户主动关掉了一个安全提醒的凭据，
   * 藏起来的话他日后只会觉得「跌了这么多怎么没提醒我」。
   * 缺省 = 没确认过，按出厂百分比走。
   */
  stopAck?: {
    stopFloor: number
    ackAt: number
    /** 确认时的浮亏百分比（负数）。「他当时接受的是多大一段」 */
    ackLossPct: number
  }
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

/**
 * 流式分片。`done` 与 `error` 互斥，二者之一到达即本次请求结束。
 *
 * `delta` 是**正文**，`thinking` 是模型的思考链 —— 两者**必须分开累积**：
 * 正文要落库、要抽观察点建议，把草稿混进去会让建议块解析错位，
 * 也会把「模型想到一半的话」当成结论存进历史。思考只实时显示，不入库。
 */
export interface AiChunk {
  requestId: string
  delta?: string
  /** 思考链增量。推理模型先想几十秒是常态，不显示的话用户分不出「在想」和「卡死」 */
  thinking?: string
  done?: boolean
  error?: string
}

/**
 * 一条已完成的 AI 解读（008_ai_explain.sql）。
 *
 * 下面那组信号字段（`direction` / `stage` / `score` / `priceAt` / `signalAt`）是
 * **落库时冗余存下来的快照**，不是 join 出来的：`signal` 按 2 年裁剪，而这张表永不裁剪，
 * 两年后原信号没了，历史列表要还能说出「哪天、什么方向、多少置信」。
 *
 * `model` / `protocol` 同理要显示出来 —— 换个模型再解读一次，结论不同是正常的，
 * 不标出来的话两条打架的解读会让人以为软件出了错。
 */
export interface AiExplainRecord {
  id: string
  signalId: string
  code: SecCode
  /** 发起时刻。列表按它倒序 —— 用户记得的是「我什么时候点的」 */
  createdAt: number
  elapsedMs: number
  text: string
  model: string
  protocol: 'openai' | 'anthropic'
  direction: GatedDirection
  stage: SignalStage
  score: number
  /** 拿不到时不给这个键 —— **不是 0**（约束 4） */
  priceAt?: number
  signalAt: number
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

/**
 * 一条日内做T建议（2026-08-14）。
 *
 * **它不是信号，也不是提醒**：不落 `signal` 表、不进 `alert_log`、不进回测与影子运行。
 * 判据、三条边界与「为什么阈值标不了」都在 `src/core/risk/intraday-t.ts` 的头注释里。
 */
export interface IntradayTHint {
  code: SecCode
  name: string
  /** 高抛（先卖后买）/ 低吸（先买，卖的是老仓那部分） */
  side: 'HIGH_SELL' | 'LOW_BUY'
  /** 现价在当日振幅中的位置 0..1 */
  position: number
  /** 当日振幅，相对昨收 */
  amplitude: number
  reason: string
}

// ─────────────────────────── 收盘日报 ───────────────────────────

/**
 * 一份收盘日报（2026-08-14）。判据在 `src/main/report/build.ts`（纯函数，有用例）。
 *
 * ## 它**只复述，不推导**
 *
 * 日报里必然有「明天该关注什么」，而那正是 `NEXT_DAY_WATCH` 信号在回答的问题。
 * 若日报自己去推导一份「明日关注」，就会出现两个来源、可能互相矛盾的结论，
 * **而用户没有办法判断该信哪个**。所以 `tomorrow` 一节的每一项都必须能指回
 * 一条已经存在的信号 / 观察点 / 风控裁决 —— 一个新结论都不产生。
 * 这与「观察点命中不写进 signal 表」「状态点只认闸门」是同一条纪律。
 *
 * ## 它不是提醒
 *
 * 不进 `alert_log`、不点亮状态点、不弹气泡。出口只有面板的「日报」页签。
 */
export interface DailyReport {
  date: TradeDate
  /**
   * `FINAL` = 每只有数据的标的都用上了当日**收盘线**；
   * `PROVISIONAL` = 至少有一只还在用盘中最后一个快照（当日日线尚未入库）。
   *
   * 这个区分不是洁癖：集合竞价会改收盘价，快照版与定稿版的数字对不上，
   * 而**用户看不出是哪个对**。界面必须把它显示出来。
   */
  stage: 'PROVISIONAL' | 'FINAL'
  /** 生成时刻（墙上时间），由调用方给 —— 判据本身不读时钟 */
  at: number
  overview: {
    watchCount: number
    /** 今日出现过**未静默**信号的只数 */
    withSignal: number
    /** 未静默信号的方向分布 */
    byDirection: { direction: GatedDirection; count: number }[]
    /** 有持仓的只数 */
    positions: number
    /** 跌破止损线的持仓数（含用户重画过线的） */
    belowStop: number
  }
  stocks: DailyReportStock[]
  alerts: {
    /** 真的发出去的条数 */
    delivered: number
    /** 被闸门挡下或降级的条数 */
    gated: number
    /** 被挡下的原因分布，多到少 */
    reasons: { reason: string; count: number }[]
  }
  tomorrow: DailyReportTomorrow[]
  data: {
    /** 当日收盘线已入库的只数 */
    withClose: number
    /** 当日既没有收盘线也没有快照的标的 —— 它们在报告里是「—」而不是 0 */
    missing: SecCode[]
  }
  /**
   * 几句**陈述**。刻意不叫「评价」：规则拼出来的句子只能陈述事实，
   * 真正的评价是 AI 那个按钮的事（措辞纪律：不得出现胜率/概率/必涨/抄底）。
   */
  highlights: string[]
}

export interface DailyReportStock {
  code: SecCode
  name: string
  industry?: string
  /** 拿不到行情时为 null —— 绝不用 0 占位（约束 4） */
  quote: {
    close: number
    changePct: number
    /** 当日振幅，相对昨收；拿不到昨收时为 null */
    amplitudePct: number | null
    open: number | null
    high: number | null
    low: number | null
    /** `CLOSE` = 当日收盘线；`SNAPSHOT` = 盘中最后一个快照（当日日线还没入库） */
    source: 'CLOSE' | 'SNAPSHOT'
  } | null
  signals: {
    total: number
    /** 未被风控硬抑制的条数 */
    actionable: number
    /** 当日**最后一条未静默**信号 —— 与悬浮条 tag 同一口径 */
    last: {
      direction: GatedDirection
      level: AlertLevel
      stage: SignalStage
      score: number
    } | null
    /** 当日被硬抑制的原因（去重），回答「它为什么没提醒我」 */
    suppressedReasons: string[]
  }
  position?: {
    shares: number
    cost: number
    /** 浮动盈亏百分比；拿不到现价时为 null */
    pnlPct: number | null
    /**
     * 距固定止损线还有多少（百分比，负数 = 已经跌破）。拿不到现价时为 null。
     * 用户重画过线（`stopAck`）时按他画的那条算 —— 那才是当前生效的判据。
     */
    toStopPct: number | null
    /** 用户确认接受过的那一段亏损，界面要显示（见 PositionView.stopAck） */
    stopFloor?: number
  }
  watch: { hit: number; expired: number; active: number }
}

/** 「明日关注」的一项。**每一项都指回一个已经存在的东西**（见 DailyReport 头注释） */
export interface DailyReportTomorrow {
  code: SecCode
  name: string
  /**
   * `NEXT_DAY_WATCH` 今日收盘给出的明日观察信号
   * `WATCH_POINT` 仍在盯的观察点（含明天到期的）
   * `POSITION_RISK` 未了结的持仓风控裁决（止损 / 减仓）
   */
  kind: 'NEXT_DAY_WATCH' | 'WATCH_POINT' | 'POSITION_RISK'
  /** 复述那条东西自己的说法，不另起一句结论 */
  note: string
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
   * 用户确认「接受这一段亏损」，把固定止损线顺延到 `stopFloor`（不复权绝对价）。
   *
   * 这是**主动关掉一个安全提醒**，所以：只换判据不取消提醒（跌破新线照样 L3）、
   * 只作用于固定止损（移动止损 / 回撤减仓 / 盈利保护照旧）、
   * 且随时可以 `position:clearStop` 撤销。见 009_position_stop.sql。
   */
  'position:acceptLoss': (code: SecCode, stopFloor: number) => PositionView | null
  /** 撤销上面那个确认，回到按 `risk.stopLossPct` 的出厂行为 */
  'position:clearStop': (code: SecCode) => PositionView | null
  /**
   * 当日分时。**只在用户打开抽屉「行情」页时才发** —— 列表平时零额外 IPC。
   * `to` 省略时取「现在」。
   *
   * 这条**会发一次网络请求**（主进程侧带 30s 缓存），是全应用唯一一处
   * 由用户交互直接触发取数的地方；轮询那份请求预算（docs/03 §2.4）不包含它，
   * 也不许反过来让 tick 去调它。
   */
  'quote:intraday': (query: { code: SecCode; from: number; to?: number }) => Promise<IntradaySeries>
  /** 日 K（不复权 + 展示用 MA）。`limit` 缺省 60 —— 抽屉里那张图就画这么多 */
  'kline:daily': (query: { code: SecCode; limit?: number }) => DailyBar[]
  /** 某只票的成交流水与盈亏汇总 */
  'trade:list': (query: { code: SecCode }) => TradeLedger
  /** 录入前试算。与 `trade:add` 走同一个 `applyTrade`，不许两处各算一遍 */
  'trade:preview': (draft: TradeDraft) => TradePreview
  /** 录一笔成交：追加流水 + 按加权平均更新持仓。参数非法时抛错，由渲染层显示 */
  'trade:add': (draft: TradeDraft) => TradeLedger
  /** 删一笔（录错了）。**按剩余流水重放重建持仓**，不做反向增量 */
  'trade:remove': (id: string) => TradeLedger
  /**
   * `perCode` = 每只标的最多取几条。**「今日信号」这类列表应当传它** ——
   * 全局 `limit` 会被单只刷屏的票吃光，而症状是「早上那批信号凭空不见了」，
   * 界面上完全看不出来（判据与实测见 `storage/repositories/signal.ts` 的 `SignalQuery.perCode`）。
   */
  'signal:history': (query: {
    code?: SecCode
    from?: number
    to?: number
    limit?: number
    perCode?: number
  }) => SignalRecord[]
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
   * 这只票的全部历史解读，**新的在上**（008_ai_explain.sql）。`limit` 缺省 100。
   *
   * 记录**永不自动裁剪**：它是花过钱、且重新生成还要再花一次钱的东西，
   * 删除只有 `ai:remove` 一条路。
   */
  'ai:history': (query: { code: SecCode; limit?: number }) => AiExplainRecord[]
  /**
   * 用户手动删一条解读。删之前**主进程弹系统确认框**（同 `watch:remove`）——
   * 删掉的是花过钱的东西，误点一下没有任何办法找回来。
   * 返回 false = 用户在确认框里取消了，什么都没动。
   */
  'ai:remove': (id: string) => boolean
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
  /**
   * 最近一个交易日的收盘日报。数据层没起来时返回 null（而不是一份空报告 ——
   * 「还没准备好」与「今天什么都没发生」是两件事）。
   *
   * **只有最近一个交易日**：`position` 是当前状态，拿它算历史那天的浮盈亏是错的，
   * 而错的方式用户看不出来（见 controller.dailyReport 的头注释）。
   */
  'report:daily': () => DailyReport | null
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
  /**
   * 鼠标是不是真的还压在悬浮条上（2026-08-14）。
   *
   * **只有主进程答得准。** 渲染层能可靠地判断「进入」（每次 mousemove 都在算命中区），
   * 但判断不了「离开」：鼠标移出窗口之后就再也没有 mousemove 了，而最后收到的那一次
   * 坐标仍然落在本体内。`document` 上的 mouseleave 在这个
   * `focusable: false` + `setIgnoreMouseEvents` 的窗口上并不可靠 ——
   * 于是「悬停暂停跑马灯」会永久卡在暂停态，而条子是常驻的，用户解不掉。
   *
   * 主进程按真实光标位置（`screen.getCursorScreenPoint()`）轮询裁决，false 即离开。
   */
  'push:overlayPointer': { over: boolean }
  /**
   * 本轮的日内做T建议（2026-08-14，判据在 `core/risk/intraday-t.ts`）。
   *
   * **每轮都推，没有建议时推空数组** —— 这一条不是随手写的：做T建议的时效只有
   * 几十分钟，价格一走开条件就不成立了。只在「有」的时候推，早上那条「可考虑高抛」
   * 会一直挂到收盘，而用户没有任何办法看出它已经过期。
   *
   * 它**不走提醒层**：不进 alert_log、不点亮状态点、不发气泡（那需要闸门，
   * 而闸门的冷却会让一条几十分钟时效的建议永远来不及）。出口只有面板与悬浮条。
   */
  'push:intradayT': IntradayTHint[]
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
