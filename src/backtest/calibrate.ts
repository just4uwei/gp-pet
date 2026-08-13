/**
 * 参数标定（docs/07 §3）。
 *
 * ```
 * ① 划分数据：训练 / 验证 / 测试三段
 * ② 在训练集上跑粗网格
 * ③ 在验证集上筛掉过拟合候选（训练好、验证崩的直接淘汰）
 * ④ 测试集只跑一次，作为最终报告，不允许据此回头调参
 * ⑤ 入选参数写入 src/core/params.ts，engine_version +1，CHANGELOG 记录依据
 * ```
 *
 * 本文件负责 ①–④。**⑤ 是人的动作**：工具不自动改 params.ts。
 * 自动写回会让「出厂默认值从哪来」变成一个没人复核过的黑箱，而 ADR-0003 的整个立场
 * 就是不接受未经复核的数值。
 *
 * ## 2026-08-13：为什么加了「折」与三态裁决
 *
 * 在此之前这个工具只回答一个问题：**「验证集 Calmar 最高的是哪一组？」**
 * 跑了十一轮（M2 §5.4–§5.14），二十来个参数里只有一个被写回，其余每一轮都是同一个形状 ——
 * 工具指出一个优胜者，人看完表判定它是「孤峰」或「验证窗口正好友好」，然后否掉。
 * 也就是说**真正在做决策的判据从来不在工具里**：那个唯一被写回的
 * `strategy.squeezeBbwPct` 靠的是人工在表里认出「16–30 是一整片高原」
 * 并核对两种基线（§5.10），而不是靠工具排名的第一名（那是 30，被否了）。
 *
 * 于是这一版把人工做过一次的那套判据写进工具，三件事：
 *
 * 1. **出厂参数（incumbent）永远在候选表里**，且所有比较都是**与它配对**的。
 *    以前的输出是「优胜者是 X」，现在是「X 相对出厂值的改进是 Δ，可分辨 / 不可分辨」——
 *    后者才是能据以决定「改不改 params.ts」的形式。
 * 2. **分数不再只有一个点估计**。同一次模拟按「标的子集 × 验证窗口内的时间片」切成折单元
 *    （`SplitRun.cells`，横截面折与时间片都不额外跑一遍模拟，见 cli.ts 的 runSplit），
 *    于是每个候选在每折上都有一个分数，可以对出厂值做**逐折配对比较**。
 *    项目一直在口头上用的「±1pp 噪音带」「正负交替 = 噪音」由此变成算出来的量
 *    （`PairedDelta.stderr`）。
 * 3. **裁决有三态**（`Verdict`）：`WRITE_BACK` / `KEEP` / `INCONCLUSIVE`。
 *    以前「没有候选够格」只能表达成 `winner: null`，读起来像标定失败、于是这一格永远挂着；
 *    实际上「出厂值没有被显著超越」**是一个结论**。KEEP 时同时给出
 *    `resolution.requiredCells`：要分辨已观测到的这个 Δ 大约需要多少折 ——
 *    「定不下来」因此变成一句可执行的话（要么扩样本到那个量级，要么承认这个参数在这个
 *    数据量下不可标定，按 M2 清单 4.9c 归档）。
 *
 * 写回门槛除了「改进大于抖动」还有两条**不许变差**：整池验证集 Calmar、
 * 以及**建仓级胜率**（2026-08-13 加，见 `passable` 的注释 ——「提高胜率」单独作为目标
 * 是可以被机械满足的，必须与收益一起卡）。
 *
 * 三条过拟合红线仍在这里执行（docs/07 §3）：
 *   - 交易次数 < 30 笔 → 直接淘汰
 *   - 验证集绩效相对训练集断崖下跌 → 标记为疑似过拟合
 *   - 邻域敏感性：最优参数 ±20% 的绩效若崩塌 → 标记为噪音峰值
 *     （**现在是自动判的**：同一维度上取值相邻的候选互为邻域，见 `plateauFlags`）
 * 外加 2026-08-12 补的第四条：训练集 Calmar ≤ 0 直接淘汰（M2 §5.14）。
 */

import { paramsFingerprint, withParams, type EngineParams, type ParamOverrides } from '../core/params'
import type { TradeDate } from '../core/types'
import { mean, sampleStdev } from './metrics'
import type { PerformanceBlock } from './report'

export interface GridSpec {
  /** 块名 → 该块的候选取值列表。例：`{ "macd": [{fast:12,slow:17,signal:9}, …] }` */
  [block: string]: Record<string, unknown>[]
}

/** 笛卡尔积展开。块内是整体替换，与 withParams 的语义一致 */
export function expandGrid(spec: GridSpec): ParamOverrides[] {
  const blocks = Object.entries(spec).filter(([, values]) => values.length > 0)
  let combos: ParamOverrides[] = [{}]
  for (const [block, values] of blocks) {
    const next: ParamOverrides[] = []
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [block]: value } as ParamOverrides)
      }
    }
    combos = next
  }
  return combos
}

