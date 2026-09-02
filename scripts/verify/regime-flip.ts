/**
 * **真机侧的 regime 改口率，以及「这个数在真机上到底算不算得出来」**（预注册 M2 §5.92 ③ 副臂）。
 *
 * ```bash
 * npx tsx scripts/verify/regime-flip.ts
 * ```
 *
 * ## 为什么单独一个脚本
 *
 * 主臂（fixture 252 只）在 `pnpm audit:regime` 里 —— 它的判定根口径与 `simulate.ts`
 * 逐条对齐，那是回测侧的唯一出处。这里读的是**另一份数据**（`%APPDATA%/gp-pet/market.db`
 * 的 `signal` 表），量的是同一个概念在**真机**上的样子。两份数据、两个工具、
 * **一个结论出处**（M2 §5.92/§5.93）。
 *
 * ## 它首先要答的不是那个数，而是「有没有资格报那个数」
 *
 * 登记项 `regime-flip-rate` 里写着「数据已经在库里（`signal` 表逐行带 regime，
 * 真机 + fixture 两侧都能算）」。**后半句可能是错的**，理由是结构性的：
 * - `signalSignature` **不含 regime**（含 date / 方向 / stage / level / subs / adjustments / verdicts）；
 * - `persist()` 有一条早退分支「方向 `NONE` 且无裁决 ⇒ 不落行」。
 *
 * ⇒ **「什么都没发生」的那些 code-day 在库里没有任何一行**，它们的 regime 无从得知。
 * 而缺的恰恰是「没事发生」的日子 —— 那更可能是**没改口**的日子
 * ⇒ **真机 flip rate 会被系统性高估**（不是随机噪音）。
 * 这与 [M2 §5.56](../../docs/notes/M2-偏差报告.md) 同源：**在只记录了「被记录下来的状态」
 * 的数据里找抖动，会系统性漏掉那个没被记录的状态。**
 *
 * 所以门槛在看结果之前就写死了（§5.92 ③）：「相邻两个交易日都至少有一行」的
 * code-day 配对覆盖率 **≥ 50%** 才报 flip rate，否则只报覆盖率并判「不可用」。
 *
 * ## 边界
 *
 * - **只读打开**（`readOnly: true`）。这个脚本绝不动用户的库。
 * - 一天一只票取**最后一行**的 regime（`created_at` 最大）—— 盘中会有多行，
 *   而收盘那一轮才是当天的结论（同 `report/build.ts` 取「当日最后一条」那条纪律）。
 * - **不写任何文件**、不进应用、不进降级链。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

interface Row {
  code: string
  day: string
  regime: string
}

function dbPath(): string | null {
  const appData = process.env['APPDATA']
  if (appData === undefined) return null
  const path = join(appData, 'gp-pet', 'market.db')
  return existsSync(path) ? path : null
}

async function main(): Promise<number> {
  const path = dbPath()
  if (path === null) {
    process.stdout.write('[regime-flip] 未找到 market.db —— 真机侧无从计算\n')
    return 2
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    /*
      一天一只票取最后一行。`created_at` 是毫秒 epoch，而「天」要按**北京日**切 ——
      库里 `signal` 没有日期列，这里用 `created_at + 8h` 再取 UTC 日期串。
      ⚠ 用本机时区切会让 UTC+7 的机器把北京 00:00–01:00 的行算进前一天（shared/time.ts 那条坑）。
    */
    const rows = db
      .prepare(
        `SELECT code,
                strftime('%Y-%m-%d', (created_at + 8 * 3600 * 1000) / 1000, 'unixepoch') AS day,
                regime,
                created_at
           FROM signal
          ORDER BY code, day, created_at`
      )
      .all() as unknown as (Row & { created_at: number })[]

    const lastOfDay = new Map<string, Row>()
    for (const row of rows) lastOfDay.set(`${row.code}|${row.day}`, row)
    const byCode = new Map<string, Map<string, string>>()
    const allDays = new Set<string>()
    for (const row of lastOfDay.values()) {
      allDays.add(row.day)
      const m = byCode.get(row.code) ?? new Map<string, string>()
      m.set(row.day, row.regime)
      byCode.set(row.code, m)
    }
    const days = [...allDays].sort()
    const codes = [...byCode.keys()].sort()

    // ① 覆盖率：分母是「所有出现过的交易日 × 所有出现过的票」，不是「有行的那些」
    const codeDays = codes.length * days.length
    let present = 0
    let adjacentBoth = 0
    let adjacentTotal = 0
    let flips = 0
    for (const code of codes) {
      const m = byCode.get(code)
      if (!m) continue
      for (const day of days) if (m.has(day)) present += 1
      for (let i = 1; i < days.length; i += 1) {
        const a = days[i - 1]
        const b = days[i]
        if (a === undefined || b === undefined) continue
        adjacentTotal += 1
        const ra = m.get(a)
        const rb = m.get(b)
        if (ra === undefined || rb === undefined) continue
        adjacentBoth += 1
        if (ra !== rb) flips += 1
      }
    }
    const coverage = codeDays === 0 ? 0 : present / codeDays
    const pairCoverage = adjacentTotal === 0 ? 0 : adjacentBoth / adjacentTotal

    const pct = (v: number): string => `${(v * 100).toFixed(2)}%`
    process.stdout.write(
      [
        '─'.repeat(72),
        `真机 regime 改口率（预注册 §5.92 副臂）· 库 ${path}`,
        '─'.repeat(72),
        `signal 行数 ${rows.length} · 票 ${codes.length} 只 · 出现过的交易日 ${days.length} 天`,
        `  ${days[0] ?? '—'} → ${days[days.length - 1] ?? '—'}`,
        '',
        `code-day 覆盖率      ${present} / ${codeDays} = ${pct(coverage)}`,
        `相邻日配对覆盖率      ${adjacentBoth} / ${adjacentTotal} = ${pct(pairCoverage)}` +
          `   （门槛 50%，§5.92 ③ 看结果之前写死）`,
        '',
        pairCoverage >= 0.5
          ? `⇒ **可用**：改口率 = ${flips} / ${adjacentBoth} = ${pct(
              adjacentBoth === 0 ? 0 : flips / adjacentBoth
            )}`
          : `⇒ **不可用**：配对覆盖率 ${pct(pairCoverage)} < 50% ⇒ 不报改口率。` +
            `\n   （若硬算是 ${flips} / ${adjacentBoth} = ${pct(
              adjacentBoth === 0 ? 0 : flips / adjacentBoth
            )}，**不许引用** —— 缺的是「方向 NONE 且无裁决」那些日子，` +
            `\n   而那更可能是没改口的日子 ⇒ 这个数被系统性**高估**，方向已在预注册里写死）`,
        '',
        '⚠ 真机侧的结构性缺口：`signalSignature` 不含 regime + persist() 那条「什么都没发生」的',
        '  早退分支 ⇒ 库里只有「发生过事」的 code-day。要真机能算，得另开一条逐日 regime 留痕',
        '  （与 014 行业留痕同一形状），那是一次独立的落地改动，不属于本轮。',
        '',
      ].join('\n')
    )
    return 0
  } finally {
    db.close()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
