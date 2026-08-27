/**
 * 看板的**渲染层**：把采集好的快照排成 Markdown。
 *
 * 为什么与 `./status.ts` 分家（2026-08-27，M2 §5.74 ⑤ 的后续）：
 * 那个文件从第一行就在读文件系统与 `market.db`，且在模块末尾直接 `main()`
 * ⇒ **import 它就会跑一遍**，于是渲染出来的文案一条用例都写不了。
 * 而看板上那些文案不是装饰 —— §5.74 那条「胜率是效应量的饱和变换、竖着不能比幅度」
 * 与效应量 μ 那一列，**本身就是为了挡住一次已经发生过的误读**
 * （§5.73 ④ 当天写、当天读错）。一道没有用例的闸门只是又一条纪律，
 * 而这个项目已经证过一次「**写下一条纪律不等于装上一道闸门**」（§5.44）。
 *
 * 所以这里只有**纯函数**：
 *
 * - **不读时钟** —— `at` 与 `straddlesMidnight` 由调用方算好传进来。
 *   `straddlesMidnight` 原先是 render 里直接 `new Date().getTimezoneOffset()`，
 *   那一句会让「本机时区告警印不印」这条永远测不了（与 `src/core` 同一条纪律）。
 * - **不读文件** —— 快照全部由 `./status.ts` 采集。
 * - **不判断「读不到算 0」** —— `Maybe` 的两态原样落到文案上（文件头纪律 3）。
 */

import type { TradeDate } from '@core/types'
import type { Freshness } from './session'
import type { BacklogItem, ItemBucket, ItemState } from './backlog'

/** 读不到就是读不到 —— 不许退化成 0（见 `status.ts` 文件头纪律 3） */
export type Maybe<T> = { known: true; value: T } | { known: false; why: string }

export interface ParamState {
  engineVersion: string
  counts: Record<string, number>
  leaves: number
}

export interface BaselineSnapshot {
  file: string
  at: string
  engineVersion: string
  codes: number
  /**
   * 这份报告覆盖的窗口（`meta.from` / `meta.to`）。**必须打印出来**（2026-08-18 加）——
   * 之前表头写死「全期收益」，而选中的 `recheck-after-idx.json` 的 `to` 是 **2023-12-31**
   * ⇒ 那是**训练窗口**，看板把一个它没挣到的标签盖在了 −1.99% 上。
   * 读不到就给 null，绝不猜「大概是全期」。
   */
  from: string | null
  to: string | null
  positions: number
  trades: number
  totalReturn: number
  winRate: number
  maxDrawdown: number
  sharpe: number
  exposure: number
  /**
   * 因**非出厂口径**被跳过的报告（2026-08-20 加）。必须打印出来 —— 不然「为什么显示的
   * 是三天前那份」没有答案，人会以为看板卡住了。判据是 `auditKnobs`（只有一个出处）。
   */
  skipped: { file: string; why: string }[]
  /**
   * 选中这份报告身上**无法核对**的旋钮（老报告没记 `meta.costs`）。
   * 与「没有偏离」是两件事：`noslip-train.json`（`--slippage 0`，−1.21% vs 出厂 −1.99%）
   * 就落在这一档，把它当成出厂口径正是这次要修的东西。
   */
  unverifiable: string[]
}

