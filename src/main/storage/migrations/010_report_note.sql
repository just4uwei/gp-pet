-- 010_report_note · 收盘日报的 AI 评价
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 011_xxx.sql，不要编辑本文件。
--
-- ## 为什么不复用 ai_explain
--
-- 那张表的 `code` / `direction` / `stage` / `score` / `signal_at` 都是 NOT NULL，
-- 而且是**刻意冗余**的（008 的头注释：原信号被裁剪之后那一行还要能读懂）。
-- 一份日报没有这些东西 —— 它说的是一整天、全部自选。
-- 往那几列塞空串和 0 正是这个项目一直在防的「用假值冒充」，
-- 而且会污染抽屉里那份**按 code** 的历史列表（日报会以一个不存在的代码混进去）。
--
-- ## 三条与 ai_explain 相同的纪律
--
-- 1. **不加外键。** 日报是按交易日算出来的，不指向任何一行 signal。
-- 2. **不进 retention.ts 的 pruneAll，也不进「清缓存」。**
--    自动删掉一条花过钱的东西、而用户完全不知道发生过，是最坏的一类。
--    眼下唯一会改动它的动作是用户自己点「重新生成」（同一天覆盖，见下）；
--    仓储留了 `remove()` 但**还没有接 IPC** —— 要接的话得像 `ai:remove` 那样
--    先弹系统确认框。
-- 3. **只有 done 才落库**（service.ts）。用户点了停止的半截不存。
--
-- ## trade_date 是主键 = 一天一条 = 幂等闸门
--
-- 与 `shadow_equity.trade_date` 同一条纪律。少了它，同一天点两次「重新生成」
-- 会攒出两行，而「历史里多了一条」这件事在界面上完全看不出来。
-- 重新生成走 UPSERT 覆盖：用户要的是**这一天**的评价，不是它的版本史。

CREATE TABLE report_note (
  trade_date  TEXT PRIMARY KEY,
  -- 发起时刻。用户记得的是「我什么时候点的」，不是模型什么时候写完的
  created_at  INTEGER NOT NULL,
  elapsed_ms  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  -- 换个模型再评一次，结论不同是正常的；不记下来就没法判断两条为什么打架
  model       TEXT NOT NULL,
  protocol    TEXT NOT NULL,
  -- 生成时那份**事实层**的指纹（见 report/digest.ts）。
  --
  -- 日报有两个阶段：盘后即时版（数字取自盘中最后一次行情）与次日定稿版（当日收盘线）。
  -- 一段基于即时版写的评价，在定稿之后可能已经与事实对不上 —— 而它读起来完全正常。
  -- 存下指纹，界面就能如实说「这段是基于盘中数据写的」，而不是让用户自己发现。
  fact_digest TEXT NOT NULL
) WITHOUT ROWID;
