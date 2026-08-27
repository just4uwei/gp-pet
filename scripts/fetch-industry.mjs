/**
 * 申万行业分类**变迁史** → `data/industry/sw-industry-history.json`（信源台账 §4）。
 *
 * ```bash
 * pnpm fetch:industry              # 抓取 + 解析 + 落盘
 * pnpm fetch:industry -- --preview # 只打印表头与前几行，不写文件
 * ```
 *
 * ## 它填的是哪个洞
 *
 * 行业分类这一格此前**三条路都不解决前视偏差**（[差距文档 §2.7](../docs/notes/与机构量化系统的差距.md)）：
 * 东财 `f127` 只给**当前**归属（拿它回标历史是未来函数）· 巨潮/Tushare 要自己拼历史版本 ·
 * 聚宽 `get_history_industry` 直接给纳入剔除历史但**许可禁止入库分发**（台账 §7）。
 * 申万这份是第四条路，也是唯一一条**既零鉴权又给历史归属**的。
 *
 * ## 三条纪律
 *
 * 1. **不许回填进 `security.industry`。** 那一列存的是东财 `f127` 的口径，
 *    申万是**另一套分类体系**（代码不通用、名称也不通用）。混在一列里，
 *    「这只票属于哪个行业」就再也答不准了。`014_industry_history.sql` 那条逐日留痕**照常继续**。
 * 2. **它是研究输入，不是引擎输入。** 不进 `src/core`、不进 `params.ts`、不新增指标（约束 5）。
 * 3. **表结构变了要炸，不许静默少列。** 申万随时可能改表头；少一列而不报错，
 *    产出的就是一份「看起来正常、其实缺了行业代码」的文件。
 *
 * ## 为什么自己写 BIFF8 解析而不是加依赖
 *
 * 源只有 `.xls` 一种格式（实测 `.xlsx` / `.csv` 均 404），而它是**真 OLE2 复合文档**
 * （magic `d0cf11e0`）不是伪装的 HTML。本仓库 `dependencies` 只有 4 个，
 * 而这份表只用到 **LABELSST / NUMBER / RK** 三种单元格记录、单个 Sheet
 * ⇒ 窄解析器比一个 xlsx 依赖便宜，也不进运行时。
 *
 * ## TLS：服务器漏发中间证书，我们补上，**不是关校验**
 *
 * `www.swsresearch.com` 只发叶证书，缺 `GeoTrust G2 TLS CN RSA4096 SHA256 2022 CA1`
 * ⇒ 本机报 `unable to verify the first certificate`。
 * 修法是把那张中间证书（AIA 里写着地址，链到 DigiCert Global Root G2，有效期至 2032）
 * 与系统根一起传给 undici。**`NODE_TLS_REJECT_UNAUTHORIZED=0` 是错的修法** ——
 * 它会把这一次的「链不全」变成永久的「谁都不验」。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tls from 'node:tls'
import { Agent, fetch as undiciFetch } from 'undici'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const URL_XLS =
  'https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls'
const CA_FILE = join(HERE, 'certs', 'geotrust-g2-tls-cn-rsa4096-2022-ca1.pem')
const OUT_FILE = join(REPO, 'data', 'industry', 'sw-industry-history.json')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// ─────────────────────────── OLE2 / CFB 容器 ───────────────────────────

/** 从 CFB 里取出名为 `wanted` 的流。只支持 512 字节扇区 + 主 FAT（这份表就是）。 */
function readCfbStream(buf, wanted) {
  if (buf.readBigUInt64LE(0) !== 0xe11ab1a1e011cfd0n) {
    throw new Error('不是 OLE2 复合文档（magic 不对）—— 源可能改成了别的格式')
  }
  const sectorSize = 1 << buf.readUInt16LE(30)
  if (sectorSize !== 512) throw new Error(`只实现了 512 字节扇区，实际 ${sectorSize}`)
  const sector = (n) => buf.subarray(512 + n * sectorSize, 512 + (n + 1) * sectorSize)

  // DIFAT（头里那 109 个够用；这份表实测只用了 18 个）
  if (buf.readUInt32LE(72) !== 0) {
    throw new Error('用到了额外的 DIFAT 扇区，本解析器没实现 —— 文件比预期大得多')
  }
  const fat = []
  for (let i = 0; i < 109; i += 1) {
    const s = buf.readUInt32LE(76 + i * 4)
    if (s > 0xfffffffa) continue
    const d = sector(s)
    for (let j = 0; j < sectorSize / 4; j += 1) fat.push(d.readUInt32LE(j * 4))
  }
  const chain = (start) => {
    const out = []
    let c = start
    // 上限防「FAT 成环」：环会让这里空转到内存耗尽，而症状看起来像卡死
    while (c <= 0xfffffffa && out.length < fat.length + 1) {
      out.push(c)
      c = fat[c]
    }
    return out
  }

  const dir = Buffer.concat(chain(buf.readUInt32LE(48)).map(sector))
  for (let i = 0; i * 128 < dir.length; i += 1) {
    const e = dir.subarray(i * 128, (i + 1) * 128)
    const nameLen = e.readUInt16LE(64)
    if (nameLen < 2 || e.readUInt8(66) !== 2) continue // 只要 stream
    if (e.subarray(0, nameLen - 2).toString('utf16le') !== wanted) continue
    const size = Number(e.readBigUInt64LE(120))
    if (size < 4096) throw new Error(`${wanted} 落在 mini stream 里，本解析器没实现`)
    return Buffer.concat(chain(e.readUInt32LE(116)).map(sector)).subarray(0, size)
  }
  throw new Error(`CFB 里没有 ${wanted} 流`)
}

