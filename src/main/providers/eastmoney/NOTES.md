# eastmoney · 接口笔记

> ## ⚠ 待核对 —— fixture 是手写的，不是录制的
>
> **最后核对：无。** 开发机（2026-08-11）访问 `push2.eastmoney.com` / `push2his.eastmoney.com`
> 时连接被对端直接断开：
>
> ```
> curl: (56) Failure when receiving data from the peer
> node fetch: TypeError: fetch failed … other side closed
> ```
>
> 同一台机器上 `quote.eastmoney.com` 返回 200，换 UA、加 Referer、http/https、
> 换 `82.push2his` 备用域名均无效 —— 判断是出口网络对该 API 的拦截，不是接口下线。
>
> **2026-08-12 更正：上面这个判断错了。** 它只在 curl 上成立。node fetch（undici，
> 应用真正用的客户端）访问同样的 URL **6/6 成功**；`provider_health` 今天记录 83 成功 /
> 24 失败（≈78%），`other side closed` 是随机出现、重试可过的间歇故障。
> **别用 curl 判断这个接口通不通。** 录制仍未做的真实原因是
> `scripts/record-fixtures.mjs` 没有重试，4 个请求通常只成 2 个。
>
> 因此 `tests/fixtures/providers/eastmoney/*.json` 是**按下述已知字段契约手写的**，
> 它验证的是「解析器对这个形状的输入是否正确」，**不能**证明真实响应就是这个形状。
>
> **首次能联网的机器上必须先做这件事：**
>
> ```bash
> pnpm fixtures:record -- --provider eastmoney
> git diff tests/fixtures/providers/eastmoney   # 人工比对，尤其是字段号与单位
> pnpm test tests/integration/providers
> ```
>
> 核对通过后删掉本段，把日期写进「最后核对」。在此之前，主源实际可用性未知，
> `settings.providerPriority` 的降级链（→ tencent → sina）是唯一保证。

角色：主源。日线（含复权）、批量快照、基础信息、交易日历。

## 端点

| 用途 | 请求 |
|---|---|
| 日线 | `GET https://push2his.eastmoney.com/api/qt/stock/kline/get` |
| 批量快照 | `GET https://push2.eastmoney.com/api/qt/ulist.np/get` |
| 基础信息 | `GET https://push2.eastmoney.com/api/qt/stock/get` |

- 编码 **UTF-8**（与另外两个源不同）。
- `ut=fa5fd1943c7b386f172d6893dbfba10b` 是接口必需的公开常量，缺了多数端点直接 400。
  它不是身份伪造 —— 全网示例都是同一个值。
- `secid` = `市场号.六位代码`，**沪市 1、深市与北交所都是 0**。
  回填内部代码时市场号 0 要靠代码段区分深市还是京市（`fromSecId`）。

## 日线

```
?secid=1.600000&ut=…&fields1=f1,f2,f3,f4,f5,f6
&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61
&klt=101&fqt=1&beg=20240101&end=20240205&lmt=2000
```

- `klt=101` 日线；`fqt` = 0 不复权 / 1 前复权 / 2 后复权。
- `data.klines` 是 CSV 字符串数组，列序**由 fields2 决定**，改一处必须改另一处：

| 列 | 字段 | 含义 |
|---|---|---|
| 0 | f51 | 日期 `YYYY-MM-DD` |
| 1 | f52 | 开 |
| 2 | f53 | **收**（注意是开、收、高、低） |
| 3 | f54 | 高 |
| 4 | f55 | 低 |
| 5 | f56 | 成交量，**手**（×100 转股） |
| 6 | f57 | 成交额，**元** |
| 7 | f58 | 振幅 % |
| 8 | f59 | 涨跌幅 % |
| 9 | f60 | 涨跌额 |
| 10 | f61 | 换手率 % |

- `rc !== 0` 视为失败；`data` 为 `null` 表示代码不存在，按空区间处理。
- **复权双轨要两次请求**：`fqt` 一次只能给一种口径。

## 批量快照

```
?ut=…&fltt=2&invt=2&secids=1.600000,0.000001&fields=f2,f5,f6,f12,f13,f14,f15,f16,f17,f18,f51,f52,f124
```

| 字段 | 含义 |
|---|---|
| f2 | 最新价 |
| f5 | 成交量，**手** |
| f6 | 成交额，元 |
| f12 / f13 | 六位代码 / 市场号 |
| f14 | 名称 |
| f15 / f16 | 最高 / 最低 |
| f17 / f18 | 今开 / 昨收 |
| f51 / f52 | 涨停价 / 跌停价 |
| f124 | 时间戳，**unix 秒** |

- **`fltt=2` 必须带**：缺了价格会是按 `decimal` 放大的整数（9.21 → 921）。
  这种错误不会抛异常，只会让面板显示 921 元。
- `data.diff` 有两种形态：数组，或以 `"0"`/`"1"`… 为键的对象。两种都要吃下。
- 停牌 / 无数据的字段返回字符串 `"-"`，`shared.ts num()` 解析为 null。

## 基础信息

`?secid=1.600000&fields=f57,f58,f127,f189` → f57 代码、f58 名称、f127 行业、f189 上市日（`YYYYMMDD` 数字）。
三个源里只有它给行业，行业集中度风控依赖这一项。

## 交易日历

不调用任何日历端点，而是拉 `SH000001` 的年度日线，有数据的那天即开市
（`shared.ts calendarFromIndexBars`）。理由：免费源都没有可靠的日历接口，
而指数日线本身就是一张交易日表，且不会因某个未公开端点下线而失效。
只覆盖到指数数据的最后一天，之后是「未知」而非「休市」。
