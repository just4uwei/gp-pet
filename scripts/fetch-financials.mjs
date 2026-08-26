/**
 * 拉**业绩报表**（东财 `datacenter-web` 的 `RPT_LICO_FN_CPD`），供离线因子测量用。
 *
 * ```bash
 * node scripts/fetch-financials.mjs --codes params/universe-broad.json --out data/financials
 * node scripts/fetch-financials.mjs --codes SH600000,SZ000001 --out data/financials
 * ```
 *
 * ## 边界（这个脚本**不是** provider）
 *
 * 与 `fetch:history` / `fetch:liquidity` 同一档：**不进应用、不进降级链、
 * 不占 docs/03 §2.4 那份轮询预算**。它只把数据落成本地 fixture，
 * 供 `scripts/verify/factor-ic.ts` 这类离线测量读。
 *
 * ## 三条口径（改之前先读）
 *
 * 1. **一只票一个请求**：`filter=(SECURITY_CODE="600000")` 一次返回它的**全部报告期**
 *    （实测 `600000` 有 107 期）。按 `REPORTDATE` 抓全市场则是 24 期 × 24 页 = 576 个请求，
 *    **贵一倍还多**，所以按票抓。
 * 2. **`NOTICE_DATE` 必须留着** —— 那是 point-in-time 的唯一入口。
 *    只存 `REPORTDATE` 的话，任何用它的分析都是未来函数，**而且不会报错**。
 *    ⚠ 台账记着：**2000 年以前的 `NOTICE_DATE` 是回填的**（`600000` 的 1996 与 1997
 *    两期都写 1999-11-06）⇒ 本项目从 2018 起，够用，但别拿它做更早的研究。
 * 3. **逐只落盘**，不是全拉完再统一写 —— `fetch:history` 那次被拦掉 98 只的教训
 *    （台账 §1）。已有文件默认跳过，`--force` 才重拉。
 *
 * ## 限速
 *
 * 台账记着东财的限流是**按整族 host** 生效的、换门救不了，所以这里并发 1 +
 * 每次请求之间固定间隔。261 只大约 4~5 分钟，慢是刻意的。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'undici'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] ?? fallback : fallback
}
const OUT = argOf('--out', 'data/financials')
const FORCE = args.includes('--force')
/** 请求间隔（毫秒）。别调小 —— 东财按整族 host 限流，被拦之后十几分钟不恢复 */
const GAP_MS = Number(argOf('--gap', '900'))

function codesOf(spec) {
  if (spec.endsWith('.json')) {
    const raw = JSON.parse(readFileSync(spec, 'utf8'))
    return Array.isArray(raw) ? raw : raw.codes
  }
  return spec.split(',').filter(Boolean)
}

/** `SH600000` → `600000`。东财这个端点只认 6 位数字 */
const bare = (code) => code.replace(/^(SH|SZ|BJ)/i, '')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchOne(code) {
  const filter = encodeURIComponent(`(SECURITY_CODE="${bare(code)}")`)
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    `?reportName=RPT_LICO_FN_CPD&columns=ALL&pageSize=500&pageNumber=1` +
    `&sortColumns=REPORTDATE&sortTypes=-1&filter=${filter}`
  const res = await request(url, {
    headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    headersTimeout: 20_000,
    bodyTimeout: 20_000,
  })
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`)
  const json = await res.body.json()
  if (json.success !== true) throw new Error(`success=${json.success}`)
  const rows = json.result?.data ?? []
  /*
    只留需要的列。**留 NOTICE_DATE**（PIT 的唯一入口）与 TRADE_MARKET / SECURITY_TYPE
    （台账限制 2：那个端点里混着非 A 股，不筛就会把它们算进横截面）。
    ⚠ 缺值一律留 null，不补 0 —— 「这期没披露 ROE」与「ROE 是 0」是两回事（约束 4）。
  */
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const day = (v) => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null)
  return rows
    .map((r) => ({
      reportDate: day(r.REPORTDATE),
      noticeDate: day(r.NOTICE_DATE),
      basicEps: num(r.BASIC_EPS),
      bps: num(r.BPS),
      roe: num(r.WEIGHTAVG_ROE),
      revYoy: num(r.YSTZ),
      profitYoy: num(r.SJLTZ),
      market: r.TRADE_MARKET ?? null,
      securityType: r.SECURITY_TYPE ?? null,
    }))
    .filter((r) => r.reportDate !== null)
    .sort((a, b) => (a.reportDate < b.reportDate ? -1 : 1))
}

async function main() {
  const codes = codesOf(argOf('--codes', 'params/universe-broad.json'))
  mkdirSync(OUT, { recursive: true })
  let ok = 0
  let skipped = 0
  const failed = []
  for (const [i, code] of codes.entries()) {
    const file = join(OUT, `${code}.json`)
    if (!FORCE && existsSync(file)) {
      skipped++
      continue
    }
    try {
      const periods = await fetchOne(code)
      // 逐只落盘：被限流那一刻之前抓到的必须留下来（fetch:history 的教训）
      writeFileSync(file, JSON.stringify({ code, periods }, null, 0))
      ok++
      if (ok % 20 === 0) console.log(`  … ${i + 1}/${codes.length}（成功 ${ok}）`)
    } catch (err) {
      failed.push(`${code}: ${String(err).slice(0, 60)}`)
    }
    await sleep(GAP_MS)
  }
  console.log(`\n成功 ${ok} · 已有跳过 ${skipped} · 失败 ${failed.length}`)
  if (failed.length > 0) {
    console.log('失败清单（**要点名，别静默少几只**）：')
    for (const f of failed.slice(0, 30)) console.log('  ·', f)
    if (failed.length > 30) console.log(`  … 还有 ${failed.length - 30} 只`)
  }
}

await main()
