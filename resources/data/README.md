# resources/data

运行时随包分发的静态数据。渲染层不直接读这里（走 `res://`，见 `src/main/resources.ts`），
主进程通过 `src/main/scheduler/holidays.ts` 加载。

## holidays.json —— 交易日历兜底表

只在**本地 `trade_calendar` 表查不到该日期**时才用得上。正常路径是每周从数据源刷新
（由基准指数日线反推，见 `src/main/providers/shared.ts` 的 `calendarFromIndexBars`），
内置表是断网/接口挂掉时的第二道防线，第三道是「周一至周五」。

### ⚠ 当前状态：所有年份均未核对

`verifiedYears` 是空的。表里 2024/2025/2026 的日期是按放假安排推算的，**没有逐条对过
交易所公告**。未核对年份的日历结论会带上 `uncertain=true`，Scheduler 因此会在交易时段内
每 30 分钟探一次真行情：如果内置表说「今天休市」而实际有行情，会立刻纠正本地日历并恢复正常轮询
（见 `src/main/scheduler/index.ts` 的 probe）。

也就是说，表错了不会让软件静默，只会浪费几次请求。但这不是可以长期依赖的状态。

### 每年更新流程

1. 查上交所与深交所当年的《关于全年休市安排的公告》（两者一致，取其一即可）。
2. 只列**非周末**的休市日。周末与调休上班的周六周日都由 `isWeekend` 兜底，列进来是冗余。
3. 逐日核对后把年份加进 `verifiedYears`，并把 `updatedAt` 改成核对当天。
4. 跑 `pnpm test tests/unit/main/calendar.test.ts` —— 表的结构校验与「不列周末」在测试里有断言。
