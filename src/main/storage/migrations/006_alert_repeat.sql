-- 006_alert_repeat · 提醒日志的重复裁决记在同一行上
--
-- 迁移只前进不回退。改这里等于改已发布用户的库 —— 一律新增 007_xxx.sql，不要编辑本文件。
--
-- ## 修的是一个实打实的缺陷
--
-- alerts/candidates.ts 的 buildAlerts 对**每一轮** tick 的每个非 NONE 信号都造候选，
-- 分发器按 `code:direction` 冷却把它丢掉，而**被丢弃的裁决照样写一行**
-- （docs/05 §4「不制造信息黑洞」）。于是一条持续一上午的买入信号会在日志里留下
-- 200+ 行一模一样的「被同键冷却挡掉」—— 用户翻不动，真正发出去的那几条被淹掉了。
--
-- ## 但不能改成「重复的直接丢」
--
-- 那会丢掉「这个状态持续了多久」这条信息，而 docs/05 §4 要答的问题
-- 「它是不是漏提醒了」恰恰需要它。所以是：**同一条裁决重复时把首行的计数 +1**，
-- 信息一条不少，噪音没了。日志上显示成「×47 · 持续到 14:52」。
--
-- 判重的签名在 alerts/service.ts：`signalId | level | channels | suppressedReason`。
-- **signalId 必须在里面** —— 新信号就是新事件，哪怕文案一字不差也要新行。

ALTER TABLE alert_log ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1;
-- 最后一次重复的时刻。NULL = 只发生过一次（此时 created_at 就是全部信息）。
-- 刻意不用 created_at 顶替：那样分不开「只发生过一次」与「重复了但恰好同一毫秒」
ALTER TABLE alert_log ADD COLUMN last_at INTEGER;
