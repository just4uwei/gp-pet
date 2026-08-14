-- 008_ai_explain · AI 解读的历史记录
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 009_xxx.sql，不要编辑本文件。
--
-- ## 为什么现在建表了（原先刻意不建）
--
-- `src/main/ai/service.ts` 早先的结论是「AI 解读花钱但可重来，只做内存 LRU」。
-- 那句话的后半截是错的：**重来要再花一次钱**，而重启一次内存缓存就空了 ——
-- 于是同一条信号会被重复计费，「上次 AI 怎么说这只票的」也永远答不上来。
--
-- 这张表让两件事成立：
--   1. 历史可查（抽屉里按时间前后翻这只票的全部解读）；
--   2. **重启后不再对同一条信号重复计费**（`explain()` 先查内存、再查这张表）。
--
-- ## 三条容易读错的
--
-- 1. **不加任何外键。**
--    * 不指向 `signal(id)`：`signal` 按 2 年裁剪，而这张表**永不裁剪** ——
--      加外键等于把花过钱的记录挂在日志保留策略上，裁剪那天会连带删掉它
--      （与 `shadow_trade` 同一条）。
--    * 不指向 `watchlist(code)`：把票移出自选不该让历史解读跟着消失（与 `trade_log` 同一条）。
-- 2. **下面那一组信号字段是刻意冗余的**，正因为没有外键。两年后原信号被裁掉，
--    历史列表若还去 join，剩下的会是一串没有上下文的正文 ——
--    「哪天、什么方向、多少置信、当时什么价」必须自带一份。
--    同理 `model` / `protocol` 也要存：换个模型再解读一次，结论不同是正常的，
--    不记下来就没法判断两条为什么打架。
-- 3. **不进 `retention.ts` 的 pruneAll，也不进「清缓存」。**
--    删除只有一条路：用户在抽屉里手动删（`ai:remove`，主进程会先弹确认框）。
--    自动删掉一条花过钱的东西，而用户完全不知道发生过 —— 那是最坏的一类。
--
-- ## 它仍然不改变 AI 的定位
--
-- 落库的是**解释文本**。它照旧不回流到信号、闸门、状态点或影子运行
-- （`src/main/ai/index.ts` 头注释那五条一条没变）。

CREATE TABLE ai_explain (
  id          TEXT PRIMARY KEY,
  -- 来源信号。**不是外键**（见上），原信号被裁剪后这一行照样活着
  signal_id   TEXT NOT NULL,
  code        TEXT NOT NULL,
  -- 发起时刻。历史列表按它倒序 —— 不是完成时刻：用户记得的是「我什么时候点的」
  created_at  INTEGER NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  model       TEXT NOT NULL,
  protocol    TEXT NOT NULL,
  -- ↓ 信号当时的样子，冗余存一份
  direction   TEXT NOT NULL,
  stage       TEXT NOT NULL,
  score       REAL NOT NULL,
  -- 当时的价。拿不到时为 NULL，**不要填 0**（约束 4）
  price_at    REAL,
  signal_at   INTEGER NOT NULL
);

-- 抽屉里那份「这只票的全部解读」
CREATE INDEX idx_ai_explain_code_at ON ai_explain(code, created_at DESC);
-- 「这条信号最近一次解读」—— 防重复计费那条路走它
CREATE INDEX idx_ai_explain_signal ON ai_explain(signal_id, created_at DESC);
