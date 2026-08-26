-- 016_trade_decision · 成交的**真实时刻**与**照哪条提醒做的**
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 017_xxx.sql，不要编辑本文件。
--
-- ## 这四列回答的问题
--
-- 007 建表时 `traded_at` 记的是「用户在表单里选的那个日期」，而表单把它存成
-- **本机 12:00**（`TradePanel` 的 `parseDate` 用 `new Date('...T12:00:00')`）。
-- 于是两件事一直答不了：
--
--   1. **这笔到底几点几分成交的** —— implementation shortfall（Perold 1988）里
--      「决策 → 成交」那一段只能按**日**算。更糟的是它会**静默丢样本**：
--      实测 `SH601788` 08-18 的首条信号在 13:04，而那个假时刻是 13:00，
--      **差 4 分钟**就让整对配不上，表里只剩一个「—」（M2 §5.53）。
--   2. **这笔是照哪条提醒做的** —— `trade_log` 没有任何指向 `signal` 的东西。
--
-- ⚠ **这两样都补不回来**：没人记得三周前那笔是几点、照哪条提醒做的。
-- 所以这个迁移的价值不在于修好历史，而在于**从今天起不再丢**。
--
-- ## 三条容易读错的
--
-- 1. **四列全部可空，NULL 是「不知道」不是 0**（约束 4）。
--    时刻尤其如此：补录上周的成交时用户根本不记得分钟，**做成必填就会逼出假数据**，
--    而假数据会一路进 IS 分解并被当成事实。留空 ⇒ NULL ⇒ 那笔不进按分钟的配对。
-- 2. **`signal_id` 刻意不加外键。** `signal` 表按 2 年裁剪（`retention.ts`），
--    而 `trade_log` **永不裁剪**（007 头注释：它是记录，不是可再生的派生物）。
--    加外键会让裁剪那天要么删不掉 signal、要么连带毁掉账本行 —— 先例是
--    `008_ai_explain`，它出于同样的理由也没加。
-- 3. **正因为不加外键，才要冗余存快照。** `decision_at` 与 `decision_price`
--    是下单依据那一刻的时刻与价格（后者取 `signal.price_at`，
--    即**引擎判定那一刻真正看到的价** —— 按信号日收盘价当决策价会把 IS 的符号读反，
--    M2 §5.53 已判）。存下来之后原信号被裁掉，IS 照样算得出。
--    这与 `ai_explain` 把 `code`/`direction`/`score` 冗余存下来是同一个形状。
--
-- ## 旧行：四列全 NULL，**不猜、不回填**
--
-- 016 之前写入的行，`traded_at` 是**本机** 12:00；之后写入的是**北京** 12:00
-- （`shared/time.ts` 的 `shanghaiMsFrom`，修的是极西时区上 T+1 会多锁一天的老坑）。
-- 迁移期无从得知写入方当时的时区，所以**不换算**。
-- 在 UTC+7/+8 上两者落在同一个北京日，差别只在别的时区上才显出来。

ALTER TABLE trade_log ADD COLUMN traded_at_exact INTEGER;
ALTER TABLE trade_log ADD COLUMN signal_id       TEXT;
ALTER TABLE trade_log ADD COLUMN decision_at     INTEGER;
ALTER TABLE trade_log ADD COLUMN decision_price  REAL;
