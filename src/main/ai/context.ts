/**
 * 发给模型的上下文构造（P2）。**纯模块**：不读时钟、不碰 IO、不 import Electron。
 *
 * ## 一条纪律：必须带上参数标定状态
 *
 * `calibration` 那一块看着像凑数，它是这个功能里最重要的一行。缺了它，模型会**默认**
 * 引擎结论是经过验证的，然后用非常有说服力的语气把一套未标定的转述阈值讲成定论
 * —— 那正是 [ADR-0003](../../../docs/adr/ADR-0003-来源文档数值不作为出厂默认.md) 要防的事。
 * `tests/unit/main/ai-context.test.ts` 钉着这一块必须存在。
 *
 * ## 不发原始 K 线
 *
 * 指标已经在本地算好了（而且是按 docs/04 的口径算的：MACD 柱用 2×(DIF−DEA)、
 * 布林带除 n 不除 n−1）。再发 300 根 OHLC 只会烧 token，并且给模型一个用**别的口径**
 * 自己重算、然后报出与面板不一致的数字的机会。
 */

import { ADJUSTMENT_LABELS, DIRECTION_LABELS, REGIME_LABELS, subSignalLabel } from '@core/risk/text'
import type { ParamRow, PositionView, SignalEvidence, SignalRecord } from '@shared/ipc-types'
import type { AiSignalContext } from './types'

const STAGE_LABELS: Record<SignalRecord['stage'], string> = {
  PROVISIONAL: '盘中临时（K 线未收，指标会抖）',
  CONFIRMED: '收盘确认',
  INVALIDATED: '收盘失效（盘中那条已被撤销）',
}

const LEVEL_LABELS: Record<SignalRecord['level'], string> = {
  L1: 'L1 静默（只记日志，不打扰）',
  L2: 'L2 气泡',
  L3: 'L3 气泡（同键当日仅一次）',
}

export interface BuildContextInput {
  record: SignalRecord
  evidence: SignalEvidence
  /** 提醒闸门的结论。缺省 = 这条没有对应的 alert_log 行（风控硬抑制的信号不进那张表） */
  gate?: { delivered: boolean; reason?: string }
  position?: PositionView
  /** 当前生效的参数表（含每项标定状态），来自 `paramRows()` */
  params: readonly ParamRow[]
  engineVersion: string
  /** 触发时刻的可读字符串，**由调用方格式化**（本模块不读时钟） */
  at: string
}

export function buildSignalContext(input: BuildContextInput): AiSignalContext {
  const { record, evidence, gate, position, params, engineVersion, at } = input

  const calibratedKeys = params
    .filter((row) => row.status === 'CALIBRATED')
    .map((row) => `${row.group}.${row.key}`)

  const counts = { CALIBRATED: 0, KEPT: 0, INERT: 0, UNTESTABLE: 0, GUESS: 0 }
  for (const row of params) counts[row.status]++

  const context: AiSignalContext = {
    security: { code: record.code, name: record.name },
    at,
    quote: { price: record.priceAt, changePct: null },
    verdict: {
      direction: DIRECTION_LABELS[record.direction],
      score: record.score,
      votes: record.votes,
      regime: REGIME_LABELS[record.regime],
      stage: STAGE_LABELS[record.stage],
      level: LEVEL_LABELS[record.level],
    },
    subSignals: evidence.subSignals.map((sub) => ({
      id: sub.id,
      label: subSignalLabel(sub),
      direction: sub.direction === 'SELL' ? '卖出' : '买入',
      score: sub.score,
      weight: sub.weight,
    })),
    adjustments: evidence.adjustments.map((item) => ({
      id: item.id,
      label: ADJUSTMENT_LABELS[item.id] ?? item.id,
      delta: item.delta,
    })),
    // null 是「没预热出来」，不是 0（约束 4）—— 直接丢掉，不给模型一个假的 0
    indicators: Object.fromEntries(
      Object.entries(evidence.indicatorsAt).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )
    ),
    gate: gate ?? {
      delivered: false,
      reason: record.suppressedReason ?? '无对应提醒记录（风控硬抑制的信号不进提醒日志）',
    },
    calibration: {
      engineVersion,
      calibrated: counts.CALIBRATED,
      kept: counts.KEPT,
      inert: counts.INERT,
      untestable: counts.UNTESTABLE,
      guess: counts.GUESS,
      calibratedKeys,
    },
  }

  if (position !== undefined) {
    context.position = {
      shares: position.shares,
      cost: position.cost,
      pnlPct:
        position.cost > 0 && Number.isFinite(record.priceAt)
          ? ((record.priceAt - position.cost) / position.cost) * 100
          : null,
    }
  }

  return context
}