// ─────────────────────────── BIFF8 记录 ───────────────────────────

const REC = {
  BOF: 0x0809,
  EOF: 0x000a,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  NUMBER: 0x0203,
  RK: 0x027e,
  BLANK: 0x0201,
}

function* records(wb) {
  let off = 0
  while (off + 4 <= wb.length) {
    const id = wb.readUInt16LE(off)
    const len = wb.readUInt16LE(off + 2)
    yield { id, off, data: wb.subarray(off + 4, off + 4 + len) }
    off += 4 + len
  }
}

/**
 * SST（共享字符串表）。
 *
 * ⚠ **这里是整个格式最容易写错的地方**：一条字符串的字符数据可以**跨 CONTINUE 记录**，
 * 而跨过去之后**新记录的第一个字节是新的 grbit**（重新声明是不是宽字符），
 * 不是字符数据。落在两条字符串**之间**的边界则**没有**那个字节。
 * 写错的症状不是报错，是**字符串整体错位** —— 后面每一行的代码与行业都对不上，
 * 而文件看起来完全正常。
 */
function parseSst(blocks) {
  let bi = 0
  let off = 0
  const cur = () => blocks[bi]
  const left = () => cur().length - off

  const need = (n) => {
    // 字符串**之间**的边界：直接翻页，不吃 grbit
    while (bi < blocks.length && left() < n) {
      bi += 1
      off = 0
    }
    if (bi >= blocks.length) throw new Error('SST 提前结束')
  }
  const u8 = () => {
    need(1)
    const v = cur().readUInt8(off)
    off += 1
    return v
  }
  const u16 = () => {
    need(2)
    const v = cur().readUInt16LE(off)
    off += 2
    return v
  }
  const u32 = () => {
    need(4)
    const v = cur().readUInt32LE(off)
    off += 4
    return v
  }
  /** 跳过 n 字节，允许跨块 */
  const skip = (n) => {
    let rest = n
    while (rest > 0) {
      if (left() === 0) {
        bi += 1
        off = 0
        if (bi >= blocks.length) throw new Error('SST 提前结束（skip）')
      }
      const take = Math.min(rest, left())
      off += take
      rest -= take
    }
  }

  u32() // cstTotal，不用
  const unique = u32()
  const out = new Array(unique)

  for (let i = 0; i < unique; i += 1) {
    const cch = u16()
    let grbit = u8()
    let wide = (grbit & 0x01) !== 0
    const rich = (grbit & 0x08) !== 0
    const ext = (grbit & 0x04) !== 0
    const cRun = rich ? u16() : 0
    const cbExt = ext ? u32() : 0

    let rest = cch
    const parts = []
    while (rest > 0) {
      if (left() === 0) {
        // 字符数据**中间**的边界：下一块第一个字节是新的 grbit
        bi += 1
        off = 0
        if (bi >= blocks.length) throw new Error('SST 提前结束（字符数据）')
        grbit = cur().readUInt8(off)
        off += 1
        wide = (grbit & 0x01) !== 0
      }
      const avail = wide ? Math.floor(left() / 2) : left()
      const take = Math.min(rest, avail)
      if (take <= 0) {
        // 宽字符恰好只剩 1 个字节：那半个字符属于下一块，翻页重来
        bi += 1
        off = 0
        if (bi >= blocks.length) throw new Error('SST 提前结束（半个宽字符）')
        grbit = cur().readUInt8(off)
        off += 1
        wide = (grbit & 0x01) !== 0
        continue
      }
      const bytes = wide ? take * 2 : take
      const slice = cur().subarray(off, off + bytes)
      parts.push(wide ? slice.toString('utf16le') : latin1To16(slice))
      off += bytes
      rest -= take
    }
    if (cRun > 0) skip(cRun * 4)
    if (cbExt > 0) skip(cbExt)
    out[i] = parts.join('')
  }
  return out
}

