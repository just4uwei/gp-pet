/**
 * 面板窗口 —— M0 阶段是一块「骨架自检」屏。
 *
 * 它刻意不长得像成品：自选股列表属 M1、今日信号属 M2。
 * 现在放在这里的每一项都是可验证的事实（IPC 通了没、皮肤加载到哪一套、引擎在不在），
 * 而不是占位用的假数据 —— 假数据会让人误判骨架的完成度。
 */

import { useEffect, useState } from 'react'
import type { EngineStatus, PetSkinView } from '@shared/ipc-types'

interface PingResult {
  roundTripMs: number
  echoed: boolean
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex gap-4 border-b border-white/10 py-2 text-sm">
      <span className="w-40 shrink-0 text-white/50">{label}</span>
      <span className="font-mono">{children}</span>
    </div>
  )
}

export function App(): React.JSX.Element {
  const [ping, setPing] = useState<PingResult | null>(null)
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [skin, setSkin] = useState<PetSkinView | null>(null)

  useEffect(() => {
    const sentAt = performance.now()
    const nonce = `m0-${String(Math.round(sentAt))}`
    void window.gp.invoke('app:ping', nonce).then((reply) => {
      setPing({ roundTripMs: Math.round(performance.now() - sentAt), echoed: reply.pong === nonce })
    })
    void window.gp.invoke('app:engineStatus').then(setStatus)
    void window.gp.invoke('pet:getSkin').then(setSkin)

    return window.gp.on('push:engineStatus', setStatus)
  }, [])

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-lg font-semibold">GP Pet · 骨架自检</h1>
      <p className="mt-1 text-sm text-white/50">
        M0 阶段：无数据源、无引擎、无提醒。此页只报告已经跑通的东西。
      </p>

      <section className="mt-6">
        <Row label="IPC 往返">
          {ping ? `${ping.echoed ? '通' : '回包不匹配'} · ${ping.roundTripMs}ms` : '…'}
        </Row>
        <Row label="皮肤">
          {skin ? `${skin.name}（${skin.id}）${skin.fallback ? ' · 已回退到占位皮肤' : ''}` : '…'}
        </Row>
        <Row label="命中区">{skin ? `${skin.hitRects.length} 个矩形` : '…'}</Row>
        <Row label="行情">{status ? (status.offline ? '离线（尚未接入数据源）' : '在线') : '…'}</Row>
        <Row label="免打扰">{status ? (status.doNotDisturb ? '生效中' : '关闭') : '…'}</Row>
        <Row label="自选股">{status ? `${status.watchCount} 只` : '…'}</Row>
      </section>

      {skin?.fallback ? (
        <p className="mt-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
          皮肤校验未通过，已回退占位形象：{skin.fallbackReason}
        </p>
      ) : null}

      <p className="mt-8 text-xs text-white/40">仅供参考，非投资建议</p>
    </main>
  )
}
