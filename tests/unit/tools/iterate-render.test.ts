/**
 * 看板的渲染层（`tools/iterate/render.ts`）。
 *
 * **钉的是那几条会静默失效的纪律，不是排版。** 挑用例的判据只有一条：
 * 这行文案没了会不会让人读错一个数 —— 会，才钉。
 *
 * - **效应量 μ 那一列与它的饱和纪律**（M2 §5.74）：配对胜率是 `Φ(μ/σ_D)` 的饱和变换
 *   ⇒ 竖着比幅度无效。§5.73 ④ **当天写、当天就这么读错过一次**，而它不会报错
 *   ⇒ 唯一的防线是把 μ 印在同一行、把纪律印在同一张表下面；
 * - **读不到 ≠ 0**（文件头纪律 3）：`Maybe` 的 false 态要说「读不到」并带原因，
 *   而不是印一个 0 或干脆少一节；
 * - **登记项一条都没有时不许默认成「没有待落地的东西」**，
 *   `LANDED` / `UNREADABLE` / 登记不合格三组一个都不许静默；
 * - **授权边界那一节固定在**（只报门槛、不提候选，2026-08-15 拍板）。
 *
 * ⚠ 这个文件存在本身也是一条结论：`status.ts` 此前 import 一次就会跑一遍
 * （读文件系统 + `market.db` + 末尾直接 `main()`）⇒ 上面每一条都测不了。
 * **一道没有用例的闸门只是又一条纪律**（§5.44）。
 */

import { describe, expect, it } from 'vitest'
import {
  cleanDaysOf,
  render,
  type AlphaSnapshot,
  type BacklogSnapshot,
  type BaselineSnapshot,
  type Maybe,
  type RuntimeSnapshot,
} from '../../../tools/iterate/render'
import type { TradeDate } from '@core/types'

const ALPHA: AlphaSnapshot = {
  file: 'random-l2a-train.json',
  engineVersion: '0.2.8-unvalidated+c38e329b',
  matchRegime: true,
  shuffleSpans: true,
  seed: 1,
  trials: 2000,
  timingNull: 'REGIME_BLOCK',
  timingNullReason: null,
  blockCoverage: 0.9964,
  blockWeight: 'runs',
  crossCode: false,
  knobs: { deviations: [], unverifiable: [] },
  skipped: [],
  byStratum: [
    { label: 'ALL', count: 1097, paired: 0.43, pairedMedian: 0.085, effectSize: -0.0036, percentile: 0.01 },
    { label: 'TRANSITION', count: 338, paired: 0.125, pairedMedian: 0, effectSize: -0.0126, percentile: 0.005 },
  ],
}

const BASELINE: BaselineSnapshot = {
  file: 'l2a-train.json',
  at: '2026-08-26',
  engineVersion: '0.2.8-unvalidated+c38e329b',
  codes: 252,
  from: '2018-01-01',
  to: '2023-12-31',
  positions: 1097,
  trades: 3305,
  totalReturn: -0.0199,
  winRate: 0.4321,
  maxDrawdown: 0.0296,
  sharpe: -0.412,
  exposure: 0.035,
  skipped: [],
  unverifiable: [],
}

const RUNTIME: RuntimeSnapshot = {
  dbPath: 'C:/x/market.db',
  signals: 1380,
  confirmed: 94,
  tradeDays: 11,
  alerts: 3768,
  alertsWithGate: 2565,
  shadowPoints: 8,
  industry: { codes: 0, rows: 0, firstDate: null },
  restarts: [
    { date: '2026-08-24' as TradeDate, boots: { total: 0, inSession: 0 } },
    { date: '2026-08-25' as TradeDate, boots: { total: 1, inSession: 0 } },
  ],
  latestSignalDate: '2026-08-27' as TradeDate,
  latestAlertDate: '2026-08-27' as TradeDate,
  signalFreshness: {
    kind: 'CAUGHT_UP',
    session: { date: '2026-08-27' as TradeDate, source: 'db', uncertain: false },
    latest: '2026-08-27' as TradeDate,
  },
  alertFreshness: {
    kind: 'CAUGHT_UP',
    session: { date: '2026-08-27' as TradeDate, source: 'db', uncertain: false },
    latest: '2026-08-27' as TradeDate,
  },
}

const EMPTY_BACKLOG: BacklogSnapshot = { rows: [], errors: [] }

const known = <T>(value: T): Maybe<T> => ({ known: true, value })
const unknown = (why: string): Maybe<never> => ({ known: false, why })

