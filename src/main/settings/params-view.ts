/**
 * 设置页那张**只读**参数表（docs/01 §5.5、ADR-0003）。
 *
 * ## 为什么是只读
 *
 * docs/01 §5.5 把「策略参数」列进了设置项，但 ADR-0003 说 `params.ts` 里的数值几乎
 * 全部是未标定的转述猜测。给用户一个自由编辑框，等于让他在没有任何回测依据的情况下
 * 换一个同样没有依据的值 —— 期望收益为零，而排查成本很高：
 * 「改坏了 → 一条信号都不出 → 以为程序坏了」这条路用户走不出来，也不会想到是自己改的。
 *
 * 所以设置页可调的只有**灵敏度三档**（同样标注未标定）与提醒级别偏移，
 * 参数表本身只回答一个问题：**这个数是哪来的、测过没有。**
 *
 * ## 这张表的价值在 `status` 那一列
 *
 * 一张不分档的参数表会让二十来个数值看起来同等可信 —— 那正是 ADR-0003 要防的事。
 * 分档之后用户（和三个月后的自己）能一眼看出：真正被标定过并写回的**只有一项**。
 *
 * `STATUS` 的每一条都对着偏差报告里的一节。**改 `params.ts` 的值时要一起改这里**：
 * `tests/unit/main/params-view.test.ts` 钉住了两条不变量 ——
 * ① 每个叶子参数都要有归档（漏了会掉进 `GUESS`，那不是默认值而是结论）；
 * ② `CALIBRATED` 集合必须**恰好**是 params.ts 顶部那张已标定清单。
 */

import { DEFAULT_PARAMS } from '@core/params'
import type { ParamGap, ParamRow } from '@shared/ipc-types'

type Status = ParamRow['status']

/**
 * **这张表管不到的数**（2026-09-02 用户拍板，计划 §4.5b 选 B）。
 *
 * ## 为什么要有这么一节
 *
 * 上面那张 `STATUS` 表的全部价值是「**哪个数有依据**」。而它只覆盖 `EngineParams`
 * 的叶子参数 —— 决定子信号排序的那五个权重是**写死在策略文件里的常量**，
 * 既不在 62 个叶子里、也不在 `withParams()` / `--grid` 的射程内
 * ⇒ 八张网格 82 组候选**一次都没扫到它们**，而这张表对它们**完全静默**。
 *
 * 静默是最糟的那一档：用户看到「未测 0」会以为每个数都被归过档。
 *
 * ## 为什么选「留作常量」而不是「补成参数」
 *
 * 二选一在计划 §4.5b 里写着，2026-09-02 用户拍板选 B：
 * [M2 §5.35](../../../docs/notes/M2-偏差报告.md) 已实测「排序方向没有可测的增量」
 * ⇒ 把五个从没被证据支持过的数升级成「待标定参数」只会让 `GUESS` 从 0 变成非 0
 * （摘 `-unvalidated` 的条件是 `GUESS` 与 `BLOCKED` 两档都清零 ⇒ 更远了），
 * **而不带来任何新证据**。⇒ 承认它们是设计常量，**但把空洞写出来**。
 *
 * ⚠ **它不是第七档**。这些条目不进 `paramRows()`、不进 `countByStatus()` ——
 * 混进去会让六档计数变成一个说不清口径的数。它是表**外**的一段说明。
 * ⚠ 要往这里加条目，先问一遍「它是不是其实该进 `STATUS`」：
 * 只有**结构上进不了 `EngineParams`** 的才属于这里。
 */
export const PARAM_GAPS: readonly ParamGap[] = [
  {
    title: '决定子信号排序的五个权重不在这张表里',
    where:
      'TREND_WEIGHTS（src/core/strategies/trend.ts）T1 0.2 / T2 0.25 / T3 0.25 / T4 0.15 / T5 0.15；' +
      'MEAN_REVERSION_WEIGHTS（src/core/strategies/mean-reversion.ts）R1–R4',
    why:
      '它们是写死的常量、不是 EngineParams 的叶子 ⇒ 标定网格在结构上扫不到，至今一格没跑过。' +
      '2026-09-02 拍板保留为设计常量（计划 §4.5b 选 B）：M2 §5.35 已测出「排序方向没有可测的增量」，' +
      '把它们升成待标定参数只会让「未测」计数变差而不带来新证据。' +
      '⚠ 这是一个已知空洞，不是遗漏 —— 也就是说，上面那六档计数**没有覆盖这五个数**。',
  },
]

