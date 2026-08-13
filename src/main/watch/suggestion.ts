/**
 * 从一段 AI 解读里抽出观察点建议（纯函数，零依赖）。
 *
 * ## 唯一的设计原则：抽不到不是错误
 *
 * 模型不照格式输出是**常态**（换个模型、换个温度、上下文长一点就可能漏）。
 * 所以这里所有失败路径 —— 缺整块、格式乱、数值非法、metric 不在白名单 ——
 * 统统当作「没有建议」返回空数组，让表单留空由用户自己填。
 *
 * **绝不抛错、绝不猜。** 抽错一个数比抽不到糟得多：抽不到用户会自己填，
 * 抽错了用户可能直接点确认，然后跟踪一个错的条件。
 *
 * 期望格式（提示词里要求的）：
 *
 * ```
 * <观察点建议>
 * metric=PRICE op=LTE threshold=8.20 meaning=INVALIDATE 说明=跌破 20 日均线支撑
 * </观察点建议>
 * ```
 */

import type { WatchSuggestion } from '@shared/ipc-types'
import { isWatchMetric } from './metrics'

/** 最多接受两条 —— 提示词也这么要求。多了是模型在灌，不是在建议 */
const MAX_SUGGESTIONS = 2

const BLOCK = /<观察点建议>([\s\S]*?)<\/观察点建议>/

/** `key=value` 抽取。value 取到下一个 `key=` 或行尾为止，所以「说明」里可以有空格 */
function field(line: string, key: string): string | null {
  const pattern = new RegExp(`${key}\\s*=\\s*(.*?)(?=\\s+[a-zA-Z\u4e00-\u9fa5]+\\s*=|$)`)
  const hit = pattern.exec(line)
  const value = hit?.[1]?.trim()
  return value === undefined || value === '' ? null : value
}

function parseLine(line: string): WatchSuggestion | null {
  const metric = field(line, 'metric')
  const op = field(line, 'op')
  const threshold = field(line, 'threshold')
  const meaning = field(line, 'meaning')
  if (metric === null || op === null || threshold === null) return null

  // metric 白名单：模型可能写出「资金流入强度」这种本地根本算不出来的东西，
  // 而它看起来完全合理 —— 用户确认下去之后那个观察点永远不会命中
  if (!isWatchMetric(metric)) return null

  const upperOp = op.toUpperCase()
  if (upperOp !== 'LTE' && upperOp !== 'GTE') return null

  const value = Number(threshold)
  if (!Number.isFinite(value)) return null

  const upperMeaning = (meaning ?? 'INVALIDATE').toUpperCase()
  const resolved = upperMeaning === 'CONFIRM' ? 'CONFIRM' : 'INVALIDATE'

  const suggestion: WatchSuggestion = {
    metric,
    op: upperOp,
    threshold: value,
    meaning: resolved,
  }
  const note = field(line, '说明') ?? field(line, 'note')
  if (note !== null) suggestion.note = note.slice(0, 200)
  return suggestion
}

export function parseWatchSuggestions(text: string): WatchSuggestion[] {
  const block = BLOCK.exec(text)?.[1]
  if (block === undefined) return []

  const out: WatchSuggestion[] = []
  for (const line of block.split(/\r?\n/)) {
    if (out.length >= MAX_SUGGESTIONS) break
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsed = parseLine(trimmed)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * 把建议块从正文里摘掉，只留给用户看的四段。
 *
 * 那一块是给程序读的，显示出来只是噪音 —— 而且它长得像「系统给的结论」，
 * 与「这段由外部模型生成」的定位冲突。
 */
export function stripSuggestionBlock(text: string): string {
  return text.replace(BLOCK, '').trimEnd()
}