/** 压缩（单字节）字符串其实是 UTF-16 的低字节，不是 latin1 —— 中文表里不会出现，但别赌 */
function latin1To16(slice) {
  let s = ''
  for (const b of slice) s += String.fromCharCode(b)
  return s
}

/** RK：2 位标志 + 30 位。`fInt` 决定是整数还是 double 的高 4 字节，`fX100` 决定要不要除 100。 */
function decodeRk(rk) {
  const fX100 = (rk & 0x01) !== 0
  const fInt = (rk & 0x02) !== 0
  let v
  if (fInt) {
    v = rk >> 2 // 有符号右移，负数正确
  } else {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(0, 0)
    b.writeUInt32LE(rk & 0xfffffffc, 4)
    v = b.readDoubleLE(0)
  }
  return fX100 ? v / 100 : v
}

/**
 * Excel 序列号 → `YYYY-MM-DD`。
 *
 * ⚠ 1900 闰年 bug：Excel 认为 1900-02-29 存在 ⇒ 序列 60 是个不存在的日子，
 * 而 > 60 的序列要以 1899-12-30 为原点才对得上。本表的日期都在 1999 年之后，
 * 但仍然显式拒绝 ≤ 60 —— 静默给出一个 1900 年的日期比报错难查得多。
 */
function excelSerialToDate(serial) {
  if (!Number.isFinite(serial) || serial <= 60) return null
  const ms = Math.round(serial) * 86400000 + Date.UTC(1899, 11, 30)
  return new Date(ms).toISOString().slice(0, 10)
}

/** Sheet1 的单元格 → 二维数组（只认这份表实际用到的三种记录） */
function readSheet(wb, sst) {
  const rows = []
  const put = (r, c, v) => {
    if (!rows[r]) rows[r] = []
    rows[r][c] = v
  }
  for (const rec of records(wb)) {
    const d = rec.data
    if (rec.id === REC.LABELSST) {
      const isst = d.readUInt32LE(6)
      put(d.readUInt16LE(0), d.readUInt16LE(2), sst[isst] ?? '')
    } else if (rec.id === REC.NUMBER) {
      put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6))
    } else if (rec.id === REC.RK) {
      put(d.readUInt16LE(0), d.readUInt16LE(2), decodeRk(d.readUInt32LE(6)))
    }
  }
  return rows
}

// ─────────────────────────── 落地 ───────────────────────────

/**
 * 表头 → 我们的字段。**少一个就抛错**（纪律 3）。
 *
 * ⚠ **只有这四列，没有任何名称列** —— 实测表头就是
 * `["股票代码","计入日期","行业代码","更新日期"]`。
 * 申万官方只发布代码、不发布中文名（名称表是另一份未公开的）
 * ⇒ **别去东财/通达信拿名字来填**：那是**另一套分类体系**，代码不通用，
 * 拼进来会得到一份「代码是申万的、名字是东财的」的表，而错法看不出来。
 */
