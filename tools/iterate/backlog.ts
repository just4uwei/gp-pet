/**
 * 「已经论证过、已经决定要做、但还没做」的那些条目 —— 看板缺的最后一块。
 *
 * ## 它修的是什么
 *
 * 学习任务与实验会长出**可落地或可测试的结论**（2026-08-20 那两轮就长出四条：
 * 影子面板缺样本充分性标注 · 回测报告该印显著性门槛 · `adx` 网格该往下探 ·
 * Lo (2002) 的夏普自相关口径该补）。它们被归档进 M2 / 计划文档 / 差距文档 ——
 * **然后就没有任何一处会在第二天提醒任何人**。
 *
 * 这不是新问题：计划文档 §4.9 那条「`audit:random` 的 meta 不继承基线口径」
 * 就是一条正在烂掉的「已识别未修」。而同一天刚好证过一次同形状的事 ——
 * §5.44 的预注册里写着「不许拿它当新基线」，纪律在文档里却没有任何东西执行它，
 * **当天就被 `pnpm iterate` 自己违反了** ⇒ **写下一条纪律不等于装上一道闸门**。
 *
 * ## 判据：条目由人登记，**状态由仓库推导**
 *
 * 看板的既有纪律是「规则驱动，不猜」「不依赖手写的进度记录（那种东西会过期）」。
 * 这里没有违反它：**手写的只有「这件事值得做」**，而「做没做」由仓库里
 * 有没有那个字符串来判。手写状态会静默过期，手写意图不会。
 *
 * 标记写在**条目论证所在的那份文档里**（一件事仍然只有一个出处），一行：
 *
 * ```
 * <!-- ITEM id=xxx | 类=落地 | 桶=就绪 | 代价=小 | 来源=M2 §5.49 | 判据=路径:字符串 | 标题=… -->
 * ```
 *
 * ## 三条规则（错一条这份清单就会变成又一个会烂的东西）
 *
 * 1. **字段缺失或非法一律进 `errors`，不猜、不静默跳过。**
 *    与看板那条「读不到的东西要说读不到，不许默认成 0」同一条。
 *    尤其是 `判据` **必填** —— 没有判据的条目**关不掉**，而关不掉的清单只会增不会减，
 *    几周之后没人再看它。
 * 2. **`LANDED` 是一条要被看见的反常**，不是好消息：条目还挂在文档里，
 *    而仓库里已经有那个字符串了 ⇒ 看板要说「去把这条标记删掉」。
 *    这是「清单只增不减」的另一半防线。
 * 2a. **判据字符串要挑「只可能在落地时出现」的，别挑一句会被散文复述的短语。**
 *    2026-08-24 现场踩了一次：`trade-decision-link` 的判据是 `ledger.ts:真实成交时刻`，
 *    而当天在**同一个文件**的头注释里写「它还缺两样输入（真实成交时刻 + …）」
 *    ⇒ 看板立刻报「证据显示已落地」，而那一列压根还不存在。
 *    去掉 `<!-- ITEM -->` 行只挡得住**自己命中自己**，挡不住**别处的散文命中它**。
 *    ⇒ 宁可长一点、带上动作（「…已落库」「继承基线口径」），别用纯名词短语。
 * 3. **判据文件读不到 ⇒ `UNREADABLE`，第三态，绝不降级成 `OPEN` 或 `LANDED`。**
 *    与 `./session.ts` 那条「日历 `uncertain` 时不进『只能靠时间』桶」同形状 ——
 *    猜错的代价不对称：猜成 `LANDED` 会**静默地**把一条真待办从清单上抹掉。
 */

/** `落地` 改软件 · `待测` 跑实验 · `拍板` 等用户 */
export type ItemKind = '落地' | '待测' | '拍板'

/**
 * **刻意不复用任务那四个桶名**（只能靠时间 / 现在就能做 / 等你拍板 / 明确不做）。
 *
 * 「等条件」不是「只能靠时间」：DSR 接不接闸门等的是「出现一个训练窗口夏普为正的候选」，
 * 那不是日历问题，多等一年也不会自己发生。混用桶名会让人以为它在倒计时。
 */
export type ItemBucket = '就绪' | '等条件' | '等拍板' | '不做'

const KINDS: readonly string[] = ['落地', '待测', '拍板']
const BUCKETS: readonly string[] = ['就绪', '等条件', '等拍板', '不做']

