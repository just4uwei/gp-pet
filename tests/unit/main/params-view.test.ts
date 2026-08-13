/**
 * 只读参数表的两条不变量（ADR-0003、settings/params-view.ts）。
 *
 * 这个文件存在的理由不是「测一个 map 函数」，而是**让 ADR-0003 在 CI 里有一条红线**：
 *
 * ① **每个叶子参数都要有归档。** 漏了会静默掉进 `GUESS`，而 `GUESS` 是一个结论
 *    （「一个网格都没跑过」）而不是默认值 —— 一个刚标定完却忘了改表的参数
 *    会被显示成「未测」，正好反了。
 * ② **`CALIBRATED` 必须恰好是 params.ts 顶部那张已标定清单。** 当前只有一项。
 *    往这一档里多加一行，就是在 UI 上宣称某个参数已经标定过 —— 那是 ADR-0003
 *    最不希望被悄悄跨过的一步（「把一个参数的证据扩张成整套参数的背书」）。
 *    要加得走 M2 清单 4.9a，并同步 CHANGELOG。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, SENSITIVITY_PRESETS, withSensitivity } from '@core/params'
import { countByStatus, paramRows } from '@main/settings/params-view'

describe('归档完整性', () => {
  it('没有任何参数落在「未归档」兜底上', () => {
    const orphans = paramRows()
      .filter((row) => row.note?.includes('未归档') === true)
      .map((row) => `${row.group}.${row.key}`)
    expect(orphans).toEqual([])
  })

  it('每一行都有 group / key / value / status', () => {
    for (const row of paramRows()) {
      expect(row.group).not.toBe('')
      expect(row.key).not.toBe('')
      expect(row.value).not.toBe('')
      expect(['CALIBRATED', 'KEPT', 'INERT', 'UNTESTABLE', 'GUESS']).toContain(row.status)
    }
  })

  it('嵌套块逐叶子展开（combine.voteThreshold → trend / meanReversion 两行）', () => {
    const votes = paramRows().filter(
      (row) => row.group === 'combine' && row.key.startsWith('voteThreshold')
    )
    expect(votes.map((row) => row.key).sort()).toEqual([
      'voteThreshold.meanReversion',
      'voteThreshold.trend',
    ])
    // 前缀命中：两个叶子共享 `combine.voteThreshold` 那条归档
    expect(votes.every((row) => row.status === 'KEPT')).toBe(true)
  })
})

describe('已标定清单', () => {
  it('CALIBRATED 恰好只有 strategy.squeezeBbwPct —— 加行要走 M2 清单 4.9a', () => {
    const calibrated = paramRows()
      .filter((row) => row.status === 'CALIBRATED')
      .map((row) => `${row.group}.${row.key}`)
    expect(calibrated).toEqual(['strategy.squeezeBbwPct'])
  })

  it('已标定那一项的值就是 params.ts 里的值（20）', () => {
    const row = paramRows().find((r) => r.status === 'CALIBRATED')
    expect(row?.value).toBe(String(DEFAULT_PARAMS.strategy.squeezeBbwPct))
  })

  it('仍有「未测」的参数 —— 这一档空了才该考虑摘 -unvalidated 后缀', () => {
    expect(countByStatus(paramRows()).GUESS).toBeGreaterThan(0)
  })
})

describe('消融开关不进表', () => {
  it('enabledStrategies 不出现 —— 它是测量工具，摆进设置页会变成一个「关掉均值回归试试」的开关', () => {
    expect(paramRows().some((row) => row.group === 'enabledStrategies')).toBe(false)
  })
})

describe('摊的是当前生效的参数集', () => {
  it('传入保守档时得分线那一行显示 0.72，而不是出厂的 0.6', () => {
    const rows = paramRows(withSensitivity('CONSERVATIVE'))
    const row = rows.find((r) => r.group === 'combine' && r.key === 'scoreThreshold')
    expect(row?.value).toBe(String(SENSITIVITY_PRESETS.CONSERVATIVE.scoreThreshold))
  })

  it('换档不改变归档状态（换的是取值，不是证据）', () => {
    const factory = countByStatus(paramRows())
    const sensitive = countByStatus(paramRows(withSensitivity('SENSITIVE')))
    expect(sensitive).toEqual(factory)
  })
})
