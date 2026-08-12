#!/usr/bin/env node
/**
 * 一次性拉取历史日线 → 回测 fixture 目录（docs/07 §3 标定流程的输入）。
 *
 * ```bash
 * pnpm fetch:history -- --codes SH600000,SZ000001 --from 2018-01-01 --to 2026-08-12
 * pnpm backtest -- --codes SH600000,SZ000001 --fixtures ./data/history \
 *                --benchmark SH000300 --grid ./params/grid.example.json
 * ```
 *
 * **为什么走这条路而不是等主进程回补：** 标定要 2018 年至今的日线，而应用的取数路径是
 * 增量回补（目标 320 根）且挂在 Electron 主进程上 —— 用它补 8 年要先跑通 better-sqlite3
 * 的 electron-rebuild。回测 CLI 本来就支持 `--fixtures`（src/backtest/data.ts），
 * 于是这里只做「批量拉 + 落 JSON」，把标定与 M1 的出口条件解耦。
 *
 * **数据源是腾讯**（`web.ifzq.gtimg.cn`）。2026-08-12 实测：eastmoney 的 push2* 仍被出口
 * 网络断连（curl 56），tencent / sina 均通。腾讯日线同时提供不复权与前复权两轨，
 * 正好对上 docs/03 的复权双轨存储。
 *
 * **实测到的三条接口行为**（决定了下面的分页与断言，改动前先重测）：
 *   1. 单次最多返回 **640 根**，且是从 `to` 往回数的最后 640 根 —— `from` 只当上界用。
 *      count 给到 2500 直接 `param error`。因此按年分页（243 根/年，稳在上限内）。
 *   2. **指数**（SH000300）请求复权也只返回 `day` —— 指数无复权，这是对的。
 *      但个股若出现同样情况，就是把不复权当复权用，指标会静默失真：见 assertKey()。
 *   3. 每根 6 列，顺序是 **日期, 开, 收, 高, 低, 量**（不是开高低收）。
 *
 * **复权轨用后复权（hfq），不用前复权（qfq）—— 这是本文件最重要的一个决定。**
 *
 * 腾讯的前复权是**加性**的（减价差，M1 偏差报告 §5.5 实测），在高分红股上会崩：
 * 累计分红一旦超过当年股价，前复权价就变成**负数**。实测中远海控（SH601919）
 * 2018–2026 有 **714 根前复权收盘价 ≤ 0**，最低 -5.145。负价格上算出来的
 * MA / MACD / RSI / 布林带全部无意义，而回测又按复权价计净值 —— 这不是「记进报告的偏差」，
 * 是数据不可用。
 *
 * 后复权没有这个问题（同一只同一区间：hfq 3.97~7.81，qfq -4.94~-1.98），而且
 * **hfq 的历史值不随抓取日变**（新的分红只影响除权日之后），复现性反而比 qfq 好。
 *
 * 对判定与绩效**等价**：指标全是比率型（MACD 穿越点、BBW、RSI、ADX 的 TR/ATR）
 * 在整条序列乘一个正常数后不变；净值用相邻复权价之比算，常数也约掉。
 * 真实成交价那一路用的是不复权 `close`（止损与持仓成本），本来就没走复权轨。
 *
 * 代价：`Candle.*Adj` 的语义从 docs/04 写的「前复权」变成「后复权」。
 * 这条偏差记在 M2 偏差报告 §5.4，字段名没改（改名要动 src/core 的类型契约）。
 *
 * **刻意不写 `profile`**：响应里有证券名称，但那是**今天**的名称。用它去标 2018 年那根
 * K 线的 ST 状态是未来函数。缺 profile 时 src/backtest/data.ts 的 fallbackProfile 会按
 * 「非 ST」处理，那条偏差已在该文件备案（回测对 ST 降级规则偏乐观）—— 已知方向的偏差，
 * 好过一个方向错了的修正。名称只记进 `_meta.nameAtFetch` 供人工核对。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 单次请求的条数上限（实测 640）。按年分页时每页最多 ~250 根，留足余量 */
