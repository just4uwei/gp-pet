/**
 * 系统提示词（src/main/ai/prompt.ts）。
 *
 * 措辞纪律（CLAUDE.md）是硬指标，而这一层的载体是一段自由文本 ——
 * **靠人记得改它等于没有约束**。所以逐条钉住禁令都还在。
 *
 * 注意这些用例保证的是「我们确实要求了」，不保证模型照做 ——
 * 免责与来源标注因此**不靠提示词**，是渲染层固定拼在输出区外面的 DOM
 * （见 AiExplain.tsx）。两层是互补的，不是重复。
 */

import { describe, expect, it } from 'vitest'
import { AI_SYSTEM_PROMPT, AI_USER_SUFFIX, FORBIDDEN_WORDS } from '@main/ai/prompt'

describe('AI_SYSTEM_PROMPT', () => {
  it('逐个点名 CLAUDE.md 的禁用词', () => {
    for (const word of FORBIDDEN_WORDS) {
      expect(AI_SYSTEM_PROMPT, `禁用词「${word}」没有出现在提示词里`).toContain(word)
    }
  })

  it('说清置信度不是胜率 / 概率 / 准确率', () => {
    expect(AI_SYSTEM_PROMPT).toContain('规则一致性')
    expect(AI_SYSTEM_PROMPT).toContain('不是胜率')
    expect(AI_SYSTEM_PROMPT).toContain('准确率')
  })

  it('禁止编绩效数字 —— 这个工具里没有一个验证过的', () => {
    expect(AI_SYSTEM_PROMPT).toContain('绩效数字')
    expect(AI_SYSTEM_PROMPT).toContain('回撤')
  })

  it('禁止把未标定的规则说成「经过验证」「有效」「准确」', () => {
    expect(AI_SYSTEM_PROMPT).toContain('经过验证')
    expect(AI_SYSTEM_PROMPT).toContain('参数标定状态')
  })

  it('禁止建议仓位金额杠杆 —— 这个工具不接券商、不下单', () => {
    expect(AI_SYSTEM_PROMPT).toContain('仓位')
    expect(AI_SYSTEM_PROMPT).toContain('不接券商')
  })

  it('要求四段结构，且失效条件那一段在', () => {
    expect(AI_SYSTEM_PROMPT).toContain('现在发生了什么')
    expect(AI_SYSTEM_PROMPT).toContain('依据是什么')
    expect(AI_SYSTEM_PROMPT).toContain('反面证据')
    expect(AI_SYSTEM_PROMPT).toContain('失效条件')
  })

  it('反面证据那一段不许空着 —— 只报利好是这类工具最常见的失真', () => {
    expect(AI_SYSTEM_PROMPT).toContain('不允许空着')
  })

  it('允许预测，但与依据、失效条件绑在一起（用户已确认的取舍）', () => {
    expect(AI_SYSTEM_PROMPT).toContain('允许给方向性判断')
  })
})

describe('AI_USER_SUFFIX', () => {
  it('把最关键的三条禁令在正文末尾重申一次，抵消长上下文里的衰减', () => {
    expect(AI_USER_SUFFIX).toContain('不是胜率')
    expect(AI_USER_SUFFIX).toContain('绩效数字')
    expect(AI_USER_SUFFIX).toContain('经过验证')
  })
})