/**
 * 逐参数归档。键是点分路径（`combine.voteThreshold.trend`），
 * 前缀命中即生效 —— 整块同档时不必逐叶子写。
 */
const STATUS: Record<string, { status: Status; note?: string }> = {
  // ── 已标定并写回（M2 清单 4.9a）。**目前只有这一项** ──────────────
  'strategy.squeezeBbwPct': {
    status: 'CALIBRATED',
    note: '2026-08-12 标定：出厂 10 被验证集红线淘汰，16–30 是通过的高原，取 20（M2 §5.10）',
  },

  // ── 已上网格、裁决保持出厂值（M2 清单 4.9c）─────────────────────
  'combine.scoreThreshold': { status: 'KEPT', note: '15 个候选最大 t = 1.4，怎么动都测不出差别（§5.15）' },
  'combine.voteThreshold': { status: 'KEPT', note: '任一策略达到自己的线即触发，不是两边相加（§5.14）' },
  'combine.conflictBand': { status: 'KEPT', note: '「压掉双方」优于「弱侧让路」已单独验证（§5.12）' },
  'adx.baseThreshold': {
    status: 'KEPT',
    note: '有正面证据：±2 与 ±4 邻域全部更差，两个邻居让训练集亏钱被淘汰（§5.16/§5.17）',
  },
  'adx.volScale': { status: 'KEPT', note: '有正面证据：6 与 10 各 −0.16pp（§5.17）' },
  'adx.period': { status: 'KEPT', note: '随 adx 块一同上过网格' },
  'adx.rangeGap': { status: 'KEPT', note: '随 adx 块一同上过网格' },
  'regime.hysteresisDays': {
    status: 'KEPT',
    note: '1 明显更差（−0.34pp），2–6 分辨不出。若为「少改口」上调，判据是提醒日志不是回测（§5.17）',
  },
  'regime.rangeMidBand': { status: 'KEPT', note: '四个邻域取值全负但非单调、t ≤ 1.6，噪音的形状（§5.17）' },
  'risk.stopLossPct': { status: 'KEPT', note: '96.6% 的离场由风控触发，这一块已上网格（§5.18）' },
  'risk.drawdownReducePct': {
    status: 'KEPT',
    // 仍是 KEPT：§5.30 的消融**没过写回门槛**（训练 Calmar 仍负、验证窗口反向），
    // 一个数都没动。这条备注记的是「证据往哪边指」，不是「已经改了」
    note:
      '**最优先复核**：7% → 10% 四个口径同向改善但 t = 0.77（§5.18，40 只旧池）；' +
      '261 只池上把它整个关掉是四个风控消融里最好的一个（训练 +1.20pp、建仓级胜率 +7.86pp、' +
      '建仓数只降 2%），但验证窗口反向 ⇒ 不写回（§5.30）。' +
      '三点网格 0.07/0.10/0.14 全部未过主判据（训练 Calmar 仍负），且 **≥0.14 是算术死区**' +
      '（被 8% 止损短路，与关掉逐位相同）⇒ 别扫上侧（§5.31）',
  },
  'risk.profitProtectTrigger': {
    status: 'KEPT',
    note: '验证集 Calmar 翻倍是陷阱 —— 训练集与建仓级胜率全线低于出厂，被写回门槛挡下（§5.18）',
  },
  'risk.profitProtectFallback': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },
  'risk.trailingStopPct': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },
  'risk.industryConcentrationCap': {
    status: 'UNTESTABLE',
    note:
      '2026-08-14 改档（原 KEPT）：回测**两重**读不到它 —— `industryShare` 只有主进程会传，' +
      '而这条规则只产 `DOWNGRADE`（改提醒级别，不改 direction）。§5.18 那轮的 KEEP 对它无信息量（§5.20）',
  },
  'risk.newListingMinBars': { status: 'KEPT', note: '随 risk 块一同上过网格（§5.18）' },

  // ── 已判参数惰性或算术无效（M2 清单 4.9c 的另一半）───────────────
  'combine.downtrendBuyPenalty': {
    status: 'INERT',
    note: '0.25/0.5/0.75 逐折逐位相同 —— 不是效应小，是没有效应（§5.15）',
  },
  'adx.maxThreshold': {
    status: 'INERT',
    note: '算术上的死参数：clamp 的被夹项 ≤ base + volScale = 28，上界永远咬不住。别扫上侧（§5.16）',
  },
  'strategy.revertLookback': {
    status: 'INERT',
    note: '取 3/5/8/12/20 验证集逐位相同；根因在票数线不在取值（§5.11）',
  },
  'multiTf.weekCrossLookback': { status: 'INERT', note: '大半取值动 0/12 折，改了等于没改（§5.18）' },
  'multiTf.dayRsiBuyMax': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.dayRsiSellMin': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.weekAdxConfirm': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.weekAdxWeak': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.resonanceDelta': { status: 'INERT', note: '同上（§5.18）' },
  'multiTf.falseBreakoutDelta': { status: 'INERT', note: '同上（§5.18）' },
  /*
    下面四条是 2026-08-14 在 B1 的准备工作里**读代码**判出来的（M2 §5.20），
    不是跑网格跑出来的 —— 它们在网格上会表现为「动 0/84 折」，而那种证据比
    「这个数没有读者」弱：前者只说明这一次没测出差别，后者是算术上不可能有差别。
    往这一档加行之前先确认是**没有读者**或**分支走不到**，不是「效应小」。
  */
  'ma.periods': {
    status: 'INERT',
    note:
      '信号层只读 5/20/60 三条（trend.ts 里是字面量），这张表只决定「算哪几条」——' +
      '加 10/120 对信号零影响，去掉 5/20/60 则是关掉 T1/T4 而不是调参。' +
      '10/120 有读者但不在信号层（观察点指标、AI 上下文），所以**不能删**（§5.20）',
  },
  'volume.shrinkRatio': {
    status: 'INERT',
    note: '全仓搜索无读者：docs/04 §1.6 的「ratio ≤ 0.8 为缩量」从未被任何子信号消费（§5.20）',
  },
  'macd.preset': {
    status: 'INERT',
    note:
      '纯标签：MacdParams 只有 fast/slow/signal，没有任何代码读 preset。' +
      '改它会变参数指纹（指标缓存作废、影子运行停止累积）却不改任何行为 —— 有代价没效果（§5.20）',
  },
  'data.minBars': {
    status: 'UNTESTABLE',
    note:
      '回测的预热下限是 fullBars = 300 > minBars = 40，这条分支在回测里走不到；' +
      '它管的是「新股上市初期不出信号」，判据只能来自真机（§5.20）',
  },
  'data.insufficientPenalty': {
    status: 'UNTESTABLE',
    note: '同一条分支（bars < fullBars 或 BBW 分位未预热）在回测里走不到，除非把 --warmup 钉住（§5.20）',
  },
  'strategy.expandedBbwPct': {
    status: 'UNTESTABLE',
    note:
      '2026-08-14 实测 70/80/95/98 四档与出厂 90 **逐位相同**（建仓 1187、胜率 43.30% 一字不差）——' +
      '因为它只产 `VOLATILITY_EXPANDED` 这条 `DOWNGRADE`（改提醒级别），而回测的 toOrder() 只读 direction。' +
      '判据与 `alert.bubbleScore` 同一档：提醒日志，不是 Calmar（§5.20 ⑦）',
  },

  // ── 日线回测原理上测不到（归影子运行 / M3 提醒日志）───────────────
  'combine.provisionalDiscount': {
    status: 'UNTESTABLE',
    note: '回测只判收盘线，走不到盘中折价这条分支。依据须来自影子运行',
  },
  'alert.bubbleScore': {
    status: 'UNTESTABLE',
    note: '判据是提醒日志里「今天这几条值不值得被打断」，不是回测 Calmar（M3 验收 §4）',
  },
  'risk.lateBuyCutoffMinutes': { status: 'UNTESTABLE', note: '回测按次日开盘成交，没有「14:50 之后」这件事' },
  'data.staleSnapshotMs': { status: 'UNTESTABLE', note: '回测没有实时快照，这条分支走不到' },
  /*
    做T的三个门。**是 UNTESTABLE 不是 GUESS** —— 差别不是「还没测」而是「测不了」：
    一根日线只有开高低收，不知道当天先到高点还是先到低点，「日内位置」在日线上
    根本没有对应量。把它们放进 GUESS 会让人在补完计划里排一轮网格，
    而那一轮扫出来的「最优值」是在一个不存在的量上取的极值。
  */
  tTrade: {
    status: 'UNTESTABLE',
    note: '日线回测看不见日内路径（不知先到高点还是低点），依据只能来自实盘使用',
  },

  /*
    ── BLOCKED：网格跑过了，但出厂值自己被红线淘汰 ⇒ 裁决必为 INCONCLUSIVE ──────

    网格文件都在（`params/grid-{volume,rsi,boll,macd,strategy,regime-rest,data}.json`），
    2026-08-14 在 261 只宽基池上**全部跑完**（八张、82 组候选）。
    但出厂参数本身在 6 年训练窗口上亏钱（−2.55% / Calmar −0.125），
    被标定工具的红线「训练集 Calmar ≤ 0 直接淘汰」判掉 ⇒ 出厂值没有逐折分数
    ⇒ 配对 Δ 全是 null ⇒ **每一张网格的裁决都只能是 `INCONCLUSIVE`**（M2 §5.20）。

    **这不是工具坏了**，是那条红线在说「先解决出厂值自己站不住这件事」。
    在那之前把这些行改成 KEPT / CALIBRATED 都是没有依据的。

    ⚠ 2026-08-15 这一批从 `GUESS` 改档 `BLOCKED`（计划文档 §1.1 拍板题 A / 方向 ③）。
    **两者的后续动作完全不同**：`GUESS` 要去跑网格，`BLOCKED` 要**先让基线转正**再重测。
    混成一档已经制造过一次「同一张网格跑两遍」。
    **失效条件**：基线在代表性池上训练窗口 Calmar > 0 之后，这一批全部退回重跑。
  */
  macd: {
    status: 'BLOCKED',
    note:
      '12/17/9 来自来源文档转述（docs/04 §1.2）。2026-08-14 上过网格但**裁决 INCONCLUSIVE**：' +
      '13 组训练集绩效落在 −2.25% ~ −2.79% 的一片平地上（经典 12/26/9 是里面最好的 −2.25%），' +
      '而出厂值自己被红线淘汰 ⇒ 拿不到配对 Δ（§5.20 ⑦）',
  },
  boll: {
    status: 'BLOCKED',
    note:
      '标准差除 n 而非 n−1 是国内平台口径。2026-08-14 网格 INCONCLUSIVE：`k` 2.5 与 `period` 22 ' +
      '把训练集从 −2.55% 拉到 −0.73%/−0.99%，但靠的是**少做**（建仓 1187 → 782）。' +
      '⚠ `bbwLookback` 375/500 那两组不可按「更差」读：分位数要够长的样本才有值，被 --warmup 300 confound 了（§5.20 ⑦）',
  },
  volume: {
    status: 'BLOCKED',
    note:
      '2026-08-14 网格 INCONCLUSIVE：`breakoutRatio` 1.1 → 1.6 单调变好（最好 −2.21%），' +
      '`maPeriod` 与 `suspiciousRatio` 一片平地（§5.20 ⑦）',
  },
  rsi: { status: 'BLOCKED', note: '2026-08-14 上过网格，裁决 INCONCLUSIVE（§5.20 ⑦）' },
  'strategy.pullbackLookback': { status: 'BLOCKED', note: '2026-08-14 网格 INCONCLUSIVE：3/8/12 三档都在 ±0.5pp 内' },
  'strategy.midReversionStd': {
    status: 'BLOCKED',
    note: '2026-08-14 网格 INCONCLUSIVE：2.0 是全场第二好（−1.13%），但同样靠少做（建仓 1187 → 945）',
  },
  'regime.rangeBbwPct': { status: 'BLOCKED', note: 'docs/04 §1.4 的「< 30 收敛」转述。2026-08-14 网格 INCONCLUSIVE，四档取值差 < 0.4pp' },
  'regime.adxSlopeWindow': { status: 'BLOCKED', note: '2026-08-14 网格 INCONCLUSIVE' },
  'regime.adxSlopeTrigger': { status: 'BLOCKED', note: '2026-08-14 网格 INCONCLUSIVE；8 与 12 逐位相同（该侧已饱和）' },
  'regime.bbwPctJump': { status: 'BLOCKED', note: '2026-08-14 网格 INCONCLUSIVE' },
  'data.fullBars': {
    status: 'BLOCKED',
    note: '它在回测里同时充当预热下限，扫它必须钉住 --warmup，否则测的是判定窗口不是参数（§5.20）',
  },
}

