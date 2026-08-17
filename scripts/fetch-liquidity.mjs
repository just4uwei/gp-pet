#!/usr/bin/env node
/**
 * 补「流动性维度」：逐只拉东财日线的**成交额**与**换手率**，反推逐日流通股本与流通市值
 * → `data/liquidity/<CODE>.json`。
 *
 * ```bash
 * node scripts/fetch-liquidity.mjs --universe params/universe-broad.json
 * node scripts/fetch-liquidity.mjs --codes SH600276,SZ002716 --from 2018-01-01
 * node scripts/fetch-liquidity.mjs --universe params/universe-delisted.json --out data/liquidity
 * ```
 *
 * ## 为什么单独一个脚本，而不是改 fetch-history.mjs
 *
 * **两家的价格轨绝不能混。** 指标与净值用腾讯的后复权（不随抓取日变，
 * `fetch-history.mjs` 头注释里那条断言挡着 qfq 是有原因的）。这里只取三样
 * **与价格轨无关**的东西：成交额、换手率、由它们反推的流通市值。
 * 把它们塞进同一份 fixture 会让「这根 K 线来自哪家」这个问题失去答案，
 * 而两家对同一天的收盘价可以差一分钱（复权口径与四舍五入）。
 *
 * ## 数据从哪来（2026-08-17 实测，[信源台账 §1](../docs/notes/信源台账.md)）
 *
 * 东财 `push2his …/stock/kline/get` 的 `fields2` 里：
 *
 * | 序号 | 列 | 口径 |
 * |---|---|---|
 * | idx 5 | `f56` 成交量 | **手**（×100 = 股） |
 * | idx 6 | `f57` 成交额 | 元，**不复权**口径 ⇒ `额 ÷ 量 ÷ 100` = 当日真实均价 |
 * | idx 10 | `f61` 换手率 | **百分数**（1.70 = 1.70%） |
 *
 * ⇒ **流通股本 = 量 × 100 ÷ (换手率 ÷ 100)**，流通市值 = 流通股本 × 真实均价。
 * 三只票交叉核对过：恒瑞 63.7 亿股（总股本 63.8 亿）、中远海控 126.3 亿股
 * （流通 A 股约 127 亿）、湖南白银 21.1 亿股。**一个请求给全 8 年半**（2092 根）。
 *
 * ## 四条边界
 *
 * 1. **不写价格。** 输出里刻意**没有** open/high/low/close —— 见上面那条。
 *    唯一的价格是 `avgPrice`（额÷量÷100），它只是算市值的中间量，不许拿去当收盘价用。
 * 2. **换手率为 0 或缺失的那天不推市值**（`floatCap: null`，绝不填 0）：
 *    停牌日与新股上市首日都会出现 0，除以它得到 Infinity。
 *    与 CLAUDE.md 约束 4 同一条：未定义就是 null。
 * 3. **换手率是「流通」口径**，所以反推出来的是**流通股本 / 流通市值**，不是总市值。
 *    做「剔除最小 30%」这类横截面分位时两者排序高度相关，但**别把这个数写成总市值**。
 * 4. **不做任何过滤与分位计算。** 这里只落原始三列 + 反推值；
 *    「剔除谁」是回测那一侧的事（预注册见 M2 §5.29），两件事分开才能各自复核。
 *
 * ## 两条路：联网取真值，或从 fixture 算成交额代理
 *
 * `--from-fixtures data/history` **不联网**，用现有腾讯 fixture 算
 * `amount ≈ 成交量(股) × 不复权收盘价`，`turnoverRate` / `floatShares` / `floatCap` 一律 null。
 *
 * **为什么这是永久口径而不是临时凑数**（M2 §5.29 修正一）：东财会因大请求整族限流，
 * 而「同一支实验先用代理报一次、拿到真值再报一次」违反「每个机制只报一次分位」。
 * 误差实测（24538 个「股票·日」）：中位 **−0.00%**、绝对误差中位 **0.44%** / p95 **2.51%** ——
 * 而横截面上不同标的的成交额差几个数量级，对「最小 30%」这个分位排序几乎无影响。
 *
 * **市值那一支没有代理**：换手率是反推流通股本的唯一入口，只能联网取。
 *
 * ## 失败方向
 *
 * 东财是**间歇性**的（undici 成功率约 78%，失败症状 `other side closed`），
 * 所以逐只重试 4 次；仍失败的**逐只落一行错误并继续**，最后汇总列出 ——
 * 一只失败让整轮中断，等于 260 只白抓。**已抓到的逐只落盘**（不是全抓完再统一写），
 * 与 fetch-history.mjs 被腾讯拦掉那次的教训同一条。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 同源的几个门。腾讯那条路备了三个门（见 fetch-history.mjs），东财同理 ——
 * ⚠ 但 2026-08-17 实测**限流是按整族 host 生效的**：撞上之后
 * `push2his` / `1.` / `7.` / `13.` / `33.push2his` / `push2` 全部 `UND_ERR_SOCKET`，
 * 而同一时刻腾讯与新浪都是 200。**所以换门救不了限流，只能救单门故障。**
 * 真正的对策是下面的限速与熔断。
 */