export interface AlphaSnapshot {
  file: string
  engineVersion: string
  matchRegime: boolean
  shuffleSpans: boolean
  seed: number
  /**
   * 蒙特卡洛复制次数（2026-08-27 加，M2 §5.76）。
   *
   * **它必须与配对胜率印在同一行**：那个量是**试验数上的二项比例**
   * （`SE = √(p(1−p)/trials)`）⇒ `trials=200` 的噪音地板实测 **6.00pp**，
   * 而全项目引用过的「`ALL` 中位 8.50%」就是那一档的一次抽样。
   * 少印它，读的人没有办法判断一个 2pp 的差是真的还是抽样噪音。
   *
   * 旧报告一律有这个字段；真读不到时是 **null 不是 0**（纪律 3）。
   */
  trials: number | null
  /**
   * 零分布的时间结构（2026-08-19，迭代计划 §4.6 / M2 §5.42）。看板必须把它印出来 ——
   * 只报数字不报口径正是 §4.6 记的那条报告缺陷。三档的读法各不相同：
   * `INDEPENDENT` 是**未调整上界**（偏向显著）· `BLOCK` 已做时间聚集调整 ·
   * `REGIME_BLOCK` 换了零点定义（段内聚集保留、吸附恒 0），**但它与前两档不可互相替代**。
   * 旧报告没有这个字段，那种情况按未调整看待（`null` ⇒ 当上界读）。
   */
  timingNull: 'BLOCK' | 'INDEPENDENT' | 'REGIME_BLOCK' | null
  timingNullReason: string | null
  /** `REGIME_BLOCK` 的块覆盖率（0..1）。低于 0.8 时那一档仍按未调整上界读（§5.42 预注册门槛） */
  blockCoverage: number | null
  /** 落点权重档（§5.43）。`runs` 与 `positions` 不是同一个零点，看板必须印出来 */
  blockWeight: 'runs' | 'positions' | null
  crossCode: boolean
  /**
   * 基线口径的核对结论，由 `audit:random` 从 `--baseline` 那份**继承**下来
   * （2026-08-25，计划 §4.9）。`null` = 那份报告早于这个字段 ⇒ **认不出来**，
   * 既不是「出厂口径」也不是「偏离」—— 与基线那一侧的 `unverifiable` 同一档。
   */
  knobs: { deviations: string[]; unverifiable: string[] } | null
  /** 因口径偏离被跳过的 alpha 报告（点名，否则「为什么显示的是旧那份」没有答案） */
  skipped: { file: string; why: string }[]
  byStratum: {
    label: string
    count: number
    /** 加权口径的配对胜率。**窄分层与极值敏感** —— 与 `pairedMedian` 背离时以后者为准 */
    paired: number | null
    /** 中位口径的配对胜率（2026-08-20 加，M2 §5.45）。旧报告没有这个字段 ⇒ null */
    pairedMedian: number | null
    /**
     * **效应量** `μ` = 真实中位 − 随机中位（2026-08-27 加，M2 §5.74）。
     *
     * **为什么它必须与胜率并排印**：配对胜率是 `Φ(μ/σ_D)` 的**饱和变换**
     * ⇒ 这张表**竖着比幅度是无效的**（33 层里按两者排序 Spearman 只有 0.865，
     * 最大错位 11 位）。而 §5.73 ④ 当天就这么读错过一次 ——
     * 把 `RANGE` 的 13.1pp 当成「分辨力集中在 RANGE」，
     * 而它底层的 `μ` 比 `TRANSITION` 小 2.7 倍。
     * ⇒ 一条纪律挡不住这个坑，把效应量放在同一行才挡得住。
     *
     * 旧报告缺 `passiveMedianMean` / `randomMedianMean` 时是 **null 不是 0**（约束 4）。
     */
    effectSize: number | null
    percentile: number
  }[]
}

/**
 * 一天的重启情况。`total` 是那天启动了几次，`inSession` 是其中**落在盘中**的几次。
 *
 * ## 为什么必须分开（2026-08-18 加，原先只有 total）
 *
 * 判据原来是 `total === 0` 才算干净。但**盘后重启污染不了当天已经写完的提醒日志** ——
 * 冷却/配额是当日语义，跨日本来就重置。实测 2026-08-18：全天只启动 1 次，
 * 在**北京 16:49（收盘后）**，而看板把那天判成「不干净」⇒ M3 的「自用一周」
 * 在「每天都会重启一次」的现实下**结构上永远到不了 5**。
 *
 * ⚠ **但盘后重启不是完全无害**：`lastForcedLoss`（强制类那 2% 台阶）是**跨日**语义，
 * 清零会让**下一个交易日**的同一条止损多发一次。所以看板报三档、
 * **不替 M3 清单 §4.0 拍板「仅盘外重启算不算干净」** —— 那是判据问题，得人定。
 */
export interface DayRestarts {
  total: number
  inSession: number
}

export interface RuntimeSnapshot {
  dbPath: string
  signals: number
  confirmed: number
  tradeDays: number
  alerts: number
  alertsWithGate: number
  shadowPoints: number
  /**
   * 行业留痕（014）攒了多少 —— **这一条与其余计数性质不同**：
   * 它是唯一「今天不记就永久少一天」的数据（数据源只给当前行业名，
   * 回标历史是未来函数）。所以它必须每天可见，**沉默 = 永久损失**。
   */
  industry: { codes: number; rows: number; firstDate: string | null } | null
  /**
   * 每个有 signal 的交易日重启过几次（`null` = 日志读不到）。
   * **M3 的「自用一周」只数干净那几档** —— 理由见 `status.ts` 的 `restartsByDay`。
   */
  restarts: { date: TradeDate; boots: DayRestarts | null }[]
  /** 库里最新一行 signal / alert_log 的北京时间日子，null = 一行都没有 */
  latestSignalDate: TradeDate | null
  latestAlertDate: TradeDate | null
  /** 这两张表相对「最后一个已收盘交易日」跟上了没（见 ./session.ts） */
  signalFreshness: Freshness
  alertFreshness: Freshness
}

