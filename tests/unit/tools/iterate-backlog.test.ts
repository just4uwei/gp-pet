/**
 * 看板的「登记在案的落地项」（`tools/iterate/backlog.ts`）。
 *
 * 钉住的是**这份清单不会烂掉**的那几条，不是文案：
 *
 * - 登记不合格要**报出来**，不许静默跳过 —— 静默跳过等于那条待办凭空消失；
 * - 仓库里已经有落地证据时要报 `LANDED`（「去把标记删掉」），
 *   否则清单只增不减，几周之后没人再看它；
 * - **判据文件读不到时的第三态不许降级** —— 猜成 `LANDED` 会静默地抹掉一条真待办，
 *   与 `session.ts` 那条「`uncertain` 不进『只能靠时间』桶」同一个不对称。
 */

import { describe, expect, it } from 'vitest'
import { MARKER, itemState, parseBacklog, type BacklogItem } from '../../../tools/iterate/backlog'

const marker = (fields: string): string => `<!-- ITEM ${fields} -->`

const FULL =
  'id=shadow-sample-gate | 类=落地 | 桶=就绪 | 代价=小 | 来源=M2 §5.49 | ' +
  '判据=src/renderer/panel/ShadowPanel.tsx:样本不足 | 标题=影子面板的夏普缺样本充分性标注'

/** 造一个最小合法条目，`over` 用来改单个字段 */
const item = (over: Partial<BacklogItem> = {}): BacklogItem => ({
  id: 'x',
  kind: '落地',
  bucket: '就绪',
  cost: '小',
  source: 'M2 §5.49',
  title: 't',
  blockedBy: null,
  evidence: { path: 'a.ts', needle: '样本不足' },
  file: 'doc.md',
  line: 1,
  ...over,
})

describe('parseBacklog', () => {
  it('完整标记：字段齐全，行号指回文档', () => {
    const { items, errors } = parseBacklog(`# 标题\n\n${marker(FULL)}\n正文\n`, 'plan.md')
    expect(errors).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'shadow-sample-gate',
      kind: '落地',
      bucket: '就绪',
      cost: '小',
      source: 'M2 §5.49',
      title: '影子面板的夏普缺样本充分性标注',
      blockedBy: null,
      file: 'plan.md',
      line: 3,
    })
    // 判据按**最后一个**冒号切：路径里的冒号不该把它切坏
    expect(items[0]!.evidence).toEqual({
      path: 'src/renderer/panel/ShadowPanel.tsx',
      needle: '样本不足',
    })
  })

  it('没有标记的文档返回空，而不是报错 —— 大多数文档本来就没有', () => {
    const { items, errors } = parseBacklog('# 只是一份普通文档\n\n正文\n', 'plan.md')
    expect(items).toEqual([])
    expect(errors).toEqual([])
  })

  it('⚠ 缺 判据 ⇒ 报错并丢弃：没有判据的条目关不掉，而关不掉的清单只会增不会减', () => {
    const bad = 'id=a | 类=落地 | 桶=就绪 | 标题=t'
    const { items, errors } = parseBacklog(marker(bad), 'plan.md')
    expect(items).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('判据')
  })

  it('桶值非法 ⇒ 报错，绝不猜一个最接近的', () => {
    const bad = 'id=a | 类=落地 | 桶=现在就能做 | 判据=a.ts:x | 标题=t'
    const { errors } = parseBacklog(marker(bad), 'plan.md')
    expect(errors[0]).toContain('桶')
  })

  it('类 非法 ⇒ 报错', () => {
    const bad = 'id=a | 类=顺手 | 桶=就绪 | 判据=a.ts:x | 标题=t'
    const { errors } = parseBacklog(marker(bad), 'plan.md')
    expect(errors[0]).toContain('类')
  })

  it('桶=等条件 但没写 前置 ⇒ 报错（否则它与「不做」没有区别）', () => {
    const bad = 'id=a | 类=落地 | 桶=等条件 | 判据=a.ts:x | 标题=t'
    const { errors } = parseBacklog(marker(bad), 'plan.md')
    expect(errors[0]).toContain('前置')
  })

  it('桶=等条件 且写了 前置 ⇒ 合格，前置原样带出来', () => {
    const ok = 'id=a | 类=落地 | 桶=等条件 | 前置=出现夏普为正的候选 | 判据=a.ts:x | 标题=t'
    const { items, errors } = parseBacklog(marker(ok), 'plan.md')
    expect(errors).toEqual([])
    expect(items[0]!.blockedBy).toBe('出现夏普为正的候选')
  })

  it('判据 缺冒号 ⇒ 报错，不把整串当路径', () => {
    const bad = 'id=a | 类=落地 | 桶=就绪 | 判据=a.ts | 标题=t'
    const { errors } = parseBacklog(marker(bad), 'plan.md')
    expect(errors[0]).toContain('判据')
  })

  it('id 重复 ⇒ 报错并只留第一条（两条同 id 会让「关掉哪一条」没有答案）', () => {
    const a = 'id=dup | 类=落地 | 桶=就绪 | 判据=a.ts:x | 标题=t1'
    const b = 'id=dup | 类=待测 | 桶=就绪 | 判据=b.ts:y | 标题=t2'
    const { items, errors } = parseBacklog(`${marker(a)}\n${marker(b)}`, 'plan.md')
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('t1')
    expect(errors[0]).toContain('重复')
  })

  it('缺 id ⇒ 报错（没有 id 就没法在会话之间指认同一条）', () => {
    const { errors } = parseBacklog(marker('类=落地 | 桶=就绪 | 判据=a.ts:x | 标题=t'), 'plan.md')
    expect(errors[0]).toContain('id')
  })
})

