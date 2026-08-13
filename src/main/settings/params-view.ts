/**
 * 设置页那张**只读**参数表（docs/01 §5.5、ADR-0003）。
 *
 * ## 为什么是只读
 *
 * docs/01 §5.5 把「策略参数」列进了设置项，但 ADR-0003 说 `params.ts` 里的数值几乎
 * 全部是未标定的转述猜测。给用户一个自由编辑框，等于让他在没有任何回测依据的情况下
 * 换一个同样没有依据的值 —— 期望收益为零，而排查成本很高：
 * 「改坏了 → 一条信号都不出 → 以为程序坏了」这条路用户走不出来，也不会想到是自己改的。
 *
 * 所以设置页可调的只有**灵敏度三档**（同样标注未标定）与提醒级别偏移，
 * 参数表本身只回答一个问题：**这个数是哪来的、测过没有。**
 *
 * ## 这张表的价值在 `status` 那一列
 *
 * 一张不分档的参数表会让二十来个数值看起来同等可信 —— 那正是 ADR-0003 要防的事。
 * 分档之后用户（和三个月后的自己）能一眼看出：真正被标定过并写回的**只有一项**。
 *
 * `STATUS` 的每一条都对着偏差报告里的一节。**改 `params.ts` 的值时要一起改这里**：
 * `tests/unit/main/params-view.test.ts` 钉住了两条不变量 ——
 * ① 每个叶子参数都要有归档（漏了会掉进 `GUESS`，那不是默认值而是结论）；
 * ② `CALIBRATED` 集合必须**恰好**是 params.ts 顶部那张已标定清单。
 */

import { DEFAULT_PARAMS } from '@core/params'
import type { ParamRow } from '@shared/ipc-types'

type Status = ParamRow['status']

/**
 * 逐参数归档。键是点分路径（`combine.voteThreshold.trend`），
 * 前缀命中即生效 —— 整块同档时不必逐叶子写。
 */
const STATUS: Record<string, { status: Status; note?: string }> = {
  // ── 已标定并写回（M2 清单 4.9a）。**目前只有这一项** ──────────────
  'strategy.squeezeBbwPct': {
    status: 'CALIBRATED',
    note: '2026-08-12 标定：出厂 10 被验证集红线淘汰，16–30 是通过的高原，取 20（M2 §5.10）',
  },

  // ── 已上网格、裁决保持出厂值（M2 清单 4.9c）─────────────────────
  'combine.scoreThreshold': { status: 'KEPT', note: '15 个候选最大 t = 1.4，怎么动都测不出差别（§5.15）' },
  'combine.voteThreshold': { status: 'KEPT', note: '任一策略达到自己的线即触发，不是两边相加（§5.14）' },
  'combine.conflictBand': { status: 'KEPT', note: '「压掉双方」优于「弱侧让路」已单独验证（§5.12）' },
  'adx.baseThreshold': {
    status: 'KEPT',
    note: '有正面证据：±2 与 ±4 邻域全部更差，两个邻居让训练集亏钱被淘汰（§5.16/§5.17）',
  },
  'adx.volScale': { status: 'KEPT', note: '有正面证据：6 与 10 各 −0.16pp（§5.17）' },
  'adx.period': { status: 'KEPT', note: '随 adx 块一同上过网格' },
  'adx.rangeGap': { status: 'KEPT', note: '随 adx 块一同上过网格' },
  'regime.hysteresisDays': {
    status: 'KEPT',
    note: '1 明显更差（−0.34pp），2–6 分辨不出。若为「少改口」上调，判据是提醒日志不是回测（§5.17）',
  },
  'regime.rangeMidBand': { status: 'KEPT', note: '四个邻域取值全负但非单调、t ≤ 1.6，噪音的形状（§5.17）' },
  'risk.stopLossPct': { status: 'KEPT', note: '96.6% 的离场由风控触发，这一块已上网格（§5.18）' },
  'risk.drawdownReducePct': {
    status: 'KEPT',
    note: '**最优先复核**：7% → 10% 四个口径同向改善，但 t = 0.77 不达标，需扩池到约 264 只（§5.18）',
  },
  'risk.profitProtectTrigger': {
    status: 'KEPT',
    note: '验证集 Calmar 翻倍是陷阱 —— 训练集与建仓级胜率全线低于出厂，被写回门槛挡下（§5.18）',
  },
  'risk.profitProtectFallback': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },
  'risk.trailingStopPct': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },
  'risk.industryConcentrationCap': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },
  'risk.newListingMinBars': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },

  // ── 已判参数惰性或算术无效（M2 清单 4.9c 的另一半）───────────────
  'combine.downtrendBuyPenalty': {
    status: 'INERT',
    note: '0.25/0.5/0.75 逐折逐位相同 —— 不是效应小，是没有效应（§5.15）',
  },
  'adx.maxThreshold': {
    status: 'INERT',
    note: '算术上的死参数：clamp 的被夹项 ≤ base + volScale = 28，上界永远咬不住。别扫上侧（§5.16）',
  },
  'strategy.revertLookback': {
    status: 'INERT',
    note: '取 3/5/8/12/20 验证集逐位相同；根因在票数线不在取值（§5.11）',
  },
  'multiTf.weekCrossLookback': { status: 'INERT', note: '大半取值动 0/12 折，改了等于没改（§5.18）' },
  'multiTf.dayRsiBuyMax': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.dayRsiSellMin': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.weekAdxConfirm': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.weekAdxWeak': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.resonanceDelta': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.falseBreakoutDelta': { status: 'INERT', note: '同上（§5.18）' },

  // ── 日线回测原理上测不到（归影子运行 / M3 提醒日志）───────────────
  'combine.provisionalDiscount': {
    status: 'UNTESTABLE',
    note: '回测只判收盘线，走不到盘中折价这条分支。依据须来自影子运行',
  },
  'alert.bubbleScore': {
    status: 'UNTESTABLE',
    note: '判据是提醒日志里「今天这几条值不值得被打断」，不是回测 Calmar（M3 验收 §4）',
  },
  'risk.lateBuyCutoffMinutes': { status: 'UNTESTABLE', note: '回测按次日开盘成交，没有「14:50 之后」这件事' },
  'data.staleSnapshotMs': { status: 'UNTESTABLE', note: '回测没有实时快照，这条分支走不到' },

  // ── 一个网格都没跑过（docs/08 M2 那一行点了名的四块）──────────────
  macd: { status: 'GUESS', note: '一个网格都没跑过。12/17/9 来自来源文档转述（docs/04 §1.2）' },
  boll: { status: 'GUESS', note: '一个网格都没跑过。标准差除 n 而非 n−1 是国内平台口径' },
  volume: { status: 'GUESS', note: '一个网格都没跑过' },
  rsi: { status: 'GUESS', note: '一个网格都没跑过' },
  ma: { status: 'GUESS', note: '一个网格都没跑过' },
  'strategy.pullbackLookback': { status: 'GUESS', note: '未测' },
  'strategy.midReversionStd': { status: 'GUESS', note: '未测' },
  'strategy.expandedBbwPct': { status: 'GUESS', note: '未测（docs/04 §1.4 的「> 90 趋势末端」转述）' },
  'regime.rangeBbwPct': { status: 'GUESS', note: '未测（docs/04 §1.4 的「< 30 收敛」转述）' },
  'regime.adxSlopeWindow': { status: 'GUESS', note: '未测' },
  'regime.adxSlopeTrigger': { status: 'GUESS', note: '未测' },
  'regime.bbwPctJump': { status: 'GUESS', note: '未测' },
  'data.minBars': { status: 'GUESS', note: '未测' },
  'data.fullBars': { status: 'GUESS', note: '未测' },
  'data.insufficientPenalty': { status: 'GUESS', note: '未测' },
}

