/**
 * 「观察点」页（P2 续）——「让用户知道软件在按这个继续跟踪」的那个答案。
 *
 * 三段：**正在跟踪** / **已命中** / **已结束**（过期或取消）。
 *
 * 四条克制：
 *
 * 1. **「正在跟踪」排最前，且倒数天数要显眼。** 这一页的存在意义就是回答
 *    「软件现在到底在盯什么」—— 把它埋在历史下面等于没做。
 * 2. **「已过期」不是错误，是结论。** 到期未命中就是「当时那个判断没兑现」，
 *    文案要这么说，而不是灰掉了事。
 * 3. **不说「AI 推荐」。** 来源那一栏说的是「模型建议 / 你改过」，
 *    因为这些数一个都没有回测依据 —— 与 `params.ts` 里标定过的东西不是一回事。
 * 4. **换过灵敏度的指标类观察点要打提示。** rsi 周期变了，同一个阈值不是同一件事；
 *    价格类不受影响，所以主进程只对指标类给 `staleEngineVersion`。
 */

import { useCallback, useEffect, useState } from 'react'
import type { WatchPointView } from '@shared/ipc-types'
import { shanghaiMdHhmm } from '@shared/time'
// 标签表与格式化都与主进程共用一份（@shared/watch-metrics）—— 各抄一张会静默分叉
import { conditionsText, hitValuesText } from '@shared/watch-metrics'

function dayText(ms: number): string {
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000))
  if (days <= 0) return '已到期'
  return `还有 ${days} 天`
}

/** 北京时间（`shared/time.ts`）。`getHours()` 会按宿主时区偏 —— 理由见 AlertLog 那一处 */
const timeText = shanghaiMdHhmm

/**
 * 方向结论的显示。**红涨绿跌**（A 股口径，与列表其余地方一致）。
 *
 * 措辞上写「判断」不写「预测」：它是用户确认过的、当时那条解读的方向结论，
 * 而这个软件里没有任何一个经过验证的绩效数字（docs/01 §9 的措辞纪律）。
 */
const VERDICT_STYLE: Record<'UP' | 'DOWN' | 'RANGE', { label: string; tone: string }> = {
  UP: { label: '判断：上涨', tone: 'text-rose-200/85' },
  DOWN: { label: '判断：下跌', tone: 'text-emerald-200/85' },
  RANGE: { label: '判断：震荡', tone: 'text-white/45' },
}

function Row({
  point,
  now,
  onRemove,
}: {
  point: WatchPointView
  now: number
  onRemove?: (id: string) => void
}): React.JSX.Element {
  const meaning = point.meaning === 'INVALIDATE' ? '命中 = 原判断失效' : '命中 = 判断得到确认'
  return (
    <li className="border-b border-white/[0.06] px-3 py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="truncate text-sm">{point.name}</span>
        <span className="font-mono text-xs text-white/35">{point.code}</span>
        {/*
          组合条件会长，所以这里**换行而不是截断**：条件被截掉等于这份列表在说谎
          （用户会以为软件盯的是更宽松的那一半）
        */}
        <span className="ml-auto text-right font-mono text-sm text-sky-200/90">
          {conditionsText(point.conditions)}
        </span>
      </div>
      {point.conditions.length > 1 ? (
        <p className="mt-0.5 text-[10px] text-white/30">
          这 {point.conditions.length} 条<span className="text-white/50">同时</span>成立才提醒
        </p>
      ) : null}

      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-white/40">
        {point.verdict !== undefined ? (
          <>
            <span className={VERDICT_STYLE[point.verdict].tone}>
              {VERDICT_STYLE[point.verdict].label}
            </span>
            <span>·</span>
          </>
        ) : null}
        <span>{meaning}</span>
        <span>·</span>
        <span>{point.source === 'AI_SUGGESTED' ? '模型建议，你确认过' : '你自己填的数'}</span>
        {point.status === 'ACTIVE' ? (
          <>
            <span>·</span>
            <span className={point.expiresAt - now < 3 * 86_400_000 ? 'text-amber-200/80' : ''}>
              {dayText(point.expiresAt - now)}
            </span>
          </>
        ) : null}
        {point.status === 'HIT' && point.hitAt !== undefined ? (
          <>
            <span>·</span>
            <span className="text-rose-200/80">
              {timeText(point.hitAt)} 命中，当时 {hitValuesText(point.conditions, point.hitValues)}
            </span>
          </>
        ) : null}
        {point.status === 'EXPIRED' ? (
          <>
            <span>·</span>
            <span className="text-white/35">到期未兑现</span>
          </>
        ) : null}
        {point.status === 'CANCELED' ? (
          <>
            <span>·</span>
            <span className="text-white/35">已取消</span>
          </>
        ) : null}
        {onRemove ? (
          <button
            className="ml-auto text-[10px] text-white/30 hover:text-rose-300"
            onClick={() => onRemove(point.id)}
          >
            不盯了，移除
          </button>
        ) : null}
      </div>

      {/*
        判断原文单独一行、单独一种灰：它是**模型当时的原话**，不是软件的结论。
        归一化枚举认不出时（`verdict` 缺省）这一行仍然在 —— 那正是它存在的理由，
        「继续震荡上行」归不了类，但它本身是有价值的记录。
      */}
      {point.verdictText !== undefined && point.verdictText !== '' ? (
        <p className="mt-0.5 text-[10px] leading-snug text-white/35">
          <span className="text-white/25">原话 </span>
          {point.verdictText}
        </p>
      ) : null}

      {point.note !== undefined && point.note !== '' ? (
        <p className="mt-0.5 text-[10px] leading-snug text-white/30">{point.note}</p>
      ) : null}

      {point.staleEngineVersion !== undefined ? (
        <p className="mt-1 rounded border border-amber-500/30 bg-amber-500/[0.07] px-2 py-1 text-[10px] leading-snug text-amber-100/70">
          设这个观察点之后引擎参数变过（{point.staleEngineVersion} → 现在）。
          指标的算法或周期可能已经不同，这个阈值不再是当初那个意思 —— 建议重新确认一次。
        </p>
      ) : null}
    </li>
  )
}

