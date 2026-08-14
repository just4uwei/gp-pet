/**
 * AI 分析接入（P2，docs/08 §后续）。
 *
 * 形状：本地引擎算完 → 结构化上下文 → **用户自己配置**的模型接口 → 流式解释。
 * 不配置就整块不存在：按钮不渲染、无任何网络行为。
 *
 * 五件必须记住的事：
 *
 * 1. **它是只读的解释层。** 结果不回流到信号、闸门、状态点或影子运行。
 * 2. **API key 不进 `AppSettings`。** `config:export` 会把设置整份写进用户选的文件。
 * 3. **不复用 `net/http.ts`。** 那个限流器与行情取数共用，40 秒的 LLM 调用会饿死 tick。
 * 4. **上下文必须带参数标定状态。** 否则模型会给一套未标定的转述阈值背书。
 * 5. **支持两种协议**（OpenAI 兼容 / Anthropic 兼容），差异只有四个点，全在 `protocols.ts`。
 *    协议是**按路径形状**选的不是按厂商选的 —— 同一家可能两条路都提供且形状不同
 *    （火山方舟 `…/api/coding` 是 Anthropic、`…/api/coding/v3` 是 OpenAI 兼容）。
 */

export { AiError, createAiClient, createUndiciAiTransport } from './client'
export type { AiClient } from './client'
export { AI_CONFIG_FILE, AiConfigStore, DEFAULT_AI_CONFIG, sanitizeAiConfig } from './config'
export { buildSignalContext, renderContext } from './context'
export { AI_SYSTEM_PROMPT, FORBIDDEN_WORDS } from './prompt'
export { ANTHROPIC_ADAPTER, OPENAI_ADAPTER, adapterOf, detectProtocol, protocolHint } from './protocols'
export type { AiDelta, ProtocolAdapter } from './protocols'
export { electronSecretCrypto } from './secret-crypto'
export { createAiService } from './service'
export type { AiHistorySink, AiService } from './service'
export type { AiConfig, AiProtocol, AiSignalContext, AiTransport, SecretCrypto } from './types'
