/**
 * 指标目录：**每个指标是什么、我们怎么用它、那个数有没有依据**。
 *
 * 主/渲染共享的纯数据（`src/shared` 的规矩：只放纯类型与纯常量）。
 *
 * ## 三条文案纪律（这一层的全部价值在这里）
 *
 * 1. **写定义与口径，不写投资含义。** 「`ADX` 是 Wilder 平滑的方向性指数」可以；
 *    「`ADX > 20` 说明趋势成立」**不行** —— 那个 20 是[未标定的转述值](../../docs/adr/ADR-0003-来源文档数值不作为出厂默认.md)，
 *    而 2026-08-19 的第三方对照更发现**我们的 ADX 与通达信/东财不是同一个数**
 *    （他们 `EXPMEMA`+MM=6，实测 30.4% 的日子「≥20 与否」结论相反，M2 §5.38）。
 *    在界面上写「金叉 = 看涨」这类话，等于把一个**已被本地数据否掉**的说法当常识 ——
 *    2026-08-20 实测：买入得分与前瞻收益的横截面秩相关是**负的**（M2 §5.46）。
 * 2. **口径差异必须写在指标旁边**，不能只写在文档里。MACD 柱 ×2、布林带除 n、
 *    ATR/ADX 与国内平台不同 —— 用户拿软件对着行情软件看的第一件事就是这些数对不上。
 * 3. **每个指标要指回它用在哪个子信号**，以及**相关阈值的标定状态**（`params` 路径）。
 *    「这个数有没有依据」是这张表存在的理由，也是它与「行情软件的指标栏」的唯一区别。
 *
 * ⚠ `tests/unit/shared/indicator-catalog.test.ts` 钉着两条不变量：
 * ① `snapshotOfIndicators()` 产出的每个键都必须在这里有条目（加了指标不许忘文案）；
 * ② 文案里不许出现措辞纪律禁用的词（必涨 / 抄底 / 稳赚 / 牛股 / 胜率 / 概率…）。
 */

/** 指标分组 —— 面板按它分节，顺序即显示顺序 */
export type IndicatorGroup = 'TREND' | 'MOMENTUM' | 'VOLATILITY' | 'VOLUME' | 'THRESHOLD'

export const INDICATOR_GROUP_LABEL: Record<IndicatorGroup, string> = {
  TREND: '趋势',
  MOMENTUM: '动量',
  VOLATILITY: '波动与轨道',
  VOLUME: '量能',
  THRESHOLD: '当日阈值（引擎实际用的线）',
}

export interface IndicatorMeta {
  /** 与 `snapshotOfIndicators()` 的键一致 */
  key: string
  label: string
  group: IndicatorGroup
  /** 小数位。价格类 2 位，比率类 2 位，分位类 0 位 */
  digits: number
  unit?: string
  /** 它是什么、怎么算的。**只讲定义** */
  definition: string
  /** ⚠ 与国内行情软件的口径差异；没有差异就不给这一项 */
  caveat?: string
  /** 用在哪些子信号里（ID 与 `SUB_SIGNAL_LABEL` 同一套） */
  usedBy?: string[]
  /**
   * 相关阈值的参数路径（`params-view.ts` 的 `STATUS` 键）。
   * 面板据此显示那个数的**标定状态**，而不是让用户以为它经过验证。
   */
  paramPaths?: string[]
}

