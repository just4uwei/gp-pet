-- 001_init · 初始 schema（docs/03 §4.2）
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 002_xxx.sql，不要编辑本文件。
-- 全部表在 M1 一次建好（含 M2/M3 才写入的 signal / alert_log / indicator_daily），
-- 理由：schema 变更要备份整库，攒到功能上线再改不如一次到位。

-- 自选股
CREATE TABLE watchlist (
  code              TEXT PRIMARY KEY,          -- 规范化代码，如 'SH600000'
  name              TEXT NOT NULL,
  market            TEXT NOT NULL,             -- SH | SZ | BJ
  board             TEXT,                      -- MAIN | GEM | STAR | BSE | ETF | INDEX
  industry          TEXT,
  group_name        TEXT NOT NULL DEFAULT '自选',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  strategy_override TEXT,                      -- JSON，null 表示用全局参数
  created_at        INTEGER NOT NULL
);

-- 日线（前复权与原始价并存，docs/03 §2.3）
-- amount / turnover_rate 允许为 null：部分数据源不提供，用 0 冒充会读成「零成交」
CREATE TABLE kline_daily (
  code          TEXT NOT NULL,
  trade_date    TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  open REAL, high REAL, low REAL, close REAL,
  open_adj REAL, high_adj REAL, low_adj REAL, close_adj REAL,
  volume INTEGER, amount REAL,
  turnover_rate REAL,
  adj_factor    REAL,
  has_gap       INTEGER NOT NULL DEFAULT 0,    -- 与前一根之间缺交易日，回测跳过该段（docs/07 §4）
  provider      TEXT NOT NULL,
  PRIMARY KEY (code, trade_date)
);
CREATE INDEX idx_kline_code_date ON kline_daily(code, trade_date DESC);

-- 指标快照（只存每日收盘值；盘中值不落库）
CREATE TABLE indicator_daily (
  code TEXT NOT NULL, trade_date TEXT NOT NULL,
  payload TEXT NOT NULL,                       -- JSON: IndicatorSet
  engine_version TEXT NOT NULL,                -- 参数或算法变更即失效重算
  PRIMARY KEY (code, trade_date)
);

-- 信号
CREATE TABLE signal (
  id             TEXT PRIMARY KEY,             -- uuid
  code           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  trade_date     TEXT NOT NULL,
  direction      TEXT NOT NULL,                -- BUY | SELL | REDUCE | HOLD_WARN
  score          REAL NOT NULL,                -- 0..1 加权得分
  votes          INTEGER NOT NULL,             -- 一致子信号数
  regime         TEXT NOT NULL,
  stage          TEXT NOT NULL,                -- PROVISIONAL | CONFIRMED | INVALIDATED
  price_at       REAL NOT NULL,
  evidence       TEXT NOT NULL,                -- JSON: 逐条子条件 + 当时指标值
  engine_version TEXT NOT NULL
);
CREATE INDEX idx_signal_code_time ON signal(code, created_at DESC);

-- 实际提醒记录（去重、冷却与「我到底被提醒过什么」的审计依据）
CREATE TABLE alert_log (
  id                TEXT PRIMARY KEY,
  signal_id         TEXT NOT NULL REFERENCES signal(id),
  level             TEXT NOT NULL,             -- L1 | L2 | L3
  channel           TEXT NOT NULL,             -- PET | BUBBLE | TRAY | OS_NOTIFY
  suppressed_reason TEXT,                      -- 非空表示被抑制及原因
  read_at           INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_alert_created ON alert_log(created_at DESC);

-- 用户手工记录的持仓（仅供风控提醒计算，本产品不接券商）
CREATE TABLE position (
  code       TEXT PRIMARY KEY REFERENCES watchlist(code),
  shares     INTEGER NOT NULL,
  cost       REAL NOT NULL,                    -- 不复权成本价
  peak_price REAL,                             -- 持有期最高价，用于回撤/移动止损
  opened_at  INTEGER NOT NULL,
  note       TEXT
);

CREATE TABLE trade_calendar (
  trade_date TEXT PRIMARY KEY,
  is_open    INTEGER NOT NULL,
  source     TEXT NOT NULL
);

CREATE TABLE provider_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL, at INTEGER NOT NULL,
  ok INTEGER NOT NULL, latency_ms INTEGER, error TEXT
);
CREATE INDEX idx_health_at ON provider_health(at DESC);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
