/**
 * 持仓录入（docs/05 §2.3 的输入端）。
 *
 * 录入持仓会打开一条**独立的强制提醒通道**：止损 / 移动止损 / 回撤减仓不经过组合层得分，
 * 也不受同键冷却限制（改为「跌幅每扩大 2% 提醒一次」）。所以这个表单不是装饰 ——
 * 填了它，这只股票的提醒行为就变了，界面必须把这件事说清楚。
 *
 * ## 两条纪律
 *
 * 1. **成本价是不复权真实成交价**（docs/03 §2.3）。用户填的是「当时付的钱」，
 *    不是前复权价 —— 拿复权价算止损会在除权后凭空触发一次卖出提醒。
 * 2. **只显示浮盈浮亏，不做任何资金计算与建议仓位数字**（docs/05 §1：只给比例建议）。
 */

import { useEffect, useState } from 'react'
import type { SecCode } from '@core/types'
import type { PositionView, QuoteTick } from '@shared/ipc-types'

function numberOr(text: string, fallback: number): number {
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function PositionEditor({
  code,
  position,
  quote,
  onSaved,
  onError,
}: {
  code: SecCode
  position: PositionView | undefined
  quote: QuoteTick | undefined
  onSaved: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [shares, setShares] = useState(position ? String(position.shares) : '')
  const [cost, setCost] = useState(position ? String(position.cost) : '')
  const [busy, setBusy] = useState(false)

  // 别的地方改了持仓（比如清除后又打开）时同步一次，避免表单停在旧值上
  useEffect(() => {
    setShares(position ? String(position.shares) : '')
    setCost(position ? String(position.cost) : '')
  }, [position])

  const parsedShares = numberOr(shares, 0)
  const parsedCost = numberOr(cost, 0)
  const valid = parsedShares > 0 && parsedCost > 0

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    try {
      await window.gp.invoke('position:set', code, parsedShares, parsedCost)
      onSaved()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function clear(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await window.gp.invoke('position:clear', code)
      onSaved()
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  // 浮盈按**当前价 vs 成本价**算，两者都是不复权真实价
  const profitPct =
    position && quote && position.cost > 0 ? ((quote.last - position.cost) / position.cost) * 100 : null

  return (
    <form className="mt-1 mb-2 rounded border border-white/10 bg-black/20 p-2" onSubmit={(e) => void submit(e)}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 text-white/50">
          持股数
          <input
            className="w-24 rounded border border-white/15 bg-white/5 px-2 py-1 text-right font-mono text-white/85 outline-none focus:border-white/35"
            inputMode="numeric"
            placeholder="1000"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1.5 text-white/50">
          成本价
          <input
            className="w-24 rounded border border-white/15 bg-white/5 px-2 py-1 text-right font-mono text-white/85 outline-none focus:border-white/35"
            inputMode="decimal"
            placeholder="12.34"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>

        <button
          className="rounded border border-white/15 px-2 py-1 text-white/80 hover:border-white/35 disabled:opacity-40"
          type="submit"
          disabled={!valid || busy}
        >
          保存
        </button>
        {position ? (
          <button
            className="rounded border border-white/10 px-2 py-1 text-white/45 hover:text-rose-300"
            type="button"
            disabled={busy}
            onClick={() => void clear()}
          >
            清除持仓
          </button>
        ) : null}

        {profitPct !== null ? (
          <span className={`ml-auto font-mono ${profitPct >= 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
            浮动盈亏 {signed(profitPct)}
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-[11px] text-white/35">
        成本价请填实际成交价（不复权）。填写后这只股票会启用止损 / 移动止损 / 回撤减仓的强制提醒，
        这类提醒不受冷却限制。仅供参考，非投资建议。
      </p>
    </form>
  )
}
