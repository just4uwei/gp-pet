/**
 * 行业 ETF 观察名单（`src/shared/industry-etf.ts`）。
 *
 * 它是一份**手写的数据清单**，没有任何东西在运行时校验它 —— 写错一位代码的症状是
 * 「一键添加」报一句「无法识别的代码」，或者更糟：加进去一只**别的**标的，
 * 而它在界面上长得和正常持仓标的一模一样，只是不发提醒。
 * 所以这几条断言测的是清单本身，不是逻辑。
 */

import { describe, expect, it } from 'vitest'
import { parseCode } from '@core/code'
import { INDUSTRY_ETFS, INDUSTRY_ETF_GROUP } from '@shared/industry-etf'

describe('INDUSTRY_ETFS', () => {
  it('每一条都能被 parseCode 认出来，且确实是 ETF', () => {
    for (const etf of INDUSTRY_ETFS) {
      const parsed = parseCode(etf.code)
      expect(parsed.ok, `${etf.code} ${etf.name}`).toBe(true)
      if (!parsed.ok) continue
      // 板块由代码段决定（SH 51/56/58、SZ 15/16）。这里断言的是「没写错成个股代码」
      expect(parsed.value.board, `${etf.code} ${etf.name}`).toBe('ETF')
    }
  })

  it('代码不重复', () => {
    const codes = INDUSTRY_ETFS.map((etf) => etf.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  /*
    这一条是选这份清单时的核心判据（见那个文件的头注释）：**每个行业只留一只**。
    候选里证券有 4 只、芯片 3 只 —— 同行业 ETF 走势高度相关，
    留多只会让同一个行业在「今日信号」里刷屏，而那正是这份名单要避免的噪音。
    往清单里加行时它会红，那时要么换掉同行业的那只，要么先改判据。
  */
  it('每个行业只有一只', () => {
    const industries = INDUSTRY_ETFS.map((etf) => etf.industry)
    const dupes = industries.filter((name, i) => industries.indexOf(name) !== i)
    expect(dupes).toEqual([])
  })

  it('分组名不是默认分组 —— 它就是「不进提醒闸门」的判据', () => {
    expect(INDUSTRY_ETF_GROUP).toBe('行业ETF')
    expect(INDUSTRY_ETF_GROUP).not.toBe('自选')
  })
})