export interface BacklogRow {
  item: BacklogItem
  state: ItemState
}

export interface BacklogSnapshot {
  rows: BacklogRow[]
  errors: string[]
}

export type Bucket = '只能靠时间' | '现在就能做' | '等你拍板' | '明确不做'

export interface Task {
  bucket: Bucket
  title: string
  why: string
}

/**
 * 四档，**必须分开**（2026-08-18 从三档扩到四档）：
 *
 * | 档 | 含义 | 那天的提醒日志能不能当判据 |
 * |---|---|---|
 * | `clean` | 一次都没启动 | 能 |
 * | `postOnly` | 启动过，但**全在盘外** | **能** —— 当天的提醒早在重启之前就写完了，而次日的计数器由 `meta.alert_gate_state` 恢复 |
 * | `dirty` | **盘中**启动过 | 不能 —— 但**理由 2026-08-26 换了**，见下 |
 * | `unknown` | 日志读不到 | 不知道 —— **绝不并进任何一边**，那是编事实 |
 *
 * ## `postOnly` 从 2026-08-26 起计入「干净交易日」（判据放宽，依据是实现变了）
 *
 * M3 清单 §4.0 那条「盘中重启过的交易日不能计入」写于 2026-08-17，前提是
 * 「冷却、配额、强制类台阶**全在内存里**，每次重启全部清零」。
 * **而 2026-08-19 闸门状态已经落库**（`meta.alert_gate_state`）⇒
 * 真库实测含 `lastSent` / `perCodeToday` / `l3Today` / **跨日的 `lastForcedLoss`**，
 * `restore()` 还会按当前时间立刻跑 `rollDay` + `pruneHourly`
 * ⇒ **「重启 ⇒ 同一条止损重新发一次」这个机制没有了。**
 *
 * ⚠ **`dirty` 仍然不算干净，但换了理由**：防抖计数 `streaks` **刻意不落库**
 * （重启跨过一段没有观测的时间，续上等于用不存在的连续性放行一条提醒）
 * ⇒ 盘中重启后头几轮条件要重新连续成立才放行 ⇒ 可能**漏**一条。
 * 它污染的是「没有漏掉重要信号」那一半，方向与旧理由**相反**。
 *
 * ⚠ **日期下界 `GATE_STATE_SINCE` 不能去掉**：更早的盘外重启日仍然不算干净 ——
 * **老数据不会因为后来修好了就变得可用**（08-13 启动 14 次、08-14 二十七次那两天）。
 */
export const GATE_STATE_SINCE = '2026-08-19'

