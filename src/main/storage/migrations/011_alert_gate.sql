-- 011 · 闸门拦截的**结构化**记录（2026-08-15）
--
-- ## 为什么不能继续用 suppressed_reason 分组
--
-- `suppressed_reason` 是给人读的一句话，里面嵌着连续量：
--   「防抖：连续成立 1/2 个 tick，未达确认次数」
--   「同键冷却：SH600000:BUY 上次 L2 提醒后还有 87 分钟」
--   「频率上限：全局每小时 L2+L3 已达 6 条，降为 L1」
-- 按它 GROUP BY 会得到成百上千个只差一个数字的桶。
-- 这与 `signalSignature` 里 `reasons[0]` 那个坑是**同一个形状**：
-- 一句嵌着百分比的文案让去重失效，两天落了 243 行同一条止损（CLAUDE.md 有记）。
-- 所以这里加两列离散字段，文案那一列**保留原样**给人读。
--
-- ## 两列各答什么，别混
--
-- `suppressed_gate`  实际把它拦下来的**第一道**闸门（四道是串行的）。null = 没被拦。
--                    它答的是「这条为什么没发出去」。
--
-- `would_block`      逗号分隔的闸门列表：**假设前置闸门都放行**，哪几道各自也会拦。
--                    它答的是「每道闸门各自有多严」。
--
-- **为什么必须有第二列**：四道闸门短路，被防抖挡下的候选**根本走不到冷却**。
-- 只看 `suppressed_gate` 的话，靠后的闸门看起来永远很松 —— 而那只是因为
-- 前面的把流量吃光了。「某道闸门拦截率 < 10% ⇒ 形同虚设」这个判据
-- 在短路结构下是**错的**，除非拿 `would_block` 来读。
-- 独立评估本身不花钱：闸门②③④在 `dispatcher.ts` 里都是纯读，只有①防抖会改状态。
--
-- ## 一条读数纪律：分母不在这张表里
--
-- **风控硬抑制的信号不进 alert_log**（它已经带着原因在 `signal` 表里，
-- CLAUDE.md「alert_log 与 signal 是两张表两件事」那条）。
-- 所以拿 alert_log 单表算出来的「拦截率」，分母已经是过滤后的流量，
-- 会系统性低估整条链路的过滤强度。**完整漏斗必须两张表拼**，
-- 见 `AlertRepo.gateFunnel()`。
--
-- ## 历史行
--
-- 改动之前的行两列都是 null。**不要回填** —— 从一句自由文案反推闸门是猜，
-- 而猜出来的分类会和真实记录混在一起再也分不开。
-- 聚合查询因此把「文案非空但 gate 为 null」单独计成 `LEGACY` 一档，
-- 让「这段时间的数据没有结构化记录」看得见，而不是变成 0。

ALTER TABLE alert_log ADD COLUMN suppressed_gate TEXT;   -- DEBOUNCE | COOLDOWN | CAP | QUIET | null
ALTER TABLE alert_log ADD COLUMN would_block TEXT;       -- 'DEBOUNCE,COOLDOWN' 形式，null = 未记录

CREATE INDEX idx_alert_gate ON alert_log(suppressed_gate, created_at DESC);
