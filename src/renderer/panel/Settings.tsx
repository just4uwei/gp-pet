/**
 * 设置页全项（docs/01 §5.5、docs/08 M4）。
 *
 * 清单里的每一项都在：轮询频率、灵敏度三档、静默时段、开机自启、
 * 数据源优先级、数据目录、清理缓存 —— 外加只读参数表、手动备份与「关于」。
 *
 * ## 三条与别的设置页不一样的地方
 *
 * 1. **改灵敏度会弹一句代价说明。** 换档 = 换一套引擎参数：指标缓存作废重算，
 *    影子运行暂停累积。这两件事都不可逆（影子记录无法重建），所以不能像调音量
 *    那样静默生效 —— 用户得先知道要付什么。
 * 2. **参数表只读，且每一行标着标定状态。** 见 `ParamRow` 与 params-view.ts：
 *    一张不分档的参数表会让二十来个未标定的转述猜测看起来同等可信。
 * 3. **「清缓存」写清了它不动什么。** K 线、自选、持仓、影子记录都不动 ——
 *    别的软件的「清缓存」常常顺手清掉一切，而这里有两样东西删了就回不来。
 *
 * 落盘时机：**每一项改完立刻 patch**，没有「保存」按钮。设置只有九项且都是单值，
 * 攒着批量提交只会多出一个「改了没保存就关窗口」的失败模式。
 */

import { useCallback, useEffect, useState } from 'react'
import type {
  AboutInfo,
  AppSettings,
  MaintenanceResult,
  ParamRow,
} from '@shared/ipc-types'
import { DISCLAIMER } from './disclaimer'
import { AiSettings } from './AiSettings'

type Provider = AppSettings['providerPriority'][number]

const SENSITIVITY: { value: AppSettings['sensitivity']; label: string; detail: string }[] = [
  // 措辞纪律：三档都未标定，只能说「出信号多少」，不许说「更准」或「更稳」
  { value: 'SENSITIVE', label: '灵敏', detail: '得分线 0.50 · 票数 2/2 —— 信号最多，误报也最多' },
  { value: 'BALANCED', label: '均衡', detail: '得分线 0.60 · 票数 3/2 —— 出厂档位' },
  { value: 'CONSERVATIVE', label: '保守', detail: '得分线 0.72 · 票数 4/3 —— 信号最少' },
]

const LEVEL_OFFSET: { value: AppSettings['alertLevelOffset']; label: string }[] = [
  { value: -1, label: '整体降一档' },
  { value: 0, label: '按规则' },
  { value: 1, label: '整体升一档' },
]

const PROVIDER_LABEL: Record<Provider, string> = {
  eastmoney: '东方财富',
  sina: '新浪',
  tencent: '腾讯',
}

const STATUS_LABEL: Record<ParamRow['status'], { text: string; cls: string }> = {
  CALIBRATED: { text: '已标定', cls: 'bg-emerald-500/15 text-emerald-300' },
  KEPT: { text: '已测·保持', cls: 'bg-sky-500/15 text-sky-300' },
  INERT: { text: '惰性', cls: 'bg-white/10 text-white/40' },
  UNTESTABLE: { text: '回测测不到', cls: 'bg-violet-500/15 text-violet-300' },
  GUESS: { text: '未测', cls: 'bg-amber-500/15 text-amber-300' },
}

export function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border-b border-white/[0.06] px-3.5 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-white/75">{label}</div>
          {hint ? <div className="mt-0.5 text-[10px] leading-snug text-white/35">{hint}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{children}</div>
      </div>
    </div>
  )
}

export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="gp-card">
      <div className="gp-card-head">
        <h2 className="gp-card-title">{title}</h2>
      </div>
      <div>{children}</div>
    </section>
  )
}

function Toggle({
  on,
  onChange,
  labels,
}: {
  on: boolean
  onChange: (next: boolean) => void
  labels: [string, string]
}): React.JSX.Element {
  return (
    <button className="gp-btn" onClick={() => onChange(!on)}>
      {on ? labels[0] : labels[1]}
    </button>
  )
}

