-- 002_shadow · 影子运行（docs/07 §2.3、docs/08 M4）
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 003_xxx.sql，不要编辑本文件。
--
-- 影子运行是**前向**记账：每个交易日收盘确认轮推进一根，成交价取次日开盘。
-- 它刻意与 signal / alert_log 分表：
--   signal    答「引擎判了什么」
--   alert_log 答「有没有真的提醒我，被哪道闸门挡的」
--   shadow_*  答「若按这些信号操作，到今天赚没赚」
-- 三个问题的答案会分叉（被闸门挡掉的信号照样进影子组合 —— 影子量的是**策略**，
-- 不是提醒策略），合表会让「策略不行」与「提醒太吵」再也分不开。

-- 待成交委托。T 日收盘产生 → T+1 开盘成交（与回测同源，见 backtest/simulate.ts 文件头）。
-- 一只标的同时最多一张：影子组合是单标的单持仓。
CREATE TABLE shadow_order (
  code         TEXT PRIMARY KEY,
  action       TEXT NOT NULL,              -- BUY | SELL | REDUCE
  placed_date  TEXT NOT NULL,              -- 产生该委托的交易日
  rule         TEXT NOT NULL,              -- 触发它的子信号 ID 或风控规则 ID
  score        REAL NOT NULL,
  regime       TEXT NOT NULL,
  signal_id    TEXT,                       -- 对应 signal.id；拿不到时为 null（**不设外键**，见下）
  deferred     INTEGER NOT NULL DEFAULT 0  -- 跌停卖不掉时的顺延次数
);

-- shadow_order.signal_id / shadow_trade 都**故意不加**指向 signal(id) 的外键：
-- signal 表按 2 年裁剪（retention.ts），而影子记录要长期留着算绩效。
-- 加了外键，裁剪那天会连带删掉影子历史 —— 那是把「绩效记录」挂在「日志保留策略」上。

-- 影子持仓。cost 一律双轨：前复权算净值，不复权是「我买在多少」（docs/03 §2.3）
CREATE TABLE shadow_position (
  code            TEXT PRIMARY KEY,
  shares          INTEGER NOT NULL,
  entry_date      TEXT NOT NULL,
  entry_price_adj REAL NOT NULL,           -- 前复权成交价（净值口径）
  entry_price_raw REAL NOT NULL,           -- 不复权成交价（风控与展示口径）
  entry_costs     REAL NOT NULL,           -- 尚未摊到已平仓部分的买入费用
  entry_regime    TEXT NOT NULL,
  entry_score     REAL NOT NULL,
  entry_rule      TEXT NOT NULL,
  peak_raw        REAL NOT NULL,           -- 持有期最高价（不复权），移动止损用
  last_close_adj  REAL NOT NULL,           -- 最近一次收盘的前复权价，停牌时净值沿用它
  bars_held       INTEGER NOT NULL DEFAULT 0,
  engine_version  TEXT NOT NULL
);

-- 已平仓的一笔。一行 = **一次卖出**，回撤减仓会把一次建仓拆成两三行 ——
-- 「胜率」因此有逐笔与建仓级两个口径，不许混用（M2 §5.18）。
CREATE TABLE shadow_trade (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL,
  entry_date      TEXT NOT NULL,
  exit_date       TEXT NOT NULL,
  entry_price     REAL NOT NULL,           -- 前复权
  exit_price      REAL NOT NULL,
  entry_price_raw REAL NOT NULL,           -- 不复权
  exit_price_raw  REAL NOT NULL,
  shares          INTEGER NOT NULL,
  pnl             REAL NOT NULL,           -- 已扣双边费用
  pnl_pct         REAL NOT NULL,
  holding_bars    INTEGER NOT NULL,
  costs           REAL NOT NULL,
  regime_at_entry TEXT NOT NULL,
  entry_score     REAL NOT NULL,
  exit_rule       TEXT NOT NULL,
  partial         INTEGER NOT NULL,        -- 1 = 减仓（非清仓）产生的那笔
  engine_version  TEXT NOT NULL
);
CREATE INDEX idx_shadow_trade_exit ON shadow_trade(exit_date DESC);
CREATE INDEX idx_shadow_trade_entry ON shadow_trade(code, entry_date);

-- 每交易日一行的组合净值。trade_date 作主键 = 天然幂等：
-- 盘后会跑多轮 tick，重复推进同一天必须是空操作。
CREATE TABLE shadow_equity (
  trade_date     TEXT PRIMARY KEY,
  cash           REAL NOT NULL,
  position_value REAL NOT NULL,
  equity         REAL NOT NULL,
  -- 沪深300 当日前复权收盘价。null = 那天拿不到基准，**不填 0**：
  -- 0 会被净值曲线读成「基准归零」（约束 4 的同一条纪律）
  benchmark      REAL
);
