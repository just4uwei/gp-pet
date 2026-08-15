#!/usr/bin/env node
/**
 * 生成标定用的宽基标的池 → `params/universe-broad.json`。
 *
 * ```bash
 * pnpm build:universe                  # 用默认规则重出
 * pnpm build:universe -- --per 15,15,10
 * ```
 *
 * **为什么要有这个脚本**：[docs/07 §3](../docs/07-回测与验证方案.md) 的标定要一个
 * 事先定死、且**选取规则可复核**的标的池。手挑几十只「有名的股票」看着合理，
 * 实则是最强的前视偏差 —— 今天有名，是因为它过去八年涨得好。
 *
 * ## 规则（改规则就要重出文件并在 CHANGELOG 记一笔）
 *
 * 1. **全集**来自新浪 `Market_Center.getHQNodeData?node=hs_a`，按 symbol 升序翻页。
 *    用它只为拿「代码是否存在」，不用它的任何行情或排名字段。
 * 2. **分层**按代码段（与 `src/core/code.ts` 的 SEGMENTS 同源）：
 *    沪主板 600/601/603/605 · 深主板 000/001/002/003 · 创业板 300/301。
 * 3. **层内等距抽样**：按代码升序排列后取第 `round(k × (n-1) / (K-1))` 个，k = 0..K-1。
 *    等距而非随机 —— 随机要存种子才能复现，等距只要规则。
 * 4. **不含科创板**：688 段 2019-07 才开市，拿不到 2018 年的训练集数据。
 * 5. **不按市值、不按流动性、不排除 ST 排样本**。这三样都是**今天**的属性，
 *    用它们筛 2018 年的样本就是前视偏差。代价是样本里会混进一些小票和 ST，
 *    那是真实的 —— 2018 年谁也不知道哪只会变成 ST。
 *
 * ## 消不掉的那个偏差
 *
 * **幸存者偏差**：已退市的股票在任何免费行情接口上都取不到日线，因此不可能进样本。
 * 这一条无法用换规则解决，只能在报告里写明。
 * 后果方向是明确的：**绩效被系统性高估**。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const LIST_API =
  'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PAGE_SIZE = 100
const DELAY_MS = 200
const RETRIES = 3

/**
 * 分层定义。顺序即输出顺序。
 *
 * **`take` 于 2026-08-14 从 15/15/10（40 只）提到 98/86/80（264 只）**，判据是
 * [docs/09 §2.2 B0](../docs/09-下一阶段开发计划.md)：40 只切成 4 × 3 = 12 折时，
 * 全项目最一致的候选（`risk.drawdownReducePct`，四个口径同向改善）t 只有 0.77,
 * 需要约 82 折 ≈ 264 只才够格。**不扩池，后面每一批标定的结论都只会是「测不出差别」。**
 *
 * 三层的比例按全市场分层规模取（沪主板 1699 / 深主板 1494 / 创业板 1401
 * ⇒ 37.0% / 32.5% / 30.5%），而不是沿用旧的 37.5/37.5/25 ——
 * docs/09 的验收条件是「分层比例与全市场大致同构」，98/86/80 是 37.1/32.6/30.3。
 * 264 是**下界**不是充分量：横截面折之间不独立（A 股同涨同跌），√n 收敛只在独立样本下成立。
 */
const STRATA = [
  { name: '沪主板', market: 'SH', prefixes: ['600', '601', '603', '605'], take: 98 },
  { name: '深主板', market: 'SZ', prefixes: ['000', '001', '002', '003'], take: 86 },
  { name: '创业板', market: 'SZ', prefixes: ['300', '301'], take: 80 },
]

