/**
 * 设置页的「AI 分析」块（P2，docs/08 §后续）。
 *
 * 四条克制，评审时按这四条看：
 *
 * 1. **明文 API key 只出不进。** 填进去之后界面上再也拿不回来，只显示
 *    `hasKey` + 脱敏尾巴。输入框留空 = 不改，点「清除」才是删。
 * 2. **系统凭据加密不可用时直接说清楚**，而不是让用户填完发现存不上。
 *    主进程在这种情况下**拒绝保存**（不会明文落盘），这里把原因摆出来。
 * 3. **文本框走 onBlur 提交**，不是 onChange —— 每敲一个字母 patch 一次会把
 *    ai.json 写穿，而且中途的半截 URL 会反复触发校验失败提示。
 * 4. **不吹功能。** 这一段的文案要说清它是外部模型、要花钱、可能出错，
 *    而不是「智能解读，更懂你的持仓」。
 */

import { useCallback, useEffect, useState } from 'react'
import type { AiConfigPatch, AiConfigView, AiTestResult } from '@shared/ipc-types'
import { Row, Section } from './Settings'

/** 常见 OpenAI 兼容端点，只作占位提示 —— 不预置、不推荐、不代填 */
const BASE_URL_PLACEHOLDER = 'https://api.deepseek.com/v1'

const PROTOCOLS: { value: AiConfigView['protocol']; label: string; detail: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI 兼容',
    detail: '发到 {地址}/chat/completions。DeepSeek、Kimi、智谱、通义、Ollama、OpenRouter 都是这一种',
  },
  {
    value: 'anthropic',
    label: 'Anthropic 兼容',
    detail: '发到 {地址}/v1/messages。火山方舟的 /api/coding（不带 /v3）与 Claude 官方接口是这一种',
  },
]

