/**
 * 「展开哪一条信号的依据」这份状态。
 *
 * 单独抽出来是因为它要**被两处共用**：概览页的信号列表，和抽屉里的信号页。
 * 各存一套的话，在列表里展开的那条进抽屉会「忘记」自己是展开的，
 * 而正在跑的 AI 解读还会因为组件重新挂载被取消（`AiExplain` 是卸载即取消的）。
 *
 * 依据按 id 缓存，同一条不会重复请求 —— 展开、收起、再展开只发一次。
 */

import { useCallback, useState } from 'react'
import type { SignalEvidence } from '@shared/ipc-types'

export interface SignalEvidenceState {
  /** 当前展开的信号 id；null = 都收起 */
  expandedId: string | null
  evidence: Record<string, SignalEvidence>
  toggle: (id: string) => void
}

export function useSignalEvidence(onError: (message: string) => void): SignalEvidenceState {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<Record<string, SignalEvidence>>({})

  const toggle = useCallback(
    (id: string): void => {
      setExpandedId((current) => (current === id ? null : id))
      if (evidence[id]) return
      void window.gp
        .invoke('signal:explain', id)
        .then((detail) => setEvidence((current) => ({ ...current, [id]: detail })))
        .catch((error: unknown) => {
          onError(error instanceof Error ? error.message : String(error))
        })
    },
    [evidence, onError]
  )

  return { expandedId, evidence, toggle }
}
