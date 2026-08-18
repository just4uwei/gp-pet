/**
 * 今日环境那一节的判据（`src/main/report/environment.ts`，docs/11 N1）。
 *
 * 钉四类**看不出来的错**：
 *
 *   1. **缺数被当成平盘** —— `breadth` 的分母若用清单长度而不是「有行情的只数」，
 *      15 只里只取到 3 只时会显示成「3 涨 0 跌 12 平」，读起来像大面积平盘；
 *   2. **静默少几行** —— 缺失不列出来，「今天行业普涨」就会凭空成立；
 *   3. **两个数据源混用** —— 收盘线配快照的昨收算出一个哪边都不对的涨跌幅；
 *   4. **措辞** —— lines 是陈述不是评价，且不得出现禁用词。
 *
 * 另有一条结构断言：环境**不掺进** `overview` / `stocks` —— 那是 `dailyReport()`
 * 那段注释里说的「独立的一节，不是把它们混进来」。
 */

import { describe, expect, it } from 'vitest'
import {
  buildEnvironment,
  type BuildEnvironmentInput,
  type EnvironmentTarget,
} from '@main/report/environment'
import type { ReportEnvironment } from '@shared/ipc-types'
import { FORBIDDEN_WORDS } from '@main/ai/prompt'
import type { Candle, SecCode, Snapshot } from '@core/types'

const DATE = '2026-08-14'
const AT = 1_760_000_000_000

function candle(close: number, over: Partial<Candle> = {}): Candle {
  return {
    date: DATE,
    open: close,
    high: close,
    low: close,
    close,
    openAdj: close,
    highAdj: close,
    lowAdj: close,
    closeAdj: close,
    volume: 1_000_000,
    amount: null,
    ...over,
  }
}

function snapshot(code: string, last: number, preClose: number): Snapshot {
  return {
    code: code as SecCode,
    at: AT,
    last,
    open: last,
    high: last,
    low: last,
    preClose,
    volume: 1_000_000,
    amount: 10_000_000,
    limitUp: null,
    limitDown: null,
    suspended: false,
  }
}

function target(code: string, name: string, industry?: string): EnvironmentTarget {
  return { code: code as SecCode, name, ...(industry === undefined ? {} : { industry }) }
}

/** code → 当日涨跌幅（用「昨收 100 → 今收 100 × (1+pct)」造） */
function barsOf(spec: Record<string, number>): Map<SecCode, { day: Candle; prev?: Candle }> {
  const map = new Map<SecCode, { day: Candle; prev?: Candle }>()
  for (const [code, pct] of Object.entries(spec)) {
    map.set(code as SecCode, { day: candle(100 * (1 + pct / 100)), prev: candle(100) })
  }
  return map
}

const BENCH = target('SH000300', '沪深300')

/** DATE 那天的北京 15:00。收盘线的「数据时刻」用它 —— 下面多数用例不关心它的值 */
const CLOSE_MS = 1_759_990_000_000

/** 统一补上 `closeMs`，免得每个用例都写一遍一个它并不关心的数 */
function buildEnv(input: Omit<BuildEnvironmentInput, 'closeMs'>): ReportEnvironment {
  return buildEnvironment({ ...input, closeMs: CLOSE_MS })
}