export interface Split {
  name: 'train' | 'validation' | 'test'
  from: TradeDate
  to: TradeDate
}

/**
 * 一段切分应当跳过多少根才开始判信号。
 *
 * **这里错过一次，整个三段切分就失效。** 早先的实现把每一段当成独立序列喂进引擎，
 * 于是 300 根预热在**每段内部**重新走一遍：验证集 359 根只剩 59 根被真正判定，
 * 测试集 272 根 < 300 根预热 → **一笔交易都不可能产生**，而报告上显示的是
 * 「测试集 0 笔」，看起来像策略不出信号，实际是工具的问题。
 *
 * 正确做法：把该段之前的历史也喂进去（回测本来就一次性载入了三段的并集），
 * 只是不在那段上判信号 —— 判定正好从 `split.from` 开始，且身后带着完整历史。
 *
 * @param dates   该标的的全部交易日（升序），已按 `<= split.to` 截断
 * @param split   目标区间
 * @param floor   最少预热根数（`params.data.fullBars`，或 CLI 的 --warmup）
 */
export function warmupForSplit(
  dates: readonly TradeDate[],
  split: Pick<Split, 'from'>,
  floor: number
): number {
  let before = 0
  for (const date of dates) {
    if (date >= split.from) break
    before++
  }
  // 段前历史不足 floor 时只能按 floor 预热，判定起点会晚于 split.from —— 无解，但要知道
  return Math.max(floor, before)
}

/** docs/07 §3 的默认切分。测试集的 `to` 由 CLI 的 --to 覆盖 */
export const DEFAULT_SPLITS: readonly Split[] = [
  { name: 'train', from: '2018-01-01', to: '2023-12-31' },
  { name: 'validation', from: '2024-01-01', to: '2025-06-30' },
  { name: 'test', from: '2025-07-01', to: '2099-12-31' },
]

/**
 * 一段切分上跑一次的结果。
 *
 * `cells` 是**同一次模拟**切出来的折单元（标的子集 × 时间片），不是重跑。
 * 它存在的唯一目的是给「这个差值能不能分辨」提供离散度估计：
 * 单折绩效与 `overall` 不可横向比较（窗口短、标的少、回撤分母小 —— 见 `cellScore`
 * 为什么折上不能用 Calmar），**只有同一折上两个候选之差才有意义**，
 * 所以下面所有用到 cells 的地方都是配对比较。
 */
export interface SplitRun {
  overall: PerformanceBlock
  cells: readonly { name: string; block: PerformanceBlock }[]
}

/**
 * 把标的按代码升序轮转分组 —— 横截面折。
 *
 * 轮转（而不是切段）是为了让 `universe-broad.json` 的三个分层（沪主板 / 深主板 / 创业板）
 * 尽量均匀落到每一折里：代码升序时同一层的票是连续的，切段会让某一折全是创业板，
 * 于是折间差异测的是板块而不是抽样噪音。
 * 不用随机分组：随机要存种子才能复现，轮转只要规则（与 `build-universe.mjs` 的等距抽样同理）。
 */
export function codeGroups<T extends string>(codes: readonly T[], folds: number): T[][] {
  const sorted = [...codes].sort()
  const count = Math.max(1, Math.min(Math.floor(folds), sorted.length))
  const groups: T[][] = Array.from({ length: count }, () => [])
  sorted.forEach((code, i) => groups[i % count]?.push(code))
  return groups.filter((group) => group.length > 0)
}

/**
 * 把一段判定区间按交易日等分成若干时间片 —— 时间折。
 *
 * 为什么两个方向都要：横截面折只能回答「换一批标的会不会翻盘」，
 * 而 §5.14 那轮定不下来的另一半原因是**验证窗口只有 18 个月、一种市场状态**
 * （`voteThreshold.trend = 4` 靠 59 笔交易排到第一名）。时间片回答的是「换一段行情
 * 会不会翻盘」。只做一个方向会系统性高估分辨率。
 */
export function timeSlices(
  dates: readonly TradeDate[],
  slices: number
): { from: TradeDate; to: TradeDate }[] {
  const count = Math.max(1, Math.min(Math.floor(slices), dates.length))
  const out: { from: TradeDate; to: TradeDate }[] = []
  for (let k = 0; k < count; k++) {
    const from = dates[Math.floor((k * dates.length) / count)]
    const to = dates[Math.floor(((k + 1) * dates.length) / count) - 1]
    if (from !== undefined && to !== undefined && from <= to) out.push({ from, to })
  }
  return out
}