const KLINE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://1.push2his.eastmoney.com',
  'https://7.push2his.eastmoney.com',
]
const KLINE_PATH = '/api/qt/stock/kline/get'
/** 与 src/main/providers/eastmoney/index.ts 的 UT 同一个值 */
const UT = 'fa5fd1943c7b386f172d6893dbfba10b'
const FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
/** 列序，由 FIELDS2 决定 —— 两者必须一起改 */
const IDX = { date: 0, close: 2, volume: 5, amount: 6, turnover: 10 }
const RETRIES = 4
const MAX_CONCURRENCY = 4
/**
 * 两次请求之间至少隔这么久（毫秒）。**这不是礼貌，是可行性**：
 * 2026-08-17 连着发 3 个 `lmt=10000` 的大请求（各 2092 根）之后，东财整族 host
 * 对这台机器 0/18 全失败，十几分钟不恢复。261 只全量抓要靠限速摊开。
 */
const MIN_INTERVAL_MS = 1500
/**
 * 熔断：连续这么多只都失败就整轮中止。
 *
 * 判据是「已经被限流了，继续发只会延长限流并且什么都拿不到」——
 * 与 `src/main/providers/registry.ts` 那道熔断同一条理由。
 * 中止不算失败：脚本是可续跑的（已有文件自动跳过），等一会儿重跑就行。
 */
const BREAKER_AFTER = 8

