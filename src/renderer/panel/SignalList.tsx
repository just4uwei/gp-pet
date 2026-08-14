/**
 * 「今日信号」列表 + 依据展开（docs/08 M2 最后一项、docs/05 §5/§6）。
 *
 * 四条克制，评审时按这四条看：
 *
 * 1. **置信度不叫「胜率」也不叫「概率」**（docs/04 §4.3）。它是规则一致性的度量。
 * 2. **被静默的信号也列出来，并写明原因**（docs/05 §4）—— 不制造信息黑洞。
 *    用户要能回答「它是不是漏提醒了」。
 * 3. **卖出用暖橙不用红**：A 股红涨绿跌，红色作警示会与涨跌色打架（docs/05 §5）。
 * 4. **没有数字就显示「—」**，不用 0 占位。
 *
 * ## 按标的分组（2026-08-14）
 *
 * 同一只票一天里会出好几条（盘中每轮 tick 都可能产出 PROVISIONAL，收盘轮再来一条
 * CONFIRMED 或 INVALIDATED），平铺时一只票就能把这个 ~300px 宽的列表刷满。
 * 现在同一 `code` 收成一组：常显最新那条，其余折叠。分组判据是纯函数，
 * 住在 `@shared/signal-group`（那儿有用例；渲染层没有测试）。
 *
 * **两个入口是分开的，别把它们并成一个**：
 *   主行点击   → 就地展开依据 + AI 解读（M2 就有的行为，一个字没改）
 *   徽标行点击 → 打开右侧抽屉：同股全部信号 + 当日走势图
 * 并成一个会变成「点一下弹出两坨东西」，而这两件事想看的时机完全不同。
 *
 * 详情从「就地展开」改成抽屉是因为右栏只有 ~300px 宽（2026-08-14）：
 * 旧信号、依据、AI 解读、走势图挤在那个宽度里都做不好，走势图连坐标轴都放不下。
 * 抽屉与列表**共用同一份 `expandedId` / `evidence`** —— 各存一套的话，
 * 在列表里展开的那条进抽屉会「忘记」自己是展开的，AI 解读还会因重新挂载被取消。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AlertLevel, GatedDirection, Regime, SecCode } from '@core/types'
import type { SignalEvidence, SignalRecord } from '@shared/ipc-types'
import { groupSignals, type SignalGroup } from '@shared/signal-group'
import { AiExplain } from './AiExplain'
import { SignalDrawer } from './SignalDrawer'

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入',
  SELL: '卖出',
  REDUCE: '减仓',
  NEXT_DAY_WATCH: '明日观察',
  NONE: '观察',
}

/** 卖出/减仓一律暖橙；买入用红（A 股红涨）；观察类中性 */
const DIRECTION_TONE: Record<GatedDirection, string> = {
  BUY: 'border-rose-400/40 bg-rose-400/10 text-rose-200',
  SELL: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  REDUCE: 'border-amber-400/40 bg-amber-400/10 text-amber-200',
  NEXT_DAY_WATCH: 'border-white/20 bg-white/5 text-white/70',
  NONE: 'border-white/15 bg-white/5 text-white/50',
}

const REGIME_LABEL: Record<Regime, string> = {
  TREND_UP: '上升趋势',
  TREND_DOWN: '下跌趋势',
  RANGE: '震荡市',
  TRANSITION: '转换期',
}

const LEVEL_LABEL: Record<AlertLevel, string> = {
  L1: '静默',
  L2: '气泡',
  L3: '通知',
}

const STAGE_LABEL: Record<SignalRecord['stage'], string> = {
  PROVISIONAL: '盘中临时',
  CONFIRMED: '收盘确认',
  INVALIDATED: '收盘失效',
}

/** 子信号 ID → 中文标签。与 core/risk/text.ts 同一份措辞，只是这里要展开全部而非前 3 条 */
const SUB_SIGNAL_LABEL: Record<string, string> = {
  T1_MA_CROSS: '均线交叉',
  T2_MACD_ZERO_CROSS: 'MACD 零轴交叉',
  T3_BREAKOUT: '轨道突破',
  T4_ALIGNMENT: '均线排列',
  T5_PULLBACK_HOLD: '回踩中轨',
  R1_RSI_BAND: 'RSI 极值触轨',
  R2_REVERT_TO_MID: '回归中轨',
  R3_SQUEEZE: '带宽压缩触轨',
  R4_MID_REVERSION: '中轨超调',
  M1_WEEK_MACD_DAY_RSI: '周线拐头共振',
  M2_WEEK_ADX_CONFIRM: '周线趋势确认',
  M3_FALSE_BREAKOUT: '周线无趋势，突破存疑',
}

