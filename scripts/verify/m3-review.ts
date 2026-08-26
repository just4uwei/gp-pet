/**
 * **M3 提醒层复盘** —— 把 [M3 清单 §4](../../docs/checklists/M3-提醒层验收.md) 的四问
 * 从真机 `alert_log` 里整理成可读的表，供人逐日过一遍。
 *
 * ```bash
 * npx tsx scripts/verify/m3-review.ts 2026-08-20 2026-08-21 2026-08-24 2026-08-25 2026-08-26
 * ```
 *
 * ## 两条口径，弄错了整份复盘就废
 *
 * 1. **「被打断」只算弹了气泡的**（`channel` 含 `BUBBLE`），**不是 `channel != 'NONE'`**。
 *    后者把**被降级成 L1** 的也算进来了 —— 那些只点状态点、不弹气泡，
 *    按 docs/05 的口径它们「算过了闸门」，但**没有打断任何人**。
 *    实测这一天差别很大：某日 `channel != 'NONE'` 有 37 行，而真弹泡只有 **6** 条。
 *    ⚠ 拿前者去答 §4.1「值不值得被打断」会得出「太吵」，而那是口径错。
 * 2. **原因分布必须按离散的 `suppressed_gate` 分组，不能按文案**（011 迁移头注释）。
 *    §4.5 那次踩过：1590 行日志只对应约 6 件事，因为判重键里嵌着连续量。
 *
 * ## 它只整理，不下结论
 *
 * §4.1/§4.4 要的是**人的事后判断**（「我当时真的不需要再被提醒一次吗」），
 * 这个脚本给不了。它只保证四问各自需要的**事实**摆在同一屏上、且口径正确。
 * 唯一会替人喊的是 §4.4 那条硬规则：**强制类（L3）出现在冷却列 = bug**。
 *
 * ## 边界
 *
 * 真机库**只读**打开。⚠ **只对 2026-08-19 之后的日子有意义** ——
 * 那天之前闸门状态没落库，重启会清零冷却/配额（M3 清单 §4.0）。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const DB = join(process.env['APPDATA'] ?? process.cwd(), 'gp-pet', 'market.db')
/** 闸门状态落库那天。更早的日子拿来复盘是无效的（§4.0） */
const GATE_STATE_SINCE = '2026-08-19'

const days = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
if (days.length === 0) {
  console.error('用法：npx tsx scripts/verify/m3-review.ts <YYYY-MM-DD> [更多日子…]')
  process.exit(2)
}

const db = new DatabaseSync(DB, { readOnly: true })
/** 北京日 */
const D = "date(a.created_at/1000,'unixepoch','+8 hours')"
const HM = "strftime('%H:%M', a.created_at/1000,'unixepoch','+8 hours')"
const list = days.map((d) => `'${d}'`).join(',')

interface Row {
  d: string
  hm: string
  code: string
  direction: string
  level: string
  score: number
  channel: string
  gate: string | null
  reason: string | null
  repeat: number
  evidence: string
}

const headlineOf = (evidence: string): string => {
  try {
    const p = JSON.parse(evidence) as { headline?: unknown }
    return typeof p.headline === 'string' ? p.headline : ''
  } catch {
    return ''
  }
}

const rows = db
  .prepare(
    `select ${D} d, ${HM} hm, s.code, s.direction, a.level, s.score,
            a.channel, a.suppressed_gate gate, a.suppressed_reason reason,
            a.repeat_count repeat, s.evidence
       from alert_log a join signal s on s.id = a.signal_id
      where ${D} in (${list})
      order by a.created_at`
  )
  .all() as unknown as Row[]

const stale = days.filter((d) => d < GATE_STATE_SINCE)
console.log('# M3 提醒层复盘（清单 §4 的四问）\n')
console.log(`日子：${days.join(' · ')} · 裁决行 **${rows.length}**\n`)
if (stale.length > 0) {
  console.log(
    `> ⚠ **${stale.join(' / ')} 早于 ${GATE_STATE_SINCE}**（闸门状态落库那天）——` +
      '那时重启会清零冷却/配额，这几天的日志**不能当判据**（§4.0）。\n'
  )
}

