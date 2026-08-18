/**
 * 提醒日志（docs/05 §6）—— **建立信任的关键界面**。
 *
 * 它回答的问题只有一个：**「它是不是漏提醒我了？」**
 * 所以这里列的不是「发出去的提醒」，而是分发器对每一条候选做出的**全部裁决**：
 * 发出去的、被防抖挡住的、被冷却挡住的、被免打扰降级的，一条不落。
 *
 * ```
 * | 时间  | 标的   | 方向 | 得分 | 结果            |
 * | 10:32 | 600xxx | BUY  | 0.78 | 已提醒 L2       |
 * | 10:45 | 000xxx | BUY  | 0.64 | 静默（冷却期内）|
 * ```
 *
 * ## 三条纪律
 *
 * 1. **被静默的条目默认可见**，不藏在开关后面 —— 藏起来就等于制造信息黑洞（docs/05 §4）。
 * 2. **原因用分发器写下的原话**，不在这里重新措辞：两处措辞会随时间走岔，
 *    而用户拿这一列去调灵敏度，读到的必须是真实判据。
 * 3. **展开即已读**：角标是「有没有新东西」，用户看过了就该清零；而没展开时不清 ——
 *    面板可能只是被拿来加自选。
 */

import { useCallback, useEffect, useState } from 'react'
import type { AlertLevel, GatedDirection } from '@core/types'
import type { AlertRecord } from '@shared/ipc-types'
import { shanghaiHhmm } from '@shared/time'

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '失效/观察',
}

/** 卖出/减仓一律暖橙；买入用红（A 股红涨）；观察类中性（docs/05 §5） */
const DIRECTION_TONE: Record<GatedDirection, string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  REDUCE: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  NEXT_DAY_WATCH: 'border-white/20 bg-white/5 text-white/70',
  NONE: 'border-white/15 bg-white/5 text-white/50',
}

/**
 * 级别标签。原先写作「表情 + 角标」/「系统通知」，那三样（桌宠表情、托盘角标、
 * 系统通知）都在 2026-08-13 删掉了 —— 提醒的可见出口只剩气泡。
 * 这一行显示在「已提醒 · X」后面，写一个不存在的渠道等于让用户去找一个不会出现的弹窗。
 *
 * L2 与 L3 渠道相同，区别是冷却窗口（两小时 / 当日一次），标签照着这个区别写。
 * **级别本身不许合并**（见 dispatcher.ts 的 CHANNELS_BY_LEVEL）。
 */
const LEVEL_LABEL: Record<AlertLevel, string> = {
  L1: '静默（仅状态点）',
  L2: '气泡',
  L3: '气泡 · 当日一次',
}

/*
  时刻按**北京时间**（`shared/time.ts`），不是宿主本地时区。
  原先这里用 `getHours()`：UTC+8 上恰好对，本机（UTC+7）上北京 09:03 那条会写成 08:03 ——
  而日报「今日提醒」那一节标的是同一条提醒的北京时刻，两屏对不上而用户没法判断哪个对。
*/
const timeOf = shanghaiHhmm

/** 当天 00:00。与「今日信号」同一口径 */
function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * 「同一条裁决持续了多久」。
 *
 * 盘中每 30s 一轮都会对同一个持续中的信号造一次候选、被同键冷却挡一次 ——
 * 那不是 47 件事，是 1 件事持续了 47 轮（006_alert_repeat.sql）。
 * 落库时已经合成一行了，这里把次数与最后时刻显示出来，
 * 否则用户会以为软件只在 10:05 判过一次。
 */
function Repeat({ record }: { record: AlertRecord }): React.JSX.Element | null {
  if (record.repeatCount <= 1) return null
  return (
    <span className="shrink-0 text-white/30">
      ×{record.repeatCount}
      {record.lastAt !== undefined ? ` · 持续到 ${timeOf(record.lastAt)}` : null}
    </span>
  )
}