/**
 * `enabledStrategies` 不进参数表。
 *
 * 它是**消融测量工具**而不是可标定参数（params.ts 的注释写着），出厂两项必须都是 true。
 * 摆到设置页里会立刻变成一个「关掉均值回归试试」的开关 —— 而均值回归已经被误判过两次死刑，
 * 两次都是别的东西的锅（M2 §5.9/§5.10）。
 */
const HIDDEN_GROUPS = new Set(['enabledStrategies'])

function lookup(path: string): { status: Status; note?: string } {
  // 最长前缀优先：`combine.voteThreshold.trend` 命中 `combine.voteThreshold`
  const parts = path.split('.')
  for (let i = parts.length; i > 0; i--) {
    const hit = STATUS[parts.slice(0, i).join('.')]
    if (hit) return hit
  }
  // 兜底成 GUESS 而不是抛错：漏归档的参数照样要显示出来，
  // 而单测会告诉我们漏了哪一个（见文件头不变量 ①）
  return { status: 'GUESS', note: '未归档 —— 请补 params-view.ts 的 STATUS 表' }
}

function render(value: unknown): string {
  if (Array.isArray(value)) return value.join(' / ')
  return String(value)
}

/**
 * 摊平 `DEFAULT_PARAMS` 成表格行。
 *
 * 传 `params` 可以摊平「当前生效的」参数集（含灵敏度换档后的值），
 * 默认摊出厂值。嵌套对象（`combine.voteThreshold`）逐叶子展开成 `voteThreshold.trend`。
 */
export function paramRows(params: object = DEFAULT_PARAMS): ParamRow[] {
  const rows: ParamRow[] = []

  const walk = (group: string, prefix: string, value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(group, prefix === '' ? key : `${prefix}.${key}`, child)
      }
      return
    }
    const archived = lookup(`${group}.${prefix}`)
    rows.push({
      group,
      key: prefix,
      value: render(value),
      status: archived.status,
      ...(archived.note === undefined ? {} : { note: archived.note }),
    })
  }

  for (const [group, block] of Object.entries(params)) {
    if (HIDDEN_GROUPS.has(group)) continue
    walk(group, '', block)
  }
  return rows
}

/** 供 UI 显示「已标定 1 / 已测 16 / 惰性 10 / 测不到 4 / 未测 15」这一行 */
export function countByStatus(rows: readonly ParamRow[]): Record<Status, number> {
  const counts: Record<Status, number> = {
    CALIBRATED: 0,
    KEPT: 0,
    INERT: 0,
    UNTESTABLE: 0,
    GUESS: 0,
  }
  for (const row of rows) counts[row.status]++
  return counts
}
