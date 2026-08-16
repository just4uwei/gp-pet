/**
 * 公告源可达性探针（docs/11 N0）。
 *
 * **为什么要有这个脚本，而不是 curl 一下**：CLAUDE.md 记着一条实测教训 ——
 * 同一个 eastmoney 接口，curl 100% 失败而 undici（应用真正用的客户端）成功率约 78%。
 * 用 curl 的结果判断可用性会得到相反的结论。所以这里走 `node:fetch`（undici），
 * 与 `src/main/net/http.ts` 的传输层同一族。
 *
 * **它不是一次性的**：N0-b 要求覆盖盘前 / 盘中 / 盘后 / 休市日四个时段、连续 ≥ 3 个交易日。
 * 所以每次跑都往同一份 JSONL 里追加一行，最后一起统计。
 *
 *   node scripts/probe-announcements.mjs                 # 跑一轮，追加到 data/probe/announcements.jsonl
 *   node scripts/probe-announcements.mjs --shape         # 额外跑一次「形状探测」（上限 / 分页 / 时间字段）
 *   node scripts/probe-announcements.mjs --report        # 只统计已有样本，不发请求
 *
 * **不落进仓库的数据目录**：`data/` 已在 .gitignore 里。
 */

import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const OUT = resolve('data/probe/announcements.jsonl')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 与 docs/11 §4.2 实测过的两个源。cninfo 是 POST，eastmoney 是 GET */
const EASTMONEY = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
const CNINFO = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'

const args = new Set(process.argv.slice(2))

/** 六位数字，东财那个接口不要市场前缀 */
function digitsOf(code) {
  return code.replace(/^(SH|SZ|BJ)/i, '')
}

async function timed(label, fn) {
  const t0 = Date.now()
  try {
    const value = await fn()
    return { label, ok: true, ms: Date.now() - t0, value }
  } catch (error) {
    return { label, ok: false, ms: Date.now() - t0, error: String(error?.message ?? error) }
  }
}

async function eastmoney(codes, { pageSize = 50, pageIndex = 1 } = {}) {
  const url =
    `${EASTMONEY}?page_size=${pageSize}&page_index=${pageIndex}&ann_type=A&client_source=web` +
    `&stock_list=${codes.map(digitsOf).join(',')}`
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json?.data ?? null
}

