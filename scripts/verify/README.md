# 指标交叉验证

对应 [docs/07 §2.1](../../docs/07-回测与验证方案.md)：**指标算错，后面全是空中楼阁。**

```bash
pnpm verify:indicators            # 重新生成 K 线 fixture 与黄金值
pnpm verify:indicators -- --check # 只校验现有黄金值仍与参照实现一致（CI 用）
pnpm test tests/unit/indicators/golden.test.ts   # 断言生产实现与黄金值一致
```

## 三个文件的分工

| 文件 | 作用 | 铁律 |
|---|---|---|
| `synthetic.mjs` | 固定种子生成 500 根合成日线 | 不用 `Math.random`——黄金用例每次生成必须一模一样 |
| `reference.mjs` | **独立参照实现** | **不得 import `src/core` 的任何东西**，一律照 docs/04 的公式直写 |
| `run.mjs` | 串起来，抽样固化到 `tests/fixtures/golden/indicators.json` | 黄金值只抽样存（前 30 根、每 25 根、后 30 根） |

参照实现的风格刻意与生产实现相反：生产是「一次遍历 + 增量递推」，参照是「每格重算窗口」。
两套实现若共用了同一个错误的辅助函数而同时算错，交叉验证就白做了 —— **风格分歧是这道防线的一部分**。

## 现状：算法一致性已验证，口径一致性**已验证一半**（2026-08-19）

| 参照 | 状态 |
|---|---|
| 独立参照实现（本目录） | ✅ 23 条序列全部一致，相对误差 < 1e-6 |
| **第三方口径对照**（`jq-crosscheck.ts`，聚宽公开数据字典的示例值） | ✅ **已执行**，见下 |
| Python `pandas-ta` / TA-Lib | ❌ **未执行**（上面那条已经把它要回答的问题答掉大半） |
| 行情软件截图人工抽查 | ❌ **未执行** |

原先待验的三处口径，前两处**已有实证**：

1. ✅ **MACD 柱 = `2×(DIF−DEA)`** —— 用聚宽自己印的三组 (DIF, DEA, 柱) 做代数，逐位吻合（与日期无关）
2. ✅ **布林带标准差除 `n`** —— 逐位一致（相对差 **1e-14**）；改成除 n−1 的相对差 3e-4~7e-4 ⇒ 这次对照有分辨力
3. ❌ MACD 默认参数 (12,17,9) 的行为 —— 这一条本来就是 ADR-0003 说的未验证主张，与口径无关

**同一次对照查出两处口径「不一致」**（不是 bug，是两套自洽的口径）：

| 指标 | 我们 | 聚宽/通达信/东财/同花顺 |
|---|---|---|
| ATR | `Wilder(TR)/14` | `MA(TR,14)` 简单算术平均（实测残差 0） |
| DMI / ADX | Wilder(1/14) 平滑 DI，ADX 也 Wilder(14) | `EXPMEMA`（α=2/15）平滑 DI，**ADX 用 MM=6** |

后果与量级（699,907 个「股票·交易日」上 30.4% 的日子「ADX ≥ 20」结论相反）
写在 [M2 §5.38](../../docs/notes/M2-偏差报告.md)。

### `jq-crosscheck.ts` 怎么跑

```bash
pnpm fetch:history -- --codes SZ000001,SZ000002,SH601211 --from 2015-06-01 --to 2018-06-30 --out ./data/verify-jq
npx tsx scripts/verify/jq-crosscheck.ts
```

⚠ 两条别踩：**数据必须落在 `data/verify-jq`**（补进 `data/history` 会改变那 261 只的预热段，
历史回测基线就复现不出来了）；**聚宽示例里写的 `check_date` 与打印出来的数值不是同一天**，
真实日期是反查出来的（脚本头注释里写了）。

## `jq-riskmetrics.mjs`：用组合层口径重读一份已有报告（2026-08-19 加）

```bash
node scripts/verify/jq-riskmetrics.mjs reports/calib/t3fix.json reports/calib/liq-base.json
```

与上面那个脚本是**两件事**：`jq-crosscheck.ts` 验的是**指标算得对不对**，
这个验的是**绩效口径怎么读**（beta / alpha / 除法版超额 / 日胜率，定义抄自聚宽「风险指标」一节）。
它**只读**报告 JSON，算出来的数**不进任何门槛**。

⚠ **四个量里两个已经进报告了**（2026-08-19 用户拍板）：`beta` 与**除法版超额**现在是
`PerformanceBlock` 的字段、报告直接打印。⇒ 跑这个脚本只剩两个理由：读 **08-19 之前**
产出的老 JSON（那些文件没有这两个字段），或者看**那两个被否掉的量**
（`alpha` 的 Rf 敏感性、`日胜率` 的机械偏置）——
它们**刻意不进报告**，理由在 `src/backtest/metrics.ts` 的 `betaOf` 头注释。

⚠ 三条读法（实测见 [M2 §5.41](../../docs/notes/M2-偏差报告.md)）：
**alpha 只看 rf=0 那一栏**（低暴露策略上 `Rf` 支配符号）· **日胜率对低暴露策略零信息**
（≈ 基准下跌天数占比）· **beta 与 `performance.exposure` 是同一件事的两种量法**，对不上先怀疑口径。

## 首台能联网的机器上怎么补上

1. 让数据层把几只沪深300 成分股的日线补到 500 根以上（`pnpm dev` 跑一天，或用回测 CLI 的 `--db`）
2. 导出为 `tests/fixtures/klines/real-<code>.json`（`Candle[]` 形状即可）
3. 用 Python 侧算同一段：

   ```python
   # pip install pandas pandas-ta
   import json, pandas as pd, pandas_ta as ta
   df = pd.DataFrame(json.load(open('real-SH600000.json')))
   df['ma5']  = ta.sma(df.closeAdj, 5)
   df['rsi']  = ta.rsi(df.closeAdj, 14)
   adx = ta.adx(df.highAdj, df.lowAdj, df.closeAdj, length=14)   # ADX_14 / DMP_14 / DMN_14
   macd = ta.macd(df.closeAdj, fast=12, slow=17, signal=9)       # 注意 TA-Lib 的柱不乘 2
   ```

4. 容差按 docs/07 §2.1：`|ours − ref| / |ref| < 1e-6`，EMA 类只比对预热期之后
5. 差异若来自**口径**（柱子 ×2、STD 除 n），不要改实现 —— 那是刻意的国内口径，
   在这份 README 里记一笔「已确认差异及原因」即可
6. 更新上表的状态，并同步 [docs/notes/M2-偏差报告.md §6](../../docs/notes/M2-偏差报告.md)