const COLUMNS = {
  股票代码: 'code',
  计入日期: 'startDate',
  行业代码: 'industryCode',
  更新日期: 'updatedAt',
}

async function download() {
  if (!existsSync(CA_FILE)) {
    throw new Error(
      `缺中间证书 ${CA_FILE}。它是 AIA 里那张（GeoTrust G2 TLS CN RSA4096 SHA256 2022 CA1，链到 DigiCert Global Root G2）。` +
        '别改成关掉 TLS 校验。'
    )
  }
  const ca = [...tls.rootCertificates, readFileSync(CA_FILE, 'utf8')]
  const agent = new Agent({ connect: { ca } })
  const res = await undiciFetch(URL_XLS, { dispatcher: agent, headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

function toRecords(grid) {
  const header = grid[0]
  if (!header) throw new Error('空表')
  const index = {}
  for (const [zh, key] of Object.entries(COLUMNS)) {
    const at = header.findIndex((h) => typeof h === 'string' && h.trim() === zh)
    if (at < 0) {
      throw new Error(
        `申万表结构变了：找不到列「${zh}」。实际表头 = ${JSON.stringify(header)}。` +
          '**不要改成跳过这一列** —— 少一列而不报错，产出的是一份看起来正常、其实缺字段的文件。'
      )
    }
    index[key] = at
  }

  const out = []
  const skipped = { noCode: 0, noDate: 0, badDate: 0 }
  for (let r = 1; r < grid.length; r += 1) {
    const row = grid[r]
    if (!row) continue
    const rawCode = row[index.code]
    if (rawCode === undefined || rawCode === null || rawCode === '') {
      skipped.noCode += 1
      continue
    }
    const digits = String(typeof rawCode === 'number' ? Math.round(rawCode) : rawCode)
      .trim()
      .padStart(6, '0')
    const rawDate = row[index.startDate]
    if (rawDate === undefined || rawDate === null || rawDate === '') {
      skipped.noDate += 1
      continue
    }
    const startDate =
      typeof rawDate === 'number'
        ? excelSerialToDate(rawDate)
        : String(rawDate).trim().replace(/\//g, '-').slice(0, 10)
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      skipped.badDate += 1
      continue
    }
    // 层级码补足 6 位：申万一级是 480000、二级 480300，直接截成 "48"/"4803" 与官方对不上
    const industryCode = String(row[index.industryCode] ?? '').trim().padStart(6, '0')
    const rawUpdated = row[index.updatedAt]
    out.push({
      code: digits,
      industryCode,
      l1: `${industryCode.slice(0, 2)}0000`,
      l2: `${industryCode.slice(0, 4)}00`,
      startDate,
      updatedAt:
        typeof rawUpdated === 'number' ? excelSerialToDate(rawUpdated) : (rawUpdated ?? null),
    })
  }
  out.sort((a, b) =>
    a.code === b.code ? a.startDate.localeCompare(b.startDate) : a.code.localeCompare(b.code)
  )
  return { rows: out, skipped }
}

/**
 * `--as-of <date>` 的自查：**这份表对我们的池子到底覆盖多少**。
 *
 * 做进脚本而不是每次现写，是因为它回答的是「能不能拿它做行业中性化」——
 * 而那个答案随日期变（2018 年初有一批票还没上市）。
 * ⚠ **「表里有这只票」≠「那一天定位得到」**：上市晚于查询日的票在表里，但那天还没有归属。
 * 两个数必须并排看，只看前者会以为覆盖率 100%。
 */
function coverageReport(rows, asOf) {
  const byCode = new Map()
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, [])
    byCode.get(r.code).push(r)
  }
  const at = (code) => {
    const list = byCode.get(code.slice(2)) // SH600000 → 600000
    if (!list) return null
    let hit = null
    for (const r of list) {
      if (r.startDate <= asOf) hit = r
      else break
    }
    return hit
  }
  const pools = [
    ['存活', join(REPO, 'params', 'universe-broad.json')],
    ['退市', join(REPO, 'params', 'universe-delisted-all.json')],
  ]
  process.stdout.write(`\n## 覆盖自查（as-of ${asOf}）\n\n`)
  process.stdout.write('| 池 | 只数 | 表里有 | **该日可定位** | 一级行业数 | 最大一层 |\n')
  process.stdout.write('|---|---|---|---|---|---|\n')
  for (const [label, file] of pools) {
    if (!existsSync(file)) continue
    const codes = JSON.parse(readFileSync(file, 'utf8')).codes ?? []
    const present = codes.filter((c) => byCode.has(c.slice(2))).length
    const hits = codes.map(at).filter(Boolean)
    const per = new Map()
    for (const h of hits) per.set(h.l1, (per.get(h.l1) ?? 0) + 1)
    const biggest = [...per.values()].sort((a, b) => b - a)[0] ?? 0
    process.stdout.write(
      `| ${label} | ${codes.length} | ${present} | **${hits.length}** | ${per.size} | ${biggest} |\n`
    )
  }
  process.stdout.write(
    '\n> 「表里有」与「该日可定位」的差 = 那天还没上市（或申万还没收录）的票，**不是抓取缺口**。\n'
  )
}

async function main() {
  const preview = process.argv.includes('--preview')
  const asOfAt = process.argv.indexOf('--as-of')
  const asOf = asOfAt >= 0 ? process.argv[asOfAt + 1] : null
  process.stdout.write(`拉取 ${URL_XLS}\n`)
  const xls = await download()
  process.stdout.write(`  ${xls.length} 字节 · magic ${xls.subarray(0, 4).toString('hex')}\n`)

  const wb = readCfbStream(xls, 'Workbook')
  const sstBlocks = []
  let collecting = false
  for (const rec of records(wb)) {
    if (rec.id === REC.SST) {
      sstBlocks.push(rec.data)
      collecting = true
    } else if (rec.id === REC.CONTINUE && collecting) {
      sstBlocks.push(rec.data)
    } else if (rec.id !== REC.CONTINUE) {
      collecting = false
    }
  }
  if (sstBlocks.length === 0) throw new Error('没有 SST 记录 —— 表里一个字符串都没有？')
  const sst = parseSst(sstBlocks)
  process.stdout.write(`  SST ${sst.length} 条唯一字符串（${sstBlocks.length} 个记录块）\n`)

  const grid = readSheet(wb, sst)
  process.stdout.write(`  Sheet 行数 ${grid.length}\n`)

  if (preview) {
    process.stdout.write(`\n表头 = ${JSON.stringify(grid[0])}\n`)
    for (let i = 1; i <= 3 && i < grid.length; i += 1) {
      process.stdout.write(`第 ${i} 行 = ${JSON.stringify(grid[i])}\n`)
    }
    return 0
  }

  const { rows, skipped } = toRecords(grid)
  const perCode = new Map()
  for (const r of rows) perCode.set(r.code, (perCode.get(r.code) ?? 0) + 1)
  const codes = perCode.size
  const l1 = new Set(rows.map((r) => r.l1))
  const changed = [...perCode.values()].filter((n) => n > 1).length
  const maxChanges = Math.max(...perCode.values())

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        source: URL_XLS,
        fetchedAt: new Date().toISOString(),
        note:
          '申万行业分类的**变迁史**（每只股票每次调整一行）。与东财 f127 是两套体系，' +
          '不许回填进 security.industry。研究输入，不进引擎。',
        counts: {
          rows: rows.length,
          codes,
          l1: l1.size,
          changedMoreThanOnce: changed,
          maxChanges,
        },
        skipped,
        rows,
      },
      null,
      0
    )}\n`,
    'utf8'
  )
  process.stdout.write(
    `\n写入 ${OUT_FILE}\n` +
      `  ${rows.length} 行 · ${codes} 只 · ${l1.size} 个一级行业 · ${changed} 只变更过 ≥2 次（最多 ${maxChanges} 次）\n` +
      `  跳过：无代码 ${skipped.noCode} · 无日期 ${skipped.noDate} · 日期解析失败 ${skipped.badDate}\n`
  )
  if (asOf) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`--as-of 要 YYYY-MM-DD，收到 ${asOf}`)
    coverageReport(rows, asOf)
  }
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(`[fetch:industry] 失败：${err.message}\n`)
    process.exitCode = 1
  }
)