const USAGE = `用法：
  node scripts/fetch-liquidity.mjs --universe params/universe-broad.json
  node scripts/fetch-liquidity.mjs --codes SH600276,SZ002716

  --universe <file>   标的池 JSON（读 codes 字段，与回测 --universe 同一份）
  --codes <list>      逗号分隔，覆盖 --universe
  --from <date>       默认 2018-01-01
  --to <date>         默认今天
  --out <dir>         默认 data/liquidity
  --concurrency <n>   默认 2（东财是间歇性的，压着并发靠重试过）
  --force             已有文件也重抓（默认跳过）
  --from-fixtures <d> **不联网**：从 <d>/<CODE>.json（腾讯日线 fixture）算成交额代理，
                      floatCap 一律 null。见下面「三条路」
  --monthly           用**月线**（klt=103，约 103 根而不是 2092 根）反推流通股本，
                      再乘 fixture 里的日收盘价展开成逐日市值。必须配 --prices
  --prices <dir>      --monthly / --from-shares 时的日线来源（默认 data/history）

不联网的两个搬运模式（换机器接力用，见文件头「怎么搬到另一台机器」）：
  --collect-shares <f>  扫 --out 目录里已抓好的文件，把流通股本压成**逐月**артefact 写到 <f>
  --from-shares <f>     反过来：读 <f> + --prices 展开成逐日文件（不需要网络）
`

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`)
  process.exit(2)
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function parseArgs(argv) {
  const args = {
    codes: [],
    universe: null,
    from: '2018-01-01',
    to: today(),
    out: join('data', 'liquidity'),
    concurrency: 2,
    force: false,
    fromFixtures: null,
    monthly: false,
    prices: join('data', 'history'),
    collectShares: null,
    fromShares: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) fail(`${flag} 缺少取值`)
      return value
    }
    if (flag === '--codes') args.codes = next().split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    else if (flag === '--universe') args.universe = next()
    else if (flag === '--from') args.from = next()
    else if (flag === '--to') args.to = next()
    else if (flag === '--out') args.out = next()
    else if (flag === '--concurrency') {
      const parsed = Number(next())
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENCY) {
        fail(`--concurrency 要是 1..${MAX_CONCURRENCY} 的整数`)
      }
      args.concurrency = parsed
    } else if (flag === '--force') args.force = true
    else if (flag === '--from-fixtures') args.fromFixtures = next()
    else if (flag === '--monthly') args.monthly = true
    else if (flag === '--collect-shares') args.collectShares = next()
    else if (flag === '--from-shares') args.fromShares = next()
    else if (flag === '--prices') args.prices = next()
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else fail(`未知参数：${flag}`)
  }
  if (args.universe !== null) {
    if (!existsSync(args.universe)) fail(`标的池文件不存在：${args.universe}`)
    const json = JSON.parse(readFileSync(args.universe, 'utf8'))
    const fromFile = Array.isArray(json.codes) ? json.codes : []
    if (fromFile.length === 0) fail(`${args.universe} 里读不到 codes 数组`)
    if (args.codes.length === 0) args.codes = fromFile.map((c) => String(c).toUpperCase())
  }
  // 两个搬运模式不需要 --codes（它们的范围由目录或产物决定）
  if (args.collectShares !== null || args.fromShares !== null) return args
  if (args.codes.length === 0) fail('必须给 --codes 或 --universe')
  for (const code of args.codes) {
    if (!/^(SH|SZ|BJ)\d{6}$/.test(code)) fail(`代码形态不对：${code}（要 SH600000 这种内部形态）`)
  }
  if (!isDate(args.from) || !isDate(args.to)) fail('--from / --to 要是 YYYY-MM-DD')
  if (args.from > args.to) fail('--from 晚于 --to')
  return args
}

/** SH600000 → 1.600000 · SZ000001 → 0.000001（与 provider 的 secid 规则一致） */
function toSecid(code) {
  const market = code.startsWith('SH') ? '1' : '0'
  return `${market}.${code.slice(2)}`
}

const compact = (date) => date.replace(/-/g, '')

/** 全局节流：所有 worker 共用一条时间线，`--concurrency` 再大也不会突发 */
let nextSlotAt = 0
async function throttle() {
  const now = Date.now()
  const slot = Math.max(now, nextSlotAt)
  nextSlotAt = slot + MIN_INTERVAL_MS
  if (slot > now) await sleep(slot - now)
}

async function fetchKlines(code, from, to, klt = '101') {
  const query = new URLSearchParams({
    secid: toSecid(code),
    ut: UT,
    fields1: 'f1,f2,f3,f4,f5,f6',
    fields2: FIELDS2,
    klt,
    // 复权口径**在这里无关**：只取量、额、换手率，三者都不受复权影响。
    // 仍显式给 fqt=2 是为了与应用内那条路一致，免得日后有人拿这个脚本去读收盘价
    fqt: '2',
    beg: compact(from),
    end: compact(to),
    lmt: '10000',
  })
  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    await throttle()
    // 换门只救单门故障（限流是整族生效的，见 KLINE_HOSTS 的注释）
    const host = KLINE_HOSTS[(attempt - 1) % KLINE_HOSTS.length]
    try {
      const res = await fetch(`${host}${KLINE_PATH}?${query.toString()}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const klines = json?.data?.klines
      if (!Array.isArray(klines)) throw new Error('响应里没有 data.klines')
      return klines
    } catch (err) {
      lastError = err
      // 间歇性失败等一下就好；指数退避到第 4 次约 1.4s
      if (attempt < RETRIES) await sleep(200 * 2 ** (attempt - 1))
    }
  }
  throw new Error(`${code} 四次都失败：${lastError?.message ?? '未知'}`)
}

/**
 * 一行 CSV → 一天的流动性。**推不出来的一律 null**（约束 4）。
 *
 * `turnover` 是百分数，0 出现在停牌日与上市首日；量为 0 同理。
 */
