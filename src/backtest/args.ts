/**
 * CLI 参数解析。
 *
 * 手写而非引入 commander：依赖表里没有它，而这里只有十几个 `--key value`。
 * 无法识别的参数**直接报错**而不是忽略 —— `--slipage 0.002`（拼错）被静默忽略，
 * 会让人以为跑了一次含滑点的回测。
 */

import type { TradeDate } from '../core/types'

export interface CliOptions {
  codes: string[]
  from: TradeDate
  to: TradeDate
  /** market.db 路径；与 fixtures 二选一 */
  db?: string
  fixtures?: string
  benchmark: string | null
  params?: string
  grid?: string
  out?: string
  capital: number
  lookback: number
  warmup?: number
  costs: {
    commissionRate?: number
    minCommission?: number
    stampTaxRate?: number
    transferFeeRate?: number
    slippage?: number
  }
  sensitivity?: 'SENSITIVE' | 'BALANCED' | 'CONSERVATIVE'
  /** 跑固定 0.5/0.5 权重对照组（默认开 —— 它是 M2 出口条件要回答的问题） */
  fixedWeights: boolean
  /** 只打印 JSON，便于管道 */
  json: boolean
  quiet: boolean
}

export const USAGE = `用法：
  pnpm backtest -- --codes SH600000,SZ000001 --from 2020-01-01 --to 2026-06-30 [选项]

数据来源（二选一，默认读应用数据库）：
  --db <file>            market.db 路径（默认 %APPDATA%/gp-pet/market.db）
  --fixtures <dir>       从 <dir>/<CODE>.json 读日线（无网络环境下自测用）

区间与标的：
  --codes <list>         逗号分隔的代码，支持 600000 / sh600000 / 000001.SZ
  --from / --to          'YYYY-MM-DD'
  --benchmark <code>     基准指数，默认 SH000300；传 none 关闭

参数：
  --params <file>        JSON 覆盖块，形如 { "macd": { "fast": 12, "slow": 26, "signal": 9 } }
  --sensitivity <档位>   sensitive | balanced | conservative（对应 0.50/2 · 0.60/3 · 0.72/4）
  --grid <file>          网格标定模式：{ "macd": [ …候选… ], "combine": [ … ] }

成交与成本：
  --capital <元>         每只标的的独立资金，默认 100000
  --lookback <根>        引擎每次可见的最大回看根数，默认 320（与实盘一致）
  --warmup <根>          前 N 根只喂数据不判信号，默认 params.data.fullBars
  --commission <率>      默认 0.00025（双边）
  --min-commission <元>  默认 5
  --stamp-tax <率>       默认 0.001（仅卖出）
  --transfer-fee <率>    默认 0.00001（双边）
  --slippage <率>        默认 0.001

输出：
  --out <file>           JSON 报告落盘路径
  --no-fixed-weights     不跑固定权重对照组
  --json                 只输出 JSON
  --quiet                不打印进度
`

const FLAGS = new Set(['--json', '--quiet', '--no-fixed-weights', '--help', '-h'])

function requireValue(key: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`${key} 缺少取值`)
  return value
}

function positiveNumber(key: string, raw: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${key} 必须是非负数字，收到 ${raw}`)
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
    lookback: 320,
    costs: {},
    fixedWeights: true,
    json: false,
    quiet: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === undefined) continue
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
        options.costs.stampTaxRate = positiveNumber(key, requireValue(key, next))
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
      case '--no-fixed-weights':
        options.fixedWeights = false
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

/** 三档灵敏度预设（docs/04 §4.2）：灵敏 0.50/2 · 均衡 0.60/3 · 保守 0.72/4 */
export const SENSITIVITY_PRESETS: Record<
  NonNullable<CliOptions['sensitivity']>,
  { scoreThreshold: number; voteThreshold: number }
> = {
  SENSITIVE: { scoreThreshold: 0.5, voteThreshold: 2 },
  BALANCED: { scoreThreshold: 0.6, voteThreshold: 3 },
  CONSERVATIVE: { scoreThreshold: 0.72, voteThreshold: 4 },
}