function num(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

/**
 * 结构化上下文 → 用户消息文本。
 *
 * 用中文小标题而不是甩一坨 JSON：一是模型对前者的遵循度更好，二是这段文本会进日志，
 * 而「这次到底发了什么给对面」是要能一眼看懂的。
 */
export function renderContext(context: AiSignalContext): string {
  const lines: string[] = []

  lines.push(`## 标的`)
  lines.push(`${context.security.name}（${context.security.code}），信号时刻 ${context.at}`)
  lines.push(`触发价 ${num(context.quote.price)}`)

  lines.push('')
  lines.push(`## 本地引擎判了什么`)
  lines.push(`方向：${context.verdict.direction}`)
  lines.push(`置信度：${(context.verdict.score * 100).toFixed(0)}%（这是规则一致性的度量，不是胜率也不是概率）`)
  lines.push(`票数：${context.verdict.votes}`)
  lines.push(`市场状态：${context.verdict.regime}`)
  lines.push(`阶段：${context.verdict.stage}`)
  lines.push(`提醒级别：${context.verdict.level}`)

  lines.push('')
  lines.push(`## 凭什么判的（子信号）`)
  if (context.subSignals.length === 0) {
    lines.push('无 —— 该条由风控规则产生，不来自策略得分')
  } else {
    for (const sub of context.subSignals) {
      lines.push(
        `- ${sub.label}（${sub.id}，${sub.direction}）强度 ${num(sub.score)} × 权重 ${num(sub.weight)}`
      )
    }
  }

  if (context.adjustments.length > 0) {
    lines.push('')
    lines.push(`## 多周期调整`)
    for (const item of context.adjustments) {
      lines.push(`- ${item.label}（${item.id}）${item.delta > 0 ? '+' : ''}${num(item.delta)}`)
    }
  }

  const indicators = Object.entries(context.indicators)
  if (indicators.length > 0) {
    lines.push('')
    lines.push(`## 触发时的指标值`)
    lines.push('（口径见下方「计算口径」一节，请勿用别的口径重算后报出不同的数）')
    for (const [key, value] of indicators) lines.push(`- ${key} = ${num(value, 4)}`)
  }

  lines.push('')
  lines.push(`## 提醒闸门`)
  lines.push(
    context.gate.delivered
      ? '这条真的弹了气泡'
      : `这条没有弹出来。原因：${context.gate.reason ?? '未记录'}`
  )

  if (context.position !== undefined) {
    lines.push('')
    lines.push(`## 用户持仓`)
    lines.push(
      `${context.position.shares} 股，成本 ${num(context.position.cost)}，` +
        `浮动盈亏 ${context.position.pnlPct === null ? '—' : `${num(context.position.pnlPct)}%`}`
    )
  }

  lines.push('')
  lines.push(`## 参数标定状态（重要，回答时必须据此把握口径）`)
  const c = context.calibration
  lines.push(`引擎版本 ${c.engineVersion}`)
  lines.push(
    `参数共 ${c.calibrated + c.kept + c.inert + c.untestable + c.guess} 项：` +
      `已标定并写回 ${c.calibrated} 项、已上网格但保持出厂值 ${c.kept} 项、` +
      `已判惰性 ${c.inert} 项、日线回测原理上测不到 ${c.untestable} 项、` +
      `**一个网格都没跑过 ${c.guess} 项**。`
  )
  lines.push(
    c.calibratedKeys.length === 0
      ? '没有任何一项经过本地回测标定。'
      : `真正标定过的只有：${c.calibratedKeys.join('、')}。`
  )
  lines.push(
    '也就是说：上面这些阈值绝大多数来自公开资料的转述，没有本地证据支持。' +
      '解释信号为什么触发是可以的，但**不得**把这套规则说成「经过验证」「有效」或「准确」。'
  )

  lines.push('')
  lines.push(`## 计算口径（与常见平台的差异，别按通用公式重算）`)
  lines.push('- MACD 柱 = 2×(DIF−DEA)（国内平台口径）')
  lines.push('- 布林带标准差除 n，不是 n−1（国内平台口径）')
  lines.push('- 指标一律用前复权价计算；展示价与持仓成本用不复权价')
  lines.push('- 盘中量比按时间归一化后再比')

  return lines.join('\n')
}
