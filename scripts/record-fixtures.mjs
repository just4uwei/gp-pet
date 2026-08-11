#!/usr/bin/env node
/**
 * 录制 provider 的真实响应到 tests/fixtures/providers/<id>/。
 *
 * 用法：
 *   node scripts/record-fixtures.mjs                      # 全部源
 *   node scripts/record-fixtures.mjs --provider eastmoney
 *   node scripts/record-fixtures.mjs --provider tencent --dry
 *
 * 刻意**不**复用 src/main/providers 的代码：录制脚本要拍下原始字节，
 * 如果它走解析器，那解析器写错时录出来的 fixture 也会跟着错，测试就永远是绿的。
 * 这里只做「发请求 + 落盘」，字段含义交给 NOTES.md 与回放测试。
 *
 * 录完必须人工比对 `git diff tests/fixtures/providers`，尤其是字段号与单位。
 * 自动覆盖会让「接口变了」悄无声息地通过。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'providers')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const UT = 'fa5fd1943c7b386f172d6893dbfba10b'

/** 五个代表性品种：沪主板 / 深主板 / 创业板 / 停牌北交所 / ETF */
const SAMPLE = {
  sina: ['sh600000', 'sz000001', 'sz300750', 'bj430047', 'sh510300'],
  tencent: ['sh600000', 'sz000001', 'sz300750', 'bj430047', 'sh510300'],
  eastmoney: ['1.600000', '0.000001', '0.300750', '0.430047', '1.510300'],
}

/** 日线固定录这一段：跨了 2024 春节，能同时覆盖节假日缺口与除权前后 */
const KLINE_FROM = '2024-01-02'
const KLINE_TO = '2024-02-05'

const PLANS = {
  sina: [
    {
      file: 'snapshot-mixed.gbk.txt',
      encoding: 'gbk',
      url: `https://hq.sinajs.cn/list=${SAMPLE.sina.join(',')}`,
      headers: { Referer: 'https://finance.sina.com.cn' },
    },
  ],
  tencent: [
    {
      file: 'snapshot-mixed.gbk.txt',
      encoding: 'gbk',
      url: `https://qt.gtimg.cn/q=${SAMPLE.tencent.join(',')}`,
    },
    {
      file: 'kline-day-raw-sh600000.json',
      encoding: 'utf-8',
      url: `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(
        `sh600000,day,${KLINE_FROM},${KLINE_TO},60,`
      )}`,
    },
    {
      file: 'kline-day-qfq-sh600000.json',
      encoding: 'utf-8',
      url: `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${encodeURIComponent(
        `sh600000,day,${KLINE_FROM},${KLINE_TO},60,qfq`
      )}`,
    },
  ],
  eastmoney: [
    {
      file: 'snapshot-mixed.json',
      encoding: 'utf-8',
      url:
        `https://push2.eastmoney.com/api/qt/ulist.np/get?ut=${UT}&fltt=2&invt=2` +
        `&secids=${SAMPLE.eastmoney.join(',')}` +
        `&fields=f2,f5,f6,f12,f13,f14,f15,f16,f17,f18,f51,f52,f124`,
    },
    {
      file: 'kline-day-raw-sh600000.json',
      encoding: 'utf-8',
      url: klineUrl(0),
    },
    {
      file: 'kline-day-qfq-sh600000.json',
      encoding: 'utf-8',
      url: klineUrl(1),
    },
    {
      file: 'profile-sh600000.json',
      encoding: 'utf-8',
      url: `https://push2.eastmoney.com/api/qt/stock/get?ut=${UT}&invt=2&fltt=2&secid=1.600000&fields=f57,f58,f127,f189`,
    },
  ],
}

function klineUrl(fqt) {
  return (
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600000&ut=${UT}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=${fqt}&beg=${KLINE_FROM.replaceAll('-', '')}&end=${KLINE_TO.replaceAll('-', '')}&lmt=2000`
  )
}

function parseArgs(argv) {
  const args = { providers: Object.keys(PLANS), dry: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--provider') {
      const id = argv[++i]
      if (!PLANS[id]) {
        console.error(`未知 provider：${id}（可选 ${Object.keys(PLANS).join(' / ')}）`)
        process.exit(2)
      }
      args.providers = [id]
    } else if (argv[i] === '--dry') {
      args.dry = true
    }
  }
  return args
}

async function record(providerId, plan, dry) {
  const target = join(FIXTURES, providerId, plan.file)
  const startedAt = Date.now()
  const response = await fetch(plan.url, {
    headers: { 'User-Agent': UA, ...plan.headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  const elapsed = Date.now() - startedAt

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`)
  }
  // GBK 的 fixture 按**原始字节**落盘：转成 UTF-8 就测不出解码那一步了
  const preview =
    plan.encoding === 'gbk'
      ? new TextDecoder('gbk').decode(bytes).slice(0, 90)
      : bytes.toString('utf8').slice(0, 90)

  console.log(`  ${plan.file}  ${bytes.length}B  ${elapsed}ms`)
  console.log(`    ${preview.replace(/\s+/g, ' ')}…`)

  if (dry) return
  mkdirSync(dirname(target), { recursive: true })
  if (plan.encoding === 'gbk') {
    writeFileSync(target, bytes)
  } else {
    // JSON 重新格式化，否则单行响应的 git diff 完全没法看
    let text = bytes.toString('utf8')
    try {
      text = `${JSON.stringify(JSON.parse(text), null, 2)}\n`
    } catch {
      /* 不是 JSON 就原样存 */
    }
    writeFileSync(target, text, 'utf8')
  }
}

const { providers, dry } = parseArgs(process.argv.slice(2))
let failed = 0

for (const providerId of providers) {
  console.log(`\n[${providerId}]${dry ? ' (dry run)' : ''}`)
  for (const plan of PLANS[providerId]) {
    try {
      await record(providerId, plan, dry)
    } catch (error) {
      failed++
      console.error(`  ✗ ${plan.file}：${error instanceof Error ? error.message : String(error)}`)
      console.error(`    ${plan.url}`)
    }
  }
}

console.log(
  failed === 0
    ? '\n全部录制完成。请人工比对 git diff tests/fixtures/providers 后再提交。'
    : `\n${failed} 个请求失败。失败的 fixture 保持原样未改动。`
)
process.exit(failed === 0 ? 0 : 1)
