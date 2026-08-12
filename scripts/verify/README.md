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

## 现状：算法一致性已验证，口径一致性**未验证**

| 参照 | 状态 |
|---|---|
| 独立参照实现（本目录） | ✅ 23 条序列全部一致，相对误差 < 1e-6 |
| Python `pandas-ta` / TA-Lib | ❌ **未执行** |
| 行情软件截图人工抽查 | ❌ **未执行** |

也就是说：「同一份公式被实现了两次、结果一致」已经成立；
「我们的公式与国内行情软件的口径一致」目前**只有文档的说法，没有实证**。

具体待验的三处口径（都在 docs/04 里写了，但没人对过真实软件）：

1. MACD 柱是否为 `2×(DIF−DEA)`（通达信/同花顺口径）
2. 布林带标准差是否除 `n` 而非 `n−1`
3. MACD 默认参数 (12,17,9) 的行为 —— 这一条本来就是 ADR-0003 说的未验证主张

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