function rowOf(csv) {
  const cells = csv.split(',')
  const date = cells[IDX.date]
  const lots = Number(cells[IDX.volume])
  const amount = Number(cells[IDX.amount])
  const turnover = Number(cells[IDX.turnover])
  if (!isDate(date)) return null

  const shares = lots > 0 ? lots * 100 : 0
  const avgPrice = shares > 0 && Number.isFinite(amount) && amount > 0 ? amount / shares : null
  const floatShares = shares > 0 && Number.isFinite(turnover) && turnover > 0 ? shares / (turnover / 100) : null
  const floatCap = floatShares !== null && avgPrice !== null ? floatShares * avgPrice : null

  return {
    date,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    turnoverRate: Number.isFinite(turnover) && turnover > 0 ? turnover : null,
    avgPrice,
    floatShares,
    floatCap,
  }
}

/**
 * 不联网那条路：从腾讯 fixture 算成交额代理。
 *
 * `amount ≈ volume(股) × close(不复权)`。**用不复权收盘价**，因为成交额本身是
 * 不复权口径的（后复权价会把 2018 年的额算成几十倍）。
 * `turnoverRate` / `floatShares` / `floatCap` 一律 null —— 没有换手率就没有股本，
 * 编一个出来正是这个项目一直在防的事。
 */
function fromFixture(code, args) {
  const file = join(args.fromFixtures, `${code}.json`)
  if (!existsSync(file)) throw new Error(`${code} 在 ${args.fromFixtures} 里没有 fixture`)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const candles = Array.isArray(parsed.candles) ? parsed.candles : []
  const rows = []
  for (const candle of candles) {
    const date = candle?.date
    if (!isDate(date) || date < args.from || date > args.to) continue
    const volume = Number(candle.volume)
    const close = Number(candle.close)
    const usable = Number.isFinite(volume) && volume > 0 && Number.isFinite(close) && close > 0
    rows.push({
      date,
      amount: usable ? volume * close : null,
      turnoverRate: null,
      avgPrice: usable ? close : null,
      floatShares: null,
      floatCap: null,
    })
  }
  if (rows.length === 0) throw new Error(`${code} 的 fixture 在区间内没有可用根`)
  writeFileSync(
    join(args.out, `${code}.json`),
    `${JSON.stringify({
      code,
      source: 'fixture-proxy(tencent)',
      units: {
        amount: '元（代理 = volume 股 × 不复权收盘价；实测绝对误差中位 0.44% / p95 2.51%）',
        turnoverRate: 'null —— fixture 没有这一列',
        floatCap: 'null —— 没有换手率就推不出股本，不许编',
      },
      from: rows[0].date,
      to: rows[rows.length - 1].date,
      bars: rows.length,
      capBars: 0,
      medianFloatCap: null,
      rows,
    })}
`,
    'utf8'
  )
  return { code, bars: rows.length, capBars: 0, median: null }
}

/**
 * 月线那条路：**只用月线反推流通股本**，日度市值靠 fixture 的日收盘价展开。
 *
 * ## 为什么要有它
 *
 * 日线一次请求 2092 根，实测约 50–60 个这种请求就会把东财整族 host 限流
 * （[台账 §1](../docs/notes/信源台账.md)）。月线约 103 根，**payload 小 20 倍**。
 *
 * ## 为什么这样换算是合法的
 *
 * `流通股本` 是**慢变量**：只在增发/解禁/送股那几天跳一次，月度采样足够。
 * 而市值 = 股本 × 当日价，其中「当日价」用**已有的腾讯 fixture 不复权收盘价** ——
 * 那一轨本来就是这个项目的价格真源。
 *
 * 已知误差两处，都写在这里而不是藏起来：
 * 1. **月内股本按当月那个值**（增发上市日在月中时，那几天的市值偏小或偏大）。
 * 2. 月线换手率是**当月合计量 ÷ 流通股本**，与日线口径一致（两者实测同源，见下）。
 *
 * ⚠ **交叉核对是这条路的前提**：`--monthly` 与日线路对同一批标的应给出接近的股本。
 * 已用先抓到的 53 只日线结果验过（见 M2 §5.29）。
 */
