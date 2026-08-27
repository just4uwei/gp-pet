/**
 * **复权口径的第二源交叉验证** —— 腾讯 `hfqday` vs 新浪复权因子（M2 §5.63）。
 *
 * ```bash
 * npx tsx scripts/verify/adjust-crosscheck.ts --fixtures ./data/history
 * npx tsx scripts/verify/adjust-crosscheck.ts --stride 5 --limit 60   # 抽样步长与上限
 * ```
 *
 * ## 它填的是哪个洞
 *
 * [信源台账 §1](../../docs/notes/信源台账.md) 写着腾讯 `fqkline` **是 `fetch:history` 的唯一源**
 * —— 全部 549 份 fixture 的 `*Adj` 列、进而全部回测收益，都只有这一个出处，
 * 而它**从来没有被第二个源核对过**。约束 4 那一族纪律（未定义值填 null、前后复权不混用）
 * 管的是我们**怎么用**这列数，管不了这列数**本身对不对**。
 *
 * 2026-08-27 从 `simonlin1212/a-stock-data` 学到新浪有一条零鉴权的复权**因子**序列
 * （一次 HTTP ≈ 1.8KB，`finance.sina.com.cn/realstock/company/{sym}/hfq.js`）
 * ⇒ 第一次有了独立第二源。
 *
 * ## 口径与归属
 *
 * 新浪给的是**因子**不是价格：`hfq_price(d) = close(d) × f(d)`，`f` 按日期倒序、
 * 每次除权除息一段，最早一段恒为 `1.0`（另有 `1900-01-01` 哨兵行）。
 * 两家的**锚点不同** ⇒ 绝对水平不可比，可比的只有两样：
 *
 * 1. **逐次除权日的收益差** —— 后复权的定义就是「把除权跳空抹平」，
 *    所以两家在除权日算出的**当日收益**应该几乎相同。这一列量的是「事件处理得对不对」。
 * 2. **全窗累计漂移** —— `(腾讯首末比) / (新浪首末比) − 1`。若两家只差一个常数倍数，
 *    这个数恒为 0；不为 0 说明**两家对窗口内的事件集合本身有分歧**。
 *
 * ⚠ **两列必须一起读，单看任何一列都会得出相反结论**（这正是本轮的主要发现）：
 * 退市股的逐次差与存活股一样小（0.050 vs 0.067 pp 中位），而累计漂移差 **16 倍**
 * （38.12% vs 2.39% 中位）—— 因为退市股的除权绝大多数发生在 2018 **之前**，
 * 落在我们数据窗口外 ⇒ **逐次那一列在退市组样本极少、没有代表性**。
 *
 * ## 边界
 *
 * **只读**：不改 fixture、不改引擎、不进 `params.ts`。**不判谁对谁错** ——
 * 两家都是非官方源，本工具只报**一致到什么程度**；分歧大的标的需要人去看第三个源。
 * 不覆盖北交所（新浪未提供其 qfq/hfq 文件，实测 `bj920982` 404）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根，**按脚本自身位置算**而不是 `process.cwd()`。
 * 换个目录跑时 `params/*.json` 会读不到，而那不会报错 —— 只会让全部标的静默落进
 * 「其他」那一组、分组汇总失去意义。这与「静默少给行」是同一类失败。
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** 新浪一段复权因子：`d` 起生效，`f` 是相对首日的累计系数 */
type Factor = { d: string; f: number }

type Candle = {
  date: string
  close: number
  closeAdj: number | null
}

type Group = '存活' | '退市' | '其他'

type CodeResult = {
  code: string
  group: Group
  bars: number
  /** 窗口内匹配上的除权事件数 */
  events: number
  /** 逐次除权日 |腾讯 − 新浪| 当日收益差，单位 pp */
  perEvent: number[]
  /** 全窗累计收益之比的偏离，单位 % */
  drift: number
}

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  return v ?? fallback
}

/**
 * 拉一只票的新浪后复权因子。
 *
 * ⚠ 响应形如 `var sh600519hfq={...}` 且**末尾还挂着一个 base64 的块注释**
 * ⇒ 不能用 `$` 锚定正则截取，只能从第一个 `{` 到最后一个 `}`。
 */
async function fetchFactors(code: string): Promise<Factor[] | null> {
  const sym = code.slice(0, 2).toLowerCase() + code.slice(2)
  const url = `https://finance.sina.com.cn/realstock/company/${sym}/hfq.js`
  let text: string
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' },
    })
    if (!res.ok) return null
    text = await res.text()
  } catch {
    return null
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const raw = (parsed as { data?: unknown }).data ?? parsed
  if (!Array.isArray(raw)) return null
  const rows: Factor[] = []
  for (const item of raw as Array<{ d?: string; f?: string }>) {
    const d = item.d
    const f = Number(item.f)
    if (typeof d !== 'string' || !Number.isFinite(f) || f <= 0) continue
    rows.push({ d, f })
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  return rows.length >= 2 ? rows : null
}

/** `d` 当天生效的因子 = 不晚于 `d` 的最后一段。序列已升序。 */
function factorAt(rows: Factor[], d: string): number | null {
  let v: number | null = null
  for (const r of rows) {
    if (r.d <= d) v = r.f
    else break
  }
  return v
}

function quantile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.floor(p * s.length))
  return s[i] as number
}

