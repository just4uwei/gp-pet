/**
 * AI 配置存储：`<用户数据目录>/ai.json`（P2）。
 *
 * ## 为什么不放进 settings.json
 *
 * `config:export` 把整份 `AppSettings` 写进用户选的 JSON 文件（settings/transfer.ts）。
 * API key 放进去就等于跟着导出文件走 —— 而导出文件的用途恰恰是「发给另一台机器」。
 * 所以 AI 配置**整块**住在自己的文件里，`AppSettings` / `AppSettingsSchema` /
 * `ConfigBundle` 一个字段都不加。
 *
 * ## 加密不可用时拒绝保存
 *
 * key 走 OS 凭据存储（Windows 下是 DPAPI）。`available()` 为 false 时**不写 key**，
 * 功能停用并明说原因。退化成明文落盘是「看起来成功了」的那一类失败 ——
 * 用户以为存好了，实际上 `%APPDATA%` 里躺着一把可以直接花钱的钥匙。
 *
 * 本模块不 import Electron：`SecretCrypto` 由调用方注入（生产实现见 secret-crypto.ts），
 * 于是「加密不可用」「密文解不开」这两条分支能写成用例，而不是靠改注册表试。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { AiConfigPatch, AiConfigView } from '@shared/ipc-types'
import type { AiConfig, AiConfigFile, SecretCrypto } from './types'
import { adapterOf, detectProtocol, endpointAdvisory } from './protocols'

export const AI_CONFIG_FILE = 'ai.json'

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  baseUrl: '',
  // 国内绝大多数服务是 OpenAI 兼容形状；填地址时会按 detectProtocol 自动纠正
  protocol: 'openai',
  model: '',
  // 一次解读要跑几十秒是常态；60s 是「还在生成」与「对面挂了」的分界
  timeoutMs: 60_000,
  maxTokens: 1200,
}

/**
 * base URL 校验。**允许 http** —— 本地 Ollama 是 `http://127.0.0.1:11434/v1`，
 * 禁掉它等于把最省钱的那条路堵死。明文 http 发 key 的风险在 client.ts 挡
 * （非回环地址 + http + 带 key = 拒发），那里才知道有没有 key。
 */
const BaseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    if (value === '') return true
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, '接口地址必须是 http(s) 开头的完整 URL')

const AiConfigSchema = z.object({
  enabled: z.boolean(),
  baseUrl: BaseUrlSchema,
  protocol: z.enum(['openai', 'anthropic']),
  model: z.string().trim().max(200),
  // 下限 5s：比这更短的超时会把正常的首字等待判成失败
  timeoutMs: z.number().int().min(5_000).max(600_000),
  maxTokens: z.number().int().min(128).max(32_000),
})

const AiConfigFileSchema = AiConfigSchema.extend({
  apiKeyEnc: z.string().min(1).optional(),
})

export interface SanitizeAiResult {
  config: AiConfigFile
  /** 被退回默认值的字段及原因，逐条回到界面上 —— 不静默（docs/02 §7） */
  repaired: string[]
}

/**
 * 逐字段校验：坏字段回默认值，好字段保留。
 * 与 `sanitizeSettings()` 同一取向 —— 一个手改坏的 maxTokens 不该让 base URL 一起丢。
 */
export function sanitizeAiConfig(raw: unknown): SanitizeAiResult {
  const repaired: string[] = []
  const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  if (raw !== undefined && !isObject) {
    repaired.push('(整份) ai.json 不是一个对象，已全部回到默认值')
  }
  const input = (isObject ? { ...(raw as object) } : {}) as Record<string, unknown>

  const config: AiConfigFile = { ...DEFAULT_AI_CONFIG }
  const shape = AiConfigSchema.shape

  for (const key of Object.keys(shape) as (keyof AiConfig)[]) {
    if (!(key in input)) continue
    const result = shape[key].safeParse(input[key])
    if (result.success) {
      ;(config as unknown as Record<string, unknown>)[key] = result.data
    } else {
      repaired.push(`${key}：${result.error.issues[0]?.message ?? '取值非法'}，已回到默认值`)
    }
  }

  if ('apiKeyEnc' in input) {
    const key = AiConfigFileSchema.shape.apiKeyEnc.safeParse(input.apiKeyEnc)
    if (key.success && key.data !== undefined) {
      config.apiKeyEnc = key.data
    } else if (input.apiKeyEnc !== undefined) {
      repaired.push('apiKeyEnc：密文字段不可读，已清除（需要重新填一次 API key）')
    }
  }

  return { config, repaired }
}

/** 归一化 base URL：去掉末尾斜杠，避免拼出 `/v1//chat/completions` */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 脱敏尾巴。只给最后 4 位，且长度不足 8 位时整把都不显示 ——
 * 一把 10 位的短 key 露出 4 位已经是四成信息量。
 */
export function keyHintOf(plain: string): string | undefined {
  if (plain.length < 8) return undefined
  return `••••${plain.slice(-4)}`
}

export class AiConfigStore {
  private current: AiConfigFile = { ...DEFAULT_AI_CONFIG }
  private repaired: string[] = []
  /** 解密后的 key 缓存。**只在主进程内存里**，任何 IPC 返回值都不含它 */
  private plainKey: string | null = null

  constructor(
    private readonly file: string,
    private readonly crypto: SecretCrypto,
    private readonly log: (message: string) => void = () => {}
  ) {}