export function cleanDaysOf(r: RuntimeSnapshot): {
  clean: number
  postOnly: number
  dirty: number
  unknown: number
} {
  /** 全在盘外，且这一天在闸门状态落库之后 ⇒ 那天的提醒日志可以当判据 */
  const postOnlyClean = (d: { date: TradeDate; boots: DayRestarts | null }): boolean =>
    d.boots !== null && d.boots.total > 0 && d.boots.inSession === 0 && d.date >= GATE_STATE_SINCE
  return {
    clean: r.restarts.filter((d) => (d.boots !== null && d.boots.total === 0) || postOnlyClean(d)).length,
    // 仍然单独报出来 —— 「零重启」与「盘外重启但算干净」是两种事实，合并就看不出来了
    postOnly: r.restarts.filter(postOnlyClean).length,
    dirty: r.restarts.filter(
      (d) => d.boots !== null && (d.boots.inSession > 0 || (d.boots.total > 0 && d.date < GATE_STATE_SINCE))
    ).length,
    unknown: r.restarts.filter((d) => d.boots === null).length,
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`

/**
 * 报告里的 `engineVersion` 带参数指纹后缀（`0.2.8-unvalidated+c38e329b`），
 * 而 `ENGINE_VERSION` 常量不带。直接比会永远不相等 —— 第一次跑就误报了一次。
 *
 * **指纹刻意不参与比较**：换灵敏度档会改指纹但不改引擎版本，那种情况下报告仍然描述当前代码。
 */
export const sameEngine = (a: string, b: string): boolean => a.split('+')[0] === b.split('+')[0]

export function render(input: {
  params: ParamState
  baseline: Maybe<BaselineSnapshot>
  alpha: Maybe<AlphaSnapshot>
  budget: Maybe<number>
  runtime: Maybe<RuntimeSnapshot>
  taskList: Task[]
  backlog: BacklogSnapshot
  at: string
  /** 宿主时区会不会让北京 09:30–15:00 跨过本地午夜（那时按本地日命名的日志会分家） */
  straddlesMidnight: boolean
}): string {
  const L: string[] = []
  const { params, baseline, alpha, budget, runtime } = input

  L.push('# 迭代看板')
  L.push('')
  L.push('> **自动生成，不要手改** —— `pnpm iterate -- --write` 会整份覆盖。')
  L.push('> 决策与候选记在 [下一阶段取舍与迭代计划](../notes/下一阶段取舍与迭代计划.md)，')
  L.push('> 实验过程记在 [M2 偏差报告](../notes/M2-偏差报告.md)。**一件事只有一个出处。**')
  L.push('>')
  L.push(`> 刷新于 ${input.at}`)
  L.push('')

  L.push('## 引擎与参数')
  L.push('')
  L.push(`- \`ENGINE_VERSION\` **${params.engineVersion}**`)
  const c = params.counts
  L.push(
    `- ${params.leaves} 个叶子参数：CALIBRATED **${c.CALIBRATED}** · KEPT ${c.KEPT} · ` +
      `INERT ${c.INERT} · UNTESTABLE ${c.UNTESTABLE} · **BLOCKED ${c.BLOCKED}** · GUESS ${c.GUESS}`
  )
  const open = (c.GUESS ?? 0) + (c.BLOCKED ?? 0)
  L.push(
    open > 0
      ? `- 摘 \`-unvalidated\` 还差 **${open} 项**（GUESS + BLOCKED 两档都要清零）`
      : '- ✅ GUESS 与 BLOCKED 都已清零 —— 可以考虑摘 `-unvalidated`'
  )
  L.push('')

  L.push('## 策略质量')
  L.push('')
  L.push('**判据是 alpha 配对胜率，不是绩效** —— 绝对收益会把 beta 与「少做」记成策略的功劳。')
  L.push('')
  if (alpha.known) {
    const a = alpha.value
    L.push(
      `来源 \`${a.file}\`（${a.engineVersion} · seed ${a.seed} · ` +
        `**trials ${a.trials ?? '读不到'}** · ` +
        `${a.matchRegime ? '同 regime' : '无条件'}${a.shuffleSpans ? ' · 打散跨度' : ' · ⚠ 未打散跨度'}）`
    )
    L.push('')
    L.push('| 分层 | 建仓 | 配对胜率·加权 | **配对胜率·中位** | **效应量 μ** | 被动分位 |')
    L.push('|---|---|---|---|---|---|')
    for (const s of a.byStratum) {
      L.push(
        `| ${s.label} | ${s.count} | ${s.paired === null ? '—' : pct(s.paired)} | ` +
          `${s.pairedMedian === null ? '—' : `**${pct(s.pairedMedian)}**`} | ` +
          `${s.effectSize === null ? '—' : pct(s.effectSize)} | ${pct(s.percentile)} |`
      )
    }
    L.push('')
    L.push('> 50% = 与随机无异 · 接近 0% = 入场系统性更差 · 高于 50% = 有正 alpha。')
    /*
      trials 那半句必须与表一起印（M2 §5.76）：配对胜率是**试验数上的二项比例**，
      而 §5.73 的裁决就是被 200 那档的 6pp 地板吞掉的（最大 Δ 4.75pp）。
      默认值 2026-08-27 已提到 2000，但归档里仍有一堆 200 的报告。
    */
    L.push(
      '> ⚠ **引用这两列必须带 `trials`**（M2 §5.76）：它是试验数上的二项比例' +
        '（`SE = √(p(1−p)/trials)`）⇒ `trials=200` 的噪音地板实测 **6.00pp**、2000 是 **1.65pp**，' +
        '而**每层的地板要各自量**（`RANGE` 4.90pp · `TRANSITION` 0.25pp）。' +
        '⇒ 小于该层地板的差读不出任何东西。' +
        (a.trials !== null && a.trials < 2000
          ? ` ⚠ **这份是 trials=${a.trials}**（低于现默认 2000）⇒ 它的每一个胜率都带着更大的抽样噪音。`
          : '')
    )
    L.push(
      '> ⚠ **两个口径背离时以中位为准**（读数纪律 2）：加权口径被少数大赢家托着 —— 实测 ' +
        'ALL 加权 31.3% 而**中位 2.8%**、TREND_UP 加权 74.2% 而**中位 35.2%**（M2 §5.45）。' +
        '中位列为「—」说明那份报告早于 2026-08-20，没有这个字段。'
    )
    /*
      这一条**必须与那张表一起印**（M2 §5.74）：整张表是**跨层**摆在一起的，
      而配对胜率是效应量的饱和变换 ⇒ 竖着读会把「放大器」读成「分辨力」。
      §5.73 ④ 就这么读错过一次，而它不会报错。
    */
    L.push(
      '> ⚠ **这一列可以竖着比方向，不能竖着比幅度**（M2 §5.74）：配对胜率 ≈ `Φ(μ/σ_D)` 是' +
        '效应量的**饱和变换** —— 灵敏度在 50% 处最大、往 0%/100% 两端塌缩，而 `σ_D ∝ 1/√n` ' +
        '⇒ **层越大胜率越极端**。实测 33 层里按胜率排 vs 按效应量排 Spearman 只有 **0.865**，' +
        '最大错位 **11 位**（`ALL` 胜率排 30/33 而它的效应量只排 19/33）。' +
        '**要比幅度就看这张表的「效应量 μ」列**（μ = 真实中位 − 随机中位）。' +
        '✅ **阈值型用法不受影响** —— `Φ` 单调 ⇒ 「> 50%」等价于「μ > 0」，L2 条件① 一字不改。'
    )
    // 零分布的时间结构必须与数字一起印（§4.6）：只报数字不报口径，读的人无从判断
    // 这一栏是「已做时间聚集调整」还是「把成批发生的建仓当成独立样本算出来的」。
    if (a.crossCode) {
      L.push('> 跨票口径固定日期 ⇒ 真实建仓的时间聚集原样保留，**无需时间结构调整**（§4.6 的例外）。')
    } else if (a.timingNull === 'BLOCK') {
      L.push('> 零分布按建仓月**整块位移**（§4.6）⇒ 分位**已做时间聚集调整**（块内残余自相关仍在，仍略偏乐观）。')
    } else if (a.timingNull === 'REGIME_BLOCK') {
      const cov = a.blockCoverage
      L.push(
        '> 零分布按 **regime 段整段平移**（块 = 标的 × 一段连续同状态行情，§5.42）· ' +
          `覆盖 ${cov === null ? '—' : pct(cov)} · 吸附恒 0 · 落点权重 ` +
          `${a.blockWeight === 'positions' ? '**按位置**（长段加权，§5.43 的对照档）' : '**按段均匀**（§5.43 默认）'}。`
      )
      L.push(
        '> ⚠ **同 regime 的分位有一个控制不住的口径自由度**：同一批 1675 次建仓在四个零点下' +
          '极差 **20–30pp**（RANGE 65.0 / 43.5 / 39.2 / 35.5 · ALL 46.5 / 36.5 / 31.3 / 55.0，§5.43）' +
          '，而三个零点都在合理设计空间里、分不出胜负。⇒ **这些分位只能支撑粗结论**' +
          '（方向与跨口径一致性），**不能**支撑「66.5 比 62.0 好」这种精细比较，也不能当写回门槛；' +
          '改动前后必须用**同一零点**（docs/07 §3.6 第 ⑤ 条）。'
      )
      if (cov !== null && cov < 0.8) {
        L.push('> ⚠ 覆盖率低于预注册门槛 80% ⇒ 这一档仍按**未调整上界**读。')
      }
    } else {
      L.push(
        '> ⚠ 零分布是**逐次独立抽日** ⇒ 方差偏小 ⇒ **上面每一个分位都是未调整上界、偏向显著**（§4.6）。' +
          (a.timingNull === null
            ? '（这份报告早于 2026-08-19，没有口径字段，按未调整看待。）'
            : a.timingNullReason === null
              ? ''
              : `降级原因：${a.timingNullReason}`)
      )
    }
    if (!a.shuffleSpans) {
      L.push('> ⚠ 这份没开 `--shuffle-spans`，数值被 `holdingBars` 内生性系统性压低，只能当下界。')
    }
    if (!sameEngine(a.engineVersion, params.engineVersion)) {
      L.push(
        `> ⚠ **这份 alpha 是 ${a.engineVersion} 的，当前引擎是 ${params.engineVersion}** —— ` +
          '它描述的不是当前代码。alpha 是主判据，版本错了比基线版本错更糟。'
      )
    }
    /*
      口径三态（2026-08-25，计划 §4.9）。alpha 报告此前只记 `--baseline` 的**路径**，
      于是一份跑在非出厂口径基线上的 alpha 在归档里认不出来 —— 而 alpha 是主判据。
      `knobs` 缺失是第三态「**认不出来**」，不许读成「出厂口径」。
    */
    if (a.knobs === null) {
      L.push(
        '> ⚠ **这份 alpha 的基线口径无法核对**（报告早于 2026-08-25，没有继承 `capitalPerCode` /' +
          ' `costs`）⇒ 只能手工去看 `meta.baseline` 那份。重跑一次就会带上这一列。'
      )
    } else if (a.knobs.unverifiable.length > 0) {
      L.push(`> ⚠ 基线口径**部分无法核对**：${a.knobs.unverifiable.join(' · ')}（「未记录」≠「等于出厂」）。`)
    }
    if (a.skipped.length > 0) {
      L.push(
        `> ⓘ 为挑出**出厂口径**，跳过了 ${a.skipped.length} 份更新的 alpha 报告：` +
          a.skipped.map((s) => `\`${s.file}\` — ${s.why}`).join(' · ')
      )
    }
  } else {
    L.push(`⚠ **读不到**：${alpha.why}`)
  }
  L.push('')

  L.push('## 回测基线')
  L.push('')
  if (baseline.known) {
    const b = baseline.value
    const window = b.from === null || b.to === null ? '窗口读不到' : `${b.from} → ${b.to}`
    L.push(`来源 \`${b.file}\`（${b.engineVersion} · ${b.at} · ${b.codes} 只 · **${window}**）`)
    L.push('')
    // 表头刻意不写「全期」：选中的那份可能是训练窗口的报告（2026-08-18 踩过）
    L.push('| 区间收益 | 建仓 | 逐笔 | 建仓级胜率 | 最大回撤 | 夏普 | 平均占用 |')
    L.push('|---|---|---|---|---|---|---|')
    L.push(
      `| **${pct(b.totalReturn)}** | ${b.positions} | ${b.trades} | ${pct(b.winRate)} | ` +
        `${pct(b.maxDrawdown)} | ${b.sharpe.toFixed(3)} | ${pct(b.exposure)} |`
    )
    L.push('')
    L.push('> 「超额收益」离开平均资金占用就会被读反（基准是满仓的，§5.13）。')
    L.push(
      `> ⚠ **这一行是上面那个窗口的收益，不是「全期」** —— 选中的是 \`reports/calib/\` 里最新的合格报告，` +
        '它很可能是某次实验的**训练窗口**跑（判据见 docs/07 §3 的三段划分）。'
    )
    if (!sameEngine(b.engineVersion, params.engineVersion)) {
      L.push(`> ⚠ **基线是 ${b.engineVersion}，当前引擎是 ${params.engineVersion}** —— 这张表描述的不是当前代码。`)
    }
    // 跳过了哪几份必须点名：不然「为什么显示的是三天前那份」没有答案，人会以为看板卡住了
    if (b.skipped.length > 0) {
      L.push(
        `> ⓘ 为挑出**出厂口径**，跳过了 ${b.skipped.length} 份更新的报告：` +
          `${b.skipped.map((s) => `\`${s.file}\` — ${s.why}`).join('；')}。` +
          '实验跑的绩效不可当基线引用（`auditKnobs`）。'
      )
    }
    if (b.unverifiable.length > 0) {
      L.push(
        `> ⚠ 这份报告有**无法核对**的口径：${b.unverifiable.join('、')}。` +
          '⇒ 不能确认它是不是 `--slippage 0` 那类跑（`noslip-train.json` 就是一份，' +
          '−1.21% vs 出厂口径 −1.99%）。**未记录 ≠ 等于出厂**；重跑一次基线就会带上这一列。'
      )
    }
  } else {
    L.push(`⚠ **读不到**：${baseline.why}`)
  }
  L.push('')

  L.push('## 真机运行')
  L.push('')
  if (runtime.known) {
    const r = runtime.value
    L.push('| 交易日 | signal | 其中 CONFIRMED | alert_log | 带闸门列 | 影子净值点 |')
    L.push('|---|---|---|---|---|---|')
    L.push(
      `| ${r.tradeDays} | ${r.signals} | ${r.confirmed} | ${r.alerts} | ${r.alertsWithGate} | ${r.shadowPoints} |`
    )
    L.push('')
    /*
      行业留痕单独一行，**不并进上面那张表** —— 它与那几个计数性质不同：
      那些是「系统跑出来的记录」，重跑还能有；这一条是**攒出来的**，
      数据源只给当前行业名、回标历史是未来函数 ⇒ **今天沉默 = 永久少一天**。
    */
    if (r.industry === null) {
      L.push('> ⚠ **行业留痕：读不到**（`industry_history` 表不存在 —— 库还没升到 014）。')
    } else if (r.industry.rows === 0) {
      L.push(
        '> **行业留痕：一行都没有。** 观测挂在休市维护上、由 `MAINTENANCE_INTERVAL_MS = 7 天` 门着' +
          '⇒ **接上之后最多要等一周才有第一行**，这段时间里为空是正常的。' +
          '若已过一周仍为空，那才是问题（多半是 `refreshProfiles()` 拿不到行业）。'
      )
    } else {
      L.push(
        `> 行业留痕：**${r.industry.codes} 只 / ${r.industry.rows} 行**，` +
          `自 ${r.industry.firstDate} 起。观测**每周一次**（不是每天），` +
          `且只在行业名变化时写行 ⇒ 行数少是正常的；**只数不涨才是问题**。`
      )
    }
    L.push('')
    /*
      逐日列重启次数。**这不是运维信息，是判据的有效性** ——
      **盘中**重启会让防抖计数归零、那天可能漏一条，提醒日志不能用来答 M3 的出口条件
      （清单 §4.0；旧理由「冷却/配额被清零」已于 08-19 随闸门状态落库而失效）。
    */
    const c = cleanDaysOf(r)
    L.push(
      `其中**可当判据**的交易日 **${c.clean}** 天` +
        (c.postOnly > 0 ? ` · 其中 **${c.postOnly} 天只在盘外重启**（§4.0 已放宽，算干净）` : '') +
        (c.dirty > 0 ? ` · 盘中重启 ${c.dirty} 天（提醒日志不可当判据）` : '') +
        (c.unknown > 0 ? ` · ${c.unknown} 天日志读不到` : '') +
        '：'
    )
    L.push('')
    L.push(
      r.restarts
        .map((d) => {
          if (d.boots === null) return `\`${d.date}\` 日志读不到`
          if (d.boots.total === 0) return `\`${d.date}\` 零重启`
          const where = d.boots.inSession > 0 ? `其中盘中 ${d.boots.inSession} 次` : '**全在盘外**'
          return `\`${d.date}\` 启动 ${d.boots.total} 次（${where}）`
        })
        .join(' · ')
    )
    if (c.postOnly > 0) {
      L.push('')
      L.push(
        '> **「只在盘外重启」自 2026-08-26 起计入干净交易日**（M3 清单 §4.0 放宽，' +
          '依据是**实现变了**：08-19 闸门状态落库进 `meta.alert_gate_state`，' +
          '连**跨日**的 `lastForcedLoss` 都在里面 ⇒ 「重启 ⇒ 同一条止损重新发一次」' +
          '这个机制没有了）。⚠ **盘中重启仍然作废**，但理由换成了「防抖计数 `streaks` ' +
          '刻意不落库 ⇒ 重启后头几轮可能**漏**一条」—— 方向与旧理由相反。' +
          `⚠ 日期下界 \`${GATE_STATE_SINCE}\`：更早的盘外重启日仍不算干净，` +
          '**老数据不会因为后来修好了就变得可用**。'
      )
    }
    if (input.straddlesMidnight) {
      L.push('')
      L.push(
        '> ⚠ 本机时区会让北京 09:30–15:00 跨过本地午夜，而日志按**本地日**分文件 ——' +
          '上面的计数可能偏少（把污染日读成干净日）。要用就手工核对相邻两个文件。'
      )
    }
    L.push('')
    L.push(`数据最新到：signal \`${r.latestSignalDate ?? '—'}\` · alert_log \`${r.latestAlertDate ?? '—'}\``)
    const f = r.signalFreshness
    if (f.kind === 'CAUGHT_UP') {
      L.push(
        `最后一个**已收盘**交易日是 \`${f.session.date}\`（日历来源 ${f.session.source}）—— ` +
          '此后一场都没收过盘，**存量诊断这会儿查不出东西**。'
      )
    } else if (f.kind === 'STALE') {
      L.push(
        `⚠ 最后一个已收盘交易日是 \`${f.session.date}\`，数据落后 **${f.sessionsBehind} 场** —— ` +
          '「等下一个交易日」这条解释不成立了。'
      )
    } else {
      L.push(`⚠ 判不了「有没有跨过新交易日」：${f.why}`)
    }
  } else {
    L.push(`⚠ **${runtime.why}**`)
    L.push('')
    L.push('这一格是空的，就意味着：M1/M3 出口条件、4 个 `UNTESTABLE` 参数的依据、')
    L.push('影子运行的第一个净值点、刚装好的闸门拦截率量表 —— **全都在等同一件事**。')
  }
  L.push('')

  L.push('## 测试集预算')
  L.push('')
  L.push(
    budget.known
      ? `累计触碰 **${budget.value} 次**（红线是「只跑一次」，docs/07 §3 ④）。它是消耗品。`
      : `⚠ 读不到：${budget.why}`
  )
  L.push('')

  L.push('## 今天该做什么')
  L.push('')
  const backlog = input.backlog
  const openRows = backlog.rows.filter((r) => r.state === 'OPEN')
  const readyCount = openRows.filter((r) => r.item.bucket === '就绪').length
  if (backlog.rows.length > 0) {
    L.push(
      `> 另有 **${backlog.rows.length}** 条登记在案的落地项（**${readyCount}** 条就绪），见下一节 —— ` +
        '那些是已经论证过、只是还没做的。'
    )
    L.push('')
  }
  const order: Bucket[] = ['只能靠时间', '现在就能做', '等你拍板', '明确不做']
  for (const bucket of order) {
    const items = input.taskList.filter((t) => t.bucket === bucket)
    if (items.length === 0) continue
    L.push(`### ${bucket}`)
    L.push('')
    for (const t of items) {
      L.push(`- **${t.title}**`)
      L.push(`  - ${t.why}`)
    }
    L.push('')
  }

  L.push('## 登记在案的落地项')
  L.push('')
  L.push('> **条目由人登记，状态由仓库判。** 条目是文档里的 `<!-- ITEM -->` 标记')
  L.push('> （登记在它论证所在的那一节），做没做由「判据那个字符串在不在仓库里」决定。')
  L.push('> 关闭方式 = **删掉那行标记**。判据与三态见 `tools/iterate/backlog.ts`。')
  L.push('')
  if (backlog.rows.length === 0 && backlog.errors.length === 0) {
    L.push('一条都没有登记。⚠ 这有两种成因，**别默认成前者**：真的没有待落地的东西，')
    L.push('或者最近几轮的学习/实验结论根本没被登记（那正是这一节要防的事）。')
    L.push('')
  }
  const bucketOrder: ItemBucket[] = ['就绪', '等条件', '等拍板', '不做']
  for (const bucket of bucketOrder) {
    const rows = openRows.filter((r) => r.item.bucket === bucket)
    if (rows.length === 0) continue
    L.push(`### ${bucket}`)
    L.push('')
    for (const { item } of rows) {
      L.push(`- **${item.title}**（${item.kind} · 代价 ${item.cost}）`)
      L.push(`  - 来源 ${item.source} · 登记在 \`${item.file}:${item.line}\``)
      if (item.blockedBy !== null) L.push(`  - **等**：${item.blockedBy}`)
      L.push(`  - 判据 \`${item.evidence.path}\` 里出现 \`${item.evidence.needle}\` ⇒ 算落地`)
    }
    L.push('')
  }
  const landed = backlog.rows.filter((r) => r.state === 'LANDED')
  if (landed.length > 0) {
    L.push('### ⚠ 证据显示已落地 —— 去把标记删掉')
    L.push('')
    L.push('条目还挂在文档里，而仓库里已经有那个字符串了。**清单只增不减就没人再看它。**')
    L.push('')
    for (const { item } of landed) {
      L.push(
        `- **${item.title}** —— \`${item.evidence.path}\` 里已有 \`${item.evidence.needle}\`；` +
          `标记在 \`${item.file}:${item.line}\``
      )
    }
    L.push('')
  }
  const unreadable = backlog.rows.filter((r) => r.state === 'UNREADABLE')
  if (unreadable.length > 0) {
    L.push('### ⚠ 判不了（判据文件读不到）')
    L.push('')
    L.push('**这是「不知道」，既不是「还没做」也不是「已经做了」** —— 路径写错了，或者那个文件被挪走了。')
    L.push('')
    for (const { item } of unreadable) {
      L.push(`- **${item.title}** —— 读不到 \`${item.evidence.path}\`（标记在 \`${item.file}:${item.line}\`）`)
    }
    L.push('')
  }
  if (backlog.errors.length > 0) {
    L.push('### ⚠ 登记不合格（这些条目没有被算进上面任何一组）')
    L.push('')
    L.push('**缺字段的条目关不掉，所以这里报出来而不是静默跳过。**')
    L.push('')
    for (const e of backlog.errors) L.push(`- ${e}`)
    L.push('')
  }

  L.push('---')
  L.push('')
  L.push('## 这份看板不做什么')
  L.push('')
  L.push('- **不提策略候选。** 授权边界（2026-08-15 拍板）：只报门槛达成情况，候选由人提。')
  L.push('  ⚠ 上面那节**不是**例外：登记项是人已经论证过、已经决定要做的工程/判据项，')
  L.push('  看板只负责不让它们烂掉，不负责发明它们。')
  L.push('- **不自动改代码。** 判定逻辑改动要走 docs/07 §3.6 的四条门槛，最后一步是人点头。')
  L.push('- **不记决策。** 那是计划文档 §1.1 的事 —— 一件事只有一个出处，两处会漂移。')
  L.push('  同理**不记条目状态**：状态每次从仓库现算，看板里那几行是快照不是台账。')
  L.push('')
  return L.join('\n')
}