async function fromMonthly(code, args) {
  const klines = await fetchKlines(code, args.from, args.to, '103')
  /** 'YYYY-MM' → 流通股本（股） */
  const sharesByMonth = new Map()
  for (const csv of klines) {
    const cells = csv.split(',')
    const date = cells[IDX.date]
    if (typeof date !== 'string' || date.length < 7) continue
    const lots = Number(cells[IDX.volume])
    const turnover = Number(cells[IDX.turnover])
    if (!(lots > 0) || !(turnover > 0)) continue
    sharesByMonth.set(date.slice(0, 7), (lots * 100) / (turnover / 100))
  }
  if (sharesByMonth.size === 0) throw new Error(`${code} 月线里一个月都推不出流通股本`)

  const priceFile = join(args.prices, `${code}.json`)
  if (!existsSync(priceFile)) throw new Error(`${code} 在 ${args.prices} 里没有日线 fixture`)
  const candles = JSON.parse(readFileSync(priceFile, 'utf8')).candles ?? []

  const months = [...sharesByMonth.keys()].sort()
  /** 前值填充：取 ≤ 该月的最后一个采样；早于第一个采样的用第一个 */
  const sharesAt = (month) => {
    let picked = null
    for (const m of months) {
      if (m > month) break
      picked = m
    }
    return sharesByMonth.get(picked ?? months[0])
  }

  const rows = []
  for (const candle of candles) {
    const date = candle?.date
    if (!isDate(date) || date < args.from || date > args.to) continue
    const volume = Number(candle.volume)
    const close = Number(candle.close)
    const usable = Number.isFinite(volume) && volume > 0 && Number.isFinite(close) && close > 0
    const shares = sharesAt(date.slice(0, 7)) ?? null
    rows.push({
      date,
      // 成交额仍是代理（M2 §5.29 修正一，实测绝对误差中位 0.44%）
      amount: usable ? volume * close : null,
      turnoverRate: null,
      avgPrice: usable ? close : null,
      floatShares: shares,
      floatCap: shares !== null && usable ? shares * close : null,
    })
  }
  if (rows.length === 0) throw new Error(`${code} 的 fixture 在区间内没有可用根`)

  const withCap = rows.filter((r) => r.floatCap !== null)
  const caps = withCap.map((r) => r.floatCap).sort((a, b) => a - b)
  writeFileSync(
    join(args.out, `${code}.json`),
    `${JSON.stringify({
      code,
      source: 'eastmoney-monthly-shares + tencent-fixture-prices',
      units: {
        amount: '元（代理 = volume 股 × 不复权收盘价；实测绝对误差中位 0.44%）',
        turnoverRate: 'null —— 月线的换手率是月度口径，不写进日行免得被误用',
        floatShares: '股（月度采样，前值填充）',
        floatCap: '元 = floatShares(当月) × 当日不复权收盘价',
      },
      monthsSampled: sharesByMonth.size,
      from: rows[0].date,
      to: rows[rows.length - 1].date,
      bars: rows.length,
      capBars: withCap.length,
      medianFloatCap: caps.length === 0 ? null : caps[Math.floor(caps.length / 2)],
      rows,
    })}
`,
    'utf8'
  )
  return { code, bars: rows.length, capBars: withCap.length, median: caps[Math.floor(caps.length / 2)] ?? null }
}