const board = (over: Partial<Parameters<typeof render>[0]> = {}): string =>
  render({
    params: {
      engineVersion: '0.2.8-unvalidated',
      counts: { CALIBRATED: 1, KEPT: 16, INERT: 13, UNTESTABLE: 11, BLOCKED: 21, GUESS: 0 },
      leaves: 62,
    },
    baseline: known(BASELINE),
    alpha: known(ALPHA),
    budget: known(5),
    runtime: known(RUNTIME),
    taskList: [],
    backlog: EMPTY_BACKLOG,
    at: '2026-08-27 18:40',
    straddlesMidnight: false,
    ...over,
  })

describe('看板 · 策略质量那张表', () => {
  it('效应量 μ 与它的饱和纪律必须与胜率同框（M2 §5.74）', () => {
    const out = board()
    // 列在（删了它，就只剩饱和变换后的胜率，跨层幅度会被读成效应量）
    expect(out).toContain('**效应量 μ**')
    // 纪律在（§5.73 ④ 当天就是没有它才读错的）
    expect(out).toContain('不能竖着比幅度')
    expect(out).toContain('饱和变换')
    // 而「阈值型不受影响」也要在 —— 少了它，这条纪律会被读成「配对胜率作废」
    expect(out).toContain('阈值型用法不受影响')
    expect(out).toContain('L2 条件① 一字不改')
  })

  it('μ 与中位胜率逐层印出来，缺字段印「—」而不是 0（约束 4）', () => {
    const out = board()
    expect(out).toContain('| ALL | 1097 | 43.00% | **8.50%** | -0.36% | 1.00% |')

    const old = board({
      // 2026-08-20 之前的报告没有中位，08-27 之前没有 μ
      alpha: known({
        ...ALPHA,
        byStratum: [{ label: 'ALL', count: 900, paired: 0.43, pairedMedian: null, effectSize: null, percentile: 0.01 }],
      }),
    })
    expect(old).toContain('| ALL | 900 | 43.00% | — | — | 1.00% |')
    expect(old).not.toContain('| ALL | 900 | 43.00% | **0.00%** | 0.00% | 1.00% |')
  })

  it('trials 与它的噪音地板必须与那两列一起印（M2 §5.76）', () => {
    const out = board()
    // 口径行上要看得见本次的 trials
    expect(out).toContain('**trials 2000**')
    expect(out).toContain('引用这两列必须带 `trials`')
    expect(out).toContain('每层的地板要各自量')

    // 归档里仍有一堆 trials=200 的报告 ⇒ 低于现默认时要额外点名
    const old = board({ alpha: known({ ...ALPHA, trials: 200 }) })
    expect(old).toContain('**这份是 trials=200**')
    // 读不到时说读不到，不许印成 0（纪律 3）
    const missing = board({ alpha: known({ ...ALPHA, trials: null }) })
    expect(missing).toContain('**trials 读不到**')
    expect(missing).not.toContain('**trials 0**')
  })

  it('中位与加权的读法（读数纪律 2）与零点口径必须一起印', () => {
    const out = board()
    expect(out).toContain('两个口径背离时以中位为准')
    // 零点定义不印出来，分位就没法判是「已调整」还是「未调整上界」
    expect(out).toContain('regime 段整段平移')
    expect(out).toContain('覆盖 99.64%')
  })

  it('零点覆盖率低于预注册门槛 80% 时要降级成「未调整上界」', () => {
    const out = board({ alpha: known({ ...ALPHA, blockCoverage: 0.62 }) })
    expect(out).toContain('覆盖率低于预注册门槛 80%')
  })

  it('没开 --shuffle-spans 的那份要标成下界（holdingBars 内生性，读数纪律 3）', () => {
    const out = board({ alpha: known({ ...ALPHA, shuffleSpans: false }) })
    expect(out).toContain('⚠ 未打散跨度')
    expect(out).toContain('只能当下界')
  })

  it('alpha 的引擎版本与当前代码不符时要点名（它是主判据）', () => {
    const out = board({ alpha: known({ ...ALPHA, engineVersion: '0.2.6-unvalidated+aaaa1111' }) })
    expect(out).toContain('它描述的不是当前代码')
    // 指纹不参与比较：换灵敏度档会改指纹但报告仍描述当前引擎
    expect(board({ alpha: known({ ...ALPHA, engineVersion: '0.2.8-unvalidated+ffff9999' }) })).not.toContain(
      '它描述的不是当前代码'
    )
  })
})

describe('看板 · 读不到就是读不到（文件头纪律 3）', () => {
  it('alpha / 基线 / 预算读不到时给原因，不给数字', () => {
    const out = board({
      alpha: unknown('reports/calib/ 不存在'),
      baseline: unknown('没有出厂口径的报告'),
      budget: unknown('docs/07 §3 那行计数读不到'),
    })
    expect(out).toContain('⚠ **读不到**：reports/calib/ 不存在')
    expect(out).toContain('⚠ **读不到**：没有出厂口径的报告')
    expect(out).toContain('⚠ 读不到：docs/07 §3 那行计数读不到')
    expect(out).not.toContain('累计触碰 **0 次**')
  })

  it('真机数据读不到时要说清「这一格空着意味着什么」', () => {
    const out = board({ runtime: unknown('打不开 market.db') })
    expect(out).toContain('⚠ **打不开 market.db**')
    expect(out).toContain('全都在等同一件事')
  })
})

