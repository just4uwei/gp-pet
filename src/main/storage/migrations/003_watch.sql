-- 003_watch · 观察点（用户确认的一次性盯盘条件）
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 004_xxx.sql，不要编辑本文件。
--
-- ## 这张表是什么，以及**它不是什么**
--
-- 它是**用户自己拥有的一次性观察条件**：由 AI 解读的「失效条件」那一段给出建议，
-- 由人确认（可改数值），由引擎每轮机械比较，命中后走正常的四道闸门发提醒。
--
-- 它**不是策略参数**。与 src/core/params.ts 的区别是硬的：
--   params.ts  引擎的、全局的、长期的，依据必须是本地回测标定（ADR-0003）
--   watch_point 用户的、单标的、一次性、会过期，依据是「用户确认」
-- 把它当参数看会污染 params-view.ts 那张标定状态表 —— 那张表的全部价值就在于
-- 「哪个数有依据」，掺进一批随手确认的阈值，它就废了。
--
-- 触发时刻**不涉及模型**：判定是一次纯比较（价格/指标 与 阈值）。
-- 模型只在「建议一个数」这一步出现过，而那一步后面站着一个人。

CREATE TABLE watch_point (
  id          TEXT PRIMARY KEY,
  -- 外键指向 watchlist：移出自选时必须先清观察点（见 WatchlistRepo.remove，
  -- 与 position 同一处、同一理由 —— foreign_keys = ON 会拒绝反序删除）
  code        TEXT NOT NULL REFERENCES watchlist(code),
  -- 来源信号。两个作用：
  --   ① 可追溯「这个观察点是看哪条解读设的」
  --   ② 命中提醒直接复用它当 alert_log.signal_id —— 于是**不用动 alert_log 的表结构**
  --      （那一列是 NOT NULL 外键，拿不到 signalId 的提醒发了也没有审计记录）
  signal_id   TEXT NOT NULL REFERENCES signal(id),
  source      TEXT NOT NULL,              -- AI_SUGGESTED 原样确认 | USER_EDITED 用户改过数值
  metric      TEXT NOT NULL,              -- PRICE | rsi | adx | ma20 | bollLower | …（白名单在 watch/metrics.ts）
  op          TEXT NOT NULL,              -- LTE 跌破（<=） | GTE 升破（>=）
  threshold   REAL NOT NULL,
  meaning     TEXT NOT NULL,              -- INVALIDATE 命中=原判断失效 | CONFIRM 命中=得到确认
  note        TEXT,                       -- 当时那段解读的摘录，回答「三个月后我为什么设了这个」
  -- 创建时的引擎版本。**指标类**观察点在换灵敏度后含义会漂（rsi 周期变了，
  -- 同一个阈值就不是同一件事），列表据此打一行提示。PRICE 类不受影响
  engine_version TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  -- **必填**。「如果判断错了会先看到什么」天然有时限；不设过期这张表会攒成
  -- 几十条永不触发的噪音，而用户会逐渐不再相信这个列表。
  -- 到期未命中**本身就是结论**（「没兑现」），不需要另一套机制表达
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,              -- ACTIVE | HIT | EXPIRED | CANCELED
  hit_at      INTEGER,
  hit_value   REAL
);

-- 每轮 tick 都要查「还在盯的有哪些」，按 status 起头
CREATE INDEX idx_watch_status ON watch_point(status, code);
CREATE INDEX idx_watch_created ON watch_point(created_at DESC);
