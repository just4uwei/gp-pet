/**
 * 个人配置的导入导出入口（头部右侧两个按钮）+ 结果提示。
 *
 * 「个人配置」= 设置 + 自选（含分组与排序）+ 手工录入的持仓，
 * 定义与理由见 `src/main/settings/transfer.ts` 的头注释。
 *
 * ## 三条纪律
 *
 * 1. **路径选择与覆盖确认都在主进程的系统对话框里做**，这里不自己搭一个确认弹窗 ——
 *    导入会把现有自选与持仓整份清掉，那种不可撤销的操作应该长成系统模态框的样子。
 * 2. **warnings 必须显示，且逐条显示。** 解析时坏字段回默认值、坏行被丢掉都在里面；
 *    只报「导入成功」会让用户以为整份配置原样搬过来了（docs/02 §7）。
 * 3. **取消不是错误。** 用户在文件框里按了取消就安静收场，不留一条红色提示。
 *    但如果解析时已经产生了 warnings（他可能正是看到「12 行被丢弃」才决定不导的），
 *    那几条仍要留在屏幕上。
 */

import { useState } from 'react'
import type { ConfigTransferResult } from '@shared/ipc-types'

export type TransferKind = 'export' | 'import'

export interface TransferOutcome {
  kind: TransferKind
  result: ConfigTransferResult
}

export function ConfigTransferButtons({
  onOutcome,
}: {
  /** 导入成功时父组件要重新拉一遍自选与持仓 */
  onOutcome: (outcome: TransferOutcome) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState<TransferKind | null>(null)

  async function run(kind: TransferKind): Promise<void> {
    if (busy !== null) return
    setBusy(kind)
    try {
      const result = await window.gp.invoke(kind === 'export' ? 'config:export' : 'config:import')
      onOutcome({ kind, result })
    } catch (error) {
      // 主进程那两条通道自己不抛错（见 controller），走到这里说明是 IPC 本身出了问题
      onOutcome({
        kind,
        result: {
          status: 'FAILED',
          warnings: [],
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <button
        className="gp-btn"
        title="把设置、自选（含分组与排序）与持仓导出成一个 JSON 文件"
        disabled={busy !== null}
        onClick={() => void run('export')}
      >
        {busy === 'export' ? '导出中…' : '导出配置'}
      </button>
      <button
        className="gp-btn"
        title="从导出文件恢复。会整份替换现有的自选与持仓，动手前有确认框"
        disabled={busy !== null}
        onClick={() => void run('import')}
      >
        {busy === 'import' ? '导入中…' : '导入配置'}
      </button>
    </>
  )
}

/** 结果提示。返回 null 表示这次没什么可说的（取消且无 warning） */
export function ConfigTransferNotice({
  outcome,
  onDismiss,
}: {
  outcome: TransferOutcome
  onDismiss: () => void
}): React.JSX.Element | null {
  const { kind, result } = outcome
  const noun = kind === 'export' ? '导出' : '导入'

  if (result.status === 'CANCELED' && result.warnings.length === 0) return null

  const failed = result.status === 'FAILED'
  const tone = failed
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
    : 'border-white/15 bg-white/5 text-white/70'

  let headline: string
  if (failed) {
    headline = `${noun}失败：${result.error ?? '未知原因'}`
  } else if (result.status === 'CANCELED') {
    headline = `已取消${noun}，什么都没有改动。`
  } else if (kind === 'export') {
    headline = `已导出 ${result.counts?.watchlist ?? 0} 只自选、${result.counts?.positions ?? 0} 条持仓。`
  } else {
    headline =
      `已导入 ${result.counts?.watchlist ?? 0} 只自选、${result.counts?.positions ?? 0} 条持仓，` +
      `原有的 ${result.removed?.watchlist ?? 0} 只自选与 ${result.removed?.positions ?? 0} 条持仓已清除。`
  }

  return (
    <div className={`rounded border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1">{headline}</p>
        <button className="shrink-0 text-white/35 hover:text-white/80" title="关闭" onClick={onDismiss}>
          ×
        </button>
      </div>
      {result.path ? <p className="mt-1 font-mono break-all text-white/35">{result.path}</p> : null}
      {result.warnings.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 text-amber-200/80">
          {result.warnings.map((warning, i) => (
            <li key={`${i}-${warning}`}>· {warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
