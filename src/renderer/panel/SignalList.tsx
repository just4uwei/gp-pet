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
 *
 * ## 状态在 App 手上，这里只负责画（2026-08-14 二次改造）
 *
 * 抽屉合并成了 `StockDrawer`（行情 / 信号 / 持仓 三页签），而它的另外两个入口在
 * **自选列表**那边。所以 `signal:history` 的拉取、分组、以及「展开了哪一条依据」
 * 全部提到 `App`：抽屉与列表共用同一份 `expandedId` / `evidence`
 * —— 各存一套的话，在列表里展开的那条进抽屉会「忘记」自己是展开的，
 * 展开状态因此共用一份。
 *
 * ## AI 解读已经搬走了（2026-08-14）
 *
 * 这里曾经内嵌 `<AiExplain>`，于是列表的重渲染能把一次正在跑的模型调用摘掉：
 * 每组常显的只有 `latest`，同一只票再来一条信号（盘中每轮 tick 都可能）就换组头，
 * 用户正展开着的那条被挤出列表 → 组件卸载 → 请求取消，而那次调用已经计过费。
 *
 * 现在展开区里只剩一个**打开 AI 抽屉**的按钮，抽屉的状态挂在 `App`，
 * 与这个列表没有父子关系 —— 那才是根治。`pinnedSignal` 保留下来是另一个理由：
 * **正读着的那一行凭空消失本身就烦人**，与 AI 无关。
 */

import type { AlertLevel, GatedDirection, Regime, SecCode } from '@core/types'
import type { SignalEvidence, SignalRecord, WatchPointView } from '@shared/ipc-types'
import { pinnedSignal, type SignalGroup } from '@shared/signal-group'
import { metricLabel } from '@shared/watch-metrics'

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

