# 候选参数与标定网格

这里放**候选**参数，不是出厂参数。出厂参数只有一处：[`src/core/params.ts`](../src/core/params.ts)。

按 [ADR-0003](../docs/adr/ADR-0003-来源文档数值不作为出厂默认.md)，出厂默认值必须由
[docs/07 §3](../docs/07-回测与验证方案.md) 的标定流程产出后**由人**写回，工具不自动改文件。

## 两种用法

```bash
# ① 单组候选参数跑一次回测
pnpm backtest -- --codes SH600000,SZ000001 --from 2018-01-01 --to 2026-06-30 \
              --params ./params/classic-macd.json --out ./reports/classic.json

# ② 粗网格标定：训练 / 验证 / 测试三段自动切分
pnpm backtest -- --codes SH600000,SZ000001 --to 2026-06-30 \
              --grid ./params/grid.example.json --out ./reports/calibration.json
```

## 文件格式

两种文件都是「**块级覆盖**」——块内整体替换，不做深合并。半个 `weights` 块比写错的参数更难发现。

- `--params <file>`：一个对象，键是 `DEFAULT_PARAMS` 的块名
- `--grid <file>`：键是块名，值是该块的**候选列表**，展开为笛卡尔积

## 标定的红线（工具已内置，不必自己盯）

| 红线 | 行为 |
|---|---|
| 全样本交易 < 30 笔 | 直接淘汰 —— 统计上无意义 |
| 验证集年化为负 | 直接淘汰 —— 训练集表现不可信 |
| 验证集 Calmar 相对训练集衰减 > 50% | 标记为疑似过拟合，不当优胜者 |
| 排名依据 | **验证集** Calmar（年化/最大回撤）。用训练集排名等于直接过拟合 |
| 测试集 | 只对优胜者跑一次，且**不允许据此回头调参** |

邻域敏感性（最优参数 ±20% 绩效是否断崖）目前要人工跑一遍相邻取值 ——
把邻域也放进网格即可，`sensitivityFlags()` 提供判据。

## 写回出厂参数时要做的四件事

1. 改 `src/core/params.ts`
2. 递增 `ENGINE_VERSION`，**去掉 `-unvalidated` 后缀**
3. CHANGELOG 记录标定依据（数据区间、标的池、优胜候选的三段绩效）
4. 删掉 `tests/unit/core/params.test.ts` 里断言该后缀存在的那条用例
   —— 删它是一个需要有意识做出的动作