  /** 读盘并修复。文件不存在是正常情况（从没配过），不报错也不落盘 */
  load(): AiConfigView {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        this.log(`[ai] 配置读取失败，使用默认值：${String(error)}`)
        this.repaired = ['ai.json 读取失败，已回到默认值']
      } else {
        this.repaired = []
      }
      this.current = { ...DEFAULT_AI_CONFIG }
      this.plainKey = null
      return this.view()
    }

    const { config, repaired } = sanitizeAiConfig(raw)
    this.current = config
    this.repaired = repaired
    for (const item of repaired) this.log(`[ai] ${item}`)

    this.plainKey = null
    if (config.apiKeyEnc !== undefined) {
      if (!this.crypto.available()) {
        // 不清掉密文：加密可能只是这一次不可用（换了会话、服务没起来），
        // 删了就要用户重新填一次。停用即可，等下次能解开
        this.repaired.push('系统凭据加密当前不可用，已保存的 API key 暂时读不出来')
      } else {
        try {
          this.plainKey = this.crypto.decrypt(config.apiKeyEnc)
        } catch (error) {
          this.log(`[ai] API key 解密失败：${String(error)}`)
          this.repaired.push('已保存的 API key 解不开（换过机器或用户账户？），请重新填写')
        }
      }
    }

    return this.view()
  }

  /** 主进程内部用。**不要**把它的返回值放进任何 IPC 响应 */
  apiKey(): string | null {
    return this.plainKey
  }

  config(): AiConfig {
    return {
      enabled: this.current.enabled,
      baseUrl: this.current.baseUrl,
      protocol: this.current.protocol,
      model: this.current.model,
      timeoutMs: this.current.timeoutMs,
      maxTokens: this.current.maxTokens,
    }
  }

  /** 已配置 = 开关打开 + 三样齐全。UI 据此决定要不要渲染 AI 按钮 */
  usable(): boolean {
    return (
      this.current.enabled &&
      normalizeBaseUrl(this.current.baseUrl) !== '' &&
      this.current.model.trim() !== '' &&
      this.plainKey !== null
    )
  }

  /**
   * 合并补丁 → 校验 → 落盘。非法字段被忽略（回到原值），返回最终生效的视图。
   *
   * **只改地址不改协议时会自动识别协议**（`detectProtocol`）。理由：同一家服务的两种
   * 协议往往只差一截路径（火山方舟 `…/api/coding` 是 Anthropic、`…/api/coding/v3` 是
   * OpenAI 兼容），用户从哪个页面复制的地址决定了他拿到哪条 —— 让他再手动去猜一次协议
   * 是没必要的。识别结果会显示在设置页的选择器上，用户看得见也改得回；
   * 补丁里**显式带了 `protocol` 时不覆盖**，那是用户的手动选择。
   */
  patch(patch: AiConfigPatch): AiConfigView {
    const { apiKey, ...rest } = patch
    if (rest.baseUrl !== undefined && rest.protocol === undefined) {
      rest.protocol = detectProtocol(rest.baseUrl)
    }
    const merged = { ...this.current, ...rest }
    const { config, repaired } = sanitizeAiConfig(merged)
    // 上一轮 load 的修复提示不该一直挂着：这一轮的结果覆盖它
    this.repaired = repaired
    for (const item of repaired) this.log(`[ai] 忽略非法补丁：${item}`)

    // 保留原密文；下面按 apiKey 的三态（缺省 / null / 字符串）决定怎么动它。
    // exactOptionalPropertyTypes 下「没有这个键」与「键值是 undefined」不等价，
    // 所以只在真的有密文时才写这个键
    if (this.current.apiKeyEnc !== undefined) config.apiKeyEnc = this.current.apiKeyEnc
    this.current = config

    if (apiKey === null) {
      delete this.current.apiKeyEnc
      this.plainKey = null
    } else if (typeof apiKey === 'string') {
      const trimmed = apiKey.trim()
      if (trimmed === '') {
        delete this.current.apiKeyEnc
        this.plainKey = null
      } else if (!this.crypto.available()) {
        // 硬拒绝，绝不明文落盘
        this.repaired.push('系统凭据加密不可用，拒绝保存 API key（不会以明文写入磁盘）')
        this.log('[ai] 系统凭据加密不可用，已拒绝保存 API key')
      } else {
        try {
          this.current.apiKeyEnc = this.crypto.encrypt(trimmed)
          this.plainKey = trimmed
        } catch (error) {
          this.repaired.push('API key 加密失败，未保存')
          this.log(`[ai] API key 加密失败：${String(error)}`)
        }
      }
    }

    this.save()
    return this.view()
  }

  save(): void {
    const tmp = join(dirname(this.file), `.${AI_CONFIG_FILE}.${process.pid}.tmp`)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      // 与 SettingsStore 同一取向：写不进去不该让应用停下来，内存里的值仍然生效
      this.log(`[ai] 写入失败：${String(error)}`)
    }
  }

  /** 渲染层视图。**这里是 key 不外泄的最后一道关口** */
  view(): AiConfigView {
    const view: AiConfigView = {
      enabled: this.current.enabled,
      baseUrl: this.current.baseUrl,
      protocol: this.current.protocol,
      // 用真正发请求的那段代码算，保证「所见即所发」
      endpoint:
        normalizeBaseUrl(this.current.baseUrl) === ''
          ? ''
          : adapterOf(this.current.protocol).endpoint(this.current.baseUrl),
      model: this.current.model,
      timeoutMs: this.current.timeoutMs,
      maxTokens: this.current.maxTokens,
      hasKey: this.plainKey !== null,
      encryptionAvailable: this.crypto.available(),
      repaired: [...this.repaired],
    }
    const hint = this.plainKey === null ? undefined : keyHintOf(this.plainKey)
    if (hint !== undefined) view.keyHint = hint
    const advisory = endpointAdvisory(this.current.baseUrl)
    if (advisory !== null) view.advisory = advisory
    return view
  }
}
