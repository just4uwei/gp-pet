# ⚠ 这些 fixture 是手写的，不是录制的

开发机（2026-08-11）无法访问 `push2.eastmoney.com` / `push2his.eastmoney.com`
（连接被对端直接断开，详见 [../../../../src/main/providers/eastmoney/NOTES.md](../../../../src/main/providers/eastmoney/NOTES.md)），
因此无法录制真实响应。

这里的文件是**按已知字段契约手写的响应骨架**：

| 文件 | 覆盖的情形 |
|---|---|
| `kline-day-raw-sh600000.json` | 日线不复权，`fqt=0` |
| `kline-day-qfq-sh600000.json` | 日线前复权，`fqt=1` |
| `kline-empty.json` | `data: null`（代码不存在） |
| `snapshot-mixed.json` | 主板 / 深主板 / 创业板 / 停牌北交所 / ETF 五种；`diff` 为数组 |
| `snapshot-diff-object.json` | `diff` 为以 `"0"`/`"1"` 为键的对象形态 |
| `profile-sh600000.json` | 基础信息（含行业与上市日） |
| `trends2-sh600000.json` | 当日分时，含午休缺口（11:30 → 13:00）。**已按真实响应核对（2026-08-14）** |
| `trends2-empty.json` | `data: null`（代码不存在） |

`trends2-sh600000.json` 是这批里**唯一有真机依据**的：字段名、列序与数值都取自当天真实拉到的
返回（`preClose: 9.18`、`'2026-08-14 09:31,9.11,13259,9.132'`），只是行数裁短到 9 行以便读。
其余文件仍是推断的。

**价格与成交量取自同日录制的腾讯真实响应**（`../tencent/`），所以数值是真的市场数据，
只有 **JSON 结构与字段号是推断的**。它们能验证「解析器对这个形状的输入是否正确」，
**不能**证明真实响应就是这个形状。

在首台能访问该接口的机器上：

```bash
pnpm fixtures:record -- --provider eastmoney
git diff tests/fixtures/providers/eastmoney   # 人工比对字段号与单位
pnpm test tests/integration/providers
```

核对通过后删掉本文件，并更新 NOTES.md 的「最后核对」。