function Outcome({ record }: { record: AlertRecord }): React.JSX.Element {
  const delivered = record.channels.length > 0
  if (!delivered) {
    return (
      <span className="text-white/40">
        未提醒
        {record.reason ? <span className="text-amber-200/70"> · {record.reason}</span> : null}
      </span>
    )
  }
  return (
    <span>
      <span className="text-white/75">已提醒 · {LEVEL_LABEL[record.level]}</span>
      {/* 被降级的也算发出去了，但原因照样要写明：那是「为什么没弹窗」的答案 */}
      {record.reason ? <span className="text-amber-200/70"> · {record.reason}</span> : null}
    </span>
  )
}

export function AlertLog({
  refreshKey,
  unread,
  onRead,
  onError,
}: {
  /** 每轮引擎跑完后由父组件递增，触发重新拉取 */
  refreshKey: number
  unread: number
  onRead: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [records, setRecords] = useState<AlertRecord[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.gp
      .invoke('alert:history', { from: startOfToday(), limit: 200 })
      .then((rows) => {
        if (!cancelled) setRecords(rows)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, open, onError])

  const toggle = useCallback((): void => {
    const next = !open
    setOpen(next)
    // 展开即已读（空数组 = 全部）。收起时不动 —— 没看过的不该被清掉
    if (next && unread > 0) {
      void window.gp
        .invoke('alert:markRead', [])
        .then(() => onRead())
        .catch(() => undefined)
    }
  }, [open, unread, onRead])

  const silenced = records.filter((r) => r.channels.length === 0).length

  // 收起时按内容给高，展开时最多吃掉右栏一半多一点并在内部滚动 ——
  // 让它无限长会把上面的「今日信号」挤没
  return (
    <section className={`gp-card ${open ? 'min-h-0 max-h-[55%]' : 'shrink-0'}`}>
      <button className="gp-card-head w-full text-left" onClick={toggle}>
        <h2 className="gp-card-title">提醒日志</h2>
        {unread > 0 ? (
          <span className="rounded bg-rose-400/15 px-1.5 py-0.5 text-[11px] text-rose-200">
            {unread} 条未读
          </span>
        ) : null}
        <span className="ml-auto text-xs text-white/35">{open ? '收起' : '展开'}</span>
      </button>

      {open ? (
        records.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-white/35">
            今日还没有任何提醒判定。引擎每轮都会记一笔，包括被静默的。
          </p>
        ) : (
          <>
            <p className="shrink-0 border-b border-white/[0.06] px-3 py-2 text-xs text-white/35">
              今日 {records.length} 条判定，其中 {silenced} 条未发出。
              下面写的是分发器的原话，可据此调整灵敏度与静默时段。
            </p>
            {/*
              两行式而不是一行五列：右栏只有 ~330px 宽，
              把「未提醒 · 同键冷却期内（剩 42 分钟）」这种原话塞进一个定宽列会被截断，
              而那句话正是这个界面存在的理由 —— 宁可多占一行也不许省略它。
            */}
            <ul className="min-h-0 flex-1 overflow-y-auto px-3">
              {records.map((record) => (
                <li key={record.id} className="border-b border-white/[0.06] py-2 text-xs last:border-b-0">
                  <div className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-white/45">{timeOf(record.createdAt)}</span>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${DIRECTION_TONE[record.direction]}`}
                    >
                      {DIRECTION_LABEL[record.direction]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-white/85">
                      {record.name}
                      <span className="ml-1.5 font-mono text-xs text-white/35">{record.code}</span>
                    </span>
                    <Repeat record={record} />
                    <span className="shrink-0 font-mono text-white/60">
                      置信 {Math.round(record.score * 100)}%
                    </span>
                  </div>
                  {record.headline ? (
                    <p className="mt-0.5 truncate text-white/45">{record.headline}</p>
                  ) : null}
                  <p className="mt-0.5">
                    <Outcome record={record} />
                  </p>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  )
}