function TextRow({
  label,
  hint,
  value,
  placeholder,
  password,
  onCommit,
}: {
  label: string
  hint: string
  value: string
  placeholder?: string
  password?: boolean
  onCommit: (next: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  // 外部值变了（比如刚保存完）要跟上，否则输入框会停在旧值
  useEffect(() => setDraft(value), [value])

  return (
    <Row label={label} hint={hint}>
      <input
        type={password === true ? 'password' : 'text'}
        className="w-56 rounded border border-white/15 bg-black/25 px-2 py-1 font-mono text-[11px] outline-none focus:border-white/35"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </Row>
  )
}

export function AiSettings({
  onError,
  onChanged,
}: {
  onError: (message: string) => void
  /** 每次配置真的落盘后调用，让 App 重算「信号行要不要显示 AI 入口」 */
  onChanged: () => void
}): React.JSX.Element {
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [test, setTest] = useState<AiTestResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.gp
      .invoke('ai:config')
      .then(setConfig)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
  }, [onError])

  const patch = useCallback(
    (delta: AiConfigPatch): void => {
      setTest(null)
      void window.gp
        .invoke('ai:setConfig', delta)
        .then((next) => {
          setConfig(next)
          onChanged()
        })
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
    },
    [onError, onChanged]
  )

  if (!config) {
    return (
      <Section title="AI 分析">
        <p className="px-3.5 py-6 text-center text-[11px] text-white/35">读取中…</p>
      </Section>
    )
  }

  return (
    <Section title="AI 分析">
      <div className="border-b border-white/[0.06] px-3.5 py-3">
        <p className="text-[10px] leading-relaxed text-white/40">
          把本地已经算出来的指标、子信号与风控结论发给<span className="text-white/60">你自己配置的</span>
          模型接口，让它解释「为什么现在会出这个信号」。不配置就整块不启用，也不会有任何网络行为。
        </p>
        <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">
          三件事请先知道：调用按对方的计费规则花你自己的钱；模型可能出错甚至编造；
          它读到的只有本地这几项数据，没有基本面、没有消息面、没有实时资金流。
        </p>
      </div>

      {config.encryptionAvailable ? null : (
        <p className="mx-3.5 mt-3 rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200">
          系统凭据加密当前不可用，因此<span className="font-semibold">拒绝保存 API key</span>
          （不会以明文写进磁盘）。这一块暂时用不了。
        </p>
      )}

      {/* 地址层面的风险提示。这不是「配置错了」，是「用这个地址可能被封号」——
          比 repaired 那一档更要紧，所以排在它前面、用更重的颜色 */}
      {config.advisory === undefined ? null : (
        <p className="mx-3.5 mt-3 rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-rose-200">
          ⚠ {config.advisory}
        </p>
      )}

      {config.repaired.length > 0 ? (
        <ul className="mx-3.5 mt-3 space-y-1 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-100/80">
          {config.repaired.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : null}

      <Row
        label="启用 AI 解读"
        hint="关闭后信号列表里不再出现「AI 解读」按钮，已保存的配置保留"
      >
        {/* aria-label 是刻意的：设置页上有好几个「已关闭」按钮，
            没有它这个开关既不好读屏也不好定位（E2E 会撞上多个同名按钮） */}
        <button
          className="gp-btn"
          aria-label="启用 AI 解读"
          disabled={!config.encryptionAvailable}
          onClick={() => patch({ enabled: !config.enabled })}
        >
          {config.enabled ? '已开启' : '已关闭'}
        </button>
      </Row>

      <TextRow
        label="接口地址"
        hint={
          '填到 base URL 为止，末尾的 /chat/completions 或 /v1/messages 会自动补。' +
          '本机 Ollama 一类的 http 地址可以直接填；非本机地址必须用 https，否则会拒绝发送 key'
        }
        value={config.baseUrl}
        placeholder={BASE_URL_PLACEHOLDER}
        onCommit={(baseUrl) => patch({ baseUrl })}
      />

      {/* 协议不是「选厂商」而是「选路径形状」：同一家可能两种都提供且路径不同。
          填地址时自动识别，识别结果就显示在这里，用户看得见也改得回 */}
      <Row
        label="接口协议"
        hint="填完地址会自动识别。识别错了在这里改 —— 选错的症状是 401 / 404，或者「返回 200 但一个字都没有」"
      >
        {PROTOCOLS.map((item) => (
          <button
            key={item.value}
            className={`gp-btn ${config.protocol === item.value ? 'border-white/40 text-white' : ''}`}
            title={item.detail}
            onClick={() => patch({ protocol: item.value })}
          >
            {item.label}
          </button>
        ))}
      </Row>

      <p className="px-3.5 pb-2 text-[10px] leading-snug text-white/30">
        {PROTOCOLS.find((item) => item.value === config.protocol)?.detail}
        {config.endpoint === '' ? null : (
          <>
            <br />
            实际会发到：<span className="font-mono text-white/45">{config.endpoint}</span>
          </>
        )}
      </p>

      <TextRow
        label="模型名"
        hint="按对方文档填，如 deepseek-chat、glm-4-plus、qwen-plus。填错通常报 404"
        value={config.model}
        placeholder="deepseek-chat"
        onCommit={(model) => patch({ model })}
      />

      <Row
        label="API key"
        hint={
          config.hasKey
            ? `已保存（${config.keyHint ?? '••••'}）。输入框留空 = 不改；要换就直接填新的`
            : '存进来之后界面上再也读不回来，只会显示末尾四位。用系统凭据存储加密，不写明文'
        }
      >
        <input
          type="password"
          className="w-40 rounded border border-white/15 bg-black/25 px-2 py-1 font-mono text-[11px] outline-none focus:border-white/35"
          value={keyDraft}
          placeholder={config.hasKey ? '不改就留空' : 'sk-…'}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <button
          className="gp-btn"
          disabled={keyDraft.trim() === '' || !config.encryptionAvailable}
          onClick={() => {
            patch({ apiKey: keyDraft })
            setKeyDraft('')
          }}
        >
          保存
        </button>
        <button
          className="gp-btn"
          disabled={!config.hasKey}
          onClick={() => {
            patch({ apiKey: null })
            setKeyDraft('')
          }}
        >
          清除
        </button>
      </Row>

      <Row label="单次上限" hint="超时（秒）与最多生成的 token 数。解读控制在 400 字以内，1200 token 通常够">
        <input
          type="number"
          min={5}
          max={600}
          className="w-16 rounded border border-white/15 bg-black/25 px-2 py-1 text-right font-mono text-xs outline-none focus:border-white/35"
          value={Math.round(config.timeoutMs / 1000)}
          onChange={(e) => {
            const seconds = Number(e.target.value)
            if (Number.isInteger(seconds) && seconds >= 5 && seconds <= 600) {
              patch({ timeoutMs: seconds * 1000 })
            }
          }}
        />
        <span className="text-[11px] text-white/35">秒</span>
        <input
          type="number"
          min={128}
          max={32000}
          step={128}
          className="w-20 rounded border border-white/15 bg-black/25 px-2 py-1 text-right font-mono text-xs outline-none focus:border-white/35"
          value={config.maxTokens}
          onChange={(e) => {
            const tokens = Number(e.target.value)
            if (Number.isInteger(tokens) && tokens >= 128 && tokens <= 32_000) {
              patch({ maxTokens: tokens })
            }
          }}
        />
        <span className="text-[11px] text-white/35">token</span>
      </Row>

      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2">
          <button
            className="gp-btn"
            disabled={busy || config.baseUrl === '' || config.model === ''}
            onClick={() => {
              setBusy(true)
              setTest(null)
              void window.gp
                .invoke('ai:test')
                .then(setTest)
                .catch((err: unknown) =>
                  setTest({ ok: false, message: err instanceof Error ? err.message : String(err) })
                )
                .finally(() => setBusy(false))
            }}
          >
            {busy ? '测试中…' : '测试连接'}
          </button>
          <span className="text-[10px] text-white/30">会发一次极短的请求，费用可以忽略</span>
        </div>
        {test ? (
          <p
            className={`mt-2 rounded border px-2.5 py-2 text-[11px] leading-relaxed ${
              test.ok
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
            }`}
          >
            {test.message}
            {test.latencyMs === undefined ? '' : `（${test.latencyMs} ms）`}
          </p>
        ) : null}
      </div>
    </Section>
  )
}