/**
 * 闸门的**有效**标识。
 *
 * `STEP`（强制类台阶）是 2026-08-26 才从 `COOLDOWN` 里分出来的，**历史行不回填** ⇒
 * 判读旧日志时必须在这里补一次：`forced` 那条路写的原因文案恒以「强制提醒台阶」开头，
 * 而它记的 gate 是 `COOLDOWN`。
 *
 * ⚠ **这是唯一一处允许看文案的地方，而且只用来纠正一个已知的标签合并** ——
 * 不是拿文案分组（011 头注释禁的是后者）。等 08-26 之后的数据攒够，这个兜底就可以删。
 */
const gateOf = (r: Row): string => {
  if (r.gate === 'COOLDOWN' && (r.reason ?? '').startsWith('强制提醒台阶')) return 'STEP（历史行）'
  return r.gate ?? '(无)'
}

const bubbled = rows.filter((r) => r.channel.includes('BUBBLE'))
const dotOnly = rows.filter((r) => r.channel !== 'NONE' && !r.channel.includes('BUBBLE'))
const blocked = rows.filter((r) => r.channel === 'NONE')

// ── §4.1 ────────────────────────────────────────────────────────────────
console.log('## §4.1 真的打断了你的：**弹了气泡**的逐条\n')
console.log(
  '> 口径：`channel` 含 `BUBBLE`。**不是** `channel != \'NONE\'` —— ' +
    `后者含 ${dotOnly.length} 行**被降级成 L1**（只点状态点、不弹气泡）。\n` +
    '> 清单的线：**一天超过 3–4 条就该怀疑 `alert.bubbleScore` 太低**。\n'
)
console.log('| 日 | 弹泡 | 其中 L3 | 其中 L2 | 超过 4 条？ |')
console.log('|---|---|---|---|---|')
for (const d of days) {
  const b = bubbled.filter((r) => r.d === d)
  const l3 = b.filter((r) => r.level === 'L3').length
  console.log(
    `| ${d} | **${b.length}** | ${l3} | ${b.length - l3} | ${b.length > 4 ? '⚠ **是**' : '否'} |`
  )
}
console.log('\n逐条（**这是要你事后判断「值不值得」的那一批**）：\n')
console.log('| 日 | 时刻 | 标的 | 方向 | 级别 | 置信度 | 文案 |')
console.log('|---|---|---|---|---|---|---|')
for (const r of bubbled) {
  console.log(
    `| ${r.d} | ${r.hm} | \`${r.code}\` | ${r.direction} | ${r.level} | ${r.score.toFixed(2)} | ${headlineOf(r.evidence)} |`
  )
}

// ── §4.2 ────────────────────────────────────────────────────────────────
console.log('\n## §4.2 被静默的原因分布（按**离散**的 `suppressed_gate` 分组）\n')
console.log(
  '> ⚠ **不许按文案分组**（011 头注释）：§4.5 那次 1590 行日志只对应约 6 件事，' +
    '因为判重键里嵌着连续量。\n' +
    '> 不合理的样子：**「防抖」占绝大多数** ⇒ 信号在阈值附近抖，该调阈值不是调防抖。\n'
)
const gates = [...new Set(rows.map(gateOf))].sort()
console.log(`| 闸门 | 挡掉行数 | 占被挡 | 累计轮次 | 其中 L3 |`)
console.log('|---|---|---|---|---|')
for (const g of gates) {
  const hit = blocked.filter((r) => gateOf(r) === g)
  if (hit.length === 0) continue
  console.log(
    `| ${g} | **${hit.length}** | ${((100 * hit.length) / Math.max(1, blocked.length)).toFixed(1)}% | ` +
      `${hit.reduce((s, r) => s + r.repeat, 0)} | ${hit.filter((r) => r.level === 'L3').length} |`
  )
}
console.log(
  `\n合计被挡 **${blocked.length}** 行 · 降级成 L1（只点状态点）**${dotOnly.length}** 行 · ` +
    `弹泡 **${bubbled.length}** 行`
)

