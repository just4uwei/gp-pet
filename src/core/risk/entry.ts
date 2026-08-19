/**
 * 建仓体检（2026-08-19）：用户自己想买一只票时，把「已知的阻碍」摆出来。
 *
 * ## 它是什么
 *
 * 引擎平时只在自己出信号时说话。用户自己决定要买的时候，那些判据一条都到不了他眼前 ——
 * 而它们**全都已经算得出来**：涨停买不到、停牌、次新股、ST、波动率历史高位、
 * 行业集中度、快照陈旧、引擎此刻正判卖出、这一笔是加在一个已触发止损的持仓上。
 * 这个函数只做一件事：把 `hardSuppressions()` / `downgrades()` / `positionVerdict()`
 * 按**买入**方向跑一遍，连同两个可核对的事实（这一笔的止损参考价、现价在今日振幅中的位置）
 * 一起交出去。
 *
 * ## ⚠ 三条边界，改这里之前先读
 *
 * 1. **只复述，不推导。** 与 `report/build.ts` 的 `tomorrow` 同一条纪律：每一项都指回
 *    一个**已经存在**的裁决或一个能核对的数。让它自己判「今天涨得多、追高危险」会造出
 *    一个可能与信号层相反的结论，**而用户没有办法判断该信哪个**。
 * 2. **一个新阈值都不许有**（约束 2 / ADR-0003）。全部判据来自已有的
 *    `hardSuppressions` / `downgrades` / `positionVerdict` / `risk.stopLossPct` /
 *    `risk.industryConcentrationCap`。往这里加一个「涨幅超过 X% 就警告」的数，
 *    等于凭空造一个未标定的参数，而它会挂着「体检」这个看起来很权威的名字。
 *    因此 `dayPosition` **只报位置，不判高低** —— 判高低要阈值。
 * 3. **`verdict` 是纯派生**：有 BLOCK 就 BLOCKED，否则有 WARN 就 CAUTION，否则 CLEAR。
 *    没有分数、没有加权、没有排序权重。它答的是「有没有已知的阻碍」，
 *    **不是「该不该买」** —— 措辞上一律不出现「可以买 / 建议买入 / 值得买」。
 *
 * 「体检做不了」（拿不到评估）由**调用方**表达，不在这里编一个 CLEAR 出来：
 * 「不知道」显示成「没问题」是这个项目一直在防的那类错误。
 */

import type { EngineParams } from '../params'
import type { CombinedSignal, Position, Snapshot } from '../types'
import { DIRECTION_LABELS, REGIME_LABELS, confidenceText } from './text'
import { downgrades, hardSuppressions, positionVerdict, type GateInput } from './index'

/** BLOCK 这一刻执行不了 · WARN 有已知风险 · NOTE 事实陈述，不含判断 */
export type EntrySeverity = 'BLOCK' | 'WARN' | 'NOTE'

export type EntryVerdict = 'BLOCKED' | 'CAUTION' | 'CLEAR'

export interface EntryCheckItem {
  /** 命中的规则 ID。与 `RiskVerdict.rule` 同一套命名，便于与提醒日志对照 */
  rule: string
  severity: EntrySeverity
  text: string
}

export interface EntryCheckInput {
  /**
   * 与 `gateSignal()` **同一份**上下文。刻意不另拼一个精简版：
   * 两份上下文会让「体检说没事、提醒说涨停买不到」这种分叉变得可能，
   * 而用户没有任何办法判断哪个才对。
   */
  gate: GateInput
  /** 用户填的意向价与股数。都缺省时只出结构性的那几条 */
  intent?: { price?: number | undefined; shares?: number | undefined } | undefined
  /**
   * 建仓**之后**该行业在持仓中的占比 0..1，由主进程按「加上这一笔」算。
   * `undefined` = 算不出来（没有持仓、拿不到价），**不是 0** —— 0 是个明确的结论
   * （完全没有同行业持仓），会让规则永不触发且看不出是缺数据（约束 4）。
   */
  industryShareAfter?: number | undefined
}

export interface EntryCheckResult {
  verdict: EntryVerdict
  /** 按严重程度排序：BLOCK → WARN → NOTE */
  items: EntryCheckItem[]
  /**
   * 这一笔的止损参考：按 `risk.stopLossPct` 从**意向价**算出来的那条线。
   * 不是新阈值，是把引擎已经在用的那条线应用到用户填的数上。
   * 没填意向价时缺省。
   */
  stop?: { price: number; lossPerShare: number; lossAmount?: number }
  /**
   * 现价在今日振幅中的位置 0..1（0 = 今日最低，1 = 今日最高）。
   * 四个数（high/low/last/preClose）缺一个就不给 —— 用 0 兜底会算出一个假位置，
   * 而它看起来和真的一模一样（与 `tTradeAdvice` 同一条纪律）。
   */
  dayPosition?: number
  /** 这一笔的名义金额（价 × 股数，**不含费**）。填全了才有 */
  amount?: number
}

const SEVERITY_ORDER: Record<EntrySeverity, number> = { BLOCK: 0, WARN: 1, NOTE: 2 }