describe('itemState', () => {
  it('仓库里没有那个字符串 ⇒ OPEN（还没做）', () => {
    expect(itemState(item(), () => '别的内容')).toBe('OPEN')
  })

  it('⚠ 仓库里已经有了 ⇒ LANDED —— 这是要被看见的反常，清单必须能说「我该被关掉了」', () => {
    expect(itemState(item(), () => '……样本不足，需约 X 年……')).toBe('LANDED')
  })

  it('⚠ 判据文件读不到 ⇒ UNREADABLE，绝不降级成 OPEN 或 LANDED', () => {
    const state = itemState(item(), () => null)
    expect(state).toBe('UNREADABLE')
    // 写死这两条断言：猜成 LANDED 会**静默地**把一条真待办从清单上抹掉
    expect(state).not.toBe('LANDED')
    expect(state).not.toBe('OPEN')
  })

  it('⚠ 判据指向标记所在的同一份文档时，不许被自己那行标记命中（首次接线真踩到）', () => {
    // 「拍板」类条目的判据常常就是「等这一节写上结论行」，而那个字符串写在 `判据=` 里
    const doc = `${marker('id=a | 类=拍板 | 桶=等拍板 | 判据=plan.md:§4.11 已拍板 | 标题=t')}\n正文\n`
    const it0 = parseBacklog(doc, 'plan.md').items[0]!
    expect(itemState(it0, () => doc)).toBe('OPEN')
    // 真的写上结论行之后才算落地
    expect(itemState(it0, () => `${doc}\n§4.11 已拍板：选 A\n`)).toBe('LANDED')
  })

  it('只读判据里写的那个文件，不去别处找', () => {
    const asked: string[] = []
    itemState(item({ evidence: { path: 'src/a.ts', needle: 'x' } }), (p) => {
      asked.push(p)
      return ''
    })
    expect(asked).toEqual(['src/a.ts'])
  })
})

describe('MARKER 整行锚定（2026-08-27 现场踩过）', () => {
  /*
    文档里到处有「这类条目要带一行 `<!-- ITEM ... -->` 标记」这种**散文提及**。
    正则不整行锚定，就会把它们也当成条目 —— 而 `status.ts` 的清单外扫描
    （`strayBacklogItems`）复用同一条正则，症状是「报了三条根本不存在的条目」，
    人会去找一个不存在的登记错误。**两处共用一条正则**就是为了这个。
  */
  it('散文里的提及不算条目', () => {
    expect(MARKER.test('所以这类条目要带一行 `<!-- ITEM ... -->` 标记登记在那一节里')).toBe(false)
    expect(MARKER.test('| `status.ts` | 读日志、`<!-- ITEM -->` | 有 IO |')).toBe(false)
  })

  it('整行的真标记算', () => {
    expect(MARKER.test(marker(FULL))).toBe(true)
    // 前面有缩进也算（文档里有缩进过的标记）
    expect(MARKER.test(`   ${marker(FULL)}`)).toBe(true)
  })
})