// ── §4.3 ────────────────────────────────────────────────────────────────
console.log('\n## §4.3 该发而没发的？—— 被挡掉的 **L3** 逐条\n')
console.log(
  '> 这是唯一能发现**漏发**的地方。L3 是持仓强制类（止损那一档）——' +
    '被挡掉本身不一定错（同一条止损一天挡几十轮是设计），但**要看得见**。\n'
)
const blockedL3 = blocked.filter((r) => r.level === 'L3')
const byCode = new Map<string, { n: number; gates: Set<string>; first: string; last: string }>()
for (const r of blockedL3) {
  const k = `${r.d}|${r.code}|${r.direction}`
  const e = byCode.get(k) ?? { n: 0, gates: new Set<string>(), first: r.hm, last: r.hm }
  e.n += 1
  e.gates.add(gateOf(r))
  e.last = r.hm
  byCode.set(k, e)
}
console.log('| 日 · 标的 · 方向 | 被挡行数 | 闸门 | 首次 → 末次 |')
console.log('|---|---|---|---|')
for (const [k, e] of [...byCode.entries()].sort()) {
  console.log(`| ${k.replace(/\|/g, ' · ')} | ${e.n} | ${[...e.gates].join(' / ')} | ${e.first} → ${e.last} |`)
}

// ── §4.4 ────────────────────────────────────────────────────────────────
console.log('\n## §4.4 冷却挡掉的里有没有强制类 —— **这一条是硬规则，不是判断题**\n')
console.log('> 清单原文：**「止损类若出现在这一列 = bug，强制类本不该受冷却」**。\n')
// ⚠ 必须用 gateOf：台阶不是冷却，直接按 r.gate 判会把每一条止损都报成 bug
const l3Cooldown = blockedL3.filter((r) => gateOf(r) === 'COOLDOWN')
if (l3Cooldown.length === 0) {
  console.log('✅ **一条都没有** —— L3 没有被冷却挡过。')
} else {
  const codes = new Set(l3Cooldown.map((r) => r.code))
  console.log(
    `🛑 **${l3Cooldown.length} 行 L3 被 \`COOLDOWN\` 挡掉**，涉及 ${codes.size} 只：` +
      `${[...codes].join(' · ')}\n`
  )
  console.log('| 日 | 时刻 | 标的 | 方向 | 轮次 | 原因文案 |')
  console.log('|---|---|---|---|---|---|')
  for (const r of l3Cooldown.slice(0, 30)) {
    console.log(
      `| ${r.d} | ${r.hm} | \`${r.code}\` | ${r.direction} | ${r.repeat} | ${(r.reason ?? '').slice(0, 60)} |`
    )
  }
  if (l3Cooldown.length > 30) console.log(`\n（还有 ${l3Cooldown.length - 30} 行）`)
  console.log(
    '\n⚠ **但要连着看是哪一道闸门记的账**（§4.5 的教训）：08-17 那次表面像冷却，' +
      '真实成因是**开盘第一轮锁屏把强制类台阶消耗掉了**。'
  )
}

console.log('\n---\n\n## 这份复盘不替你回答什么\n')
console.log(
  '§4.1「值不值得被打断」与 §4.4「我当时真的不需要再被提醒一次吗」**要人的事后判断**。\n' +
    '⚠ 若结论是「太吵」或「太哑」，按 [docs/08 关键决策点 3](../../docs/08-开发路线图.md)：\n' +
    '**回到 docs/04 §4.2 的阈值或 docs/05 §4 的冷却策略去标定，不要增加新指标。**'
)
db.close()
