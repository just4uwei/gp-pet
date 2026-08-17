#!/usr/bin/env node
/**
 * 生成「窗口内退市」的标的清单 → `params/universe-delisted.json`。
 *
 * ```bash
 * node scripts/build-delisted.mjs                 # 用缓存，抽 19 只
 * node scripts/build-delisted.mjs --take 40       # 抽更多
 * node scripts/build-delisted.mjs --refresh       # 忽略缓存，重探 348 只
 * ```
 *
 * ## 为什么有这个脚本
 *
 * [build-universe.mjs](./build-universe.mjs) 的文件头与 `params/universe-broad.json`
 * 的 `knownBias` 字段都写着一句话：
 *
 * > 幸存者偏差无法消除：已退市股票在**任何免费行情接口上都取不到日线**，必然缺席。
 *
 * **这句话是错的**（2026-08-17 实测推翻）。腾讯 `fqkline` 有退市股的完整日线，
 * 一直延伸到各自的退市日，两轨（不复权 + 后复权）都在，格式与现有 fixture 逐字段一致 ——
 * `fetch-history.mjs` 一个字都不用改就能拉。四只已知案例：
 *
 * | 代码 | 名称 | 区间 |
 * |---|---|---|
 * | SZ300104 | 乐视退 | 2018-01-24 .. 2020-07-20 |
 * | SZ000979 | 中弘退 | 2018-02-14 .. 2018-12-27 |
 * | SH600074 | 退市保千 | 2018-01-02 .. 2020-05-26 |
 * | SZ002450 | 康得退 | 2018-01-02 .. 2019-07-05 |
 *
 * 于是幸存者偏差从「消不掉、只能在报告里写明」变成「补得上」。
 * 这是当前所有回测结论的乐观来源里唯一一个可以直接修掉的。
 *
 * ## 清单怎么来（三条实测形状）
 *
 * 1. **退市代码表不需要新数据源** —— 巨潮的 `szse_stock.json`（`fetch-announcements.mjs`
 *    已经在用它取 orgId）实测 **6234 只**，沪深两市都在里面，**且含退市股**，
 *    名称就是退市后的名称（「乐视退」「退市保千」）。按现有三层代码段过滤是 **4942 只**。
 * 2. **候选 = 巨潮 ∖ 新浪**。新浪 `hs_a` 是「今天在交易」的清单（build-universe.mjs 用它），
 *    三层内 **4594 只**。差集 **348 只**，其中 274 只名称含「退」或 ST —— 但差集里混着两类
 *    不是我们要的：**2002 年前退市的**（`PT金田A` / `PT中浩A`，PT 是 1999–2001 年的制度）
 *    与**改名/重组导致代码变更的**（`深赤湾A` → 招商港口、`招商地产`、`中航善达` → 招商积余）。
 *    这两类都要靠下一步筛掉，**不能只看名称里有没有「退」字**。
 * 3. **一个请求就能同时定「有没有数据」和「退市日」**：腾讯「单次返回从 `to` 往回数的
 *    最后 N 根」这个特性（见 fetch-history.mjs 文件头实测第 1 条），拿
 *    `2018-01-01 → 今天, count=300` 去问，返回的末根就是该票的最后一个交易日。
 *    348 只逐只探一次约 3 分钟，远低于被腾讯 501 拦的阈值（实测约 1800 请求）。
 *
 * **2026-08-17 实测**：348 候选 → **240 只**有 2018 后数据 → **236 只**末根早于 `LAST_BAR_CUTOFF`
 * （沪 97 / 深 100 / 创 39）。按退市年份：2018:8 · 2019:10 · 2020:18 · 2021:19 ·
 * 2022:42 · 2023:46 · 2024:49 · 2025:30 · 2026:14 —— 逐年上升，与 2020 年退市新规后
 * 退市加速的事实一致，是这份清单可信的一个旁证。
 *
 * 剩下 4 只（`国华退` `恒久退` `赛隆退` `天龙退`）末根就在近期，说明还在退市整理期 ——
 * **它们的数据还没结束**，这一轮不取，否则「退市日」会取到一个还会往后长的日期。
 *
 * ## 抽多少只：19，不是 348
 *
 * 判据是**真实占比**，不是「能拿到多少就放多少」。2018-01-01 时点三层内约 **3530 只**
 * （4594 今存 − 约 1300 只 2018 后新上市 + 236 只窗口内退市），所以退市股的真实占比是
 * **236 / 3530 ≈ 6.7%**。旧池 261 只要维持这个比例需要补 `x / (261 + x) = 6.7%` ⇒ **x ≈ 19**。
 *
 * **过采样是有代价的**：把 236 只全放进去，池子变成 497 只、退市股占 47%，
 * 整体绩效就再也不能当「全市场代表值」读了（它会系统性偏低，而偏多少取决于抽样而非市场）。
 * 要单独研究退市股上的引擎行为是另一个问题，那时该用全部 236 只并**单独报**，
 * 不要混进主池的绩效数字里。
 *
 * ## 这个脚本产出的 `delistedAt` 是给回测用的
 *
 * `src/backtest/simulate.ts` 在退市日强制平仓并记一笔 `trade` —— 不记的话那笔亏损
 * 只进净值、不进 `trades`，而**建仓级胜率与 `audit:random` 的配对 alpha 都只读 `trades`**
 * （`groupPositions()` 在 metrics.ts 与 random-audit.ts 各有一份，都按 `code@entryDate` 分组）。
 * 于是退市股会变成「贡献了净值上的亏损，却不进入胜率与 alpha 统计」—— 那正好是
 * 幸存者偏差在统计口径上的第二重体现，补了池子不补这里等于只修了一半。
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const CNINFO_URL = 'http://www.cninfo.com.cn/new/data/szse_stock.json'
const SINA_URL =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'

/** 与 fetch-history.mjs 同源的三个门：换门不换源，被 501 拦下时前移 */
const ENDPOINTS = [
  'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://ifzq.gtimg.cn/appstock/app/fqkline/get',
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get',
]
let endpointIndex = 0

