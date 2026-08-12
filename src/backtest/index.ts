/**
 * 回测模块的公共出口 —— 供测试与（将来的）应用内影子运行复用。
 *
 * CLI 入口在 cli.ts；本文件不做 IO，只重导出。
 */

export { DEFAULT_COSTS, LOT_SIZE, buyFees, buyFill, lotsAffordable, sellFees, sellFill } from './costs'
export type { CostModel } from './costs'
export {
  fallbackProfile,
  openFixtureSource,
  openSqliteSource,
  sentimentSeries,
} from './data'
export type { DataSource, LoadedSeries } from './data'
export {
  BARS_PER_YEAR,
  annualizedReturn,
  informationRatio,
  maxDrawdown,
  mean,
  returnsOf,
  sampleStdev,
  sharpeRatio,
  summarizeTrades,
} from './metrics'
export type { DrawdownResult, EquityPoint, TradeStats } from './metrics'
export {
  DEFAULT_SIMULATE_OPTIONS,
  NEUTRAL_SENTIMENT,
  assertNoFuture,
  simulateCode,
} from './simulate'
export type { BacktestTrade, CodeResult, SentimentLookup, SimulateOptions } from './simulate'
export {
  DISCLAIMERS,
  assembleReport,
  attributeByRegime,
  mergeEquity,
  performanceOf,
  renderReport,
} from './report'
export type { BacktestReport, PerformanceBlock, RegimeAttribution } from './report'
export {
  DEFAULT_SPLITS,
  calibrate,
  calmar,
  expandGrid,
  renderCalibration,
  sensitivityFlags,
} from './calibrate'
export type { Candidate, CalibrationReport, GridSpec, Split } from './calibrate'
export { SENSITIVITY_PRESETS, USAGE, parseArgs } from './args'
export type { CliOptions } from './args'
