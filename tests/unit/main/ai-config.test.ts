/**
 * AI 配置存储（src/main/ai/config.ts）。
 *
 * 这个文件里有一把能直接花钱的钥匙，所以用例盯的是三件事，不是「存取能不能跑通」：
 *
 *   1. **明文 key 绝不出现在渲染层视图里**（`view()` 是最后一道关口）
 *   2. **系统凭据加密不可用时拒绝保存**，而不是退化成明文落盘 ——
 *      那是「看起来成功了」的那一类失败，用户以为存好了，实际 %APPDATA% 里躺着裸 key
 *   3. **明文 key 绝不出现在磁盘文件里**（读回落盘内容逐字搜）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_CONFIG_FILE, AiConfigStore, DEFAULT_AI_CONFIG, sanitizeAiConfig } from '@main/ai/config'
import type { SecretCrypto } from '@main/ai/types'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gp-ai-'))
  dirs.push(dir)
  return join(dir, AI_CONFIG_FILE)
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/** 可用的假加密：base64 反转，足够验证「落盘的不是明文」 */
function fakeCrypto(available = true): SecretCrypto {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64'),
    decrypt: (b64) => [...Buffer.from(b64, 'base64').toString('utf8')].reverse().join(''),
  }
}

const SECRET = 'sk-test-abcdefghijklmnop-4f2a'

describe('AiConfigStore', () => {
  it('明文 key 不出现在渲染层视图里 —— 只有 hasKey 与脱敏尾巴', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    const view = store.patch({ apiKey: SECRET })

    expect(view.hasKey).toBe(true)
    expect(view.keyHint).toBe('••••4f2a')
    // 整份视图序列化后都不许出现明文
    expect(JSON.stringify(view)).not.toContain(SECRET)
    // 主进程内部仍拿得到（发请求要用）
    expect(store.apiKey()).toBe(SECRET)
  })

  it('明文 key 不出现在磁盘文件里', () => {
    const file = tempFile()
    const store = new AiConfigStore(file, fakeCrypto())
    store.load()
    store.patch({ apiKey: SECRET })

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(SECRET)
    expect(raw).toContain('apiKeyEnc')
  })

  it('加密不可用时**拒绝保存**，不退化成明文落盘', () => {
    const file = tempFile()
    const store = new AiConfigStore(file, fakeCrypto(false))
    store.load()
    const view = store.patch({ apiKey: SECRET })

    expect(view.hasKey).toBe(false)
    expect(view.encryptionAvailable).toBe(false)
    expect(view.repaired.join('')).toContain('拒绝保存')
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    expect(store.apiKey()).toBeNull()
  })

  it('落盘后重新读回来，key 解得开', () => {
    const file = tempFile()
    const first = new AiConfigStore(file, fakeCrypto())
    first.load()
    first.patch({ apiKey: SECRET, baseUrl: 'https://example.com/v1', model: 'm', enabled: true })

    const second = new AiConfigStore(file, fakeCrypto())
    const view = second.load()
    expect(view.hasKey).toBe(true)
    expect(second.apiKey()).toBe(SECRET)
    expect(second.usable()).toBe(true)
  })

  it('密文解不开时留一条提示，但**不清掉密文** —— 可能只是这一次读不出来', () => {
    const file = tempFile()
    const first = new AiConfigStore(file, fakeCrypto())
    first.load()
    first.patch({ apiKey: SECRET })

    const broken: SecretCrypto = {
      available: () => true,
      encrypt: () => 'x',
      decrypt: () => {
        throw new Error('DPAPI: 换过 Windows 账户')
      },
    }
    const second = new AiConfigStore(file, broken)
    const view = second.load()

    expect(view.hasKey).toBe(false)
    expect(view.repaired.join('')).toContain('解不开')
    expect(readFileSync(file, 'utf8')).toContain('apiKeyEnc')
  })

  it('apiKey 三态：缺省不动、null 清除、字符串覆盖', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    store.patch({ apiKey: SECRET })

    // 缺省：改别的字段不该把 key 带没了
    expect(store.patch({ model: 'deepseek-chat' }).hasKey).toBe(true)
    // null：清除
    expect(store.patch({ apiKey: null }).hasKey).toBe(false)
    expect(store.apiKey()).toBeNull()
  })

  it('usable() 要求开关 + 三样齐全 —— 少一样就不渲染 AI 按钮', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    expect(store.usable()).toBe(false)

    store.patch({ enabled: true, baseUrl: 'https://example.com/v1' })
    expect(store.usable()).toBe(false) // 缺 model 与 key

    store.patch({ model: 'm' })
    expect(store.usable()).toBe(false) // 缺 key

    store.patch({ apiKey: SECRET })
    expect(store.usable()).toBe(true)

    store.patch({ enabled: false })
    expect(store.usable()).toBe(false)
  })

  it('文件不存在是正常情况：回默认值、不报错、不落盘', () => {
    const file = tempFile()
    const view = new AiConfigStore(file, fakeCrypto()).load()
    expect(view.enabled).toBe(false)
    expect(view.repaired).toEqual([])
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('文件被改坏：坏字段回默认值，好字段保留，逐条留痕', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({ enabled: true, baseUrl: 'not a url', model: 'glm-4-plus', maxTokens: 9 }),
      'utf8'
    )
    const view = new AiConfigStore(file, fakeCrypto()).load()

    expect(view.enabled).toBe(true) // 好字段保留
    expect(view.model).toBe('glm-4-plus')
    expect(view.baseUrl).toBe('') // 坏字段回默认
    expect(view.maxTokens).toBe(DEFAULT_AI_CONFIG.maxTokens)
    expect(view.repaired).toHaveLength(2)
  })

  /**
   * 出厂 maxTokens 曾是 1200，而那个额度是**思考链与正文共用**的 ⇒ 带思考链的模型上
   * 常见结果是「只有思考、没有正文」（client.ts 那条报错）。下限抬到 2048 之后，
   * 改动前存下的 1200 必须被抬到默认值 **且留下一条可见提示**：
   * 悄悄改掉用户填过的数，与「给小了没有正文」是同一类查不清的问题。
   */
  it('改动前存下的 maxTokens = 1200 被抬到默认值，并留一条可见提示', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        enabled: true,
        baseUrl: 'https://api.deepseek.com/v1',
        protocol: 'openai',
        model: 'deepseek-chat',
        timeoutMs: 60_000,
        maxTokens: 1200,
      }),
      'utf8'
    )
    const view = new AiConfigStore(file, fakeCrypto()).load()

    expect(view.maxTokens).toBe(DEFAULT_AI_CONFIG.maxTokens)
    expect(view.repaired).toHaveLength(1)
    expect(view.repaired[0]).toContain('maxTokens')
    // 其余字段一个都不受影响
    expect(view.enabled).toBe(true)
    expect(view.model).toBe('deepseek-chat')
    expect(view.timeoutMs).toBe(60_000)
  })
})