const PAGE_COUNT = 300
/** 请求间隔。docs/03 §2.4 的自我限制：单源并发 ≤ 2，这里更保守地串行 + 间隔 */
const DELAY_MS = 300
const TIMEOUT_MS = 20_000
const RETRIES = 3

// ─────────────────────────── 参数 ───────────────────────────

const USAGE = `用法：
  node scripts/fetch-history.mjs --codes SH600000,SZ000001 [选项]

  --codes <a,b,c>     必填。内部形态代码（SH600000 / SZ000001 / BJ430047）
  --from <YYYY-MM-DD> 起始日，默认 2018-01-01（docs/07 §3 训练集起点）
  --to <YYYY-MM-DD>   截止日，默认今天
  --out <dir>         输出目录，默认 ./data/history
  --benchmark <code>  基准指数，默认 SH000300；给 none 可关闭
                      （它同时充当交易日历，用来标 has_gap）
  --dry               只拉不写盘
`

function parseArgs(argv) {
  const args = {
    codes: [],
    from: '2018-01-01',
    to: today(),
    out: join('data', 'history'),
    benchmark: 'SH000300',
    dry: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value === undefined) fail(`${flag} 缺少取值`)
      return value
    }
    if (flag === '--codes') args.codes = next().split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
    else if (flag === '--from') args.from = next()
    else if (flag === '--to') args.to = next()
    else if (flag === '--out') args.out = next()
    else if (flag === '--benchmark') args.benchmark = next().toUpperCase()
    else if (flag === '--dry') args.dry = true
    else if (flag === '--help' || flag === '-h') {
      process.stdout.write(USAGE)
      process.exit(0)
    } else fail(`未知参数：${flag}`)
  }
  if (args.codes.length === 0) fail('必须给 --codes')
  for (const code of [...args.codes, ...(args.benchmark === 'NONE' ? [] : [args.benchmark])]) {
    if (!/^(SH|SZ|BJ)\d{6}$/.test(code)) fail(`代码形态不对：${code}（要 SH600000 这种内部形态）`)
  }
  if (!isDate(args.from) || !isDate(args.to)) fail('--from / --to 要是 YYYY-MM-DD')
  if (args.from > args.to) fail('--from 晚于 --to')
  return args
}

function fail(message) {
  process.stderr.write(`${message}\n\n${USAGE}`)
  process.exit(2)
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s)

function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

// ─────────────────────────── 取数 ───────────────────────────

/** SH600000 → sh600000。内部形态转腾讯形态只是大小写，但集中在一处便于改 */
const toTencent = (code) => code.toLowerCase()

/** 指数段：SH000xxx / SZ399xxx（与 src/core/code.ts 的 SEGMENTS 一致） */
const isIndex = (code) => /^SH000/.test(code) || /^SZ399/.test(code)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 拉一页。`fq` 为 'hfq'（后复权，见文件头的口径说明）或 ''（不复权）。
 *
 * 返回 `{ rows, name }`。rows 的每项形如 [日期, 开, 收, 高, 低, 量]。
 */