function timeOf(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function numberText(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function Evidence({ evidence }: { evidence: SignalEvidence }): React.JSX.Element {
  const indicators = Object.entries(evidence.indicatorsAt).filter(([, v]) => v !== null)
  return (
    <div className="mt-2 space-y-2 rounded border border-white/10 bg-black/20 p-2 text-xs">
      <div>
        <div className="text-white/40">子信号</div>
        {evidence.subSignals.length === 0 ? (
          <div className="text-white/35">无 —— 该条记录由风控规则产生，不来自策略得分</div>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {evidence.subSignals.map((sub, i) => (
              <li key={`${sub.id}-${i}`} className="flex items-baseline gap-2">
                <span className={sub.direction === 'SELL' ? 'text-amber-200/80' : 'text-rose-200/80'}>
                  {sub.direction === 'SELL' ? '卖' : '买'}
                </span>
                <span className="flex-1">{SUB_SIGNAL_LABEL[sub.id] ?? sub.id}</span>
                <span className="font-mono text-white/45">
                  强度 {numberText(sub.score)} × 权重 {numberText(sub.weight)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {evidence.adjustments.length > 0 ? (
        <div>
          <div className="text-white/40">多周期调整</div>
          <ul className="mt-1 space-y-0.5">
            {evidence.adjustments.map((adjustment, i) => (
              <li key={`${adjustment.id}-${i}`} className="flex items-baseline gap-2">
                <span className="flex-1">{SUB_SIGNAL_LABEL[adjustment.id] ?? adjustment.id}</span>
                <span className={`font-mono ${adjustment.delta < 0 ? 'text-amber-200/80' : 'text-white/60'}`}>
                  {adjustment.delta > 0 ? '+' : ''}
                  {numberText(adjustment.delta)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div className="text-white/40">触发时的指标值</div>
        {/* 固定两列：右栏只有 ~330px 宽，三列会让指标名与数值挤成一团 */}
        <div className="mt-1 grid grid-cols-2 gap-x-4 font-mono text-white/55">
          {indicators.map(([key, value]) => (
            <span key={key}>
              {key} {numberText(value)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function SignalRow({
  record,
  expanded,
  evidence,
  aiReady,
  onWatchCreated,
  onError,
  onToggle,
}: {
  record: SignalRecord
  expanded: boolean
  evidence: SignalEvidence | null
  /** AI 已配置且已启用。false → 整块不渲染，而不是渲染一个点了报错的按钮 */
  aiReady: boolean
  onWatchCreated: () => void
  onError: (message: string) => void
  onToggle: (id: string) => void
}): React.JSX.Element {
  const suppressed = record.suppressedReason !== undefined
  return (
    // 外层是 div 不是 li：`<li>` 归分组（SignalGroupItem），同一只票的旧条目
    // 是嵌在组里的，不该各自成为列表项
    <div>
      <button className="flex w-full items-center gap-3 text-left" onClick={() => onToggle(record.id)}>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${DIRECTION_TONE[record.direction]}`}
        >
          {DIRECTION_LABEL[record.direction]}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm">{record.name}</span>
            <span className="font-mono text-xs text-white/35">{record.code}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-white/45">
            <span>{REGIME_LABEL[record.regime]}</span>
            <span>·</span>
            <span>{STAGE_LABEL[record.stage]}</span>
            <span>·</span>
            <span>{LEVEL_LABEL[record.level]}</span>
            {suppressed ? <span className="text-amber-200/70">· 已静默：{record.suppressedReason}</span> : null}
          </span>
        </span>

        <span className="shrink-0 text-right">
          {/* 「置信」二字是有意的：不得写成胜率或概率（docs/04 §4.3） */}
          <span className="block font-mono text-sm">置信 {Math.round(record.score * 100)}%</span>
          <span className="block text-xs text-white/40">
            {record.votes} 票 · {timeOf(record.createdAt)} · {numberText(record.priceAt)}
          </span>
        </span>

        {/*
          可展开的提示。整行本来就是按钮，但看不出来 ——「AI 分析开了却找不到入口」
          有一半是这个原因：入口藏在展开区里，而没有任何东西说这行能点。
          开了 AI 就多标一个 AI 字，让入口自己露个头。
        */}
        <span className="shrink-0 self-start pt-0.5 text-[10px] leading-none text-white/25">
          {aiReady ? <span className="mr-1 text-violet-300/50">AI</span> : null}
          <span className="inline-block">{expanded ? '▾' : '▸'}</span>
        </span>
      </button>

      {expanded ? (
        evidence ? (
          <>
            <Evidence evidence={evidence} />
            {/* AI 解读是**只读的解释层**：它不参与闸门，也不点亮状态点。
                未配置时整块不渲染 —— 一个点了就报错的按钮比没有按钮更烦人 */}
            {aiReady ? (
              <AiExplain
                signalId={record.id}
                code={record.code}
                name={record.name}
                onWatchCreated={onWatchCreated}
                onError={onError}
              />
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-xs text-white/40">依据加载中…</p>
        )
      ) : null}
    </div>
  )
}

/** 方向计数徽标。列表与抽屉共用一份 —— 两处对不上比不显示更难查 */
function CountChips({ group }: { group: SignalGroup<SignalRecord> }): React.JSX.Element {
  return (
    <>
      {group.counts.map((item) => (
        <span
          key={item.direction}
          className={`rounded border px-1 py-px text-[10px] leading-4 ${DIRECTION_TONE[item.direction]}`}
        >
          {DIRECTION_LABEL[item.direction]} {item.count} 条
        </span>
      ))}
    </>
  )
}

/**
 * 一只标的的一组信号：常显最新那条，其余在**抽屉**里看。
 *
 * 徽标行是**主行之外**的另一个按钮（见文件头）。它同时管两件事：
 * 看同股的旧信号，以及看当日走势图 —— 两者回答的是同一个问题
 *（「今天这只票到底怎么了」），分开放反而要点两次。
 */
function SignalGroupItem({
  group,
  expandedId,
  evidence,
  aiReady,
  onWatchCreated,
  onError,
  onToggle,
  onOpen,
}: {
  group: SignalGroup<SignalRecord>
  expandedId: string | null
  evidence: Record<string, SignalEvidence>
  aiReady: boolean
  onWatchCreated: () => void
  onError: (message: string) => void
  onToggle: (id: string) => void
  onOpen: (code: SecCode) => void
}): React.JSX.Element {
  return (
    <li className="border-b border-white/[0.06] py-2 last:border-b-0">
      <SignalRow
        record={group.latest}
        expanded={expandedId === group.latest.id}
        evidence={evidence[group.latest.id] ?? null}
        aiReady={aiReady}
        onWatchCreated={onWatchCreated}
        onError={onError}
        onToggle={onToggle}
      />

      <button
        className="mt-1 flex w-full items-center gap-1 text-left"
        onClick={() => onOpen(group.code)}
      >
        {group.total > 1 ? (
          <CountChips group={group} />
        ) : (
          // 只有一条时不重复报「买入 1 条」—— 上面那行已经写着方向了。
          // 但入口留着：走势图对单条信号一样有用
          <span className="text-[10px] leading-4 text-white/30">当日走势</span>
        )}
        <span className="ml-auto shrink-0 text-[10px] leading-4 text-white/25">详情 ›</span>
      </button>
    </li>
  )
}

/** 当天 00:00 的时间戳。信号按 created_at 存的是墙上时刻，列表按「今天」筛 */
function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function SignalList({
  refreshKey,
  aiReady,
  onWatchCreated,
  onError,
}: {
  /** 每轮引擎跑完后由父组件递增，触发重新拉取 */
  refreshKey: number
  /**
   * AI 解读是否可用。**由 App 传进来而不是自己读** —— 概览页常驻挂载，
   * 自己读就只会在应用启动时读那一次（见 App 里 `aiReady` 的注释）。
   */
  aiReady: boolean
  /** 新建观察点成功后通知上层刷新计数与「观察点」页 */
  onWatchCreated: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const [records, setRecords] = useState<SignalRecord[]>([])
  const [showSuppressed, setShowSuppressed] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<Record<string, SignalEvidence>>({})
  /** 抽屉里正在看哪只。null = 抽屉关着 */
  const [drawerCode, setDrawerCode] = useState<SecCode | null>(null)
  /*
    「今天」只在挂载时算一次并存住。每次渲染现算的话，跨午夜那一刻
    `startOfToday()` 会变，走势图的 x 轴与 `signal:history` 的起点就会对不上 ——
    而面板是常驻挂载的（App.tsx 只切 display），真的会跨午夜。
    refreshKey 每轮引擎跑完都递增，届时自然会重新对齐。
  */
  const [dayStart] = useState(startOfToday)

  useEffect(() => {
    let cancelled = false
    void window.gp
      .invoke('signal:history', { from: dayStart, limit: 200 })
      .then((rows) => {
        if (!cancelled) setRecords(rows)
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey, dayStart, onError])

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

  const closeDrawer = useCallback(() => setDrawerCode(null), [])

  /*
    先按「含被静默的」过滤，**再**分组 —— 顺序不能倒过来。
    倒过来的话徽标会数上几条用户当前看不到的信号，而「写着 4 条、展开只有 1 条」
    这种对不上比少显示更难排查（groupSignals 的头注释记着同一条）。
  */
  const { groups, suppressedCount } = useMemo(() => {
    const suppressed = records.filter((r) => r.suppressedReason !== undefined)
    const visible = showSuppressed ? records : records.filter((r) => r.suppressedReason === undefined)
    return { groups: groupSignals(visible), suppressedCount: suppressed.length }
  }, [records, showSuppressed])

  /*
    抽屉认的是 code 而不是快照下来的那个 group 对象：引擎每轮都会推新数据，
    存对象的话抽屉会一直显示打开那一刻的旧内容（而它看起来完全正常）。
    那只票的信号全没了（被「含被静默的」筛掉、或跨了午夜）时 drawer 为 undefined，
    抽屉自然收起来 —— 这比留一个空壳好。
  */
  const drawer = drawerCode === null ? undefined : groups.find((g) => g.code === drawerCode)

  // 卡片自己吃掉右栏剩下的高度，列表在卡片内部滚动 —— 信号是每轮都在长的流水，
  // 让它把整页顶长会把下面的提醒日志推出视野
  return (
    <section className="gp-card min-h-0 flex-1">
      <div className="gp-card-head">
        <h2 className="gp-card-title">今日信号</h2>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-white/40">
          <input
            type="checkbox"
            checked={showSuppressed}
            onChange={(e) => setShowSuppressed(e.target.checked)}
          />
          含被静默的 {suppressedCount} 条
        </label>
      </div>

      {groups.length === 0 ? (
        <p className="px-3 py-8 text-center text-xs text-white/35">
          今日暂无信号。收盘后引擎会做一次确认轮，届时再看。
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-3">
          {groups.map((group) => (
            <SignalGroupItem
              key={group.code}
              group={group}
              expandedId={expandedId}
              evidence={evidence}
              aiReady={aiReady}
              onWatchCreated={onWatchCreated}
              onError={onError}
              onToggle={toggle}
              onOpen={setDrawerCode}
            />
          ))}
        </ul>
      )}

      {/*
        抽屉里的信号行由这里渲染，**共用同一份 expandedId / evidence** ——
        抽屉自己存一套的话，在列表里展开的那条进抽屉会「忘记」自己是展开的，
        而 AI 解读那一块还会因为重新挂载被取消（AiExplain 的卸载即取消）。
      */}
      {drawer ? (
        <SignalDrawer
          group={drawer}
          dayStart={dayStart}
          countChips={<CountChips group={drawer} />}
          renderRow={(record) => (
            <SignalRow
              record={record}
              expanded={expandedId === record.id}
              evidence={evidence[record.id] ?? null}
              aiReady={aiReady}
              onWatchCreated={onWatchCreated}
              onError={onError}
              onToggle={toggle}
            />
          )}
          onError={onError}
          onClose={closeDrawer}
        />
      ) : null}
    </section>
  )
}

export type { SecCode }