async function fetchOne(code, args) {
  if (args.fromFixtures !== null) return fromFixture(code, args)
  if (args.monthly) return fromMonthly(code, args)

  const klines = await fetchKlines(code, args.from, args.to)
  const rows = klines.map(rowOf).filter((r) => r !== null)
  if (rows.length === 0) throw new Error(`${code} 返回 ${klines.length} 行但一行都解不出来`)
  const withCap = rows.filter((r) => r.floatCap !== null)
  const caps = withCap.map((r) => r.floatCap).sort((a, b) => a - b)
  const median = caps.length === 0 ? null : caps[Math.floor(caps.length / 2)]
  const file = join(args.out, `${code}.json`)
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        code,
        source: 'eastmoney',
        // 口径写进文件里：读的人不该回来翻脚本
        units: {
          amount: '元（不复权口径）',
          turnoverRate: '百分数',
          avgPrice: '元 = amount ÷ (volume 手 × 100)',
          floatShares: '股 = volume × 100 ÷ (turnoverRate ÷ 100)',
          floatCap: '元 = floatShares × avgPrice（**流通**市值，不是总市值）',
        },
        from: rows[0].date,
        to: rows[rows.length - 1].date,
        bars: rows.length,
        capBars: withCap.length,
        medianFloatCap: median,
        rows,
      },
      null,
      0
    )}\n`,
    'utf8'
  )
  return { code, bars: rows.length, capBars: withCap.length, median }
}

/**
 * 把已抓好的逐日文件压成**逐月流通股本**产物（`params/float-shares.json`）。
 *
 * ## 为什么要有这个
 *
 * `data/` 整个不进版本控制（可重出），但**东财这条路极难重出** ——
 * 大请求约 50–60 个就限流，283 只要磨好几轮。而真正贵的信息只有
 * 「每只票每个月的流通股本」这一小块：280 只 × 约 103 个月 ≈ 几百 KB，
 * 逐日展开（× fixture 的日收盘价）在任何机器上都是**离线**的、一秒钟的事。
 *
 * 所以：贵且难重出的进 git（`params/`），便宜的本地重算。
 * `--from-shares` 是它的反向操作。
 */
function collectShares(args) {
  const out = { _meta: {}, shares: {} }
  const files = readdirSync(args.out).filter((f) => f.endsWith('.json'))
  let codes = 0
  let months = 0
  for (const file of files) {
    const json = JSON.parse(readFileSync(join(args.out, file), 'utf8'))
    const byMonth = {}
    for (const r of json.rows ?? []) {
      if (r.floatShares === null || r.floatShares === undefined) continue
      // 同一个月里取**最后一个**有值日：月末那个更接近该月的真实股本
      byMonth[String(r.date).slice(0, 7)] = Math.round(r.floatShares)
    }
    const count = Object.keys(byMonth).length
    if (count === 0) continue
    out.shares[json.code] = byMonth
    codes++
    months += count
  }
  out._meta = {
    source: 'eastmoney kline f56/f61（日线或月线反推：流通股本 = 量×100 ÷ (换手率÷100)）',
    note: '逐月采样。日度市值 = 该月股本 × 当日**不复权**收盘价（来自腾讯 fixture）。用 --from-shares 展开',
    codes,
    monthsTotal: months,
  }
  const target = args.collectShares
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(out, null, 1)}
`, 'utf8')
  process.stdout.write(`已把 ${codes} 只 / ${months} 个「票·月」的流通股本写到 ${target}
`)
  return 0
}

/** `--from-shares`：产物 + fixture 日线 → 逐日文件（离线，一秒钟） */
function expandShares(args) {
  const artifact = JSON.parse(readFileSync(args.fromShares, 'utf8'))
  const table = artifact.shares ?? {}
  mkdirSync(args.out, { recursive: true })
  let written = 0
  let skipped = 0
  for (const [code, byMonth] of Object.entries(table)) {
    const priceFile = join(args.prices, `${code}.json`)
    if (!existsSync(priceFile)) {
      skipped++
      continue
    }
    const candles = JSON.parse(readFileSync(priceFile, 'utf8')).candles ?? []
    const months = Object.keys(byMonth).sort()
    const sharesAt = (month) => {
      let picked = null
      for (const m of months) {
        if (m > month) break
        picked = m
      }
      return byMonth[picked ?? months[0]] ?? null
    }
    const rows = []
    for (const candle of candles) {
      const date = candle?.date
      if (!isDate(date) || date < args.from || date > args.to) continue
      const volume = Number(candle.volume)
      const close = Number(candle.close)
      const usable = Number.isFinite(volume) && volume > 0 && Number.isFinite(close) && close > 0
      const shares = sharesAt(date.slice(0, 7))
      rows.push({
        date,
        amount: usable ? volume * close : null,
        turnoverRate: null,
        avgPrice: usable ? close : null,
        floatShares: shares,
        floatCap: shares !== null && usable ? shares * close : null,
      })
    }
    if (rows.length === 0) {
      skipped++
      continue
    }
    const caps = rows.filter((r) => r.floatCap !== null).map((r) => r.floatCap).sort((a, b) => a - b)
    writeFileSync(
      join(args.out, `${code}.json`),
      `${JSON.stringify({
        code,
        source: `expanded from ${args.fromShares} + tencent-fixture-prices`,
        units: {
          amount: '元（代理 = volume 股 × 不复权收盘价）',
          floatCap: '元 = floatShares(当月) × 当日不复权收盘价',
        },
        from: rows[0].date,
        to: rows[rows.length - 1].date,
        bars: rows.length,
        capBars: caps.length,
        medianFloatCap: caps.length === 0 ? null : caps[Math.floor(caps.length / 2)],
        rows,
      })}
`,
      'utf8'
    )
    written++
  }
  process.stdout.write(`展开 ${written} 只到 ${args.out}${skipped > 0 ? `（${skipped} 只缺 fixture，跳过）` : ''}
`)
  return 0
}