/**
 * 折上用来配对比较的量：**本折的总收益**，不是 Calmar。
 *
 * 排名口径仍然是整池的验证集 Calmar（`Candidate.score`，没变），但**折上不能用 Calmar** ——
 * 一折只有 ~10 只标的 × ~120 根，最大回撤可以小到 0.3%，Calmar 的分母趋零就炸：
 * 2026-08-13 实测出厂值的 12 折 Calmar 是
 * `−1.97 13.53 1.25 −0.80 3.41 5.83 −0.21 −1.42 17.67 −1.50 −1.80 −0.97`
 * —— 折间标准差 **6.50**（标准误 1.88），而整池 Calmar 只有 **0.427**。
 * 噪音标尺被分母的不稳定撑大了一个量级以上，于是任何真实效应都不可能过门槛
 * （那次估出来要 270 折）。这不是「数据不够」，是**折上换错了尺子**。
 *
 * 换成总收益还有一个好处：**单位与项目此前所有的判断一致**。
 * §5.5–§5.13 的每一条消融结论都是拿「差多少 pp」说的、噪音带也是拿 ±1pp 描述的，
 * 折间标准误因此可以直接和那些历史结论比。风险调整没有丢 ——
 * 它在红线（验证集年化为负即淘汰）、排名（整池 Calmar）与写回门槛
 *（挑战者的整池 Calmar 不得低于出厂值）这三处都还在。
 */
export function cellScore(block: PerformanceBlock): number | null {
  return block.totalReturn
}

/** 逐折配对比较：挑战者 − 出厂值，只在两边都有分数的折上计算 */
export interface PairedDelta {
  /** 参与比较的折数 */
  cells: number
  /**
   * Δ ≠ 0 的折数。**「改了参数但这一折逐笔不变」是这个项目里最常见的情形** ——
   * 2026-08-13 实测 `scoreThreshold` 0.55 只动了 12 折里的 5 折，
   * `downtrendBuyPenalty` 一折都没动。胜率按这个数算而不是按 `cells` 算，
   * 否则「只影响少数折但每折都改善」的候选永远够不着 2/3 的线。
   */
  affected: number
  /** 折间 Δ 的均值（**含**未受影响的 0 折 —— 那是整池效应被摊薄的真实程度） */
  mean: number
  /** 折间 Δ 均值的标准误 = stdev(Δ) / √n。折数 < 2 或 Δ 恒等时为 null */
  stderr: number | null
  /** Δ > 0 的折数 */
  wins: number
  /** |mean| / stderr。**这不是 p 值**，是「差值相对它自己的抖动有多大」的量级标尺 */
  t: number | null
}

export function pairedDelta(
  challenger: readonly (number | null)[],
  incumbent: readonly (number | null)[]
): PairedDelta | null {
  const deltas: number[] = []
  for (let i = 0; i < Math.min(challenger.length, incumbent.length); i++) {
    const a = challenger[i]
    const b = incumbent[i]
    if (a === null || a === undefined || b === null || b === undefined) continue
    deltas.push(a - b)
  }
  if (deltas.length === 0) return null
  const m = mean(deltas)
  const sd = sampleStdev(deltas)
  const stderr = deltas.length >= 2 && sd > 0 ? sd / Math.sqrt(deltas.length) : null
  return {
    cells: deltas.length,
    affected: deltas.filter((d) => d !== 0).length,
    mean: m,
    stderr,
    wins: deltas.filter((d) => d > 0).length,
    t: stderr !== null && stderr > 0 ? Math.abs(m) / stderr : null,
  }
}

export interface Candidate {
  overrides: ParamOverrides
  fingerprint: string
  /** 相对出厂参数改了哪些叶子；空数组即出厂参数本身 */
  changed: readonly { path: string; value: unknown }[]
  /** 只改了一个数值叶子时的维度名，用于自动邻域（高原）判定；否则为 null */
  axis: string | null
  /** 出厂参数本身 */
  incumbent: boolean
  train: PerformanceBlock
  validation: PerformanceBlock | null
  /** 排名分数（验证集 Calmar，整池口径），越大越好 —— 与 2026-08-12 之前的口径一致 */
  score: number | null
  /** 逐折验证集**总收益**，与 `SplitRun.cells` 同序，用于配对比较（见 `cellScore`） */
  foldScores: readonly (number | null)[]
  /** 与出厂参数的逐折配对比较；出厂参数本身为 null */
  delta: PairedDelta | null
  /** 淘汰原因；null 表示进入下一轮 */
  rejected: string | null
  flags: string[]
}

/**
 * 候选排序分数：**Calmar 比率**（年化 / 最大回撤）。
 *
 * 为什么不用年化本身：年化最高的那组几乎总是回撤最大的那组，据此定出厂参数
 * 等于把用户的账户押在「一次没赶上的回撤」上。为什么不用夏普：本策略持仓周期短、
 * 交易次数少，日频夏普对少数几笔大盈亏过于敏感。
 *
 * 回撤为 0（几乎没交易）不给 Infinity —— 那会让「什么都不做」排第一。
 */
export function calmar(block: PerformanceBlock): number | null {
  if (block.annualized === null) return null
  if (block.maxDrawdown <= 0) return block.trades.count === 0 ? null : block.annualized
  return block.annualized / block.maxDrawdown
}