/**
 * 末根早于这个日期才算「已经退完了」。
 *
 * 退市整理期的票末根就在近期，它们的序列**还会往后长** —— 现在取到的「退市日」
 * 过几周就不对了，而 fixture 里那个日期不会自己更新。宁可这一轮不取。
 */
const LAST_BAR_CUTOFF = '2026-07-01'

/** 探测起点：与 docs/07 §3 的训练集起点一致 */
const PROBE_FROM = '2018-01-01'
/** 单次回看根数。300 够覆盖「2018 年后只交易过一小段」的票 */
const PROBE_COUNT = 300
const DELAY_MS = 220
const PROBE_CACHE = join('data', 'delisted-probe.json')
const OUT = join('params', 'universe-delisted.json')

/** 分层定义与 build-universe.mjs 的 STRATA 同源（改一处要改两处） */
const STRATA = [
  { name: '沪主板', market: 'SH', prefixes: ['600', '601', '603', '605'] },
  { name: '深主板', market: 'SZ', prefixes: ['000', '001', '002', '003'] },
  { name: '创业板', market: 'SZ', prefixes: ['300', '301'] },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stratumOf = (digits) => STRATA.find((s) => s.prefixes.some((p) => digits.startsWith(p))) ?? null

function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 等距抽样：K 个点均匀铺在 0..n-1 上，两端都取到（与 build-universe.mjs 逐字相同） */
function evenlySpaced(items, take) {
  if (items.length <= take) return [...items]
  if (take <= 1) return items.length > 0 ? [items[0]] : []
  const out = []
  for (let k = 0; k < take; k++) out.push(items[Math.round((k * (items.length - 1)) / (take - 1))])
  return [...new Set(out)]
}

// ─────────────────────────── 取全集 ───────────────────────────

/** 巨潮：历史收录（含退市），六位代码 → 中文简称 */
async function fetchCninfo() {
  const res = await fetch(CNINFO_URL, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`巨潮 HTTP ${res.status}`)
  const json = await res.json()
  const map = new Map()
  for (const s of json.stockList ?? []) {
    const digits = String(s.code ?? '')
    if (digits.length === 6 && stratumOf(digits)) map.set(digits, String(s.zwjc ?? ''))
  }
  return map
}

/** 新浪：今天在交易的六位代码集合 */
async function fetchSinaLive() {
  const live = new Set()
  for (let page = 1; ; page++) {
    const url = `${SINA_URL}?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`新浪 第 ${page} 页 HTTP ${res.status}`)
    const text = await res.text()
    if (text.trim() === 'null' || text.trim() === '') break
    const rows = JSON.parse(text)
    if (rows.length === 0) break
    for (const row of rows) {
      const m = /^(sh|sz)(\d{6})$/.exec(String(row.symbol ?? ''))
      if (m && stratumOf(m[2])) live.add(m[2])
    }
    if (rows.length < 100) break
    await sleep(150)
  }
  return live
}

// ─────────────────────────── 逐只探末根 ───────────────────────────

/**
 * 探一只的最后一个交易日。返回 `{bars, first, last}`，无数据时 null。
 *
 * 只拉不复权轨（判「有没有数据」与「末根是哪天」不需要复权），一只一个请求。
 */
async function probeLastBar(code) {
  const tc = code.toLowerCase()
  const param = `${tc},day,${PROBE_FROM},${today()},${PROBE_COUNT},`
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${ENDPOINTS[endpointIndex]}?param=${encodeURIComponent(param)}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      })
      // 501 = 本机被这个门拦了（不是「这只没数据」），换门重来且不算掉重试机会
      if (res.status === 501 && endpointIndex + 1 < ENDPOINTS.length) {
        endpointIndex++
        process.stderr.write(`  [warn] HTTP 501（被拦），换门 → ${ENDPOINTS[endpointIndex]}\n`)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const rows = json?.data?.[tc]?.day ?? []
      if (!Array.isArray(rows) || rows.length === 0) return null
      return { bars: rows.length, first: rows[0][0], last: rows[rows.length - 1][0] }
    } catch {
      await sleep(400 * (attempt + 1))
    }
  }
  return null
}

async function probeAll(candidates, names) {
  const out = []
  for (let i = 0; i < candidates.length; i++) {
    const digits = candidates[i]
    const stratum = stratumOf(digits)
    const code = `${stratum.market}${digits}`
    const hit = await probeLastBar(code)
    if (hit) out.push({ code, name: names.get(digits) ?? '', stratum: stratum.name, ...hit })
    if ((i + 1) % 50 === 0) {
      process.stdout.write(`  ${i + 1}/${candidates.length} 已探，有数据 ${out.length}\n`)
    }
    await sleep(DELAY_MS)
  }
  return out
}

// ─────────────────────────── 主流程 ───────────────────────────

function parseArgs(argv) {
  const args = { take: 19, refresh: false, out: OUT }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--take') {
      const parsed = Number(argv[++i])
      if (!Number.isInteger(parsed) || parsed <= 0) {
        process.stderr.write('--take 要是正整数\n')
        process.exit(2)
      }
      args.take = parsed
    } else if (flag === '--out') {
      const value = argv[++i]
      if (!value) {
        process.stderr.write('--out 缺少取值\n')
        process.exit(2)
      }
      args.out = value
    } else if (flag === '--refresh') args.refresh = true
    else if (flag === '--') continue
    else {
      process.stderr.write(`未知参数：${flag}\n`)
      process.exit(2)
    }
  }
  return args
}

async function main(argv) {
  const args = parseArgs(argv)

  let probed
  if (!args.refresh && existsSync(PROBE_CACHE)) {
    const cache = JSON.parse(readFileSync(PROBE_CACHE, 'utf8'))
    probed = cache.withData ?? []
    process.stdout.write(`[delisted] 用缓存 ${PROBE_CACHE}（探于 ${cache.probedAt}，${probed.length} 只有数据）\n`)
  } else {
    process.stdout.write('[delisted] 拉巨潮历史收录清单…\n')
    const names = await fetchCninfo()
    process.stdout.write(`  巨潮 三层内 ${names.size} 只\n`)
    process.stdout.write('[delisted] 拉新浪今日在交易清单…\n')
    const live = await fetchSinaLive()
    process.stdout.write(`  新浪 三层内 ${live.size} 只\n`)

    const candidates = [...names.keys()].filter((d) => !live.has(d)).sort()
    process.stdout.write(`[delisted] 候选 ${candidates.length} 只，逐只探末根（约 ${Math.ceil(candidates.length * 0.6 / 60)} 分钟）…\n`)
    probed = await probeAll(candidates, names)
    mkdirSync(dirname(resolve(PROBE_CACHE)), { recursive: true })
    writeFileSync(
      PROBE_CACHE,
      `${JSON.stringify({ probedAt: today(), candidates: candidates.length, withData: probed }, null, 1)}\n`,
      'utf8'
    )
    process.stdout.write(`  已缓存 → ${PROBE_CACHE}\n`)
  }

  // 末根还在近期的是退市整理期，序列还会往后长 —— 这一轮不取（见 LAST_BAR_CUTOFF）
  const settled = probed.filter((p) => p.last < LAST_BAR_CUTOFF)
  const inProgress = probed.length - settled.length
  process.stdout.write(
    `\n[delisted] 有数据 ${probed.length} 只 → 已退完 ${settled.length} 只` +
      (inProgress > 0 ? `（另 ${inProgress} 只仍在退市整理期，本轮不取）` : '') +
      '\n'
  )

  const byYear = {}
  for (const p of settled) byYear[p.last.slice(0, 4)] = (byYear[p.last.slice(0, 4)] ?? 0) + 1
  process.stdout.write(
    `  按退市年份：${Object.entries(byYear).sort().map(([y, n]) => `${y}:${n}`).join(' · ')}\n`
  )

  // 分层等距抽样：层内配额按各层在 settled 里的占比分，余数给最大的层
  const buckets = STRATA.map((s) => ({
    name: s.name,
    pool: settled.filter((p) => p.stratum === s.name).sort((a, b) => a.code.localeCompare(b.code)),
  }))
  const total = settled.length
  const quotas = buckets.map((b) => Math.round((b.pool.length / total) * args.take))
  // 四舍五入会差一两只，补到样本最多的那层上
  let drift = args.take - quotas.reduce((a, b) => a + b, 0)
  while (drift !== 0) {
    const idx = quotas.indexOf(drift > 0 ? Math.max(...quotas) : Math.min(...quotas.filter((q) => q > 0)))
    quotas[idx] += drift > 0 ? 1 : -1
    drift += drift > 0 ? -1 : 1
  }

  const picked = []
  const strata = []
  buckets.forEach((bucket, i) => {
    const chosen = evenlySpaced(bucket.pool, quotas[i])
    strata.push({ name: bucket.name, poolSize: bucket.pool.length, take: chosen.length })
    picked.push(...chosen)
    process.stdout.write(
      `  ${bucket.name.padEnd(4)} 已退完 ${String(bucket.pool.length).padStart(3)} 只 → 抽 ${chosen.length} 只：` +
        `${chosen.map((c) => `${c.code}(${c.name} ${c.last})`).join(' ')}\n`
    )
  })

  mkdirSync(dirname(resolve(args.out)), { recursive: true })
  writeFileSync(
    args.out,
    `${JSON.stringify(
      {
        rule:
          '巨潮历史收录清单 ∖ 新浪今日在交易清单 → 逐只探腾讯日线末根 → 保留末根早于 ' +
          `${LAST_BAR_CUTOFF} 的（已退完）→ 分层等距抽样。不按行业/市值/退市原因筛（那都会引入选择偏差）。`,
        why:
          '修幸存者偏差。旧的 params/universe-broad.json 只含今天仍在交易的股票，' +
          '而「已退市股票在免费接口上取不到日线」这个论断 2026-08-17 已被实测推翻（腾讯有完整日线）。',
        ratioNote:
          `真实占比 ≈ ${settled.length} / 约3530（2018-01-01 时点三层内股票数）≈ ` +
          `${((settled.length / 3530) * 100).toFixed(1)}%；本文件按该比例抽样，刻意不过采样 —— ` +
          '把全部退市股放进主池会让整体绩效偏低且偏多少取决于抽样，不能再当全市场代表值读。',
        source: { list: 'cninfo:szse_stock.json ∖ sina:hs_a', bars: 'tencent:fqkline' },
        probedAt: today(),
        settledPool: settled.length,
        strata,
        codes: picked.map((p) => p.code),
        /** 回测用：退市日 = 该票最后一个交易日。src/backtest/simulate.ts 在这一天强制平仓 */
        delistedAt: Object.fromEntries(picked.map((p) => [p.code, p.last])),
        names: Object.fromEntries(picked.map((p) => [p.code, p.name])),
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  // 不给 --benchmark：默认的 SH000300 同时充当交易日历，`has_gap`（停牌段）靠它标。
  // 给 none 会让每一段停牌都标不出来，而退市股恰恰停牌频繁 —— 缺口段本该跳过成交
  process.stdout.write(
    `\n共 ${picked.length} 只，已写入 ${args.out}。接着跑：\n` +
      `  node scripts/fetch-history.mjs --codes <上面那批> --from ${PROBE_FROM}\n` +
      `\n然后做「含退市 vs 不含退市」的对照跑（差值 = 幸存者偏差的量化值）：\n` +
      `  pnpm backtest -- --codes <universe-broad 的 codes> --fixtures data/history --from ${PROBE_FROM} --to <末日> --out reports/pit-A-old.json\n` +
      `  pnpm backtest -- --codes <两个池子的 codes 合并> --fixtures data/history --from ${PROBE_FROM} --to <末日> --delisted ${args.out} --out reports/pit-B-new.json\n`
  )
  return 0
}

const invokedDirectly = process.argv[1]?.endsWith('build-delisted.mjs') === true
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`[delisted] 失败：${error instanceof Error ? error.stack : String(error)}\n`)
      process.exitCode = 1
    }
  )
}

export { evenlySpaced, stratumOf, LAST_BAR_CUTOFF }
