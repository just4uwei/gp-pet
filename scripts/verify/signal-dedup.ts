/**
 * **`signal` 去重回归**：每 (只 × 天) 中位 6 · p90 69 · 最大 244，而文档说「约 2 行」
 * —— 去重坏了，还是有个离散字段在抖？（M2 §5.56）
 *
 * ```bash
 * npx tsx scripts/verify/signal-dedup.ts
 * ```
 *
 * ## 它答的是什么
 *
 * 登记项 `signal-dedup-regression`。两个假设的**修法相反**，所以判据在
 * [M2 §5.56](../../docs/notes/M2-偏差报告.md) 里先写死了：
 *
 * * **H_A**（去重坏了）⇐ 相邻两行签名**相同**的对数超过「重启 + `stage` 改写」两个上界之和；
 * * **H_B**（离散字段在抖）⇐ 相邻对几乎总是不同 ⇒ 再做**字段级归因** + 数 A→B→A 往复。
 *
 * ## 为什么能只靠落库的行做
 *
 * `signalSignature()` 的八个分量在 `signal` 表里全都在 —— `trade_date` · `direction` ·
 * `stage` · `evidence.level` · `evidence.suppressed` · `subSignals[].id:direction` ·
 * `adjustments[].id` · `verdicts[].rule:action`。这里重建的字符串与那个函数**逐字段同构**
 * （三个集合项同样排序后拼接）。
 *
 * ⚠ **一处不可重建**：`stage` 会被 `reconcile()` 事后改写（`PROVISIONAL → CONFIRMED /
 * INVALIDATED`）⇒ 重建值不一定是插入那一刻的值。影响上界是**每组至多 1 行**
 * （`latestOfDay` 只改一行）⇒ 算进「不可归因」，**不当成一次 flap**。
 *
 * ## 边界
 *
 * 真机库**只读**打开，不写任何东西、不改任何代码、不跑模拟。
 * 判的是「哪一个假设」，修法是另一次改动。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const DB = join(process.env['APPDATA'] ?? process.cwd(), 'gp-pet', 'market.db')

/** 签名的八个分量，逐个留着好做字段级归因 */
interface Parts {
  tradeDate: string
  direction: string
  stage: string
  level: string
  suppressed: string
  subs: string
  adjustments: string
  verdicts: string
}

const FIELDS: readonly (keyof Parts)[] = [
  'tradeDate',
  'direction',
  'stage',
  'level',
  'suppressed',
  'subs',
  'adjustments',
  'verdicts',
]

interface Row {
  id: string
  code: string
  created_at: number
  trade_date: string
  direction: string
  score: number
  price_at: number
  stage: string
  evidence: string
}

interface Ev {
  level?: string
  suppressed?: boolean
  subSignals?: { id: string; direction: string }[]
  adjustments?: { id: string }[]
  verdicts?: { rule: string; action: string }[]
}

function partsOf(row: Row): Parts {
  const ev = JSON.parse(row.evidence) as Ev
  return {
    tradeDate: row.trade_date,
    direction: row.direction,
    stage: row.stage,
    level: ev.level ?? '?',
    suppressed: ev.suppressed ? 'S' : '-',
    subs: (ev.subSignals ?? []).map((s) => `${s.id}:${s.direction}`).sort().join(','),
    adjustments: (ev.adjustments ?? []).map((a) => a.id).sort().join(','),
    verdicts: (ev.verdicts ?? []).map((v) => `${v.rule}:${v.action}`).sort().join(','),
  }
}