export interface CalibrationInput {
  candidates: readonly ParamOverrides[]
  base: EngineParams
  /** 在指定区间上跑一次回测 */
  run(params: EngineParams, split: Split): SplitRun
  splits: readonly Split[]
  /** 交易次数下限，低于此值直接淘汰（docs/07 §3） */
  minTrades?: number
  /** 验证集相对训练集的 Calmar 允许衰减比例，超过即标记疑似过拟合 */
  maxDecay?: number
  /**
   * 配对比较的可分辨门槛：|Δ| / stderr(Δ) 要大于它。
   * 默认 2 —— 约等于「两倍标准误」，与常用的 95% 直觉同量级，但**不是**假设检验：
   * 折之间不独立（同一段行情、同一批标的），所以这个数只当量级标尺用。
   */
  minDeltaT?: number
  /** 配对胜率门槛（Δ > 0 的折数 ÷ **受影响**的折数）。默认 2/3 */
  minWinRate?: number
  /**
   * 是否跑测试集。**默认 false**（2026-08-13 改）。
   *
   * docs/07 §3 ④ 要求「测试集只跑一次」，而这个工具以前每次调用都对该次优胜者跑一遍
   * 测试段 —— 于是「扩个网格重跑一轮」就等于又看了一次测试窗口，截至 2026-08-12
   * 已经累计触碰 5 次（docs/07 §3 的计数），其中绝大多数次的优胜者最后都没被采用。
   * 把它改成显式开关：只有在真的要出最终报告时才 `--touch-test`。
   */
  touchTest?: boolean
  log?: (message: string) => void
}

/** 三态裁决。以前只有「有优胜者 / 没有优胜者」，后者读起来像失败，其实 KEEP 是结论 */
export type Verdict =
  /** 有挑战者在配对比较上显著优于出厂值，且不是孤峰 —— 可以进人工复核与写回流程 */
  | 'WRITE_BACK'
  /** 出厂值站得住：没有挑战者的改进大于它自己的抖动。**这是结论，不是没跑出来** */
  | 'KEEP'
  /** 连出厂值本身都被红线淘汰，或折数不足以估离散度 —— 此时 KEEP 与 WRITE_BACK 都不能说 */
  | 'INCONCLUSIVE'

/** KEEP 时用来量化「差多少才能分辨」——「定不下来」由此变成一个可执行的数 */
export interface Resolution {
  /** 折数 */
  cells: number
  /** 可分辨的最小 Δ（= minDeltaT × stderr），按最好的那个挑战者估 */
  noiseFloor: number | null
  /** 观测到的最大 Δ（挑战者中 delta.mean 最大者） */
  bestDelta: number | null
  /**
   * 要让 `bestDelta` 变得可分辨，大约需要多少折。
   * 按 stderr ∝ 1/√n 反解：n* = cells × (minDeltaT × stdev / bestDelta)²。
   * **量级估计**，不是样本量计算 —— 折之间不独立，且假设了 Δ 与离散度都不随样本变。
   */
  requiredCells: number | null
}

export interface CalibrationReport {
  splits: Split[]
  candidates: Candidate[]
  /** 出厂参数那一行（永远参与评估，即使网格里没写它） */
  incumbent: Candidate | null
  /** 通过全部红线与配对门槛的最佳挑战者；没有则为 null */
  winner: Candidate | null
  verdict: Verdict
  resolution: Resolution | null
  /** 测试集只跑一次的结果（仅对 winner，且需 touchTest） */
  test: PerformanceBlock | null
  notes: string[]
}

/** 逐叶子对比覆盖块与基准参数，收集真正改了的叶子 */
export function changedLeaves(
  overrides: ParamOverrides,
  base: EngineParams
): { path: string; value: unknown }[] {
  const out: { path: string; value: unknown }[] = []
  const walk = (patch: unknown, current: unknown, prefix: string): void => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      if (JSON.stringify(patch) !== JSON.stringify(current)) out.push({ path: prefix, value: patch })
      return
    }
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      const next =
        current !== null && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined
      walk(value, next, prefix === '' ? key : `${prefix}.${key}`)
    }
  }
  walk(overrides, base, '')
  return out
}

