/**
 * CLI 参数解析。
 *
 * 手写而非引入 commander：依赖表里没有它，而这里只有十几个 `--key value`。
 * 无法识别的参数**直接报错**而不是忽略 —— `--slipage 0.002`（拼错）被静默忽略，
 * 会让人以为跑了一次含滑点的回测。
 */

import type { SensitivityTier } from '../core/params'
import type { TradeDate } from '../core/types'

export interface CliOptions {
  codes: string[]
  from: TradeDate
  to: TradeDate
  /** market.db 路径；与 fixtures 二选一 */
  db?: string
  fixtures?: string
  /**
   * 退市清单 JSON（`params/universe-delisted.json` 的形状：`{ delistedAt: { CODE: 'YYYY-MM-DD' } }`）。
   *
   * 给了它，名单内的标的会在退市日收盘**强制平仓并记一笔 trade**
   * （见 `simulate.ts` 的 `SimulateOptions.delistedAt`）。不给则行为与以前逐位相同 ——
   * 这是刻意的：旧结论要能原样复现，新旧差值才归得清。
   */
  delisted?: string
  /**
   * 流动性数据目录（`data/liquidity/<CODE>.json`，`pnpm fetch:liquidity` 产出）。
   * 只有同时给了 `--drop-cap-pct` 或 `--drop-amount-pct` 才真的剔 ——
   * 单给目录等于只加载不使用，行为与不给逐位相同。预注册见 M2 §5.29。
   */
  liquidity?: string
  /** 逐日剔除横截面流通市值最小的百分比。0 = 不按市值剔 */
  dropCapPct: number
  /** 逐日剔除「过去 N 日均成交额」最小的百分比。0 = 不按流动性剔 */
  dropAmountPct: number
  benchmark: string | null
  params?: string
  grid?: string
  out?: string
  capital: number
  /**
   * 年化无风险利率，**只作用于报告里那个并排的 `sharpeNet`**（默认 0 ⇒ 不算、不打印）。
   * 净值曲线、收益、回撤、Calmar 与 `sharpe` 一个都不受它影响 —— 所以带 `--rf` 的跑
   * 仍然是出厂口径，`auditKnobs` 刻意不认它。为什么不真给现金计息：见
   * `metrics.ts` 的 `riskFreeAdjustedSharpe` 头注释（会把 totalReturn 抬成正数）。
   */
  riskFree: number
  lookback: number
  warmup?: number
  costs: {
    commissionRate?: number
    minCommission?: number
    stampTaxRate?: number
    stampTaxPinned?: number
    transferFeeRate?: number
    slippage?: number
  }
  sensitivity?: SensitivityTier
  /** 标定：横截面折数（标的子集），默认 4 */
  codeFolds: number
  /** 标定：验证窗口内的时间片数，默认 3 */
  timeSlices: number
  /** 标定：可分辨门槛 |Δ|/stderr，默认由 calibrate.ts 定（2） */
  minDeltaT?: number
  /** 标定：是否读测试集。默认 false —— 每读一次都要按 docs/07 §3 ④ 记账 */
  touchTest: boolean
  /** 只打印 JSON，便于管道 */
  json: boolean
  quiet: boolean
}