describe('buildEnvironment', () => {
  it('breadth 的分母是「有行情的只数」，不是清单长度 —— 缺数不能被读成平盘', () => {
    const env = buildEnv({
      benchmark: BENCH,
      industries: [target('SH512800', '银行ETF', '银行'), target('SH512880', '证券ETF', '证券'), target('SH512980', '传媒ETF', '传媒')],
      bars: barsOf({ SH512800: 1.5, SH512880: -2 }),
      snapshots: new Map(),
    })

    expect(env.breadth).toEqual({ withQuote: 2, up: 1, down: 1, flat: 0 })
    // 第三只没有行情：它既不算涨也不算跌，更不算平
    expect(env.missing).toContain('SH512980')
  })

  it('缺失必须显式列出并出现在陈述里 —— 静默少几行会让「普涨」凭空成立', () => {
    const env = buildEnv({
      benchmark: BENCH,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      bars: barsOf({ SH512800: 1.5 }),
      snapshots: new Map(),
    })

    // 基准也没行情 → 它同样进 missing（`missing` 是完整清单）
    expect(env.missing).toEqual(['SH000300', 'SH512880'])
    // 但陈述句只数**行业**的 1 只：基准那一行已经说过「暂缺」，同一件事不报两遍
    expect(env.lines.join('\n')).toContain('另有 1 只今日无行情数据')
    expect(env.lines.join('\n')).toContain('沪深300 今日行情暂缺')
  })

  it('一只行业都没取到时说清楚为什么，而不是留一片「—」（真机现状：ETF 刚加进自选，还没跑过交易日）', () => {
    const env = buildEnv({
      benchmark: BENCH,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      bars: barsOf({ SH000300: -1.2 }),
      snapshots: new Map(),
    })

    const text = env.lines.join('\n')
    expect(text).toContain('沪深300 −1.20%')
    expect(text).toContain('行业 ETF 2 只今日均无行情数据')
    // 「均无」已经讲完了，不要再补一句「另有 2 只」
    expect(text).not.toContain('另有')
  })

  it('拿不到行情时 quote 是 null，不是 0（约束 4）', () => {
    const env = buildEnv({
      benchmark: BENCH,
      industries: [target('SH512800', '银行ETF')],
      bars: new Map(),
      snapshots: new Map(),
    })

    expect(env.benchmark?.quote).toBeNull()
    expect(env.industries[0]?.quote).toBeNull()
    expect(env.breadth.withQuote).toBe(0)
  })

  it('按涨跌幅降序，拿不到行情的排最后', () => {
    const env = buildEnv({
      benchmark: undefined,
      industries: [
        target('SH512800', '银行ETF'),
        target('SH512880', '证券ETF'),
        target('SH512980', '传媒ETF'),
        target('SZ159755', '电池ETF'),
      ],
      bars: barsOf({ SH512800: -1, SH512880: 2.5, SH512980: 0.4 }),
      snapshots: new Map(),
    })

    expect(env.industries.map((i) => i.name)).toEqual(['证券ETF', '传媒ETF', '银行ETF', '电池ETF'])
    expect(env.industries[3]?.quote).toBeNull()
  })

  it('收盘线优先于快照，两者不混用', () => {
    const env = buildEnv({
      benchmark: undefined,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      // 银行有收盘线（+1%），证券只有快照（110/100 = +10%）
      bars: barsOf({ SH512800: 1 }),
      snapshots: new Map([['SH512880' as SecCode, snapshot('SH512880', 110, 100)]]),
    })

    const bank = env.industries.find((i) => i.code === 'SH512800')
    const broker = env.industries.find((i) => i.code === 'SH512880')
    expect(bank?.quote?.source).toBe('CLOSE')
    expect(bank?.quote?.changePct).toBeCloseTo(1, 6)
    expect(broker?.quote?.source).toBe('SNAPSHOT')
    expect(broker?.quote?.changePct).toBeCloseTo(10, 6)
    // 只要有一只用了快照，整段就要说清楚
    expect(env.lines.join('\n')).toContain('盘中最后一次行情')
  })

  it('只有一只有行情时不说「最高/最低」—— 那是句废话', () => {
    const env = buildEnv({
      benchmark: undefined,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      bars: barsOf({ SH512800: 1 }),
      snapshots: new Map(),
    })
    expect(env.lines.join('\n')).not.toContain('涨幅最高')
  })

  it('两只以上时报出两端，且百分号与符号是显式的', () => {
    const env = buildEnv({
      benchmark: BENCH,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      bars: barsOf({ SH000300: -1.2, SH512800: 1.5, SH512880: -2.34 }),
      snapshots: new Map(),
    })

    const text = env.lines.join('\n')
    expect(text).toContain('沪深300 −1.20%')
    expect(text).toContain('涨幅最高 银行ETF +1.50%')
    expect(text).toContain('最低 证券ETF −2.34%')
  })

  it('lines 是陈述不是评价：不出现禁用词，也不出现「环境不好」这类判断', () => {
    const env = buildEnv({
      benchmark: BENCH,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      bars: barsOf({ SH000300: -3, SH512800: -2, SH512880: -4 }),
      snapshots: new Map(),
    })

    const text = env.lines.join('\n')
    for (const word of FORBIDDEN_WORDS) expect(text).not.toContain(word)
    for (const word of ['不好', '不佳', '风险', '注意', '建议', '普跌', '普涨', '走弱', '走强']) {
      expect(text).not.toContain(word)
    }
  })

  it('一只都没有时给一句实话，而不是空数组', () => {
    const env = buildEnv({ benchmark: undefined, industries: [], bars: new Map(), snapshots: new Map() })
    expect(env.lines).toEqual(['今日环境数据暂缺。'])
    expect(env.breadth.withQuote).toBe(0)
    expect(env.missing).toEqual([])
  })

  /*
    行情的「数据时刻」（2026-08-18）。日报页头与各栏目标题上的时刻从这里来 ——
    环境那一节的时刻取的是它自己这些标的里最新的一条。
  */
  it('收盘线的时刻是那天的收盘（closeMs），快照的是最后成交时刻', () => {
    const env = buildEnv({
      benchmark: undefined,
      industries: [target('SH512800', '银行ETF'), target('SH512880', '证券ETF')],
      bars: barsOf({ SH512800: 1 }),
      snapshots: new Map([['SH512880' as SecCode, snapshot('SH512880', 110, 100)]]),
    })
    expect(env.industries.find((i) => i.code === 'SH512800')?.quote?.at).toBe(CLOSE_MS)
    expect(env.industries.find((i) => i.code === 'SH512880')?.quote?.at).toBe(AT)
  })

  it('并列涨跌幅时按代码定序 —— 顺序抖动的列表读起来像在闪', () => {
    const build = (): string[] =>
      buildEnv({
        benchmark: undefined,
        industries: [target('SZ159755', '电池ETF'), target('SH512800', '银行ETF')],
        bars: barsOf({ SH512800: 1, SZ159755: 1 }),
        snapshots: new Map(),
      }).industries.map((i) => i.code)

    expect(build()).toEqual(['SH512800', 'SZ159755'])
    expect(build()).toEqual(build())
  })
})