/** 按 `a.b.c` 取值 */
function valueAtPath(root: unknown, path: string): unknown {
  let cursor: unknown = root
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/**
 * 候选在某个维度之外「还改了什么」的签名。
 *
 * 用来定义**谁是谁的邻居**：只有其余维度完全一样、仅在维度 P 上取值不同的两个候选，
 * 才能拿来判 P 的邻域。OFAT 网格里这个签名恒为空，出厂值（一个叶子都没改）因此
 * 天然是每个 OFAT 候选的邻居之一 —— 这正是我们要的，`scoreThreshold` 0.55 的上侧邻居
 * 就该是出厂的 0.6。
 */
function otherAxesKey(candidate: Candidate, axis: string): string {
  return JSON.stringify(
    candidate.changed
      .filter((leaf) => leaf.path !== axis)
      .map((leaf) => [leaf.path, leaf.value] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  )
}

/**
 * 邻域（高原）判定 —— docs/07 §3 的「参数敏感性」红线，2026-08-13 起自动判。
 *
 * 判据就是人工在 §5.10 对 `squeezeBbwPct` 做过的那一套：**同一维度上取值相邻的候选
 * 也得站得住**。孤峰（自己很高、两边塌）不采用，因为那是噪音尖峰的形状；
 * 高原（±一档邻居都没崩）才算测出了东西。§5.14 的 `voteThreshold.trend = 4`
 * （验证集 Calmar 0.887，两侧是 0.427 与 −0.233）就是被人工按这条否掉的。
 *
 * 落在网格边界上时**也要标**：不是它不好，是邻域没测过 —— 这正是
 * §5.10「设计网格时先把取值范围想宽一点」那条教训的机器版本。
 *
 * 改了多个叶子的候选（笛卡尔积网格常见）逐维度分别判：每个数值维度都要有站得住的邻居。
 * 非数值维度（预设名、布尔）没有邻域概念，只标一次「判不了」。
 */
export function plateauFlags(
  target: Candidate,
  all: readonly Candidate[],
  base: EngineParams,
  cliffRatio = 0.5
): string[] {
  if (target.score === null || target.changed.length === 0) return []
  const flags: string[] = []

  for (const leaf of target.changed) {
    // 取成局部 const 再判：`typeof leaf.value === 'number'` 这种**属性**上的收窄
    // 一进闭包（下面全是 filter/sort 回调）就失效，TS 无法保证属性没被改过
    const centre = leaf.value
    const score = target.score
    if (typeof centre !== 'number') {
      flags.push(`维度 ${leaf.path} 不是数值，邻域判不了（docs/07 §3 的敏感性红线只对连续量成立）`)
      continue
    }
    const key = otherAxesKey(target, leaf.path)
    const siblings = all
      .filter((c) => c !== target && otherAxesKey(c, leaf.path) === key)
      .map((c) => ({
        candidate: c,
        // 该候选没有改这个维度时，它在这个维度上的取值就是出厂值 ——
        // 出厂值那一行因此天然是每个 OFAT 候选的一侧邻居
        value: Number(c.changed.find((l) => l.path === leaf.path)?.value ?? valueAtPath(base, leaf.path)),
      }))
      .filter((s) => Number.isFinite(s.value) && s.value !== centre)
    const lower = siblings.filter((s) => s.value < centre).sort((a, b) => b.value - a.value)[0]
    const upper = siblings.filter((s) => s.value > centre).sort((a, b) => a.value - b.value)[0]

    for (const [side, neighbour] of [
      ['下侧', lower],
      ['上侧', upper],
    ] as const) {
      if (!neighbour) {
        flags.push(
          `${leaf.path} = ${centre} 落在网格${side}边界，该侧邻域未测 —— 先把网格放宽再判`
        )
        continue
      }
      const peer = neighbour.candidate.rejected !== null ? null : neighbour.candidate.score
      if (peer === null || peer < score * (1 - cliffRatio)) {
        flags.push(
          `${leaf.path} = ${centre} 的${side}邻居 ${neighbour.value} 绩效断崖（${
            peer === null ? '被红线淘汰' : peer.toFixed(3)
          } vs ${score.toFixed(3)}），是孤峰不是高原，不宜采用`
        )
      }
    }
  }
  return flags
}

export function calibrate(input: CalibrationInput): CalibrationReport {
  const minTrades = input.minTrades ?? 30
  const maxDecay = input.maxDecay ?? 0.5
  const minDeltaT = input.minDeltaT ?? 2
  const minWinRate = input.minWinRate ?? 2 / 3
  const log = input.log ?? ((): void => {})
  const train = input.splits.find((s) => s.name === 'train')
  const validation = input.splits.find((s) => s.name === 'validation')
  const test = input.splits.find((s) => s.name === 'test')
  if (!train) throw new Error('缺少训练集区间')

  // 出厂参数永远在候选表里，且排在最前面 —— 后面所有比较都是「相对它」的配对比较。
  // 网格里已经写了出厂值（OFAT 网格的中心行就是）时不重复跑。
  const baseFingerprint = paramsFingerprint(input.base)
  const queue: ParamOverrides[] = [...input.candidates]
  if (!queue.some((o) => paramsFingerprint(withParams(o, input.base)) === baseFingerprint)) {
    queue.unshift({})
  }

  const candidates: Candidate[] = []

  for (const [i, overrides] of queue.entries()) {
    const params = withParams(overrides, input.base)
    const fingerprint = paramsFingerprint(params)
    const changed = changedLeaves(overrides, input.base)
    const axis =
      changed.length === 1 && typeof changed[0]?.value === 'number' ? (changed[0]?.path ?? null) : null
    const incumbent = fingerprint === baseFingerprint
    const shell = {
      overrides,
      fingerprint,
      changed,
      axis,
      incumbent,
      foldScores: [] as (number | null)[],
      delta: null,
      flags: [] as string[],
    }
    log(`[calibrate] ${i + 1}/${queue.length} ${fingerprint}${incumbent ? '（出厂值）' : ''}`)

    const trainRun = input.run(params, train)
    const trainBlock = trainRun.overall

    if (trainBlock.trades.count < minTrades) {
      candidates.push({
        ...shell,
        train: trainBlock,
        validation: null,
        score: null,
        rejected: `训练集仅 ${trainBlock.trades.count} 笔交易（< ${minTrades}）`,
      })
      continue
    }

    // 训练集本身就亏钱的候选没有资格进排名。排名口径是**验证集** Calmar（见下），
    // 这本身是对的（用训练集排名等于直接过拟合），但它有个盲区：一个在 6 年训练窗口里
    // 亏钱、却在 18 个月验证窗口里赚钱的候选会排到很前面 —— 那不叫稳健，叫验证窗口正好对它友好。
    // 2026-08-12 标定 combine 块时 `voteThreshold {trend:3, meanReversion:1}` 就是这样：
    // 训练集 1047 笔 / −3.73% / 夏普 −0.29，验证集 359 笔 / +2.77% / Calmar 0.54，排名第 2，
    // 而当时三条红线一条都拦不住它（衰减红线要求 `trainScore > 0` 才判）。见 M2 §5.14。
    const trainScore = calmar(trainBlock)
    if (trainScore !== null && trainScore <= 0) {
      candidates.push({
        ...shell,
        train: trainBlock,
        validation: null,
        score: null,
        rejected: `训练集年化为负（Calmar ${trainScore.toFixed(2)}），验证集再好也只是窗口运气`,
      })
      continue
    }

    const validationRun = validation ? input.run(params, validation) : null
    const validationBlock = validationRun?.overall ?? null
    const validationScore = validationBlock ? calmar(validationBlock) : null
    const foldScores = (validationRun?.cells ?? []).map((cell) => cellScore(cell.block))

    const flags: string[] = []
    let rejected: string | null = null
    if (validationBlock && validationBlock.trades.count < Math.max(5, Math.floor(minTrades / 4))) {
      rejected = `验证集交易过少（${validationBlock.trades.count} 笔），无法判断稳定性`
    } else if (validationScore !== null && validationScore < 0) {
      rejected = '验证集年化为负，训练集表现不可信'
    } else if (
      trainScore !== null &&
      validationScore !== null &&
      trainScore > 0 &&
      validationScore < trainScore * (1 - maxDecay)
    ) {
      flags.push(
        `验证集 Calmar ${validationScore.toFixed(2)} 相对训练集 ${trainScore.toFixed(2)} 衰减超过 ${(
          maxDecay * 100
        ).toFixed(0)}%，疑似过拟合`
      )
    }

    candidates.push({
      ...shell,
      train: trainBlock,
      validation: validationBlock,
      // 排名用**验证集**分数：训练集分数只用来筛交易次数，用它排名等于直接过拟合
      score: validationScore ?? trainScore,
      foldScores,
      flags,
      rejected,
    })
  }

  const incumbent = candidates.find((c) => c.incumbent) ?? null

  // 逐折配对比较。**必须与出厂值比**，不是与彼此比：折单元之间不可横向读
  //（窗口短、标的少），只有同一折上的差值才有意义。
  if (incumbent) {
    for (const candidate of candidates) {
      if (candidate.incumbent) continue
      candidate.delta = pairedDelta(candidate.foldScores, incumbent.foldScores)
    }
  }

  const clean = candidates.filter((c) => !c.incumbent && c.rejected === null && c.score !== null)
  for (const candidate of clean) candidate.flags.push(...plateauFlags(candidate, candidates, input.base))

  const incumbentScore = incumbent?.score ?? null
  const incumbentWinRate = incumbent?.validation?.positions.winRate ?? null
  const passable = clean
    .filter((c) => c.flags.length === 0)
    .filter((c) => {
      const delta = c.delta
      if (!delta) return false
      // ① 风险调整后不能比出厂值差：折上比的是总收益，Calmar 这一关在这里守
      if (incumbentScore !== null && (c.score ?? -Infinity) < incumbentScore) return false
      // ①b **建仓级胜率不能比出厂值低**（2026-08-13 加）。
      //
      // 「提高胜率」这个目标可以被机械满足：把 profitProtectTrigger 调低（小赚就跑）
      // 能把胜率做到 70%，同时把盈亏比压到 0.5 —— 那是更差的系统。反过来也成立：
      // 只按收益排名会放过「胜率掉一大截、靠一两笔大赚拉回来」的候选。
      // 两个门槛一起卡，方向就唯一了：**胜率不降 + 收益显著提高**。
      // 注意口径是**建仓级**（把减仓拆出来的多行归并回一次建仓），不是逐行 —— 见 PositionStats。
      const winRate = c.validation?.positions.winRate ?? null
      if (incumbentWinRate !== null && winRate !== null && winRate < incumbentWinRate) return false
      // ② 至少要有三折真的被改动，否则「改善」只是一两折的巧合
      if (delta.affected < 3) return false
      // ③ 改善要稳定、且大于它自己的抖动
      if (delta.mean <= 0) return false
      if (delta.t === null || delta.t < minDeltaT) return false
      return delta.wins / delta.affected >= minWinRate
    })
    .sort((a, b) => (b.delta?.mean ?? 0) - (a.delta?.mean ?? 0))
  const winner = passable[0] ?? null

  // 分辨率：用「最好的那个挑战者」估「要多少折才能分辨已观测到的这个 Δ」
  const bestByDelta = [...clean]
    .filter((c) => c.delta !== null && c.delta.mean > 0)
    .sort((a, b) => (b.delta?.mean ?? 0) - (a.delta?.mean ?? 0))[0]
  const resolution: Resolution | null = (() => {
    const cells = incumbent?.foldScores.length ?? 0
    if (cells === 0) return null
    const delta = bestByDelta?.delta ?? null
    if (!delta || delta.stderr === null) {
      return { cells, noiseFloor: null, bestDelta: delta?.mean ?? null, requiredCells: null }
    }
    // 要求 minDeltaT × stdev/√n < mean ⇒ n > (minDeltaT × stdev / mean)²
    const stdev = delta.stderr * Math.sqrt(delta.cells)
    return {
      cells,
      noiseFloor: minDeltaT * delta.stderr,
      bestDelta: delta.mean,
      requiredCells: Math.ceil(((minDeltaT * stdev) / delta.mean) ** 2),
    }
  })()

  const verdict: Verdict = ((): Verdict => {
    if (!incumbent || incumbent.rejected !== null) return 'INCONCLUSIVE'
    if ((incumbent.foldScores.filter((s) => s !== null).length ?? 0) < 3) return 'INCONCLUSIVE'
    if (clean.length === 0) return 'INCONCLUSIVE'
    return winner ? 'WRITE_BACK' : 'KEEP'
  })()

  const notes: string[] = []
  switch (verdict) {
    case 'WRITE_BACK':
      notes.push(
        `裁决 WRITE_BACK：${JSON.stringify(winner?.overrides)} 在 ${winner?.delta?.cells} 个折单元上` +
          `平均优于出厂值 ${pp(winner?.delta?.mean)}（|Δ|/stderr = ${winner?.delta?.t?.toFixed(1)}，` +
          `受影响的 ${winner?.delta?.affected} 折里 ${winner?.delta?.wins} 折为正），` +
          '整池 Calmar 不低于出厂值，且邻域不断崖。仍需人工复核后写回（M2 清单 4.9a）。'
      )
      break
    case 'KEEP': {
      notes.push(
        '裁决 KEEP：**出厂值保持不变，这是结论而不是「没跑出来」** —— ' +
          '没有挑战者的改进大于它自己的折间抖动。写回任何一个都是用噪音替换猜测（ADR-0003）。'
      )
      // KEEP 有两种强度，差别很大，必须分开说：
      // ①「怎么动都测不出差别」（combine 块：全部 t < 1.5，M2 §5.15）——
      //    出厂值只是没有被推翻，本身没有任何正面证据；
      // ②「往任一方向动都显著更差」（adx/regime：t 最高 4.1，M2 §5.16）——
      //    出厂值落在一个测得出边界的区域里，这是**支持这个转述值**的正面证据。
      // 只印「没有候选够格」会把 ② 读成 ①，白扔掉这个项目最缺的那种证据。
      const worse = candidates.filter(
        (c) => !c.incumbent && c.delta !== null && c.delta.mean < 0 && (c.delta.t ?? 0) >= minDeltaT
      )
      if (worse.length > 0) {
        notes.push(
          `**但出厂值不是「随便取的也一样」**：${worse.length} 个候选显著更差` +
            `（Δ < 0 且 |Δ|/标准误 ≥ ${minDeltaT}，最差 ${pp(
              Math.min(...worse.map((c) => c.delta?.mean ?? 0))
            )}）。` +
            '也就是说往这些方向动是测得出代价的 —— 这是支持当前出厂值的正面证据，' +
            '与「怎么动都测不出差别」的 KEEP 不是一回事，归档时要分开写。'
        )
      }
      if (resolution?.requiredCells !== null && resolution?.requiredCells !== undefined) {
        notes.push(
          `分辨率（折上口径 = 本折总收益）：观测到的最大改进 Δ = ${pp(resolution.bestDelta)}，` +
            `当前 ${resolution.cells} 折下的可分辨门槛是 ${pp(resolution.noiseFloor)}。` +
            `要让这个 Δ 变得可分辨大约需要 ${resolution.requiredCells} 折（量级估计）——` +
            '要么把标的池 / 窗口扩到那个量级，要么承认这个参数在当前数据量下不可标定' +
            '（M2 清单 4.9c，别再重跑同一个网格）。'
        )
      }
      break
    }
    case 'INCONCLUSIVE':
      notes.push(
        '裁决 INCONCLUSIVE：出厂值本身被红线淘汰、或折数不足以估离散度。' +
          '此时既不能说「保持出厂值」也不能说「换成谁」—— 先把红线原因或折数解决掉。'
      )
      break
  }
  if (candidates.some((c) => c.flags.length > 0)) {
    notes.push('有候选被标记（疑似过拟合 / 孤峰 / 邻域未测），已排除在优胜者之外，但保留在报告中以备复核。')
  }
  notes.push(
    input.touchTest
      ? '测试集本次**已被读取**，按 docs/07 §3 ④ 记一次触碰；且不允许据此回头调参。'
      : '测试集本次未跑（默认不跑）。要出最终报告再加 --touch-test —— 它每跑一次都要按 docs/07 §3 ④ 记账。'
  )
  notes.push('入选参数写回 src/core/params.ts 是人的动作，本工具不自动改文件。')

  const testBlock =
    input.touchTest && winner && test ? input.run(withParams(winner.overrides, input.base), test).overall : null

  return { splits: [...input.splits], candidates, incumbent, winner, verdict, resolution, test: testBlock, notes }
}

/**
 * 邻域敏感性检查的手工版（docs/07 §3 的第一条红线）。
 *
 * `plateauFlags` 已经能从网格里自动找邻居，这个函数留给「邻域不在同一次网格里」的场合
 * （比如手动跑三个点做扰动）。判据相同：邻域绩效断崖即视为噪音峰值。
 */
export function sensitivityFlags(
  center: number,
  neighbours: readonly { value: number; score: number | null }[],
  centerScore: number | null,
  cliffRatio = 0.5
): string[] {
  if (centerScore === null || centerScore <= 0) return []
  const flags: string[] = []
  for (const neighbour of neighbours) {
    if (neighbour.score === null || neighbour.score < centerScore * (1 - cliffRatio)) {
      flags.push(
        `邻域 ${neighbour.value}（中心 ${center}）绩效断崖下跌，最优点疑似噪音峰值，不宜采用`
      )
    }
  }
  return flags
}

function fmt(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined ? '—' : value.toFixed(digits)
}

/** 折上的量是收益率，用 pp 打 —— 与 §5.5–§5.13 里所有消融结论的单位一致 */
function pp(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? '—' : `${(value * 100).toFixed(digits)}pp`
}

export function renderCalibration(report: CalibrationReport): string {
  const lines: string[] = []
  lines.push('─'.repeat(78))
  lines.push(`参数标定报告 · 裁决 ${report.verdict}`)
  for (const split of report.splits) {
    const skipped = split.name === 'test' && report.test === null ? '（本次未跑）' : ''
    lines.push(`  ${split.name.padEnd(11)} ${split.from} → ${split.to}${skipped}`)
  }
  if (report.resolution) {
    lines.push(
      `  折单元 ${report.resolution.cells} 个（标的子集 × 时间片，同一次模拟切出来，不额外跑）`
    )
  }
  lines.push('─'.repeat(78))
  lines.push('候选（按整池验证集 Calmar 排序；Δ 是与出厂值的逐折配对**总收益**差值）：')

  const sorted = [...report.candidates].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
  for (const candidate of sorted) {
    const status = candidate.rejected
      ? `淘汰：${candidate.rejected}`
      : candidate.flags.length > 0
        ? `标记：${candidate.flags.join('；')}`
        : candidate.incumbent
          ? '出厂值'
          : candidate === report.winner
            ? '**优胜**'
            : '通过'
    const delta = candidate.delta
    const deltaText = delta
      ? `Δ ${delta.mean >= 0 ? '+' : ''}${pp(delta.mean)} ± ${pp(delta.stderr)}  ` +
        `t ${fmt(delta.t, 1).padStart(4)}  胜 ${delta.wins}/${delta.affected} 折（动了 ${delta.affected}/${delta.cells}）`
      : candidate.incumbent
        ? '（基准）'
        : 'Δ —'
    lines.push(
      `  ${candidate.fingerprint}  Calmar ${fmt(candidate.score).padStart(8)}  ${deltaText}  ${status}`
    )
    lines.push(`      ${JSON.stringify(candidate.overrides)}`)
  }

  lines.push('')
  if (report.incumbent) {
    const t = report.incumbent.train
    const v = report.incumbent.validation
    lines.push(
      `出厂值：训练 ${t.trades.count} 笔 / ${(t.totalReturn * 100).toFixed(2)}% / Calmar ${fmt(calmar(t))}` +
        (v ? `  验证 ${v.trades.count} 笔 / ${(v.totalReturn * 100).toFixed(2)}% / Calmar ${fmt(calmar(v))}` : '')
    )
  }
  if (report.winner) {
    lines.push(`优胜候选：${report.winner.fingerprint}  ${JSON.stringify(report.winner.overrides)}`)
    if (report.test) {
      lines.push(
        `测试集：总收益 ${(report.test.totalReturn * 100).toFixed(2)}%  回撤 ${(
          report.test.maxDrawdown * 100
        ).toFixed(2)}%  ${report.test.trades.count} 笔`
      )
    }
  } else {
    lines.push('优胜候选：无')
  }

  lines.push('')
  for (const note of report.notes) lines.push(`※ ${note}`)
  return lines.join('\n')
}