export interface BacklogItem {
  id: string
  kind: ItemKind
  bucket: ItemBucket
  /** 代价：小 / 中 / 大。只为排期，不参与任何判断 */
  cost: string
  /** 来源：哪一节论证的它（M2 §5.49 / §4.9 …） */
  source: string
  title: string
  /** `桶=等条件` 时必填：等的到底是什么 */
  blockedBy: string | null
  /** 落地时必然会出现的那个字符串。登记时它必须还不存在 */
  evidence: { path: string; needle: string }
  /** 标记所在的文档与行号，看板据此指回去 */
  file: string
  line: number
}

export type ItemState = 'OPEN' | 'LANDED' | 'UNREADABLE'

const MARKER = /^\s*<!--\s*ITEM\s+(.+?)\s*-->\s*$/

/** `a=1 | b=2` → Map。值里可以有 `=`（`判据=路径:串` 就有冒号，将来也可能有等号） */
function parseFields(body: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of body.split('|')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key.length > 0) out.set(key, value)
  }
  return out
}

/**
 * 扫一份 markdown 里的所有 `<!-- ITEM ... -->`。
 *
 * 没有标记时返回空数组**而不是报错** —— 大多数文档里本来就没有。
 */
export function parseBacklog(
  text: string,
  file: string,
): { items: BacklogItem[]; errors: string[] } {
  const items: BacklogItem[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]!)
    if (m === null) continue
    const at = `${file}:${i + 1}`
    const f = parseFields(m[1]!)

    const id = f.get('id') ?? ''
    if (id === '') {
      errors.push(`${at} 缺 id`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`${at} id 重复：${id}`)
      continue
    }

    const kind = f.get('类') ?? ''
    const bucket = f.get('桶') ?? ''
    const title = f.get('标题') ?? ''
    const evidenceRaw = f.get('判据') ?? ''
    const blockedBy = f.get('前置') ?? ''

    const bad: string[] = []
    if (!KINDS.includes(kind)) bad.push(`类 非法或缺失（${kind === '' ? '缺' : kind}）`)
    if (!BUCKETS.includes(bucket)) bad.push(`桶 非法或缺失（${bucket === '' ? '缺' : bucket}）`)
    if (title === '') bad.push('缺 标题')
    // 判据必填：没有它这条就关不掉，而关不掉的条目一定会烂
    if (evidenceRaw === '') bad.push('缺 判据（没有判据的条目关不掉）')
    // 「等条件」必须说清等的是什么，否则与「不做」没有区别
    if (bucket === '等条件' && blockedBy === '') bad.push('桶=等条件 但缺 前置')

    const sep = evidenceRaw.lastIndexOf(':')
    if (evidenceRaw !== '' && (sep <= 0 || sep === evidenceRaw.length - 1)) {
      bad.push(`判据 格式应为 路径:字符串（收到 ${evidenceRaw}）`)
    }

    if (bad.length > 0) {
      errors.push(`${at} ${id}：${bad.join('；')}`)
      continue
    }

    seen.add(id)
    items.push({
      id,
      kind: kind as ItemKind,
      bucket: bucket as ItemBucket,
      cost: f.get('代价') ?? '—',
      source: f.get('来源') ?? '—',
      title,
      blockedBy: blockedBy === '' ? null : blockedBy,
      evidence: { path: evidenceRaw.slice(0, sep), needle: evidenceRaw.slice(sep + 1) },
      file,
      line: i + 1,
    })
  }
  return { items, errors }
}

/**
 * 找判据之前先把所有 `<!-- ITEM ... -->` 行去掉。
 *
 * ⚠ **不这么做会自己命中自己**：`拍板` 类条目的判据往往指向标记所在的同一份文档
 * （「等 §4.11 写上结论行」），而那个字符串就写在 `判据=` 里 ⇒ 条目登记的当下
 * 就被报成「已落地」。首次接线时真踩到了这一下。
 * 顺带也挡住「A 的判据命中了 B 的标记」这种跨条目误报。
 */
function withoutMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !MARKER.test(line))
    .join('\n')
}

/**
 * 这条到底做没做 —— **只问仓库，不问文档**（`<!-- ITEM -->` 标记行不算仓库内容）。
 *
 * `readFile` 读不到时返回 `null`（不要抛），调用方拿到 `UNREADABLE`
 * 必须原样报出来：那是「不知道」，既不是「还没做」也不是「已经做了」。
 */
export function itemState(
  item: BacklogItem,
  readFile: (path: string) => string | null,
): ItemState {
  const text = readFile(item.evidence.path)
  if (text === null) return 'UNREADABLE'
  return withoutMarkers(text).includes(item.evidence.needle) ? 'LANDED' : 'OPEN'
}
