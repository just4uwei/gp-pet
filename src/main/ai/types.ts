/**
 * AI 分析接入的主进程内部类型（docs/08 §后续 P2）。
 *
 * 渲染层看到的形状在 `@shared/ipc-types`（`AiConfigView` / `AiConfigPatch` / `AiChunk`），
 * 这里是主进程自己用的：落盘形状、传输层契约、上下文结构。
 *
 * 本文件零运行时依赖，也不 import Electron —— 与 `settings/transfer.ts` 同一取向，
 * 好让配置解析与上下文构造能在 Vitest 里直接跑。
 */

/**
 * 接口协议。两者只差四个点（路径 / 鉴权头 / system 放哪 / 增量字段），
 * 逐条见 `protocols.ts`。
 *
 * 同一家服务可能两种都提供且**路径不同** —— 火山方舟 `…/api/coding` 是 Anthropic，
 * `…/api/coding/v3` 是 OpenAI 兼容。所以这不是「选一个厂商」，是「选一条路径的形状」。
 */
export type AiProtocol = 'openai' | 'anthropic'

/** 落盘的非密字段。API key 单独存（加密），不在这里 */
export interface AiConfig {
  enabled: boolean
  /**
   * base URL。**不含**末尾的 `/chat/completions` 或 `/v1/messages`（拼上去的时候会判重）。
   * 例：`https://api.deepseek.com/v1`（OpenAI）、
   * `https://ark.cn-beijing.volces.com/api/coding`（Anthropic）。
   */
  baseUrl: string
  protocol: AiProtocol
  model: string
  /** 单次请求的总超时。首字超时另算（见 client.ts） */
  timeoutMs: number
  maxTokens: number
}

/** ai.json 的完整形状：非密字段 + 加密后的 key */
export interface AiConfigFile extends AiConfig {
  /** `safeStorage.encryptString()` 的 base64。缺省 = 没存过 key */
  apiKeyEnc?: string
}

/**
 * OS 凭据加密。抽成接口是为了可测 —— `safeStorage` 只有 Electron 里才有，
 * 而「加密不可用时拒绝保存」这条恰恰是最需要用例钉住的分支。
 */
export interface SecretCrypto {
  available(): boolean
  /** 明文 → base64 密文 */
  encrypt(plain: string): string
  /** base64 密文 → 明文。解不开时抛错（调用方按「key 已失效」处理） */
  decrypt(cipherB64: string): string
}

// ─────────────────────────── 传输层 ───────────────────────────

/**
 * 一次流式 POST。抽成接口的理由与 `net/http.ts` 的 `Transport` 相同：
 * provider 与重试逻辑的测试不该发真请求。
 *
 * **但实现不共用** —— `net/http.ts` 只有 get()、默认 3s 超时，
 * 而且它的限流器与行情取数共用。把一次 40 秒的 LLM 调用挂上去会把 tick 饿死。
 */
export type AiTransport = (request: AiHttpRequest) => Promise<AiHttpResponse>

export interface AiHttpRequest {
  url: string
  headers: Record<string, string>
  body: string
  signal: AbortSignal
}

export interface AiHttpResponse {
  status: number
  /** UTF-8 文本分片流。非 2xx 时也要能读出错误体，否则报不出原因 */
  chunks: AsyncIterable<string>
}

// ─────────────────────────── 上下文 ───────────────────────────

/**
 * 发给模型的结构化上下文。
 *
 * **`calibration` 那一块是这个设计里最重要的一行。** 缺了它，模型会默认引擎结论
 * 是经过验证的，然后用很有说服力的语气转述一套没人验证过的阈值（ADR-0003 要防的正是这件事）。
 */
export interface AiSignalContext {
  security: { code: string; name: string }
  /** 触发时刻的墙上时间字符串，由调用方格式化后传入（本模块不读时钟） */
  at: string
  quote: { price: number; changePct: number | null }
  verdict: {
    direction: string
    /** 0..1。文案里只能叫「置信度」 */
    score: number
    votes: number
    regime: string
    stage: string
    level: string
  }
  subSignals: { id: string; label: string; direction: string; score: number; weight: number }[]
  adjustments: { id: string; label: string; delta: number }[]
  indicators: Record<string, number>
  /** 提醒闸门的结论：有没有真的发出去，被哪道闸门挡的 */
  gate: { delivered: boolean; reason?: string }
  position?: { shares: number; cost: number; pnlPct: number | null }
  calibration: {
    engineVersion: string
    calibrated: number
    kept: number
    inert: number
    untestable: number
    /** 已上网格，但出厂值自己被红线淘汰 ⇒ 裁决只能是 INCONCLUSIVE（M2 §5.20 ⑨） */
    blocked: number
    guess: number
    /** 已标定并写回的参数名，逐个列出 —— 目前只有一项 */
    calibratedKeys: string[]
  }
}