async function main(argv) {
  const args = parseArgs(argv)
  // 两个离线搬运模式：不联网、不看 --codes
  if (args.collectShares !== null) return collectShares(args)
  if (args.fromShares !== null) return expandShares(args)
  mkdirSync(args.out, { recursive: true })

  const pending = args.codes.filter(
    (code) => args.force || !existsSync(join(args.out, `${code}.json`))
  )
  const skipped = args.codes.length - pending.length
  process.stdout.write(
    `共 ${args.codes.length} 只，需抓 ${pending.length}${skipped > 0 ? `（跳过已有 ${skipped}，要重抓加 --force）` : ''}\n` +
      `区间 ${args.from} → ${args.to} · 并发 ${args.concurrency}\n\n`
  )

  const ok = []
  const failed = []
  let cursor = 0
  let consecutiveFailures = 0
  let tripped = false
  const worker = async () => {
    for (;;) {
      if (tripped) return
      const index = cursor++
      const code = pending[index]
      if (code === undefined) return
      try {
        const result = await fetchOne(code, args)
        consecutiveFailures = 0
        ok.push(result)
        process.stdout.write(
          `[${ok.length + failed.length}/${pending.length}] ${code} ${result.bars} 根 · ` +
            `可推市值 ${result.capBars} 根 · 中位流通市值 ` +
            `${result.median === null ? '—' : `${(result.median / 1e8).toFixed(1)} 亿`}\n`
        )
      } catch (err) {
        failed.push({ code, why: err.message })
        consecutiveFailures++
        process.stdout.write(`[${ok.length + failed.length}/${pending.length}] ${code} 失败：${err.message}\n`)
        if (consecutiveFailures >= BREAKER_AFTER) {
          tripped = true
          process.stdout.write(
            `\n⚠ 连续 ${consecutiveFailures} 只失败，判为东财整体限流，整轮中止。\n` +
              '  这不是数据不存在。等十几分钟后**重跑同一条命令**即可（已抓到的自动跳过）。\n' +
              '  判断它恢复没有只能拿同一个 URL 再探 —— 腾讯/新浪那时照样是 200，看它们会以为网络没问题。\n'
          )
          return
        }
      }
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker))

  process.stdout.write(`\n成功 ${ok.length} · 失败 ${failed.length}${tripped ? ' · **已熔断中止**' : ''}\n`)
  if (failed.length > 0) {
    process.stdout.write('失败清单（重跑本命令即可，已成功的会自动跳过）：\n')
    for (const f of failed) process.stdout.write(`  ${f.code} ${f.why}\n`)
  }
  // 失败不算整轮失败：已落盘的那些是有用的，退出码只反映「有没有漏」
  return failed.length === 0 ? 0 : 1
}

const invokedDirectly = process.argv[1]?.endsWith('fetch-liquidity.mjs') === true
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`未捕获错误：${err?.stack ?? err}\n`)
      process.exit(3)
    }
  )
}

export { parseArgs, rowOf, toSecid }