export const INDICATOR_CATALOG: readonly IndicatorMeta[] = [
  // ── 趋势 ────────────────────────────────────────────────────────────
  {
    key: 'ma5',
    label: 'MA5',
    group: 'TREND',
    digits: 2,
    definition: '最近 5 根收盘价的算术平均（前复权价）。',
    usedBy: ['T1_MA_CROSS', 'T4_ALIGNMENT'],
  },
  {
    key: 'ma10',
    label: 'MA10',
    group: 'TREND',
    digits: 2,
    definition: '最近 10 根收盘价的算术平均。',
    usedBy: ['T1_MA_CROSS', 'T4_ALIGNMENT'],
  },
  {
    key: 'ma20',
    label: 'MA20',
    group: 'TREND',
    digits: 2,
    definition: '最近 20 根收盘价的算术平均，也是布林带的中轨。',
    usedBy: ['T4_ALIGNMENT', 'T5_PULLBACK_HOLD', 'R2_REVERT_TO_MID', 'R4_MID_REVERSION'],
  },
  {
    key: 'ma60',
    label: 'MA60',
    group: 'TREND',
    digits: 2,
    definition: '最近 60 根收盘价的算术平均。',
    usedBy: ['T4_ALIGNMENT'],
  },
  {
    key: 'ma120',
    label: 'MA120',
    group: 'TREND',
    digits: 2,
    definition: '最近 120 根收盘价的算术平均（约半年）。',
    caveat: '⚠ 目前**没有任何子信号用它** —— 它在 `params.ma.periods` 里算着，只做展示。',
  },
  {
    key: 'adx',
    label: 'ADX',
    group: 'TREND',
    digits: 2,
    definition:
      '方向性指数：把 +DI 与 −DI 的差距做 Wilder 平滑，衡量**趋势的强弱**（不含方向）。' +
      '数值越大表示单边推进越持续。',
    caveat:
      '⚠ 与通达信/东财/同花顺**不是同一个数**：他们用 EXPMEMA（α=2/15）平滑、ADX 周期取 6，' +
      '我们用 Wilder + 14（ADX 的原始定义）。实测在 69.9 万个「股票·交易日」上，' +
      '两套口径对「ADX ≥ 20」有 30.4% 的日子结论相反 —— 拿这个数对着行情软件看会对不上。',
    usedBy: ['T1_MA_CROSS', 'T4_ALIGNMENT', 'M2_WEEK_ADX_CONFIRM'],
    paramPaths: ['adx.baseThreshold', 'adx.volScale', 'adx.maxThreshold'],
  },
  {
    key: 'plusDI',
    label: '+DI',
    group: 'TREND',
    digits: 2,
    definition: '上升方向线：向上真实波动占真实波幅的 Wilder 平滑比例。',
  },
  {
    key: 'minusDI',
    label: '−DI',
    group: 'TREND',
    digits: 2,
    definition: '下降方向线：向下真实波动占真实波幅的 Wilder 平滑比例。',
  },

  // ── 动量 ────────────────────────────────────────────────────────────
  {
    key: 'dif',
    label: 'MACD DIF',
    group: 'MOMENTUM',
    digits: 3,
    definition: '快慢两条 EMA 的差（快 12 − 慢 17）。',
    caveat: '⚠ 慢线周期是 **17** 而不是常见的 26 —— 那是来源文档的转述值，**未经标定**。',
    usedBy: ['T2_MACD_ZERO_CROSS', 'R2_REVERT_TO_MID', 'M1_WEEK_MACD_DAY_RSI'],
    paramPaths: ['macd.fast', 'macd.slow', 'macd.signal'],
  },
  {
    key: 'dea',
    label: 'MACD DEA',
    group: 'MOMENTUM',
    digits: 3,
    definition: 'DIF 的 9 周期 EMA（信号线）。',
    usedBy: ['T2_MACD_ZERO_CROSS'],
  },
  {
    key: 'hist',
    label: 'MACD 柱',
    group: 'MOMENTUM',
    digits: 3,
    definition: '柱状值 = **2 ×（DIF − DEA）**。',
    caveat:
      '⚠ 这里的 ×2 是**国内平台口径**（通达信/东财/同花顺都乘 2），与国际常见的 DIF − DEA 差一倍。' +
      '2026-08-19 已与第三方数据交叉验证过：倍数关系确认。它不影响任何穿越判定（符号不变）。',
    usedBy: ['R2_REVERT_TO_MID'],
  },
  {
    key: 'rsi',
    label: 'RSI',
    group: 'MOMENTUM',
    digits: 2,
    definition: '相对强弱指数（14 周期）：上涨幅度均值占总波动均值的比例，取值 0–100。',
    caveat: '✅ 与第三方数据逐位一致（2026-08-19 对照，相对差 1e-9）。',
    usedBy: ['R1_RSI_BAND', 'M1_WEEK_MACD_DAY_RSI'],
    paramPaths: ['rsi.period', 'rsi.obBase', 'rsi.osBase'],
  },

  // ── 波动与轨道 ──────────────────────────────────────────────────────
  {
    key: 'bollUpper',
    label: '布林上轨',
    group: 'VOLATILITY',
    digits: 2,
    definition: '中轨 + 2 倍标准差。',
    usedBy: ['T3_BREAKOUT', 'R1_RSI_BAND', 'R3_SQUEEZE'],
  },
  {
    key: 'bollMid',
    label: '布林中轨',
    group: 'VOLATILITY',
    digits: 2,
    definition: '20 根收盘价的算术平均（= MA20）。',
    usedBy: ['T5_PULLBACK_HOLD', 'R2_REVERT_TO_MID', 'R4_MID_REVERSION'],
  },
  {
    key: 'bollLower',
    label: '布林下轨',
    group: 'VOLATILITY',
    digits: 2,
    definition: '中轨 − 2 倍标准差。',
    usedBy: ['T3_BREAKOUT', 'R1_RSI_BAND', 'R3_SQUEEZE'],
  },
  {
    key: 'bbw',
    label: '带宽 BBW',
    group: 'VOLATILITY',
    digits: 4,
    definition: '(上轨 − 下轨) ÷ 中轨，衡量当前波动区间的相对宽度。',
    caveat:
      '⚠ 标准差**除 n 不除 n−1**（国内平台口径）。2026-08-19 与第三方数据逐位一致（1e-14），' +
      '而除 n−1 的变体相对差 3e-4 ~ 7e-4 —— 也就是说这次对照是有分辨力的。',
  },
  {
    key: 'bbwPct',
    label: '带宽分位',
    group: 'VOLATILITY',
    digits: 0,
    unit: '%',
    definition: '当前 BBW 在过去 250 根 BBW 里的百分位（0–100）。越小表示当前波动区间越窄。',
    usedBy: ['T3_BREAKOUT', 'R3_SQUEEZE'],
    paramPaths: ['strategy.squeezeBbwPct', 'regime.rangeBbwPct', 'strategy.expandedBbwPct'],
  },
  {
    key: 'atr',
    label: 'ATR',
    group: 'VOLATILITY',
    digits: 3,
    definition: '真实波幅的 Wilder 平滑（14 周期），单位与价格相同。',
    caveat:
      '⚠ 与国内平台**不是同一个数**：他们的 ATR 是 MA(TR, 14)（简单算术平均），' +
      '我们是 Wilder(TR)/14。两者在同一段行情上系统性不同（2026-08-19 对照）。',
  },

  // ── 量能 ────────────────────────────────────────────────────────────
  {
    key: 'volMa',
    label: '成交量均值',
    group: 'VOLUME',
    digits: 0,
    unit: '手',
    definition: '最近 20 根成交量的算术平均。',
  },
  {
    key: 'volRatio',
    label: '量比',
    group: 'VOLUME',
    digits: 2,
    definition: '当日成交量 ÷ 成交量均值。1.0 表示与近期平均持平。',
    caveat:
      '⚠ **盘中会按时间归一化**（用已过去的交易分钟折算成全天口径），' +
      '否则上午永远显示「缩量」。收盘后就是当日实际量的比值。',
    usedBy: ['T1_MA_CROSS', 'T3_BREAKOUT'],
    paramPaths: ['volume.maPeriod', 'volume.breakoutRatio', 'volume.shrinkRatio'],
  },

  // ── 当日阈值 ────────────────────────────────────────────────────────
  {
    key: 'adxTrend',
    label: 'ADX 趋势线',
    group: 'THRESHOLD',
    digits: 2,
    definition:
      '当日判定「算不算趋势」用的那条 ADX 线，随波动分位在 baseThreshold 与 maxThreshold 之间浮动。' +
      '**这是引擎当天实际比较的那个数**，不是一个固定值。',
    paramPaths: ['adx.baseThreshold', 'adx.volScale', 'adx.maxThreshold'],
  },
  {
    key: 'adxRange',
    label: 'ADX 震荡线',
    group: 'THRESHOLD',
    digits: 2,
    definition: '当日判定「算不算震荡」用的那条 ADX 线（低于它才可能判震荡）。',
    paramPaths: ['adx.rangeGap'],
  },
  {
    key: 'rsiOverbought',
    label: 'RSI 超买线',
    group: 'THRESHOLD',
    digits: 2,
    definition: '当日的 RSI 上界，随市场情绪浮动（情绪越热越高）。R1 拿它比。',
    paramPaths: ['rsi.obBase', 'rsi.sentimentScale'],
  },
  {
    key: 'rsiOversold',
    label: 'RSI 超卖线',
    group: 'THRESHOLD',
    digits: 2,
    definition: '当日的 RSI 下界，随市场情绪浮动。R1 拿它比。',
    paramPaths: ['rsi.osBase', 'rsi.sentimentScale'],
  },
  {
    key: 'volPct',
    label: '波动分位',
    group: 'THRESHOLD',
    digits: 0,
    unit: '%',
    definition: 'ATR/价格 在过去若干根里的百分位（0–100）。ADX 趋势线随它抬高。',
    paramPaths: ['adx.volScale'],
  },
]

/** 按键查目录。渲染层用它把快照里的数字配上文案 */
export const INDICATOR_BY_KEY: Record<string, IndicatorMeta> = Object.fromEntries(
  INDICATOR_CATALOG.map((meta) => [meta.key, meta])
)
