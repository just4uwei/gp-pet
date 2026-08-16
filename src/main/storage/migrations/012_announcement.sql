-- 012_announcement · 自选股公告（docs/11 N2）
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 013_xxx.sql，不要编辑本文件。
--
-- ## 它是什么，不是什么
--
-- **它不是信号，也不是提醒。** 引擎看不见公告，这张表也不进 `signal` / `alert_log` /
-- 影子账本。它回答的是引擎答不了的那个问题：「这只票今天为什么跌破止损」——
-- 可能是趋势走坏（引擎能说），也可能是昨晚出了减持公告（引擎完全不知道）。
--
-- **只有标题与分类，没有正文。** 本功能不下载解析 PDF（docs/11 §9）。
-- 所以这张表里的每一行都必须能点回原文 —— `url` 是 NOT NULL，
-- 解析层拿不到链接的条目在入库之前就丢弃了（docs/11 N2-d）。
-- 这是防幻觉的**结构性**保证：用户随时能自己核对，比提示词硬。
--
-- ## 与 report_note / ai_explain 相反：这张表**可以裁剪**
--
-- 010 与 008 不进 `pruneAll`，理由是「无法重建」（花过钱、模型可能已换）。
-- 公告不一样：**再拉一次就有**。所以它进保留策略，默认 90 天。
-- 两者要分开，否则裁剪那天会连带删掉不该删的。
--
-- ## 去重键是数据源给的条目 ID，不是「标题 + 日期」
--
-- 同一天同名公告是常见的（半年度报告会拆成正文 / 摘要 / 财务报告若干份，
-- 实测长江材料 2026-08-14 一次发了 4 份，`display_time` 逐秒相同）。
-- 拿标题拼键会把它们去重成一条 —— 少的那几条用户完全看不出来。
--
-- ## 不加指向 watchlist 的外键
--
-- 用户删掉一只自选股不该连带删掉历史公告记录；而且删除顺序会立刻变成第三处坑
-- （`watch_point` 已经贡献了两处，见 003 头注释）。代价是可能留下已不在自选里的行，
-- 由保留策略按时间清掉即可。
--
-- ## 两个时刻不许合并
--
-- `published_at` 是**真实发布时刻**，`notice_date` 是**归属的公告日**。
-- 实测 `display_time = 2026-08-14 17:30` 对应 `notice_date = 2026-08-15`。
-- 切「昨收盘之后」这个窗口用前者，展示「哪天的公告」用后者。
-- 只留一个的症状是：盘前简报要么漏掉昨晚 17:30 发的那条，要么把它标成今天发的。

CREATE TABLE announcement (
  -- 数据源给的条目 ID（东财 art_code / 巨潮 announcementId）
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  -- 数据源给的简称，只作留痕。**展示用 watchlist 里的名字** —— 那个才是用户认得的
  name         TEXT NOT NULL,
  title        TEXT NOT NULL,
  -- 数据源自己的分类（「业绩快报」「关联交易」…）。拿不到时 NULL，
  -- **不写空串也不写「其他」** —— 猜一个出来，下游的「建议先看」白名单会命中不存在的类型
  category     TEXT,
  -- 真实发布时刻（epoch ms，北京时间解析而来）
  published_at INTEGER NOT NULL,
  -- 归属公告日 'YYYY-MM-DD'
  notice_date  TEXT NOT NULL,
  -- 原文链接。NOT NULL 是刻意的，见上
  url          TEXT NOT NULL,
  -- 本地入库时刻，用于保留策略与「这批是什么时候拉的」
  fetched_at   INTEGER NOT NULL,
  -- 哪个源给的。两个源的条目 ID 空间不同，混用时要能查出这一行的出处
  provider     TEXT NOT NULL
) WITHOUT ROWID;

-- 盘前简报按「某只票、某个时间窗口」查，两列一起走
CREATE INDEX idx_announcement_code_time ON announcement(code, published_at DESC);
-- 保留策略按时间裁剪
CREATE INDEX idx_announcement_time ON announcement(published_at);