async function cninfo({ pageSize = 30 } = {}) {
  const body = new URLSearchParams({
    pageNum: '1',
    pageSize: String(pageSize),
    column: 'szse',
    tabName: 'fulltext',
    stock: '',
    searchkey: '',
    seDate: '',
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  })
  const res = await fetch(CNINFO, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

/**
 * N0-c：`stock_list` 到底能塞几只 —— 决定 100 只自选要拆几次请求。
 *
 * 自选通常只有几只，测不出上限，所以这里借 `params/universe-broad.json` 的 264 只
 * 分层抽样池当「够多的真代码」。**只用来探接口形状，与标定无关。**
 */
async function probeShape(codes) {
  console.log('\n── 形状探测（N0-c）────────────────────────────')

  let bulk = codes
  try {
    const pool = JSON.parse(readFileSync(resolve('params/universe-broad.json'), 'utf-8'))
    if (Array.isArray(pool?.codes) && pool.codes.length > 100) {
      bulk = pool.codes
      console.log(`  （上限探测借用 params/universe-broad.json 的 ${bulk.length} 只）`)
    }
  } catch {
    console.log('  （没读到 universe-broad.json，上限探测只能用自选）')
  }

  for (const n of [1, 4, 10, 20, 40, 60, 100, 200]) {
    if (bulk.length < n) {
      console.log(`  stock_list=${n} 只：跳过（只有 ${bulk.length} 只可用）`)
      continue
    }
    const slice = bulk.slice(0, n)
    const r = await timed(`n=${n}`, () => eastmoney(slice, { pageSize: 100 }))
    if (!r.ok) {
      console.log(`  stock_list=${n} 只：失败 ${r.error}（${r.ms}ms）`)
      continue
    }
    const list = r.value?.list ?? []
    const got = new Set(list.flatMap((x) => (x.codes ?? []).map((c) => c.stock_code)))
    const asked = new Set(slice.map(digitsOf))
    // **关键判据**：返回里有没有「没点过名的票」—— 有就说明 stock_list 被忽略了，
    // 那会让公告清单混进一堆与用户无关的公司，而界面上完全看不出来
    const stray = [...got].filter((c) => !asked.has(c))
    console.log(
      `  stock_list=${n} 只：${r.ms}ms · 返回 ${list.length} 条 · 覆盖 ${got.size} 只` +
        ` · total_hits=${r.value?.total_hits ?? '—'}` +
        (stray.length > 0 ? ` · ⚠ 混入未点名 ${stray.length} 只：${stray.slice(0, 5).join(',')}` : ' · 无混入')
    )
    await new Promise((r) => setTimeout(r, 400))
  }

  // 分页语义
  const p1 = await timed('page1', () => eastmoney(codes.slice(0, 4), { pageSize: 5, pageIndex: 1 }))
  const p2 = await timed('page2', () => eastmoney(codes.slice(0, 4), { pageSize: 5, pageIndex: 2 }))
  if (p1.ok && p2.ok) {
    const ids1 = (p1.value.list ?? []).map((x) => x.art_code)
    const ids2 = (p2.value.list ?? []).map((x) => x.art_code)
    const overlap = ids1.filter((id) => ids2.includes(id)).length
    console.log(`  分页：page1=${ids1.length} 条 page2=${ids2.length} 条 重叠 ${overlap} 条`)
  }

  // 时间字段语义：notice_date vs display_time 差几天
  const r = await timed('time', () => eastmoney(codes.slice(0, 8), { pageSize: 20 }))
  if (r.ok) {
    console.log('  时间字段样本（display_time → notice_date）：')
    for (const item of (r.value.list ?? []).slice(0, 6)) {
      console.log(`    ${item.display_time}  →  ${item.notice_date}   ${String(item.title).slice(0, 28)}`)
    }
  }
}

/** N0-d：随机抽几条，人工核对原文用 */
async function probeTruth(codes) {
  console.log('\n── 真实性抽样（N0-d，需人工点开核对）──────────')
  const r = await timed('truth', () => eastmoney(codes, { pageSize: 5 }))
  if (!r.ok) return console.log(`  失败：${r.error}`)
  for (const item of (r.value.list ?? []).slice(0, 5)) {
    const code = item.codes?.[0]?.stock_code ?? '?'
    const name = item.codes?.[0]?.short_name ?? '?'
    console.log(`  ${code} ${name} ${item.notice_date}`)
    console.log(`    ${item.title}`)
    console.log(`    https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html`)
  }
}

/** N0-a/b：一轮成功率与延迟样本 */
async function probeHealth(codes) {
  const rounds = 8
  const em = []
  const cn = []
  for (let i = 0; i < rounds; i++) {
    em.push(await timed('em', () => eastmoney(codes.slice(0, 10), { pageSize: 20 })))
    cn.push(await timed('cn', () => cninfo({ pageSize: 10 })))
    await new Promise((r) => setTimeout(r, 500))
  }
  return { em, cn }
}

function summarize(rows, label) {
  const ok = rows.filter((r) => r.ok)
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b)
  const p = (q) => (lat.length === 0 ? '—' : `${lat[Math.min(lat.length - 1, Math.floor(lat.length * q))]}ms`)
  const errs = [...new Set(rows.filter((r) => !r.ok).map((r) => r.error))]
  console.log(
    `  ${label}: ${ok.length}/${rows.length} 成功（${((ok.length / rows.length) * 100).toFixed(0)}%）· P50 ${p(0.5)} · P95 ${p(0.95)}` +
      (errs.length > 0 ? ` · 失败症状 ${errs.join(' / ')}` : '')
  )
}

function report() {
  if (!existsSync(OUT)) return console.log('还没有样本。先跑一次 node scripts/probe-announcements.mjs')
  const rows = readFileSync(OUT, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  console.log(`\n── 累计样本（${rows.length} 轮）───────────────────`)
  for (const row of rows) {
    console.log(`  ${row.at} · ${row.session} · eastmoney ${row.em.ok}/${row.em.total} · cninfo ${row.cn.ok}/${row.cn.total}`)
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k].ok, 0)
  const tot = (k) => rows.reduce((a, r) => a + r[k].total, 0)
  console.log(`  合计 eastmoney ${sum('em')}/${tot('em')} · cninfo ${sum('cn')}/${tot('cn')}`)
  const sessions = new Set(rows.map((r) => r.session))
  const need = ['PRE_OPEN', 'TRADING', 'AFTER_CLOSE', 'CLOSED_DAY'].filter((s) => !sessions.has(s))
  console.log(need.length === 0 ? '  四个时段都覆盖到了。' : `  ⚠ 还缺时段：${need.join(' / ')}`)
}

/** 粗略的时段标签，只用于「四个时段覆盖到没有」，不参与任何判定 */
function sessionOf(now) {
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  const day = bj.getDay()
  if (day === 0 || day === 6) return 'CLOSED_DAY'
  const m = bj.getHours() * 60 + bj.getMinutes()
  if (m < 9 * 60 + 15) return 'PRE_OPEN'
  if (m <= 15 * 60) return 'TRADING'
  return 'AFTER_CLOSE'
}

async function main() {
  if (args.has('--report')) return report()

  // 自选股：从真机库读；读不到就用几只常见票，脚本不该依赖应用装过
  let codes = ['SH600000', 'SZ000001', 'SH600519', 'SZ300750', 'SH601318', 'SZ000002', 'SH600036']
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(
      resolve(process.env.APPDATA ?? '', 'gp-pet', 'market.db'),
      { readOnly: true }
    )
    const rows = db.prepare("select code from watchlist where group_name is null or group_name <> '行业ETF'").all()
    if (rows.length > 0) codes = rows.map((r) => r.code)
    db.close()
    console.log(`自选股 ${codes.length} 只（读自真机库）`)
  } catch (error) {
    console.log(`读真机库失败，用内置样本代码：${String(error?.message ?? error)}`)
  }

  const now = new Date()
  const session = sessionOf(now)
  console.log(`时段：${session}（北京时间）`)

  if (args.has('--shape')) {
    await probeShape(codes)
    await probeTruth(codes.slice(0, 8))
  }

  console.log('\n── 成功率与延迟（N0-a/b）──────────────────────')
  const { em, cn } = await probeHealth(codes)
  summarize(em, 'eastmoney')
  summarize(cn, 'cninfo   ')

  mkdirSync(dirname(OUT), { recursive: true })
  appendFileSync(
    OUT,
    JSON.stringify({
      at: now.toISOString(),
      session,
      em: { ok: em.filter((r) => r.ok).length, total: em.length },
      cn: { ok: cn.filter((r) => r.ok).length, total: cn.length },
    }) + '\n'
  )
  console.log(`\n已追加到 ${OUT}`)
  report()
}

await main()
