/**
 * 历史公告抓取（docs/11 附带的只读验证）。
 *
 * **它不是功能的一部分**，是一次离线测量的输入：回答「公告日上引擎的 alpha 是多少」。
 * 产物落 `data/announcements/`（gitignored），供 `pnpm backtest -- --announcements` 过滤用。
 *
 * ## 三条从实测里定下来的形状（2026-08-15）
 *
 * 1. **`stock` 参数必须是 `代码,orgId`。** 只给六位代码会**静默返回 0 条**，不报错 ——
 *    这是这个接口最坑的一点：抓完一看每只都是空的，而它一次异常都没抛。
 *    orgId 从 `szse_stock.json` 取（实测 6234 只，**沪深两市都在里面**，
 *    尽管文件名叫 szse；`sse_stock.json` 返回的是 HTML，不能用）。
 * 2. **`pageSize` 上限是 30。** 要 100 或 200 都只给 30 条，所以翻页次数是硬成本。
 * 3. **一只 8 年约 1300 条**（实测 000157：2018-01-01~2026-08-15 共 1305 条）
 *    ⇒ 261 只约 28 万条 ⇒ 约 9400 次请求。
 *
 * ## 断点续抓
 *
 * 每只单独落盘（与 `fetch-history.mjs` 被腾讯拦那次的教训一致：全抓完再统一写，
 * 被拦时前面的全丢）。已有文件且覆盖区间一致就跳过。
 *
 *   node scripts/fetch-announcements.mjs
 *   node scripts/fetch-announcements.mjs -- --from 2018-01-01 --to 2026-08-15
 *   node scripts/fetch-announcements.mjs -- --force        # 忽略已有文件重抓
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const QUERY_URL = 'http://www.cninfo.com.cn/new/hisAnnouncement/query'
const ORG_URL = 'http://www.cninfo.com.cn/new/data/szse_stock.json'
const OUT_DIR = resolve('data/announcements')
const PAGE_SIZE = 30
/** 并发 2：与 fetch-history 同一条教训（并发 4 被腾讯按 host 拦过） */
const CONCURRENCY = 2
const MAX_PAGES = 200

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const FROM = arg('from', '2018-01-01')
const TO = arg('to', '2026-08-15')
const FORCE = argv.includes('--force')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withRetry(label, fn, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await sleep(300 * 2 ** i)
    }
  }
  throw new Error(`${label}: ${String(last?.message ?? last)}`)
}

async function loadOrgIds() {
  const res = await fetch(ORG_URL, { headers: { 'User-Agent': UA } })
  const json = await res.json()
  const map = new Map()
  for (const s of json.stockList ?? []) if (s.code && s.orgId) map.set(s.code, s.orgId)
  return map
}

/** 一只票的全部公告（翻页到底）。返回 `{date, id, title}[]`，date 是北京时间的公告日 */
async function fetchOne(digits, orgId) {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = new URLSearchParams({
      pageNum: String(page),
      pageSize: String(PAGE_SIZE),
      column: 'szse',
      tabName: 'fulltext',
      stock: `${digits},${orgId}`,
      searchkey: '',
      seDate: `${FROM}~${TO}`,
      sortName: '',
      sortType: '',
      isHLtitle: 'true',
    })
    const json = await withRetry(`${digits} p${page}`, async () => {
      const res = await fetch(QUERY_URL, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    })

    const list = json.announcements ?? []
    for (const a of list) {
      if (!a.announcementId || !a.announcementTime) continue
      // announcementTime 是 epoch ms（北京时间的当天 0 点）。+8h 再取日期，
      // 用本机时区会让 UTC−N 的机器整体差一天
      const date = new Date(a.announcementTime + 8 * 3600_000).toISOString().slice(0, 10)
      items.push({ date, id: String(a.announcementId), title: String(a.announcementTitle ?? '') })
    }
    if (list.length < PAGE_SIZE) break
    await sleep(120)
  }
  return items
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const universe = JSON.parse(readFileSync(resolve('params/universe-broad.json'), 'utf-8'))
  const codes = universe.codes ?? []
  console.log(`标的池 ${codes.length} 只 · 区间 ${FROM} ~ ${TO}`)

  console.log('拉 orgId 表…')
  const orgIds = await loadOrgIds()
  console.log(`  ${orgIds.size} 只有 orgId`)

  const missing = []
  const queue = []
  for (const code of codes) {
    const digits = code.replace(/^(SH|SZ|BJ)/, '')
    const orgId = orgIds.get(digits)
    if (!orgId) {
      missing.push(code)
      continue
    }
    queue.push({ code, digits, orgId })
  }
  if (missing.length > 0) console.log(`  ⚠ ${missing.length} 只没有 orgId：${missing.slice(0, 8).join(',')}…`)

  let done = 0
  let skipped = 0
  let failed = 0
  let totalItems = 0

  async function worker() {
    for (;;) {
      const job = queue.shift()
      if (!job) return
      const file = resolve(OUT_DIR, `${job.code}.json`)
      if (!FORCE && existsSync(file)) {
        try {
          const prev = JSON.parse(readFileSync(file, 'utf-8'))
          if (prev.from === FROM && prev.to === TO) {
            skipped++
            totalItems += prev.items?.length ?? 0
            continue
          }
        } catch {
          /* 坏文件当没有，重抓 */
        }
      }
      try {
        const items = await fetchOne(job.digits, job.orgId)
        // 逐只落盘：被拦时前面的成果要保住
        writeFileSync(
          file,
          JSON.stringify({ code: job.code, orgId: job.orgId, from: FROM, to: TO, items }, null, 0)
        )
        totalItems += items.length
        done++
        if ((done + skipped) % 20 === 0) {
          console.log(`  进度 ${done + skipped}/${codes.length}（新抓 ${done} · 跳过 ${skipped} · 失败 ${failed}）`)
        }
      } catch (error) {
        failed++
        console.log(`  ✗ ${job.code}: ${String(error?.message ?? error)}`)
      }
    }
  }

  const t0 = Date.now()
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const mins = ((Date.now() - t0) / 60000).toFixed(1)
  console.log(`\n完成：新抓 ${done} · 跳过 ${skipped} · 失败 ${failed} · 共 ${totalItems} 条 · 耗时 ${mins} 分钟`)
  console.log(`产物 → ${OUT_DIR}`)
}

await main()