async function fetchPage(code, from, to, fq) {
  const tc = toTencent(code)
  const param = `${tc},day,${from},${to},${PAGE_COUNT},${fq}`
  const url = `${ENDPOINT}?param=${encodeURIComponent(param)}`

  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const block = payload?.data?.[tc]
      // 注意：param 出错时 code 仍是 0，只是 data 为空 —— 不能只看 code
      if (!block) throw new Error(`响应无数据（code=${payload?.code} msg=${payload?.msg ?? ''}）`)
      return { rows: assertKey(code, block, fq, param), name: block?.qt?.[tc]?.[1] ?? null }
    } catch (error) {
      lastError = error
      if (attempt < RETRIES) await sleep(DELAY_MS * attempt * 2)
    }
  }
  throw new Error(`${param}：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * 取出该复权口径对应的数组，并挡住「请求复权、返回不复权」这一类静默降级。
 *
 * 指数没有复权一说，请求 hfq 也返回 `day`（实测），那是对的；
 * 个股上出现同样情况则必须中止 —— 把不复权序列当复权用，除权日会凭空多出金叉死叉，
 * 而报告看上去一切正常。
 */
function assertKey(code, block, fq, param) {
  const wanted = fq === 'hfq' ? 'hfqday' : 'day'
  if (Array.isArray(block[wanted])) return block[wanted]
  if (fq === 'hfq' && isIndex(code) && Array.isArray(block.day)) return block.day
  // 整段都在上市之前时，接口返回空的 `day` 而不是空的 `hfqday`（实测 SZ001296 的 2018 年）。
  // 「这段没数据」与「复权轨被静默降级」是两回事，只有前者可以放过
  if (fq === 'hfq' && Array.isArray(block.day) && block.day.length === 0) return []
  const got = Object.keys(block).filter((k) => Array.isArray(block[k]))
  throw new Error(`${param}：期望 ${wanted}，实际只有 [${got.join(', ')}]`)
}

/** 按年分页拉完整个区间，返回 date → 行 的映射 */
async function fetchTrack(code, from, to, fq, onProgress) {
  const byDate = new Map()
  let name = null
  const firstYear = Number(from.slice(0, 4))
  const lastYear = Number(to.slice(0, 4))

  for (let year = firstYear; year <= lastYear; year++) {
    const pageFrom = year === firstYear ? from : `${year}-01-01`
    const pageTo = year === lastYear ? to : `${year}-12-31`
    const page = await fetchPage(code, pageFrom, pageTo, fq)
    if (page.name) name = page.name
    for (const row of page.rows) {
      if (!Array.isArray(row) || row.length < 6) continue
      const [date] = row
      // 分页边界重叠时后到的覆盖先到的，同一天两页取值一致，覆盖无害
      if (date >= from && date <= to) byDate.set(date, row)
    }
    if (page.rows.length >= 640) {
      // 真撞上上限说明这一年超过 640 根，不可能 —— 除非接口行为变了
      process.stderr.write(`  [warn] ${code} ${year} 年返回 ${page.rows.length} 根，疑似触及单页上限\n`)
    }
    onProgress?.(year, byDate.size)
    await sleep(DELAY_MS)
  }
  return { byDate, name }
}

// ─────────────────────────── 组装与校验 ───────────────────────────

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 两轨合并成 Candle[]。
 *
 * 只有**两轨都有**的日期才产出一根 —— 单边补齐等于凭空编一个复权价。
 * 被丢弃的日期计数后打出来，不静默。
 */
function merge(code, raw, adj, tradingDays, cutoff) {
  const candles = []
  const dropped = { onlyRaw: 0, onlyQfq: 0, malformed: 0, illogical: 0, provisional: 0 }
  const suspicious = { zeroVolume: 0, jump: 0, volumeMismatch: 0 }

  const dates = [...new Set([...raw.keys(), ...adj.keys()])].sort()
  for (const date of dates) {
    // 当天那根是盘中临时 K 线，收盘前一直在变（CLAUDE.md「盘中 K 线是临时的」）。
    // 标定数据集里混一根会变的 K 线，等于让回测结论依赖跑它的时刻。
    if (cutoff && date >= cutoff) { dropped.provisional++; continue }
    const r = raw.get(date)
    const q = adj.get(date)
    if (!r) { dropped.onlyQfq++; continue }
    if (!q) { dropped.onlyRaw++; continue }

    // 列序：日期, 开, 收, 高, 低, 量
    const open = num(r[1]), close = num(r[2]), high = num(r[3]), low = num(r[4])
    const openAdj = num(q[1]), closeAdj = num(q[2]), highAdj = num(q[3]), lowAdj = num(q[4])
    const lots = num(r[5])
    if ([open, close, high, low, openAdj, closeAdj, highAdj, lowAdj, lots].some((v) => v === null)) {
      dropped.malformed++
      continue
    }
    // docs/07 §4：价格逻辑错误丢弃该根并告警
    if (high < low || close > high || close < low || open > high || open < low) {
      dropped.illogical++
      continue
    }
    if (lots === 0) suspicious.zeroVolume++
    const adjLots = num(q[5])
    if (adjLots !== null && lots > 0 && Math.abs(adjLots - lots) / lots > 1e-6) suspicious.volumeMismatch++

    candles.push({
      date,
      open, high, low, close,
      openAdj, highAdj, lowAdj, closeAdj,
      // 腾讯日线的量单位是**手**，×100 转股（src/core/types.ts Candle.volume 的口径）
      volume: Math.round(lots * 100),
      // 腾讯日线只给量不给额。用 0 冒充会读成「零成交额」（CLAUDE.md 约束 4）
      amount: null,
    })
  }

  // docs/07 §4：相邻收盘跳变 > 20% 标记可疑。用**复权**轨判断 ——
  // 除权跳空在这一轨上已被消除，还跳就是真异动或数据错
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].closeAdj
    if (prev > 0 && Math.abs(candles[i].closeAdj / prev - 1) > 0.2) suspicious.jump++
  }
  // 复权价必须恒正。加性前复权在高分红股上会变负（见文件头），后复权不该出现，
  // 出现就说明口径又回到了 qfq —— 这是一个绝不能静默通过的信号
  const nonPositive = candles.filter((c) => c.closeAdj <= 0 || c.lowAdj <= 0).length
  if (nonPositive > 0) {
    throw new Error(
      `${code}：复权价出现 ${nonPositive} 根非正值。后复权不该如此 —— 检查是不是又拉成了加性前复权`
    )
  }

  // has_gap：与前一根之间隔着「基准指数开过市、本股没数据」的日子 = 停牌段。
  // 交易日历用基准指数的日线充当（与 providers/shared.ts calendarFromIndexBars 同一思路）
  if (tradingDays) {
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1].date
      const cur = candles[i].date
      const between = tradingDays.filter((d) => d > prev && d < cur).length
      if (between > 0) candles[i].hasGap = true
    }
  }

  return { code, candles, dropped, suspicious }
}

function summarize(result) {
  const { code, candles, dropped, suspicious } = result
  const span = candles.length > 0 ? `${candles[0].date}..${candles[candles.length - 1].date}` : '空'
  const gaps = candles.filter((c) => c.hasGap).length
  const parts = [`${String(candles.length).padStart(5)} 根  ${span}`]
  const dropTotal = dropped.onlyRaw + dropped.onlyQfq + dropped.malformed + dropped.illogical
  if (dropTotal > 0) {
    parts.push(
      `丢弃 ${dropTotal}（单边 ${dropped.onlyRaw + dropped.onlyQfq} · 残缺 ${dropped.malformed} · 价格矛盾 ${dropped.illogical}）`
    )
  }
  if (dropped.provisional > 0) parts.push(`临时K线 ${dropped.provisional}`)
  if (gaps > 0) parts.push(`停牌段 ${gaps}`)
  const flags = []
  if (suspicious.zeroVolume > 0) flags.push(`零成交 ${suspicious.zeroVolume}`)
  if (suspicious.jump > 0) flags.push(`复权后跳变>20% ${suspicious.jump}`)
  if (suspicious.volumeMismatch > 0) flags.push(`两轨成交量不一致 ${suspicious.volumeMismatch}`)
  if (flags.length > 0) parts.push(`可疑：${flags.join(' · ')}`)
  return `  ${code}  ${parts.join('  |  ')}`
}

// ─────────────────────────── 主流程 ───────────────────────────

async function fetchCode(code, args) {
  process.stdout.write(`[fetch] ${code} …`)
  const raw = await fetchTrack(code, args.from, args.to, '')
  // 指数无复权：复权轨与不复权轨同源，省一半请求
  const adj = isIndex(code) ? raw : await fetchTrack(code, args.from, args.to, 'hfq')
  process.stdout.write(` ${raw.byDate.size} 根\n`)
  return { raw, adj, name: raw.name ?? adj.name ?? null }
}

async function main(argv) {
  const args = parseArgs(argv)
  const fetchedAt = new Date().toISOString()
  /** 当天及之后的 K 线一律不要，见 merge() 里的说明 */
  const cutoff = today()
  const wantBenchmark = args.benchmark !== 'NONE'
  const targets = [...new Set([...args.codes, ...(wantBenchmark ? [args.benchmark] : [])])]

  process.stdout.write(
    `[fetch-history] ${targets.length} 个代码 · ${args.from} → ${args.to} · 源 tencent · 输出 ${args.out}${args.dry ? '（dry run）' : ''}\n`
  )

  // 基准先拉：它同时充当交易日历，后面每只股票标 has_gap 都要用
  let tradingDays = null
  const fetched = new Map()
  for (const code of targets) {
    try {
      const bundle = await fetchCode(code, args)
      fetched.set(code, bundle)
      if (wantBenchmark && code === args.benchmark) {
        tradingDays = [...bundle.raw.byDate.keys()].filter((d) => d < cutoff).sort()
      }
    } catch (error) {
      process.stdout.write('\n')
      process.stderr.write(`  ✗ ${code}：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  if (wantBenchmark && !tradingDays) {
    process.stderr.write(`  [warn] 基准 ${args.benchmark} 未取到，停牌段（has_gap）无法标记\n`)
  }

  if (!args.dry) mkdirSync(args.out, { recursive: true })
  process.stdout.write('\n[结果]\n')

  let written = 0
  for (const [code, bundle] of fetched) {
    const result = merge(code, bundle.raw.byDate, bundle.adj.byDate, tradingDays, cutoff)
    process.stdout.write(`${summarize(result)}\n`)
    if (result.candles.length === 0) {
      process.stderr.write(`  ✗ ${code} 没有可用日线，不写盘\n`)
      continue
    }
    if (args.dry) continue

    writeFileSync(
      join(args.out, `${code}.json`),
      `${JSON.stringify(
        {
          // src/backtest/data.ts 的 openFixtureSource 只读 candles（profile 见文件头注释）
          candles: result.candles,
          _meta: {
            source: 'tencent:web.ifzq.gtimg.cn/appstock/app/fqkline/get',
            fetchedAt,
            // *Adj 是**后复权**而非前复权，理由见 scripts/fetch-history.mjs 文件头。
            // 后复权的历史值不随抓取日变，所以这条序列是可复现的
            adjustment: 'hfq',
            range: { from: args.from, to: args.to },
            nameAtFetch: bundle.name,
            dropped: result.dropped,
            suspicious: result.suspicious,
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    written++
  }

  if (args.dry) {
    process.stdout.write('\ndry run，未写盘。\n')
    return fetched.size === targets.length ? 0 : 1
  }

  process.stdout.write(
    `\n已写入 ${written} 个文件到 ${args.out}。接着跑：\n` +
      `  pnpm backtest -- --codes ${args.codes.join(',')} --fixtures ${args.out} ` +
      `${wantBenchmark ? `--benchmark ${args.benchmark} ` : ''}--from ${args.from} --to ${args.to}\n` +
      `\n先看一眼上面的「可疑」计数再往下走 —— 回测结论的可信度上限由数据质量决定（docs/07 §4）。\n`
  )
  return written === targets.length ? 0 : 1
}

const invokedDirectly = process.argv[1]?.endsWith('fetch-history.mjs') === true
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error) => {
      process.stderr.write(`[fetch-history] 失败：${error instanceof Error ? error.stack : String(error)}\n`)
      process.exitCode = 1
    }
  )
}

export { merge, assertKey, isIndex }