export function SignalRow({
  record,
  expanded,
  evidence,
  aiReady,
  onOpenAi,
  onToggle,
}: {
  record: SignalRecord
  expanded: boolean
  evidence: SignalEvidence | null
  /** AI 已配置且已启用。false → 整块不渲染，而不是渲染一个点了报错的按钮 */
  aiReady: boolean
  /** 打开 AI 解读抽屉（第二层，状态在 App —— 见展开区里那段注释） */
  onOpenAi: (record: SignalRecord) => void
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
            {/*
              AI 解读**开在另一层抽屉里**，不再内嵌在这里（2026-08-14）。
              内嵌时它长在一个每轮 tick 都在重排的列表里，同一只票来条新信号就被卸载 ——
              而它当时是「卸载即取消」的，用户看到的是分析界面自己没了。
              抽屉的状态挂在 App，与这个列表没有父子关系，这是结构性保证。

              AI 未配置时整块不渲染 —— 一个点了就报错的按钮比没有按钮更烦人。
            */}
            {aiReady ? (
              <button
                className="gp-btn mt-2 w-full justify-center text-[11px]"
                onClick={() => onOpenAi(record)}
              >
                AI 解读（调用你配置的模型，按对方规则计费）›
              </button>
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
export function CountChips({ group }: { group: SignalGroup<SignalRecord> }): React.JSX.Element {
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
 * 观察点命中的一行。**与信号行长得明显不同**是刻意的。
 *
 * 它不是引擎判的，是用户自己设的一个条件到了 —— 所以没有方向徽章、没有置信度，
 * 只有一面旗和「你设的条件」。给它一个买入/卖出徽章会让人以为引擎又出了信号，
 * 而这两件事的可信度来源完全不同（一个是回测过的规则，一个是用户当时的判断）。
 *
 * 措辞与提醒层同源（`alerts/candidates.ts` 的 `watchHitAlert`）：
 * `INVALIDATE` 写「你设的失效条件已出现」，**不许写成「快卖」**（措辞纪律）。
 */
function WatchHitRow({ hit }: { hit: WatchPointView }): React.JSX.Element {
  const opLabel = hit.op === 'LTE' ? '跌破' : '升破'
  return (
    <div className="flex items-start gap-3 py-0.5">
      <span className="shrink-0 rounded border border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[11px] text-sky-200">
        ⚑ 观察点
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs leading-snug text-white/70">
          {hit.meaning === 'INVALIDATE' ? '你设的失效条件已出现' : '你设的观察条件已满足'}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-white/45">
          <span>
            {metricLabel(hit.metric)}
            {opLabel} {hit.threshold}
          </span>
          {hit.hitValue !== undefined ? (
            <>
              <span>·</span>
              <span className="font-mono">实际 {hit.hitValue}</span>
            </>
          ) : null}
          {hit.hitAt !== undefined ? (
            <>
              <span>·</span>
              <span>{timeOf(hit.hitAt)}</span>
            </>
          ) : null}
        </span>
      </span>
    </div>
  )
}

/**
 * 一只标的的时间线：信号与观察点命中按时间穿插，**这只票今天怎么变的**一眼看完。
 *
 * 徽标行是**时间线之外**的另一个按钮（见文件头）。它同时管两件事：
 * 看同股的旧信号，以及看当日走势图 —— 两者回答的是同一个问题
 *（「今天这只票到底怎么了」），分开放反而要点两次。
 *
 * ## 只画时间线的头 + 正展开着的那条
 *
 * 全部都画会让一只活跃的票占满整个列表（这就是当初分组的理由）。但**只画头**时，
 * 同一只票再来一条信号会把用户正展开着、正在读依据的那条挤掉 ——
 * 界面在他眼皮底下换了内容，而他什么都没做。判据是纯函数 `pinnedSignal`
 * （在 shared，有用例），这里只负责画。
 *
 * （这条最初是为了挡「正在跑的 AI 解读被卸载取消」加的。AI 已经搬进抽屉页签、
 * 不再受这个列表影响了，但这一条本身仍然成立 —— 理由换了，行为不变。）
 */
function SignalGroupItem({
  group,
  expandedId,
  renderRow,
  onOpen,
}: {
  group: SignalGroup<SignalRecord, WatchPointView>
  /** 当前展开的信号 id。时间线头之外的那条要靠它决定钉不钉住 */
  expandedId: string | null
  renderRow: (record: SignalRecord) => React.JSX.Element
  onOpen: (code: SecCode) => void
}): React.JSX.Element {
  const pinned = pinnedSignal(group, expandedId)
  const head = group.events[0]
  /*
    时间线的头是命中时，把**最新那条信号**一起画出来 ——
    「你设的条件到了」单独摆着回答不了「那现在该怎么看这只票」，
    而那条信号就是当时的判断。两行挨着才是用户要的那个「变化」。
  */
  const headIsHit = head?.kind === 'HIT'

  return (
    <li className="border-b border-white/[0.06] py-2 last:border-b-0">
      {headIsHit && head.kind === 'HIT' ? <WatchHitRow hit={head.hit} /> : null}

      <div className={headIsHit ? 'mt-1.5' : ''}>{renderRow(group.latest)}</div>

      {/* 头之后的其余命中（一天里可能命中好几个观察点），按时间接着排 */}
      {group.events
        .slice(1)
        .filter((event) => event.kind === 'HIT')
        .map((event) =>
          event.kind === 'HIT' ? (
            <div key={event.hit.id} className="mt-1">
              <WatchHitRow hit={event.hit} />
            </div>
          ) : null
        )}

      {/*
        钉住的那条画在最后：新来的必须在最上面（这是这个列表的本职），
        用户正在看的那条跟在后面。加一行说明是因为「同一只票凭空多出一行」
        本身会让人困惑 —— 不说的话，看起来像列表出了重复。
      */}
      {pinned ? (
        <div className="mt-2 border-l-2 border-violet-400/25 pl-2">
          <p className="mb-1 text-[10px] leading-snug text-white/30">
            上面是刚到的新动态；这条是你正在看的那条，留在这里没有打断它。
          </p>
          {renderRow(pinned)}
        </div>
      ) : null}

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
        {/* 命中数单独一个 chip：它与方向计数不是同一类东西，合进去就再也拆不开 */}
        {group.hits.length > 0 ? (
          <span className="rounded border border-sky-400/40 bg-sky-400/10 px-1 py-px text-[10px] leading-4 text-sky-200">
            观察点命中 {group.hits.length} 次
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] leading-4 text-white/25">详情 ›</span>
      </button>
    </li>
  )
}

export function SignalList({
  groups,
  expandedId,
  suppressedCount,
  showSuppressed,
  onShowSuppressed,
  renderRow,
  onOpen,
}: {
  /** 已按「含被静默的」筛过、并分好组的数据。拉取与分组都在 App（见文件头） */
  groups: readonly SignalGroup<SignalRecord, WatchPointView>[]
  /** 当前展开的信号 id。用来把它钉在组里，别被新信号挤掉（见 SignalGroupItem） */
  expandedId: string | null
  suppressedCount: number
  showSuppressed: boolean
  onShowSuppressed: (next: boolean) => void
  /** 信号行交给 App 渲染 —— 展开依据 / AI 的状态在那边，与抽屉共用 */
  renderRow: (record: SignalRecord) => React.JSX.Element
  onOpen: (code: SecCode) => void
}): React.JSX.Element {
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
            onChange={(e) => onShowSuppressed(e.target.checked)}
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
              renderRow={renderRow}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

export type { SecCode }