export const USAGE = `用法：
  pnpm backtest -- --codes SH600000,SZ000001 --from 2020-01-01 --to 2026-06-30 [选项]

数据来源（二选一，默认读应用数据库）：
  --db <file>            market.db 路径（默认 %APPDATA%/gp-pet/market.db）
  --fixtures <dir>       从 <dir>/<CODE>.json 读日线（无网络环境下自测用）
  --delisted <file>      退市清单（params/universe-delisted.json）。名单内的标的在退市日
                         收盘强制平仓并记一笔 trade —— 不给则未平仓的建仓不进 trades，
                         而建仓级胜率与配对 alpha 都只读 trades（幸存者偏差的第二重）

池过滤（流动性 / 市值，预注册见 M2 §5.29）：
  --liquidity <dir>      流动性数据目录（data/liquidity/<CODE>.json，pnpm fetch:liquidity 产出）
  --drop-cap-pct <n>     逐日剔除横截面**流通市值**最小的 n%（默认 0 = 不剔）
  --drop-amount-pct <n>  逐日剔除**20 日均成交额**最小的 n%（默认 0 = 不剔）
                         只挡建仓不挡离场；缺数不剔；横截面仅本池之内

区间与标的：
  --codes <list>         逗号分隔的代码，支持 600000 / sh600000 / 000001.SZ
  --from / --to          'YYYY-MM-DD'
  --benchmark <code>     基准指数，默认 SH000300；传 none 关闭

参数：
  --params <file>        JSON 覆盖块，形如 { "macd": { "fast": 12, "slow": 26, "signal": 9 } }
  --sensitivity <档位>   sensitive | balanced | conservative（得分/票数线：0.50/(2,2) · 0.60/(3,2) · 0.72/(4,3)）
  --grid <file>          网格标定模式：{ "macd": [ …候选… ], "combine": [ … ] }

标定（仅 --grid 下生效）：
  --code-folds <n>       横截面折数（标的按代码轮转分组），默认 4
  --time-slices <n>      验证窗口内的时间片数，默认 3
                         折单元 = 折数 × 片数，用于与出厂值做逐折配对比较；
                         都是从同一次模拟里切出来的，加折不加耗时
  --min-delta-t <倍>     可分辨门槛 |Δ| / 标准误，默认 2
  --touch-test           读一次测试集（默认不读）。docs/07 §3 ④ 要求「测试集只跑一次」，
                         每加一次都要在那一节的计数里记账

成交与成本：
  --capital <元>         每只标的的独立资金，默认 100000
  --lookback <根>        引擎每次可见的最大回看根数，默认 320（与实盘一致）
  --warmup <根>          前 N 根只喂数据不判信号，默认 params.data.fullBars
  --commission <率>      默认 0.00025（双边）
  --min-commission <元>  默认 5
  --stamp-tax <率>       钉死印花税率（默认按成交日取规则：2023-08-28 起千 0.5，之前千 1）
  --transfer-fee <率>    默认 0.00001（双边）
  --slippage <率>        默认 0.001
  --rf <年化率>          无风险利率，只多打一行 sharpeNet（默认 0 = 不算）
                         机会成本只按逐日持仓占用收，不动净值曲线

输出：
  --out <file>           JSON 报告落盘路径
  --json                 只输出 JSON
  --quiet                不打印进度
`

const FLAGS = new Set(['--json', '--quiet', '--help', '-h', '--touch-test'])

function requireValue(key: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${key} 缺少取值`)
  return value
}

function positiveNumber(key: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} 必须是非负数字，收到 ${raw}`)
  return value
}

/** 0..90 的百分比。上界不是洁癖：剔掉 90% 以上就不叫「过滤」了，那是换池子 */
function percent(key: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 90) {
    throw new Error(`${key} 必须是 0..90 的百分比，收到 ${raw}`)
  }
  return value
}

