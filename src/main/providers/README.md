# providers · 行情数据源适配层

每个数据源一个目录，实现 [`types.ts`](./types.ts) 的 `QuoteProvider` 接口。

| Provider | 角色 | 承担能力 |
|---|---|---|
| `eastmoney` | 主源 | 日线（含前复权）、批量快照、基础信息、交易日历 |
| `sina` | 备源 | 批量快照 |
| `tencent` | 备源 | 快照、日线 |

## 约定

1. **URL 与字段映射只写在各自模块内。** 设计文档不记录接口细节 —— 非官方接口会变，文档会腐化。真相以代码 + fixture 为准。
2. **每个 provider 必须配 fixture。** 把真实响应录制到 `tests/fixtures/providers/<id>/*.json`，集成测试回放这些 fixture 验证解析。接口字段变动时测试会立刻失败并指出位置。
3. **每个 provider 目录下写一份 `NOTES.md`**，记录：接口地址、字段含义、已知怪癖（如停牌时某字段为 `-`、科创板价格精度、复权因子口径）、最后一次核对日期。
4. **自我限制**：全局并发 ≤ 4、单源并发 ≤ 2、快照必须批量（分片 ≤ 50 只）、日线只做增量、休市不发请求。见 [docs/03 §2.4](../../../docs/03-数据源与存储设计.md)。
5. **不伪造身份**：统一 UA，开启 keep-alive，除必要 Referer 外不附加任何伪装。

## 重新录制 fixture

```bash
pnpm fixtures:record -- --provider eastmoney
```

录制后需人工比对新旧 fixture 的差异再提交 —— 自动覆盖会让「接口变了」这件事悄无声息地通过。