const OUT = join('params', 'universe-broad.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchPage(page) {
  const url = `${LIST_API}?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=hs_a`
  let lastError
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
        signal: AbortSignal.timeout(20_000),
      })
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.trim() === 'null' || text.trim() === '') return []
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      if (attempt < RETRIES) await sleep(DELAY_MS * attempt * 2)
    }
  }
  throw new Error(`第 ${page} 页：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/** sina 的 symbol 是 `sh600000` / `sz000001` / `bj920000` → 内部形态 */
function toInternal(symbol) {
  const match = /^(sh|sz|bj)(\d{6})$/.exec(symbol)
  return match ? `${match[1].toUpperCase()}${match[2]}` : null
}

function stratumOf(code) {
  const market = code.slice(0, 2)
  const digits = code.slice(2)
  return STRATA.find((s) => s.market === market && s.prefixes.some((p) => digits.startsWith(p))) ?? null
}

/** 等距抽样：K 个点均匀铺在 0..n-1 上，两端都取到 */
function evenlySpaced(items, take) {
  if (items.length <= take) return [...items]
  if (take <= 1) return items.length > 0 ? [items[0]] : []
  const out = []
  for (let k = 0; k < take; k++) {
    out.push(items[Math.round((k * (items.length - 1)) / (take - 1))])
  }
  return [...new Set(out)]
}

function parseArgs(argv) {
  const args = { per: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--per') {
      const parts = String(argv[++i]).split(',').map((n) => Number(n))
      if (parts.length !== STRATA.length || parts.some((n) => !Number.isInteger(n) || n <= 0)) {
        process.stderr.write(`--per 要给 ${STRATA.length} 个正整数（对应 ${STRATA.map((s) => s.name).join(' / ')}）\n`)
        process.exit(2)
      }
      args.per = parts
    } else if (argv[i] === '--') continue
    else {
      process.stderr.write(`未知参数：${argv[i]}\n`)
      process.exit(2)
    }
  }
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.per) STRATA.forEach((s, i) => { s.take = args.per[i] })

  process.stdout.write('[universe] 拉取沪深 A 股全集（新浪）…\n')
  const all = []
  for (let page = 1; ; page++) {
    const rows = await fetchPage(page)
    if (rows.length === 0) break
    for (const row of rows) {
      const code = toInternal(String(row.symbol ?? ''))
      if (code) all.push({ code, name: String(row.name ?? '') })
    }
    if (page % 10 === 0) process.stdout.write(`  第 ${page} 页，累计 ${all.length} 只\n`)
    if (rows.length < PAGE_SIZE) break
    await sleep(DELAY_MS)
  }
  process.stdout.write(`[universe] 全集 ${all.length} 只\n\n`)

  const buckets = new Map(STRATA.map((s) => [s.name, []]))
  for (const item of all) {
    const stratum = stratumOf(item.code)
    if (stratum) buckets.get(stratum.name).push(item)
  }

  const strata = []
  const codes = []
  for (const stratum of STRATA) {
    const pool = buckets.get(stratum.name).sort((a, b) => a.code.localeCompare(b.code))
    const picked = evenlySpaced(pool, stratum.take)
    strata.push({
      name: stratum.name,
      prefixes: stratum.prefixes,
      poolSize: pool.length,
      take: stratum.take,
      codes: picked.map((p) => p.code),
    })
    codes.push(...picked.map((p) => p.code))
    process.stdout.write(
      `  ${stratum.name.padEnd(4)} 全集 ${String(pool.length).padStart(4)} 只 → 抽 ${picked.length} 只：` +
        `${picked.map((p) => `${p.code}(${p.name})`).join(' ')}\n`
    )
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        rule: '按代码段分层 + 层内按代码升序等距抽样；不按市值/流动性/ST 筛选（那都是今天的属性，会引入前视偏差）；不含科创板（2019-07 才开市）',
        knownBias: '幸存者偏差无法消除：已退市股票在免费接口上取不到日线，必然缺席。方向是绩效被系统性高估。',
        source: 'sina:Market_Center.getHQNodeData?node=hs_a',
        universeSize: all.length,
        strata,
        codes,
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  process.stdout.write(
    `\n共 ${codes.length} 只，已写入 ${OUT}。接着跑：\n` +
      `  pnpm fetch:history -- --codes $(node -p "require('./${OUT.replace(/\\/g, '/')}').codes.join(',')") --from 2018-01-01\n`
  )
  return 0
}

const invokedDirectly = process.argv[1]?.endsWith('build-universe.mjs') === true
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error) => {
      process.stderr.write(`[universe] 失败：${error instanceof Error ? error.stack : String(error)}\n`)
      process.exitCode = 1
    }
  )
}
