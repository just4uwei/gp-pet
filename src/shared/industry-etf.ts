/**
 * 行业 ETF 清单（2026-08-15）。**主进程与渲染层共用这一份。**
 *
 * ## 它是什么，不是什么
 *
 * 这是一份**观察名单**，不是策略、不是参数、不是推荐。放进自选的「行业ETF」分组后，
 * 引擎照常给它们算信号（ETF 与个股走同一套指标与判定，`src/core` 不认识「ETF」这个概念），
 * 但它们**不进提醒闸门**（见 `alerts/service.ts` 的 `alertable`）——
 * 目的是攒一份「行业 ETF 上的信号质量 vs 个股」的对照数据，而不是多一个打扰源。
 *
 * ## 选它们的判据（2026-08-15 实测，非交易日读的是 08-14 收盘）
 *
 * 34 只候选全部实测有效（`ulist.np`，11/11 成功）。这 15 只是两道筛选的结果：
 *
 * 1. **按行业去重，每个行业只留成交额最大的一只。** 候选里证券有 4 只、芯片 3 只、
 *    游戏与通信各 2 只 —— 同行业的 ETF 走势高度相关，留多只只会让同一个行业
 *    在信号列表里刷屏，还会多占几份提醒配额（如果日后接进闸门的话）。
 * 2. **日成交额 ≥ 2 亿。** 低于这条线的标的点差大、分钟级价格跳变，技术指标基本是噪音
 *    —— 被这条筛掉的有环保ETF（0.08 亿）、基建ETF（0.05 亿）、汽车ETF（0.26 亿）等。
 *    代价是光伏、房地产、家电、钢铁、养殖、旅游这几个行业**没有覆盖**，
 *    这是明确的取舍，不是遗漏。
 *
 * ## 维护
 *
 * `name` 只用于「还没添加时」的清单展示。**真正入库的名字来自数据源**
 * （`watchlist.add()` 会拉 profile），所以基金改名不会让库里的名字错，
 * 只会让这份清单的展示文案旧一点。成交额会随行情变化，
 * 上面那条 2 亿的线是**选入时**的判据，不做持续复核 —— 真要复核是一次独立的事。
 */

/** 「行业ETF」分组名。渲染层按它分 tab，主进程按它判断要不要进提醒闸门 */
export const INDUSTRY_ETF_GROUP = '行业ETF'

export interface IndustryEtf {
  /** 带市场前缀，与 `parseCode` 的口径一致 */
  code: string
  /** 展示用，真正的名字入库时由数据源覆盖 */
  name: string
  industry: string
}

/** 15 只，每个行业一只。顺序按行业名，不含任何优先级含义 */
export const INDUSTRY_ETFS: readonly IndustryEtf[] = [
  { code: 'SH512800', name: '银行ETF', industry: '银行' },
  { code: 'SH512880', name: '证券ETF', industry: '证券' },
  { code: 'SH512980', name: '传媒ETF', industry: '传媒' },
  { code: 'SZ159755', name: '电池ETF', industry: '电池' },
  { code: 'SZ159611', name: '电力ETF', industry: '电力' },
  { code: 'SH512400', name: '有色金属ETF', industry: '有色金属' },
  { code: 'SH512660', name: '军工ETF', industry: '军工' },
  { code: 'SH512010', name: '医药ETF', industry: '医药' },
  { code: 'SH512170', name: '医疗ETF', industry: '医疗' },
  { code: 'SZ159869', name: '游戏ETF', industry: '游戏' },
  { code: 'SH512690', name: '酒ETF', industry: '白酒' },
  { code: 'SZ159928', name: '消费ETF', industry: '消费' },
  { code: 'SH512480', name: '半导体ETF', industry: '半导体' },
  { code: 'SH515220', name: '煤炭ETF', industry: '煤炭' },
  { code: 'SH515880', name: '通信ETF', industry: '通信' },
]