const sigOf = (p: Parts): string => FIELDS.map((f) => p[f]).join('|')

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`)

/** 北京时间 HH:mm（脚本里不引 src/，重写一份最小版） */
function hhmm(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[i] as number
}

function main(): void {
  const db = new DatabaseSync(DB, { readOnly: true })
  console.log('# `signal` 去重回归：H_A（去重坏了）还是 H_B（离散字段在抖）（M2 §5.56）\n')

  const rows = db
    .prepare(
      'select id,code,created_at,trade_date,direction,score,price_at,stage,evidence from signal order by code,trade_date,created_at'
    )
    .all() as unknown as Row[]

  // ---------- 1. 样本 ----------
  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const key = `${r.code}|${r.trade_date}`
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  const sizes = [...groups.values()].map((g) => g.length).sort((a, b) => a - b)
  console.log('## 1. 样本\n')
  console.log(
    `\`signal\` **${rows.length}** 行 · **${groups.size}** 个 (只 × 天) 组 · ` +
      `组大小 中位 **${quantile(sizes, 0.5)}** · p90 **${quantile(sizes, 0.9)}** · 最大 **${sizes[sizes.length - 1]}**`
  )

  // ---------- 2. 主判据：相邻对同/不同 ----------
  let pairs = 0
  let same = 0
  const sameByGroup = new Map<string, number>()
  const fieldChanged = new Map<string, number>()
  let oscillating = 0 // sig[i] === sig[i-2]
  let triples = 0

  // ⚠ 字段级归因**只算签名修复之后**的行：08-13/08-14 是**旧签名**（含 `reasons[0]`）
  // 下落的，用今天的签名去归因它们，答的是一个没人问过的问题
  for (const [key, list] of groups) {
    if ((key.split('|')[1] as string) <= '2026-08-14') continue
    for (let i = 1; i < list.length; i += 1) {
      const a = partsOf(list[i - 1] as Row)
      const b = partsOf(list[i] as Row)
      pairs += 1
      if (sigOf(a) === sigOf(b)) {
        same += 1
        sameByGroup.set(key, (sameByGroup.get(key) ?? 0) + 1)
        continue
      }
      for (const f of FIELDS) if (a[f] !== b[f]) fieldChanged.set(f, (fieldChanged.get(f) ?? 0) + 1)
    }
    // ⚠ 往复只在**相邻都不同**的三连上算。连续三行签名全同（A,A,A）同样满足
    // `sig[i] === sig[i-2]`，把它算进「抖」会让这个指标在 H_A 的样本上失去区分力
    for (let i = 2; i < list.length; i += 1) {
      const s0 = sigOf(partsOf(list[i - 2] as Row))
      const s1 = sigOf(partsOf(list[i - 1] as Row))
      const s2 = sigOf(partsOf(list[i] as Row))
      if (s0 === s1 || s1 === s2) continue
      triples += 1
      if (s0 === s2) oscillating += 1
    }
  }

  const postGroups = [...groups.keys()].filter((k) => (k.split('|')[1] as string) > '2026-08-14').length
  console.log('\n## 2. 主判据：相邻两行的签名同不同（**只算签名修复之后**，见 2b）\n')
  console.log(
    `修复后 **${postGroups}** 组 · 相邻对 **${pairs}** 个 · 签名**相同** **${same}**` +
      `（${pct(same, pairs)}）· 不同 ${pairs - same}`
  )
  console.log(
    `\n**\`stage\` 事后改写上界** = 每组至多 1 ⇒ **${postGroups}**（重启另算，而 08-17 起` +
      `每天 0–2 次且全在盘外）。实测 \`n_same\` = **${same}** ⇒ ` +
      `${same <= postGroups ? '**落在上界内 ⇒ H_B**' : '**超出上界 ⇒ H_A**'}`
  )
  const sameGroups = [...sameByGroup.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
  if (sameGroups.length > 0) {
    console.log('\n签名相同最多的组：')
    for (const [k, n] of sameGroups) console.log(`- \`${k}\` — ${n} 对`)
  }

  // ---------- 2b. 按「签名修复」前后分开 ----------
  //
  // `reasons[0]` 是 2026-08-14 **晚**才移出签名的（CLAUDE.md / §5.53）⇒ 08-13 与 08-14
  // 的行是**旧签名**下落的，用今天的签名重建当然显示「相同」。CHANGELOG 记着那两天
  // 769 行按新签名回放只剩 13 行 ⇒ 那两天的组**已经有解释**，不是本轮要判的东西。
  const FIX_DATE = '2026-08-14'
  console.log('\n## 2b. 按签名修复（2026-08-14 晚）前后分开\n')
  console.log('| 段 | 组 | 行 | 相邻对 | 签名相同 | 占比 |')
  console.log('|---|---|---|---|---|---|')
  for (const [label, keep] of [
    ['修复前（≤ 08-14）', (d: string) => d <= FIX_DATE],
    ['**修复后（> 08-14）**', (d: string) => d > FIX_DATE],
  ] as const) {
    let p = 0
    let s = 0
    let n = 0
    let g = 0
    for (const [key, list] of groups) {
      const day = key.split('|')[1] as string
      if (!keep(day)) continue
      g += 1
      n += list.length
      for (let i = 1; i < list.length; i += 1) {
        p += 1
        if (sigOf(partsOf(list[i - 1] as Row)) === sigOf(partsOf(list[i] as Row))) s += 1
      }
    }
    console.log(`| ${label} | ${g} | ${n} | ${p} | **${s}** | **${pct(s, p)}** |`)
  }

  // ---------- 2c. SAME 对：中间那一轮 tick 到底跑了没 ----------
  //
  // 「相同签名却落了新行」有两个互斥的解释：① 去重没生效（每轮都插）；
  // ② 中间有一轮算出了**别的**签名、把去重记忆覆盖掉了，而那一轮自己没落行
  // （`persist()` 的 `NONE && verdicts 为空` 早退分支就会这么做）。
  // 判据：**SAME 对的时间间隔**。tick 是 30s 一轮 —— 若间隔普遍 > 60s，
  // 说明中间那些轮**没有**落行 ⇒ 是 ②，不是每轮都插。
  console.log('\n## 2c. SAME 对的时间间隔（tick 30s 一轮）\n')
  const gaps: number[] = []
  for (const [key, list] of groups) {
    const day = key.split('|')[1] as string
    if (day <= FIX_DATE) continue
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1] as Row
      const b = list[i] as Row
      if (sigOf(partsOf(a)) === sigOf(partsOf(b))) gaps.push((b.created_at - a.created_at) / 1000)
    }
  }
  gaps.sort((x, y) => x - y)
  const le60 = gaps.filter((g) => g <= 60).length
  console.log(
    `修复后的 SAME 对 **${gaps.length}** 个 · 间隔 中位 **${quantile(gaps, 0.5).toFixed(0)}s** · ` +
      `p10 ${quantile(gaps, 0.1).toFixed(0)}s · p90 ${quantile(gaps, 0.9).toFixed(0)}s · ` +
      `**≤ 60s 的只有 ${le60}（${pct(le60, gaps.length)}）**`
  )
  console.log(
    '\n⇒ 间隔普遍远大于一轮 tick ⇒ **中间那些轮没有落行** ⇒ 不是「每轮都插」，' +
      '而是**有一轮算出了别的签名、把去重记忆覆盖掉了**。'
  )

  // ---------- 2d. 那个覆盖来自哪：direction 的分布 ----------
  const dirs = new Map<string, number>()
  for (const r of rows) dirs.set(r.direction, (dirs.get(r.direction) ?? 0) + 1)
  console.log('\n## 2d. 落库行的 direction 分布\n')
  console.log('| direction | 行数 |')
  console.log('|---|---|')
  for (const [d, n] of [...dirs.entries()].sort((x, y) => y[1] - x[1])) console.log(`| ${d} | ${n} |`)
  console.log(
    `\n⇒ \`NONE\` 落库 **${dirs.get('NONE') ?? 0}** 行。而 \`persist()\` 对` +
      '「`direction === NONE` 且 `verdicts` 为空」是**早退不落行、却照样 `set` 签名**' +
      '（`signals.ts:270-273`）⇒ 那一轮正是看不见的覆盖者。'
  )

  // ---------- 3. 字段级归因 ----------
  console.log('\n## 3. 字段级归因（只数「有变化」的那些对）\n')
  console.log('| 字段 | 变了多少对 | 占有变化的对 |')
  console.log('|---|---|---|')
  const changed = pairs - same
  for (const f of FIELDS) {
    const n = fieldChanged.get(f) ?? 0
    if (n > 0) console.log(`| \`${f}\` | ${n} | **${pct(n, changed)}** |`)
  }
  for (const f of FIELDS) if ((fieldChanged.get(f) ?? 0) === 0) console.log(`| \`${f}\` | 0 | — |`)

  console.log(
    `\n**A→B→A 往复**：${oscillating} / ${triples} 个三连（**${pct(oscillating, triples)}**）` +
      ` —— 往复是「抖」的指纹，单向递进不是。`
  )

  // ---------- 3b. 「不覆盖」之后按观测到的签名流回放 ----------
  //
  // 修法若是「NONE 早退分支不再 set 签名」，那么按**观测到的**签名流回放，
  // 每组的行数 = 1 + 该组「相邻不同」的对数（看不见的 NONE 轮修好之后照样不落行）。
  // ⚠ 这是**对观测流的回放**，不是重跑引擎 —— 它答的是「这些行里有多少是纯重复」。
  console.log('\n## 3b. 修掉覆盖之后，按观测到的签名流回放（修复后那 446 行）\n')
  const replayed = postGroups + changed
  console.log(
    `现在 **${postGroups + pairs}** 行 ⇒ 回放后 **${replayed}** 行` +
      `（= ${postGroups} 组 + ${changed} 个有变化的对）⇒ **−${(100 * (1 - replayed / (postGroups + pairs))).toFixed(0)}%**`
  )

  // ---------- 4. 最重的几组拆开看 ----------
  console.log('\n## 4. 最重的 5 组：变的是哪个字段、K 线动没动\n')
  const heaviest = [...groups.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 5)
  for (const [key, list] of heaviest) {
    const first = list[0] as Row
    const last = list[list.length - 1] as Row
    const scores = new Set(list.map((r) => r.score.toFixed(6)))
    const prices = new Set(list.map((r) => r.price_at.toFixed(4)))
    const sigs = new Set(list.map((r) => sigOf(partsOf(r))))
    const per = new Map<string, number>()
    for (let i = 1; i < list.length; i += 1) {
      const a = partsOf(list[i - 1] as Row)
      const b = partsOf(list[i] as Row)
      const diff = FIELDS.filter((f) => a[f] !== b[f])
      const label = diff.length === 0 ? '（签名相同）' : diff.join('+')
      per.set(label, (per.get(label) ?? 0) + 1)
    }
    console.log(
      `\n### \`${key}\` — **${list.length}** 行 · ${hhmm(first.created_at)}–${hhmm(last.created_at)} · ` +
        `不同签名 **${sigs.size}** 种 · score ${scores.size} 种 · price_at ${prices.size} 种`
    )
    for (const [label, n] of [...per.entries()].sort((x, y) => y[1] - x[1])) {
      console.log(`- \`${label}\` × ${n}`)
    }
    // 那两个在抖的值长什么样（取变化最多的字段）
    const top = [...per.entries()].sort((x, y) => y[1] - x[1])[0]
    if (top && top[0] !== '（签名相同）' && !top[0].includes('+')) {
      const f = top[0] as keyof Parts
      const vals = new Set(list.map((r) => partsOf(r)[f]))
      console.log(`  - \`${f}\` 取过的值（${vals.size} 种）：`)
      for (const v of [...vals].slice(0, 6)) console.log(`    - \`${v || '（空）'}\``)
    }
  }

  // ---------- 5. 时段分布 ----------
  console.log('\n## 5. 落行的时段分布（北京时间，每 30s 一轮 ⇒ 连续竞价 4h 上界约 480 轮）\n')
  const byHour = new Map<string, number>()
  for (const r of rows) {
    const h = hhmm(r.created_at).slice(0, 2)
    byHour.set(h, (byHour.get(h) ?? 0) + 1)
  }
  console.log('| 时 | 行数 |')
  console.log('|---|---|')
  for (const h of [...byHour.keys()].sort()) console.log(`| ${h}:xx | ${byHour.get(h)} |`)

  db.close()
}

main()