function QuietHours({
  hours,
  onChange,
}: {
  hours: AppSettings['quietHours']
  onChange: (next: AppSettings['quietHours']) => void
}): React.JSX.Element {
  const [start, setStart] = useState('12:00')
  const [end, setEnd] = useState('13:00')
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(end)

  return (
    <div className="border-b border-white/[0.06] px-3.5 py-3 last:border-b-0">
      <div className="text-xs text-white/75">静默时段</div>
      <div className="mt-0.5 text-[10px] leading-snug text-white/35">
        这些时段内一律不弹气泡（状态点照常）。跨午夜可以直接写 23:00 → 07:00
      </div>

      {hours.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {hours.map((range, i) => (
            <li key={`${range.start}-${range.end}-${i}`} className="gp-chip text-white/60">
              {range.start} → {range.end}
              <button
                className="ml-1 text-white/35 hover:text-rose-300"
                title="删除"
                onClick={() => onChange(hours.filter((_, index) => index !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[11px] text-white/30">没有静默时段。</p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <input
          className="w-20 rounded border border-white/15 bg-black/25 px-2 py-1 font-mono text-xs outline-none focus:border-white/35"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          placeholder="HH:MM"
        />
        <span className="text-white/30">→</span>
        <input
          className="w-20 rounded border border-white/15 bg-black/25 px-2 py-1 font-mono text-xs outline-none focus:border-white/35"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          placeholder="HH:MM"
        />
        <button
          className="gp-btn"
          disabled={!valid}
          onClick={() => onChange([...hours, { start, end }])}
        >
          添加
        </button>
      </div>
    </div>
  )
}

function ParamsTable(): React.JSX.Element {
  const [rows, setRows] = useState<ParamRow[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open || rows !== null) return
    void window.gp.invoke('app:params').then(setRows)
  }, [open, rows])

  const counts = (rows ?? []).reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs text-white/75">策略参数（只读）</div>
          <div className="mt-0.5 text-[10px] leading-snug text-white/35">
            设置页不提供参数编辑：这些数值绝大多数是公开资料的转述，还没有本地回测依据，
            改成另一个同样没有依据的值不会更好，但会让「怎么一条信号都不出」变得很难查。
          </div>
        </div>
        <button className="gp-btn" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
        </button>
      </div>

      {open ? (
        rows === null ? (
          <p className="mt-2 text-[11px] text-white/35">读取中…</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(Object.keys(STATUS_LABEL) as ParamRow['status'][]).map((status) => (
                <span
                  key={status}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${STATUS_LABEL[status].cls}`}
                >
                  {STATUS_LABEL[status].text} {counts[status] ?? 0}
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-white/30">
              真正被标定过并写回的只有「已标定」那一档。「已测·保持」是上过网格但结论是保持原值；
              「惰性」是改了等于没改；「回测测不到」的依据只能来自影子运行或提醒日志。
            </p>
            <ul className="mt-2 max-h-72 overflow-y-auto rounded border border-white/10">
              {rows.map((row) => (
                <li
                  key={`${row.group}.${row.key}`}
                  className="border-b border-white/[0.06] px-2.5 py-1.5 last:border-b-0"
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="w-40 shrink-0 truncate font-mono text-white/50">
                      {row.group}.{row.key}
                    </span>
                    <span className="w-24 shrink-0 truncate font-mono text-white/80">{row.value}</span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${STATUS_LABEL[row.status].cls}`}
                    >
                      {STATUS_LABEL[row.status].text}
                    </span>
                  </div>
                  {row.note ? (
                    <p className="mt-0.5 pl-1 text-[10px] leading-snug text-white/30">{row.note}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </div>
  )
}

export function Settings({ onError }: { onError: (message: string) => void }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [about, setAbout] = useState<AboutInfo | null>(null)
  const [notice, setNotice] = useState<MaintenanceResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void window.gp.invoke('settings:get').then(setSettings)
    void window.gp.invoke('app:about').then(setAbout)
  }, [])

  const patch = useCallback(
    (delta: Partial<AppSettings>): void => {
      void window.gp
        .invoke('settings:patch', delta)
        .then((next) => {
          setSettings(next)
          // 灵敏度换档会重建引擎 → 引擎版本变了，「关于」那一块得跟上
          void window.gp.invoke('app:about').then(setAbout)
        })
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
    },
    [onError]
  )

  const maintenance = useCallback(
    (channel: 'app:backupDatabase' | 'app:clearCache' | 'app:chooseDataDir', label: string): void => {
      setBusy(label)
      setNotice(null)
      void window.gp
        .invoke(channel)
        .then((result) => {
          setNotice(result)
          if (result.status === 'DONE') void window.gp.invoke('app:about').then(setAbout)
        })
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(null))
    },
    [onError]
  )

  if (!settings) {
    return <p className="px-1 py-10 text-center text-sm text-white/35">读取设置…</p>
  }

  const providers = settings.providerPriority
  const moveProvider = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= providers.length) return
    const next = [...providers]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    patch({ providerPriority: next })
  }

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <p
          className={`rounded border px-3 py-2 text-xs leading-relaxed ${
            notice.status === 'FAILED'
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : notice.needsRestart === true
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                : 'border-white/15 bg-white/5 text-white/60'
          }`}
        >
          {notice.message}
          {notice.error ? `：${notice.error}` : ''}
        </p>
      ) : null}

      <Section title="行情与信号">
        <Row
          label="轮询频率"
          hint="盘中每隔这么久取一次快照。低于 10 秒对免费接口是滥用，休市时会自动降到分钟级"
        >
          <input
            type="number"
            min={10}
            max={120}
            className="w-16 rounded border border-white/15 bg-black/25 px-2 py-1 text-right font-mono text-xs outline-none focus:border-white/35"
            value={settings.pollIntervalSec}
            onChange={(e) => {
              const value = Number(e.target.value)
              // 越界值不发出去：主进程会静默退回原值，界面却已经显示成新值了
              if (Number.isInteger(value) && value >= 10 && value <= 120) {
                patch({ pollIntervalSec: value })
              }
            }}
          />
          <span className="text-[11px] text-white/35">秒</span>
        </Row>

        <Row
          label="灵敏度"
          hint={
            '得分线与票数线的松紧。三档都未标定（均衡档恰好是出厂值），差别只在「出信号多少」，' +
            '不代表哪一档更准。改档会重算指标缓存，并让影子运行暂停累积'
          }
        >
          {SENSITIVITY.map((tier) => (
            <button
              key={tier.value}
              className={`gp-btn ${settings.sensitivity === tier.value ? 'border-white/40 text-white' : ''}`}
              title={tier.detail}
              onClick={() => {
                if (settings.sensitivity === tier.value) return
                // 换档的代价不可逆（影子记录无法重建），所以先说清再改
                const ok = window.confirm(
                  `切到「${tier.label}」档？\n\n${tier.detail}\n\n` +
                    '这会更换整套引擎参数：指标缓存作废重算，影子运行会暂停累积' +
                    '（两套参数下的绩效不可混在一条曲线上）。'
                )
                if (ok) patch({ sensitivity: tier.value })
              }}
            >
              {tier.label}
            </button>
          ))}
        </Row>

        <Row label="数据源优先级" hint="按顺序降级：前一个连不上才试下一个">
          <ul className="flex flex-col gap-1">
            {providers.map((provider, i) => (
              <li key={provider} className="flex items-center gap-1.5 text-[11px]">
                <span className="w-4 text-right font-mono text-white/30">{i + 1}</span>
                <span className="w-16 text-white/70">{PROVIDER_LABEL[provider]}</span>
                <button
                  className="gp-btn px-1.5 py-0.5"
                  disabled={i === 0}
                  onClick={() => moveProvider(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="gp-btn px-1.5 py-0.5"
                  disabled={i === providers.length - 1}
                  onClick={() => moveProvider(i, 1)}
                >
                  ↓
                </button>
              </li>
            ))}
          </ul>
        </Row>

        <ParamsTable />
      </Section>

      <Section title="提醒">
        <Row
          label="提醒级别"
          hint="整体升降一档。持仓止损一类的强制提醒**不受**降档影响 —— 少发一条止损，你发现不了"
        >
          {LEVEL_OFFSET.map((option) => (
            <button
              key={option.value}
              className={`gp-btn ${settings.alertLevelOffset === option.value ? 'border-white/40 text-white' : ''}`}
              onClick={() => patch({ alertLevelOffset: option.value })}
            >
              {option.label}
            </button>
          ))}
        </Row>

        <QuietHours hours={settings.quietHours} onChange={(next) => patch({ quietHours: next })} />

        <Row
          label="全屏 / 演示时不打扰"
          hint="检测到全屏应用、投影或专注助手时不弹气泡。探测不出来时按「可以提醒」处理"
        >
          <Toggle
            on={settings.respectFullscreen}
            labels={['已开启', '已关闭']}
            onChange={(next) => patch({ respectFullscreen: next })}
          />
        </Row>
      </Section>

      {/* AI 解读是**只读的解释层**：它不参与信号、闸门、状态点与影子运行。
          配置整块住在 ai.json，不在 AppSettings 里 —— 见 AiSettings.tsx 头注释 */}
      <AiSettings onError={onError} />

      <Section title="系统">
        <Row label="开机自启" hint="开发模式下不写注册表（会注册成一个裸 Electron），要验请先打包">
          <Toggle
            on={settings.autoLaunch}
            labels={['已开启', '已关闭']}
            onChange={(next) => patch({ autoLaunch: next })}
          />
        </Row>

        <Row
          label="数据目录"
          hint={`market.db 的位置（settings.json 始终留在默认目录，改坏了才找得回来）。当前：${about?.dataDir ?? '…'}`}
        >
          <button className="gp-btn" onClick={() => window.gp.invoke('app:revealPath', 'data')}>
            打开
          </button>
          <button
            className="gp-btn"
            disabled={busy !== null}
            onClick={() => maintenance('app:chooseDataDir', '数据目录')}
          >
            更改…
          </button>
        </Row>

        <Row
          label="备份数据库"
          hint="一致性快照（运行中也能做），保留最近 3 份。迁移前的自动备份是另一套，不冲突"
        >
          <button className="gp-btn" onClick={() => window.gp.invoke('app:revealPath', 'backups')}>
            打开目录
          </button>
          <button
            className="gp-btn"
            disabled={busy !== null}
            onClick={() => maintenance('app:backupDatabase', '备份')}
          >
            {busy === '备份' ? '备份中…' : '立即备份'}
          </button>
        </Row>

        <Row
          label="清理缓存"
          hint="清指标缓存 + 过期信号与提醒日志，并整理数据库。不动 K 线、自选、持仓与影子记录"
        >
          <button
            className="gp-btn"
            disabled={busy !== null}
            onClick={() => maintenance('app:clearCache', '清缓存')}
          >
            {busy === '清缓存' ? '清理中…' : '清理'}
          </button>
        </Row>

        <Row label="日志" hint="按天分文件，保留 7 天">
          <button className="gp-btn" onClick={() => window.gp.invoke('app:revealPath', 'logs')}>
            打开目录
          </button>
        </Row>
      </Section>

      <Section title="关于">
        <div className="px-3.5 py-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            <dt className="text-white/40">版本</dt>
            <dd className="font-mono text-white/70">{about?.appVersion ?? '…'}</dd>
            <dt className="text-white/40">Electron</dt>
            <dd className="font-mono text-white/70">{about?.electronVersion ?? '…'}</dd>
            <dt className="text-white/40">引擎</dt>
            <dd className="font-mono text-white/70">{about?.engineVersion ?? '…'}</dd>
            <dt className="text-white/40">数据库 schema</dt>
            <dd className="font-mono text-white/70">v{about?.schemaVersion ?? '…'}</dd>
          </dl>
          {/* 引擎版本带 -unvalidated 后缀是刻意的：它跟的是整套参数的状态 */}
          {about?.engineVersion.includes('-unvalidated') === true ? (
            <p className="mt-2 text-[10px] leading-snug text-white/35">
              引擎版本号里的 <span className="font-mono">-unvalidated</span> 表示整套参数尚未完成标定。
              它会一直留着，直到参数表里不再有「未测」那一档。
            </p>
          ) : null}
          <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/[0.07] p-2.5 text-[11px] leading-relaxed text-amber-100/70">
            {DISCLAIMER}
          </p>
        </div>
      </Section>
    </div>
  )
}