function Section({
  title,
  hint,
  points,
  now,
  onRemove,
}: {
  title: string
  hint?: string
  points: WatchPointView[]
  now: number
  onRemove?: (id: string) => void
}): React.JSX.Element | null {
  if (points.length === 0) return null
  return (
    <section className="gp-card">
      <div className="gp-card-head">
        <h2 className="gp-card-title">
          {title} <span className="text-white/30">{points.length}</span>
        </h2>
      </div>
      {hint ? <p className="px-3 pb-1 text-[10px] leading-snug text-white/30">{hint}</p> : null}
      <ul>
        {points.map((point) => (
          // exactOptionalPropertyTypes：onRemove 缺省时不要传这个 prop（传 undefined 不等价）
          <Row
            key={point.id}
            point={point}
            now={now}
            {...(onRemove === undefined ? {} : { onRemove })}
          />
        ))}
      </ul>
    </section>
  )
}

export function WatchPoints({
  refreshKey,
  onChanged,
  onError,
}: {
  refreshKey: number
  onChanged: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [points, setPoints] = useState<WatchPointView[] | null>(null)
  const now = Date.now()

  const reload = useCallback((): void => {
    void window.gp
      .invoke('watch:list', { limit: 200 })
      .then(setPoints)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
  }, [onError])

  useEffect(reload, [reload, refreshKey])

  /**
   * 「不盯了」= **直接删记录**（2026-08-14 改，此前是标记成已取消）。
   *
   * 确认框在**主进程**弹（系统模态框），不在这里做二次点击 —— 删掉之后
   * 「当时押了什么」找不回来，那种操作该长成系统对话框的样子
   * （与覆盖导入、清空影子账本同一条，见 controller.removeWatchPoint）。
   * 返回 false = 用户在框里点了取消，此时**不刷新**：什么都没变，刷一下只会让人以为动过了。
   */
  const remove = useCallback(
    (id: string): void => {
      void window.gp
        .invoke('watch:remove', id)
        .then((removed) => {
          if (!removed) return
          reload()
          onChanged()
        })
        .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
    },
    [reload, onChanged, onError]
  )

  if (points === null) {
    return <p className="px-1 py-10 text-center text-sm text-white/35">读取中…</p>
  }

  const active = points.filter((p) => p.status === 'ACTIVE')
  const hit = points.filter((p) => p.status === 'HIT')
  const done = points.filter((p) => p.status === 'EXPIRED' || p.status === 'CANCELED')

  return (
    <div className="flex flex-col gap-4">
      <div className="gp-card">
        <div className="px-3.5 py-3">
          <p className="text-[11px] leading-relaxed text-white/50">
            观察点是<span className="text-white/70">你自己确认过</span>的盯盘条件：
            通常来自某条信号的 AI 解读里「如果判断错了会先看到什么」那一段。
            条件成立时会提醒你一次，然后这个观察点就结束了。
          </p>
          <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">
            它<span className="text-white/45">不是策略参数</span> ——
            不参与信号计算、不影响任何其他标的、也没有回测依据。
            引擎自己的参数在「设置 → 策略参数」那张只读表里，两者不是一回事。
          </p>
        </div>
      </div>

      {active.length === 0 && points.length === 0 ? (
        <p className="px-1 py-10 text-center text-xs leading-relaxed text-white/35">
          还没有观察点。
          <br />
          到「概览 → 今日信号」展开一条信号，让 AI 解读一次，
          <br />
          然后把它给出的失效条件确认成观察点。
        </p>
      ) : null}

      <Section
        title="正在跟踪"
        hint="盘中每轮取数后都会比一次。命中即提醒，且照过防抖、冷却、每日上限与免打扰"
        points={active}
        now={now}
        onRemove={remove}
      />
      {/* 已命中 / 已结束的也能清掉：那是用户自己的记录，该由他决定留不留 */}
      <Section title="已命中" points={hit} now={now} onRemove={remove} />
      <Section
        title="已结束"
        hint="到期未命中就是「当时那个判断没兑现」—— 这本身也是一个结论，删之前想一下"
        points={done}
        now={now}
        onRemove={remove}
      />
    </div>
  )
}
