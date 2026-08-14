/**
 * 单只标的的信号详情抽屉（右侧滑出）。
 *
 * 分组的展开内容原先是**就地展开**在右栏里的，而右栏只有 ~300px 宽 ——
 * 旧信号、依据、AI 解读、走势图挤在那个宽度里都做不好，走势图连坐标轴都放不下。
 * 抽屉给到 ~460px，坐标轴才有地方画。
 *
 * ## 三条
 *
 * 1. **`top` 从 `TITLE_BAR_HEIGHT`（40px）开始，不要 `inset-y-0`。**
 *    面板是 `titleBarStyle: 'hidden'` + `titleBarOverlay`，右上角那一块归**系统**
 *    窗口控件（PanelWindow.ts）。抽屉盖上去 = 用户关不掉窗口，而且他多半会以为是软件卡死了。
 * 2. **不发新的 IPC 取信号。** 分组数据已经在 SignalList 手里，原样传进来。
 *    这里唯一会发请求的是走势图（挂载时一次 `quote:intraday`）。
 * 3. **Esc 与点遮罩都要能关。** 一个只能靠右上角小叉关掉的浮层，在键盘用户那里就是个陷阱。
 *
 * ## 为什么走 portal
 *
 * 抽屉由 SignalList 触发，但 SignalList 住在右栏里 —— 那一栏 `overflow-hidden` 且只有
 * ~300px 宽，`absolute` 定位会被它裁掉。挂到 `document.body` 上用 `fixed` 定位，
 * 状态就能继续留在 SignalList 里（展开依据 / AI 的状态都在那边，不必为了定位把它们提到 App）。
 */

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { SignalRecord } from '@shared/ipc-types'
import type { SignalGroup } from '@shared/signal-group'
import { IntradayChart, type IntradayMark } from './IntradayChart'

/** 与 PanelWindow.ts 的 TITLE_BAR_HEIGHT 成对，改一处要改两处 */
const TITLE_BAR_HEIGHT = 40

export function SignalDrawer({
  group,
  dayStart,
  renderRow,
  countChips,
  onError,
  onClose,
}: {
  group: SignalGroup<SignalRecord>
  /** 当天 00:00，走势图的 x 轴由它推出 09:30–15:00 */
  dayStart: number
  /** 信号行的渲染交回 SignalList —— 展开依据 / AI 的状态都在那边，抽屉不该复制一份 */
  renderRow: (record: SignalRecord) => React.JSX.Element
  /** 方向计数徽标，与列表上那一行同源 */
  countChips: React.JSX.Element
  onError: (message: string) => void
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 走势图上要标出**今日全部**信号点，组头那条也算 —— 它同样是一次真实观测
  const marks: IntradayMark[] = [group.latest, ...group.rest].map((record) => ({
    id: record.id,
    ts: record.createdAt,
    price: record.priceAt,
    direction: record.direction,
  }))

  return createPortal(
    <>
      {/* 遮罩也从标题栏下方开始：盖住系统窗口控件的话，点它会变成「点了没反应」 */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 bg-black/45"
        style={{ top: TITLE_BAR_HEIGHT }}
        onClick={onClose}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`${group.name} 今日信号详情`}
        className="fixed bottom-0 right-0 z-50 flex w-[460px] max-w-full flex-col border-l border-white/10 bg-[var(--gp-surface)] shadow-2xl"
        style={{ top: TITLE_BAR_HEIGHT }}
      >
        <header className="flex shrink-0 items-baseline gap-2 border-b border-white/10 px-4 py-3">
          <span className="truncate text-sm font-medium">{group.name}</span>
          <span className="font-mono text-xs text-white/35">{group.code}</span>
          <button
            className="ml-auto shrink-0 text-xs text-white/35 hover:text-white/70"
            onClick={onClose}
          >
            关闭 ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-1">{countChips}</div>

          <div className="mt-3">
            <IntradayChart code={group.code} from={dayStart} marks={marks} onError={onError} />
          </div>

          <h3 className="mt-4 border-t border-white/10 pt-3 text-[11px] text-white/40">
            今日全部信号（{group.total} 条，新的在上）
          </h3>
          <ul className="mt-1">
            {[group.latest, ...group.rest].map((record) => (
              <li key={record.id} className="border-b border-white/[0.06] py-2 last:border-b-0">
                {renderRow(record)}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>,
    document.body
  )
}