describe('看板 · 真机运行那一节', () => {
  it('干净交易日按四档分开报，日志读不到的那天不并进任何一边', () => {
    const out = board({
      runtime: known({
        ...RUNTIME,
        restarts: [
          { date: '2026-08-24' as TradeDate, boots: { total: 0, inSession: 0 } },
          { date: '2026-08-25' as TradeDate, boots: { total: 1, inSession: 0 } },
          { date: '2026-08-26' as TradeDate, boots: { total: 2, inSession: 1 } },
          { date: '2026-08-27' as TradeDate, boots: null },
        ],
      }),
    })
    expect(out).toContain('可当判据**的交易日 **2** 天')
    expect(out).toContain('**1 天只在盘外重启**')
    expect(out).toContain('盘中重启 1 天')
    expect(out).toContain('1 天日志读不到')
  })

  it('时钟不进渲染层：跨本地午夜的告警由调用方的开关决定', () => {
    expect(board({ straddlesMidnight: false })).not.toContain('跨过本地午夜')
    expect(board({ straddlesMidnight: true })).toContain('跨过本地午夜')
  })

  it('行业留痕为 0 与读不到是两句话（沉默 = 永久少一天）', () => {
    expect(board()).toContain('行业留痕：一行都没有')
    expect(board({ runtime: known({ ...RUNTIME, industry: null }) })).toContain('行业留痕：读不到')
  })
})

describe('看板 · 登记在案的落地项', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 'x',
    kind: '落地' as const,
    bucket: '就绪' as const,
    cost: '小',
    source: 'M2 §5.74',
    title: '某条待办',
    blockedBy: null,
    evidence: { path: 'src/a.ts', needle: '某个串' },
    file: 'docs/notes/计划.md',
    line: 12,
    ...over,
  })

  it('一条都没有时要报「两种成因」，不许默认成没有待办', () => {
    const out = board()
    expect(out).toContain('别默认成前者')
    expect(out).toContain('根本没被登记')
  })

  it('LANDED 要喊「去把标记删掉」—— 清单只增不减就没人再看它', () => {
    const out = board({ backlog: { rows: [{ item: item(), state: 'LANDED' }], errors: [] } })
    expect(out).toContain('证据显示已落地')
    expect(out).toContain('src/a.ts')
  })

  it('判据文件读不到是第三态「不知道」，不许降级成已落地或未落地', () => {
    const out = board({ backlog: { rows: [{ item: item(), state: 'UNREADABLE' }], errors: [] } })
    expect(out).toContain('判不了（判据文件读不到）')
    expect(out).toContain('既不是「还没做」也不是「已经做了」')
  })

  it('登记不合格要报出来，不许静默跳过（缺字段的条目关不掉）', () => {
    const out = board({ backlog: { rows: [], errors: ['docs/x.md:3 缺字段 判据'] } })
    expect(out).toContain('登记不合格')
    expect(out).toContain('docs/x.md:3 缺字段 判据')
  })

  it('等条件的条目必须印出「等的是什么」，否则它与「不做」没有区别', () => {
    const out = board({
      backlog: {
        rows: [{ item: item({ bucket: '等条件', blockedBy: '出现一个夏普为正的候选' }), state: 'OPEN' }],
        errors: [],
      },
    })
    expect(out).toContain('**等**：出现一个夏普为正的候选')
  })
})

describe('看板 · 授权边界', () => {
  it('「不提策略候选」那一节固定在（2026-08-15 拍板）', () => {
    const out = board()
    expect(out).toContain('不提策略候选')
    expect(out).toContain('候选由人提')
    expect(out).toContain('不自动改代码')
  })
})

describe('cleanDaysOf', () => {
  it('闸门状态落库之前的盘外重启日仍然不算干净（老数据不会因为后来修好就可用）', () => {
    const before = cleanDaysOf({
      ...RUNTIME,
      restarts: [{ date: '2026-08-14' as TradeDate, boots: { total: 27, inSession: 12 } }],
    })
    expect(before).toEqual({ clean: 0, postOnly: 0, dirty: 1, unknown: 0 })

    // 同样「只在盘外」，只差日期：08-18 在下界之前 ⇒ 不算干净
    const early = cleanDaysOf({
      ...RUNTIME,
      restarts: [{ date: '2026-08-18' as TradeDate, boots: { total: 1, inSession: 0 } }],
    })
    expect(early).toEqual({ clean: 0, postOnly: 0, dirty: 1, unknown: 0 })
  })
})
