-- 007_trade_log · 成交流水（用户自己的账本）
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 008_xxx.sql，不要编辑本文件。
--
-- ## 这张表回答的问题
--
-- `position` 答的是「我现在持有什么」，它只有当前股数与摊薄成本 ——
-- **卖出之后那笔赚亏就消失了**，清仓后连持仓行一起没，于是
-- 「这只票我总共赚了多少」在这个软件里从来答不上来。这张表答那个问题。
--
-- 记账口径（`src/main/trades/ledger.ts` 是唯一实现，UI 试算与落库共用它）：
--   买入  成本按加权平均摊薄，**含手续费**（券商的摊薄成本口径）
--   卖出  只减股数，**成本价不动**，差额结转成 realized 存在这一行上
--
-- ## 三条容易读错的
--
-- 1. **不加指向 `watchlist(code)` 的外键**（`position` 有，这里刻意没有）。
--    账本是用户自己的东西，不该挂在自选列表的生命周期上 —— 卖光之后把票移出自选，
--    「这只票总共赚了多少」不该跟着消失。同一个理由让 `retention.ts` 的 pruneAll
--    **完全不碰**这张表（与 shadow_* 同一档：它是记录，不是可再生的派生物）。
-- 2. **`realized` 为 NULL 与为 0 是两回事。** 买入与期初建仓没有已实现盈亏（NULL），
--    刚好打平才是 0。用 0 顶替 NULL 会让「打平」与「不适用」再也分不开（约束 4）。
-- 3. **下面那笔期初建仓的 `fee = 0` 不是「没有手续费」，是「不知道」。**
--    迁移时无从得知当时的费用，也无从倒推。它同时意味着期初那一笔的 price
--    就是用户当初在持仓表单里填的成本价 —— 那个数本来也是他自己估的。

CREATE TABLE trade_log (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  -- BUY 买入 | SELL 卖出 | OPENING 期初建仓（迁移或配置导入补的，不是一次真实成交）
  side       TEXT NOT NULL,
  -- 成交时刻。**用户填的那个日期**，不是录入时刻（补录上周的成交是常态）
  traded_at  INTEGER NOT NULL,
  -- **不复权**真实成交价：用户当时付的钱，与 position.cost 同一口径（docs/03 §2.3）
  price      REAL NOT NULL,
  shares     INTEGER NOT NULL,
  fee        REAL NOT NULL,
  realized   REAL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_trade_code_at ON trade_log(code, traded_at DESC);

-- 把现有持仓补成一笔期初建仓。
-- 不补的话持仓页会出现「现持 1000 股、历史成交 0 笔」，而已实现盈亏的起算点也对不上。
INSERT INTO trade_log (id, code, side, traded_at, price, shares, fee, realized, note, created_at)
SELECT 'opening-' || code, code, 'OPENING', opened_at, cost, shares, 0, NULL,
       '迁移时按当时的持仓记录补的期初建仓，手续费未知', opened_at
FROM position;