function loadCodeSet(relative: string): Set<string> {
  const path = join(REPO_ROOT, relative)
  if (!existsSync(path)) {
    console.error(`⚠ 读不到 ${path} —— 分组会退化，结果不可用`)
    return new Set()
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { codes?: string[] }
  return new Set(raw.codes ?? [])
}

async function analyse(
  code: string,
  group: Group,
  candles: Candle[]
): Promise<CodeResult | null> {
  const factors = await fetchFactors(code)
  if (!factors) return null
  const first = candles[0]
  const last = candles[candles.length - 1]
  if (!first || !last || first.closeAdj === null || last.closeAdj === null) return null

  const indexOfDate = new Map(candles.map((c, i) => [c.date, i]))
  const perEvent: number[] = []
  for (let k = 1; k < factors.length; k += 1) {
    const cur = factors[k]
    const prev = factors[k - 1]
    if (!cur || !prev || cur.f === prev.f) continue
    const i = indexOfDate.get(cur.d)
    if (i === undefined || i < 1) continue
    const b = candles[i]
    const a = candles[i - 1]
    if (!a || !b || a.closeAdj === null || b.closeAdj === null) continue
    const fa = factorAt(factors, a.date)
    const fb = factorAt(factors, b.date)
    if (fa === null || fb === null) continue
    const rTencent = b.closeAdj / a.closeAdj - 1
    const rSina = (b.close * fb) / (a.close * fa) - 1
    perEvent.push(Math.abs(rTencent - rSina) * 100)
  }

  const fFirst = factorAt(factors, first.date)
  const fLast = factorAt(factors, last.date)
  if (fFirst === null || fLast === null) return null
  const ratioTencent = last.closeAdj / first.closeAdj
  const ratioSina = (last.close * fLast) / (first.close * fFirst)
  if (!Number.isFinite(ratioTencent) || !Number.isFinite(ratioSina) || ratioSina <= 0) return null

  return {
    code,
    group,
    bars: candles.length,
    events: perEvent.length,
    perEvent,
    drift: Math.abs(ratioTencent / ratioSina - 1) * 100,
  }
}

async function main(): Promise<number> {
  const fixtures = argOf('--fixtures', './data/history')
  const stride = Number(argOf('--stride', '5'))
  const limit = Number(argOf('--limit', '120'))

  if (!existsSync(fixtures)) {
    console.error(`读不到 fixture 目录：${fixtures}`)
    return 1
  }
  const live = loadCodeSet('params/universe-broad.json')
  const dead = new Set([
    ...loadCodeSet('params/universe-delisted-all.json'),
    ...loadCodeSet('params/universe-delisted.json'),
  ])

  const files = readdirSync(fixtures)
    .filter((f) => /^S[HZ]\d{6}\.json$/.test(f))
    .filter((_, i) => i % stride === 0)
    .slice(0, limit)

  console.log('# 复权口径交叉验证：腾讯 `hfqday` vs 新浪复权因子')
  console.log('')
  console.log(
    `样本：${files.length} 只（${fixtures}，步长 ${stride}）· 存活池 ${live.size} · 退市池 ${dead.size}`
  )
  console.log('')

  const results: CodeResult[] = []
  let unreachable = 0
  for (const file of files) {
    const code = file.slice(0, -5)
    const group: Group = live.has(code) ? '存活' : dead.has(code) ? '退市' : '其他'
    const parsed = JSON.parse(readFileSync(join(fixtures, file), 'utf8')) as {
      candles?: Candle[]
    }
    const candles = parsed.candles
    if (!candles || candles.length < 2) continue
    const r = await analyse(code, group, candles)
    if (r === null) {
      unreachable += 1
      continue
    }
    if (r.events === 0) continue // 窗口内没有除权事件 ⇒ 两列都无从比较
    results.push(r)
  }

  if (results.length === 0) {
    console.log('⚠ 没有一只票在窗口内匹配到除权事件 —— 这份样本给不出结论。')
    return 2
  }

  // ── ① 分组汇总（两列必须并排读） ───────────────────────────────────
  console.log('## ① 逐次除权日 vs 全窗累计（**两列并排读**）')
  console.log('')
  console.log(
    '| 组 | 只数 | 事件数 | 逐次差 中位(pp) | p90 | 最大 | 全窗漂移 中位(%) | p90 | 最大 |'
  )
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const group of ['存活', '退市', '其他'] as const) {
    const g = results.filter((r) => r.group === group)
    if (g.length === 0) continue
    const ev = g.flatMap((r) => r.perEvent)
    const dr = g.map((r) => r.drift)
    console.log(
      `| ${group} | ${g.length} | ${ev.length} | **${quantile(ev, 0.5).toFixed(3)}** | ${quantile(ev, 0.9).toFixed(3)} | ${Math.max(...ev).toFixed(2)} | **${quantile(dr, 0.5).toFixed(2)}** | ${quantile(dr, 0.9).toFixed(2)} | ${Math.max(...dr).toFixed(1)} |`
    )
  }
  console.log('')
  console.log(
    '> **逐次差小 ≠ 累计一致。** 退市股的除权绝大多数发生在数据窗口（2018 起）之前 ⇒'
  )
  console.log(
    '> 逐次那一列在退市组样本极少、**没有代表性**，不许拿它说「退市股的复权也一致」。'
  )
  console.log('')

  // ── ② 分歧最大的标的（人工复核入口） ───────────────────────────────
  console.log('## ② 分歧最大的 10 只（需要人拿第三个源复核）')
  console.log('')
  console.log('| 标的 | 组 | 全窗漂移 | 窗内事件 | 根数 |')
  console.log('|---|---|---|---|---|')
  for (const r of [...results].sort((a, b) => b.drift - a.drift).slice(0, 10)) {
    console.log(
      `| ${r.code} | ${r.group} | **${r.drift.toFixed(1)}%** | ${r.events} | ${r.bars} |`
    )
  }
  console.log('')
  if (unreachable > 0) {
    console.log(`⚠ ${unreachable} 只在新浪取不到因子（未计入任何一组，不是「一致」）。`)
    console.log('')
  }

  return 0
}

main().then((code) => {
  process.exitCode = code
})