/**
 * `enabledStrategies` 不进参数表。
 *
 * 它是**消融测量工具**而不是可标定参数（params.ts 的注释写着），出厂两项必须都是 true。
 * 摆到设置页里会立刻变成一个「关掉均值回归试试」的开关 —— 而均值回归已经被误判过两次死刑，
 * 两次都是别的东西的锅（M2 §5.9/§5.10）。
 */
const HIDDEN_GROUPS = new Set(['enabledStrategies'])

function lookup(path: string): { status: Status; note?: string } {
  // 最长前缀优先：`combine.voteThreshold.trend` 命中 `combine.voteThreshold`
  const parts = path.split('.')
  for (let i = parts.length; i > 0; i--) {
    const hit = STATUS[parts.slice(0, i).join('.')]
    if (hit) return hit
  }
  // 兜底成 GUESS 而不是抛错：漏归档的参数照样要显示出来，
  // 而单测会告诉我们漏了哪一个（见文件头不变量 ①）
  return { status: 'GUESS', note: '未归档 —— 请补 params-view.ts 的 STATUS 表' }
}

function render(value: unknown): string {
  if (Array.isArray(value)) return value.join(' / ')
  return String(value)
}

/**
 * 摊平 `DEFAULT_PARAMS` 成表格行。
 *
 * 传 `params` 可以摊平「当前生效的」参数集（含灵敏度换档后的值），
 * 默认摊出厂值。嵌套对象（`combine.voteThreshold`）逐叶子展开成 `voteThreshold.trend`。
 */
export function paramRows(params: object = DEFAULT_PARAMS): ParamRow[] {
  const rows: ParamRow[] = []

  const walk = (group: string, prefix: string, value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        walk(group, prefix === '' ? key : `${prefix}.${key}`, child)
      }
      return
    }
    const archived = lookup(`${group}.${prefix}`)
    rows.push({
      group,
      key: prefix,
      value: render(value),
      status: archived.status,
      ...(archived.note === undefined ? {} : { note: archived.note }),
    })
  }

  for (const [group, block] of Object.entries(params)) {
    if (HIDDEN_GROUPS.has(group)) continue
    walk(group, '', block)
  }
  return rows
}

/** 供 UI 显示「已标定 1 / 已测 n / 惰性 n / 测不到 n / 卡住 n / 未测 n」这一行 */
export function countByStatus(rows: readonly ParamRow[]): Record<Status, number> {
  const counts: Record<Status, number> = {
    CALIBRATED: 0,
    KEPT: 0,
    INERT: 0,
    UNTESTABLE: 0,
    BLOCKED: 0,
    GUESS: 0,
  }
  for (const row of rows) counts[row.status]++
  return counts
}