export function entryCheck(input: EntryCheckInput): EntryCheckResult {
  const { gate, intent, industryShareAfter } = input
  const params = gate.params
  const items: EntryCheckItem[] = []

  // ① 硬抑制：这一刻**执行不了**（停牌 / 数据不足 / 次新股 / 已涨停 / 快照陈旧）。
  //    按 BUY 方向跑 —— 体检问的就是「我现在买得进吗」
  for (const verdict of hardSuppressions(gate, 'BUY')) {
    items.push({ rule: verdict.rule, severity: 'BLOCK', text: verdict.reason })
  }

  // ② 降级规则：能执行，但有已知风险（T+1 尾盘 / ST / 行业集中度 / 波动率历史高位）
  for (const verdict of downgrades(gate, 'BUY')) {
    items.push({ rule: verdict.rule, severity: 'WARN', text: verdict.reason })
  }

  /*
    ③ 已有持仓且风控正在给强制裁决 —— 这一笔是**加仓**，而引擎正建议减/卖。
       这是体检最值钱的一条：单看行情看不出「我正在往一个已经触发止损的坑里加钱」。
       只复述那条裁决自己的说法，不另起一句结论。
  */
  const forced = positionVerdict(gate)
  if (forced) {
    items.push({
      rule: forced.verdict.rule,
      severity: 'WARN',
      text: `这一笔是加仓，而持仓风控正在给「${DIRECTION_LABELS[forced.direction]}」：${forced.verdict.reason}`,
    })
  }

  // ④ 引擎此刻的结论。**只复述**：方向相反时算一条 WARN，其余是 NOTE
  items.push(engineItem(gate.signal))

  /*
    ⑤ 建仓后的行业集中度。复用 `downgrades()` 里那条规则的**同一个上限**，
       只是把分母换成「加上这一笔之后」—— 那条规则看的是现状，
       而用户此刻想知道的是「买完会不会超」。
  */
  if (industryShareAfter !== undefined && industryShareAfter > params.risk.industryConcentrationCap) {
    items.push({
      rule: 'INDUSTRY_CONCENTRATION_AFTER',
      severity: 'WARN',
      text: `建仓后${gate.profile.industry ?? '同行业'}持仓占比将达 ${(industryShareAfter * 100).toFixed(0)}%（上限 ${(params.risk.industryConcentrationCap * 100).toFixed(0)}%）`,
    })
  }

  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])

  const result: EntryCheckResult = {
    verdict: items.some((item) => item.severity === 'BLOCK')
      ? 'BLOCKED'
      : items.some((item) => item.severity === 'WARN')
        ? 'CAUTION'
        : 'CLEAR',
    items,
  }

  const stop = stopReference(intent, gate.position, params)
  if (stop) result.stop = stop

  const day = dayPositionOf(gate.snapshot)
  if (day !== null) result.dayPosition = day

  const price = positiveOf(intent?.price)
  const shares = positiveOf(intent?.shares)
  if (price !== null && shares !== null) result.amount = price * Math.trunc(shares)

  return result
}

/**
 * 引擎此刻怎么看。**这一条永远在**（哪怕方向是 NONE）——
 * 「引擎今天对这只票没有意见」本身就是体检要回答的问题之一，
 * 少了它用户会以为体检漏看了信号。
 */
function engineItem(signal: CombinedSignal): EntryCheckItem {
  const regime = REGIME_LABELS[signal.regime]
  if (signal.direction === 'SELL') {
    return {
      rule: 'ENGINE_OPPOSITE',
      severity: 'WARN',
      text: `引擎此刻判「卖出」（${regime} · ${confidenceText(signal.score)}），与买入方向相反`,
    }
  }
  if (signal.direction === 'NONE') {
    return {
      rule: 'ENGINE_VIEW',
      severity: 'NOTE',
      text: `引擎此刻无一致信号（${regime}）—— 这一笔完全由你自己判断`,
    }
  }
  return {
    rule: 'ENGINE_VIEW',
    severity: 'NOTE',
    text: `引擎此刻判「买入」（${regime} · ${confidenceText(signal.score)}）`,
  }
}

/**
 * 这一笔的止损参考线。
 *
 * **用户已经画过线的持仓不给**（`position.stopFloor`）：那条线是他对**当前这段持仓**
 * 的决定，而加仓会清空它（`PositionRepo.set` 里的 `= NULL`）—— 在这里按老线报一个数，
 * 报的是一条录完这笔就不存在的线。
 */
function stopReference(
  intent: EntryCheckInput['intent'],
  position: Position | undefined,
  params: EngineParams
): EntryCheckResult['stop'] {
  if (position?.stopFloor !== undefined && position.stopFloor > 0) return undefined
  const price = positiveOf(intent?.price)
  if (price === null) return undefined

  const stopPrice = round2(price * (1 - params.risk.stopLossPct))
  const lossPerShare = round2(price - stopPrice)
  const shares = positiveOf(intent?.shares)
  return {
    price: stopPrice,
    lossPerShare,
    ...(shares === null ? {} : { lossAmount: round2(lossPerShare * Math.trunc(shares)) }),
  }
}

/** 现价在今日振幅中的位置。四个数缺一个就返回 null（约束 4） */
function dayPositionOf(snapshot: Snapshot | undefined): number | null {
  if (!snapshot || snapshot.suspended) return null
  const { high, low, last, preClose } = snapshot
  if (!(high > 0 && low > 0 && last > 0 && preClose > 0)) return null
  if (high <= low) return null
  return (last - low) / (high - low)
}

function positiveOf(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
