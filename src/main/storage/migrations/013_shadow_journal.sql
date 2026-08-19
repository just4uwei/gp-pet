-- 013_shadow_journal · 影子运行的逐日操作流水（2026-08-19）
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 014_xxx.sql，不要编辑本文件。
--
-- ## 为什么需要它
--
-- 影子运行「在不在跑」这个问题，靠现有三张表答不出来：
--
--   * `shadow_equity` 一天一根，全空仓时是一条 1000000 的直线 —— 与「压根没推进」长得一样；
--   * `shadow_order` 是**当前**挂着的委托，`executeOrder` 成交后 `clearOrder` 就把它删了
--     ⇒ **事后拼不出「那天挂了哪两单」**；
--   * `shadow_trade` 只有卖出，建仓与作废都不在里面。
--
-- 实测（2026-08-19）：跑了两个交易日，面板上只有一个「待成交 2」的数字，
-- 用户问的是「这两笔是什么？除此之外它今天干了什么？」—— 那两个问题当时都没有出处。
--
-- ## 一行一个动作，不是一行一天
--
-- 「那天挂了哪两单」要能直接查出来。一行一天（把明细塞进一个 JSON 列）读起来一样，
-- 但每次都要解析，且没法按 code 过滤。
--
-- ## 这张表不是什么
--
--   * **不是绩效来源。** 绩效一律读 `shadow_trade` / `shadow_equity`。
--     这张表是给人看的流水，重复、冗余、可读优先。
--   * **不参与任何判定。** 引擎、风控、提醒层都不认识它。
--
-- ## 不进裁剪
--
-- `pruneAll`（retention.ts）**不碰这张表**，与 `shadow_trade` / `shadow_equity` 同一档：
-- 判据是「能不能重建」，而前向记录用历史 K 线补不出来（补出来的那个叫回测）。
-- 它很小 —— 一个交易日通常只有几行。
--
-- ## 不设外键
--
-- 不加指向 `signal(id)` 的外键：`signal` 按 2 年裁剪，挂上去等于把一段无法重建的流水
-- 挂在日志的保留策略上，裁剪那天会连带删掉它（`shadow_trade` 头注释里同一条理由）。

CREATE TABLE shadow_journal (
  trade_date TEXT    NOT NULL,
  -- 当天内的序号，从 1 起。推进是幂等的（重推前先按 trade_date 清空），所以不会有空洞
  seq        INTEGER NOT NULL,
  at         INTEGER NOT NULL,          -- 推进发生的墙上时刻（ms）
  -- PLACED       挂委托（用今天的收盘确认信号挂明天的）
  -- FILLED_BUY   委托成交，建仓
  -- FILLED_SELL  委托成交，平仓或减仓
  -- VOIDED       委托作废（涨停买不到 / 顺延超上限 / 现金不足…）
  -- DEFERRED     委托顺延（停牌或 K 线未回补）
  -- CLOSED_OUT   移出自选而了结
  -- NOT_ADVANCED **整轮没推进**，reason 说明为什么（这一档最值钱，见下）
  kind       TEXT    NOT NULL,
  code       TEXT,
  action     TEXT,                      -- BUY | SELL | REDUCE
  shares     INTEGER,
  price      REAL,                      -- 成交价，与 shadow_trade 同口径（不复权）
  rule       TEXT,                      -- 触发规则（建仓）或离场规则（平仓）
  regime     TEXT,
  score      REAL,
  reason     TEXT,                      -- VOIDED / DEFERRED / NOT_ADVANCED 的人话
  PRIMARY KEY (trade_date, seq)
) WITHOUT ROWID;

-- `NOT_ADVANCED` 单独说：用户下午才开机时，收盘确认补跑那一刻「次日开盘」已经过去，
-- 按前向纪律**不喂影子**（engine/tick.ts 的 feedShadow）⇒ 那一个交易日永远不会被推进，
-- 净值曲线上是个洞。这件事此前只在主进程日志里出现一行，界面上完全不可见 ——
-- 而它恰恰是「影子为什么不动」的最常见答案。

-- 面板按日倒序翻，主键的前缀就够了；这条索引是给「某只票的历史动作」用的
CREATE INDEX idx_shadow_journal_code ON shadow_journal(code, trade_date);