describe('协议识别', () => {
  it('只填地址时自动识别协议 —— 用户不该再手动猜一次', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()

    // 火山方舟 coding 路径不带 /v3 → Anthropic
    expect(store.patch({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }).protocol).toBe(
      'anthropic'
    )
    // 带 /v3 → OpenAI 兼容
    expect(
      store.patch({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' }).protocol
    ).toBe('openai')
  })

  /**
   * 真实回归：加 `protocol` 字段之前写下的 ai.json 是没有这个键的
   * （本机 `%APPDATA%/gp-pet/ai.json` 就是这个形状）。
   * 它必须**静默**升级成默认协议 —— 冒一条「已回到默认值」的告警会让用户以为配置坏了。
   */
  it('旧版 ai.json（没有 protocol 键）静默升级为 openai，不冒告警', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        enabled: true,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        timeoutMs: 60_000,
        // 刻意用当前合法值：这条用例盯的是「缺 protocol 键要静默升级」，
        // 掺一条 maxTokens 的修复提示会让 repaired 断言表达两件事
        maxTokens: 4096,
      }),
      'utf8'
    )
    const view = new AiConfigStore(file, fakeCrypto()).load()

    expect(view.protocol).toBe('openai')
    expect(view.repaired).toEqual([])
    expect(view.model).toBe('deepseek-chat')
    expect(view.endpoint).toBe('https://api.deepseek.com/v1/chat/completions')
  })

  /**
   * 方舟编程套餐的额度按官方说明**只允许在 AI 编程工具里用**，
   * 拿它做别的 API 调用可能被判滥用（订阅停用甚至封号）。
   * 本应用不是编程工具 —— 这条提示必须能到界面上，不能只写在文档里。
   */
  it('填了方舟编程套餐地址时给出封号风险提示', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()

    for (const url of [
      'https://ark.cn-beijing.volces.com/api/coding',
      'https://ark.cn-beijing.volces.com/api/coding/v3',
      'https://ark.cn-beijing.volces.com/api/plan',
    ]) {
      const view = store.patch({ baseUrl: url })
      expect(view.advisory, url).toContain('封禁')
      expect(view.advisory, url).toContain('/api/v3')
    }
  })

  it('通用接口与其他服务不给这条提示 —— 提示滥用会让人无视它', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    expect(store.patch({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }).advisory).toBeUndefined()
    expect(store.patch({ baseUrl: 'https://api.deepseek.com/v1' }).advisory).toBeUndefined()
  })

  it('endpoint 由主进程算，与真正发出去的地址同源', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    expect(store.view().endpoint).toBe('') // 没填地址时是空串，不是拼出个坏 URL
    expect(store.patch({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }).endpoint).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages'
    )
  })

  it('补丁里显式带了 protocol 就不覆盖 —— 那是用户的手动选择', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    const view = store.patch({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      protocol: 'openai',
    })
    expect(view.protocol).toBe('openai')
  })

  it('只改协议不改地址时，地址不动', () => {
    const store = new AiConfigStore(tempFile(), fakeCrypto())
    store.load()
    store.patch({ baseUrl: 'https://api.deepseek.com/v1' })
    const view = store.patch({ protocol: 'anthropic' })
    expect(view.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(view.protocol).toBe('anthropic')
  })
})

describe('sanitizeAiConfig', () => {
  it('整份不是对象时全部回默认值并留痕', () => {
    const { config, repaired } = sanitizeAiConfig('[]')
    expect(config.enabled).toBe(false)
    expect(repaired[0]).toContain('不是一个对象')
  })

  it('允许 http 本机地址 —— 本地 Ollama 是 http://127.0.0.1:11434/v1', () => {
    const { config, repaired } = sanitizeAiConfig({ baseUrl: 'http://127.0.0.1:11434/v1' })
    expect(config.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(repaired).toEqual([])
  })
})