function positiveInteger(key: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} 必须是 ≥ 1 的整数，收到 ${raw}`)
  return value
}

const SENSITIVITY_MAP: Record<string, CliOptions['sensitivity']> = {
  sensitive: 'SENSITIVE',
  balanced: 'BALANCED',
  conservative: 'CONSERVATIVE',
}

export function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  const options: CliOptions = {
    codes: [],
    from: '2018-01-01',
    to: '2099-12-31',
    benchmark: 'SH000300',
    capital: 100_000,
    riskFree: 0,
    lookback: 320,
    costs: {},
    dropCapPct: 0,
    dropAmountPct: 0,
    codeFolds: 4,
    timeSlices: 3,
    touchTest: false,
    json: false,
    quiet: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === undefined) continue
    // 裸 `--`：npm / 旧版 pnpm 用它分隔脚本参数并自行吃掉，pnpm 11 却原样传进来。
    // 两种写法都得能跑，否则全部文档里的 `pnpm backtest -- --codes …` 都是错的。
    if (key === '--') continue
    const next = FLAGS.has(key) ? undefined : argv[i + 1]
    if (!FLAGS.has(key)) i++

    switch (key) {
      case '--help':
      case '-h':
        return 'help'
      case '--codes':
        options.codes = requireValue(key, next)
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
        break
      case '--from':
        options.from = requireValue(key, next)
        break
      case '--to':
        options.to = requireValue(key, next)
        break
      case '--db':
        options.db = requireValue(key, next)
        break
      case '--fixtures':
        options.fixtures = requireValue(key, next)
        break
      case '--delisted':
        options.delisted = requireValue(key, next)
        break
      case '--liquidity':
        options.liquidity = requireValue(key, next)
        break
      case '--drop-cap-pct':
        options.dropCapPct = percent(key, requireValue(key, next))
        break
      case '--drop-amount-pct':
        options.dropAmountPct = percent(key, requireValue(key, next))
        break
      case '--benchmark': {
        const value = requireValue(key, next)
        options.benchmark = value === 'none' ? null : value
        break
      }
      case '--params':
        options.params = requireValue(key, next)
        break
      case '--grid':
        options.grid = requireValue(key, next)
        break
      case '--out':
        options.out = requireValue(key, next)
        break
      case '--capital':
        options.capital = positiveNumber(key, requireValue(key, next))
        break
      case '--rf':
        options.riskFree = positiveNumber(key, requireValue(key, next))
        break
      case '--lookback':
        options.lookback = positiveNumber(key, requireValue(key, next))
        break
      case '--warmup':
        options.warmup = positiveNumber(key, requireValue(key, next))
        break
      case '--commission':
        options.costs.commissionRate = positiveNumber(key, requireValue(key, next))
        break
      case '--min-commission':
        options.costs.minCommission = positiveNumber(key, requireValue(key, next))
        break
      case '--stamp-tax':
        {
          // 钉死它：`costsOn` 从此不再按成交日改写这一项（那正是这个实验旋钮的意思）
          const pinned = positiveNumber(key, requireValue(key, next))
          options.costs.stampTaxRate = pinned
          options.costs.stampTaxPinned = pinned
        }
        break
      case '--transfer-fee':
        options.costs.transferFeeRate = positiveNumber(key, requireValue(key, next))
        break
      case '--slippage':
        options.costs.slippage = positiveNumber(key, requireValue(key, next))
        break
      case '--sensitivity': {
        const value = SENSITIVITY_MAP[requireValue(key, next).toLowerCase()]
        if (!value) throw new Error(`--sensitivity 只接受 sensitive / balanced / conservative`)
        options.sensitivity = value
        break
      }
      case '--code-folds':
        options.codeFolds = positiveInteger(key, requireValue(key, next))
        break
      case '--time-slices':
        options.timeSlices = positiveInteger(key, requireValue(key, next))
        break
      case '--min-delta-t':
        options.minDeltaT = positiveNumber(key, requireValue(key, next))
        break
      case '--touch-test':
        options.touchTest = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      default:
        throw new Error(`无法识别的参数：${key}`)
    }
  }

  if (options.codes.length === 0) throw new Error('必须用 --codes 指定至少一只标的')
  if (options.db && options.fixtures) throw new Error('--db 与 --fixtures 只能选一个')
  if (options.from > options.to) throw new Error(`--from (${options.from}) 晚于 --to (${options.to})`)
  return options
}

/**
 * 三档灵敏度预设（docs/04 §4.2）：灵敏 0.50/(2,2) · 均衡 0.60/(3,2) · 保守 0.72/(4,3)。
 *
 * **定义已搬到 `src/core/params.ts`**（2026-08-13，M4 接线 `AppSettings.sensitivity`）：
 * 主进程也要按用户设置构造参数集，而 `main → backtest` 不是既有的依赖边。
 * 这里只重导出，保证 `--sensitivity` 与设置页三档**永远是同一张表** ——
 * 抄一份到主进程会让「回测里的均衡档」与「用户设置里的均衡档」悄悄分叉。
 */
export { SENSITIVITY_PRESETS } from '../core/params'
