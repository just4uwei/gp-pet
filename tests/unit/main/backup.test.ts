/**
 * `market.db` 的周期备份（docs/03 §4.4、storage/backup.ts）。
 *
 * 两条纪律各有一条用例钉着，都是「删错文件」这一类不可逆的错：
 *   ① 认不出名字的文件一律不删（用户丢进来的、改名前留下的）
 *   ② 自动备份失败也要记下时刻，否则每轮 tick 都重试一次同样会失败的备份
 *
 * 另外验 `VACUUM INTO` 真的产出一个**能打开且数据齐全**的库 ——
 * WAL 下拷主文件会得到一个少了最后几分钟数据、但照样能打开的库，
 * 那种备份最坏，因为它看起来成功了。
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStorage, openDatabase, type Storage } from '@main/storage'
import {
  DEFAULT_BACKUP_POLICY,
  LAST_BACKUP_KEY,
  backupFileName,
  backupIfDue,
  backupNow,
  listBackups,
  pruneBackups,
} from '@main/storage/backup'

const DRIVER = 'node:sqlite' as const
const DAY = 24 * 60 * 60 * 1000

let dir: string
let storage: Storage

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gp-backup-'))
  storage = createStorage(
    await openDatabase({ file: join(dir, 'market.db'), driver: DRIVER, backup: false })
  )
})

afterEach(() => {
  storage.close()
  rmSync(dir, { recursive: true, force: true })
})

function seed(): void {
  storage.watchlist.add(
    { code: 'SH600000', name: '浦发银行', market: 'SH', board: 'MAIN', isST: false },
    '自选',
    1
  )
}

describe('文件名', () => {
  it('用本地时间 —— 按 UTC 会让晚上的备份显示成第二天', () => {
    const at = new Date(2026, 7, 13, 21, 5).getTime()
    expect(backupFileName(at)).toBe('market-2026-08-13-2105.db')
  })
})

describe('backupNow', () => {
  it('产出一个能打开、且数据齐全的库', async () => {
    seed()
    const backupsDir = join(dir, 'backups')
    const result = backupNow(storage.db, backupsDir, Date.now())

    expect(existsSync(result.path)).toBe(true)
    expect(result.bytes).toBeGreaterThan(0)
    expect(statSync(result.path).size).toBe(result.bytes)

    // 打开备份，自选那一行必须在里面 —— 这是「快照一致」与「拷了个空壳」的分界
    const copy = createStorage(await openDatabase({ file: result.path, driver: DRIVER, backup: false }))
    try {
      expect(copy.watchlist.count()).toBe(1)
      expect(copy.watchlist.get('SH600000')?.profile.name).toBe('浦发银行')
    } finally {
      copy.close()
    }
  })

  it('目标文件已存在时报错，不静默覆盖上一份', () => {
    const backupsDir = join(dir, 'backups')
    const at = Date.now()
    backupNow(storage.db, backupsDir, at)
    // 同一分钟内点第二次：文件名相同
    expect(() => backupNow(storage.db, backupsDir, at)).toThrow()
  })

  it('记下备份时刻，供 backupIfDue 判间隔', () => {
    const at = Date.UTC(2026, 7, 13)
    backupNow(storage.db, join(dir, 'backups'), at)
    expect(storage.meta.getNumber(LAST_BACKUP_KEY)).toBe(at)
  })
})

describe('保留与清理', () => {
  it('只保留最近 keep 份，删的是最旧的', () => {
    const backupsDir = join(dir, 'backups')
    const base = new Date(2026, 7, 1, 10, 0).getTime()
    for (let i = 0; i < 5; i++) {
      backupNow(storage.db, backupsDir, base + i * DAY, { keep: 3, intervalMs: DAY })
    }
    const names = listBackups(backupsDir)
    expect(names).toHaveLength(3)
    // 留下的是 08-03 / 08-04 / 08-05
    expect(names[0]).toContain('2026-08-03')
    expect(names[2]).toContain('2026-08-05')
  })

  it('**认不出名字的文件一律不删** —— 误删用户的文件比多占几十 MB 贵得多', () => {
    const backupsDir = join(dir, 'backups')
    const base = new Date(2026, 7, 1, 10, 0).getTime()
    for (let i = 0; i < 4; i++) {
      backupNow(storage.db, backupsDir, base + i * DAY, { keep: 4, intervalMs: DAY })
    }
    // 三类不该被碰的东西：改动前的旧命名、用户自己的备份、随手放的笔记
    writeFileSync(join(backupsDir, 'market.db.bak-1'), 'old naming')
    writeFileSync(join(backupsDir, '我的备份.db'), 'user copy')
    writeFileSync(join(backupsDir, 'notes.txt'), 'hello')

    const pruned = pruneBackups(backupsDir, 1, () => {})
    expect(pruned).toBe(3)

    const left = readdirSync(backupsDir).sort()
    expect(left).toContain('market.db.bak-1')
    expect(left).toContain('我的备份.db')
    expect(left).toContain('notes.txt')
    expect(left.filter((name) => /^market-\d/.test(name))).toHaveLength(1)
  })

  it('份数还没超过 keep 时一个都不删', () => {
    const backupsDir = join(dir, 'backups')
    backupNow(storage.db, backupsDir, Date.now())
    expect(pruneBackups(backupsDir, 3, () => {})).toBe(0)
  })

  it('目录不存在时 listBackups 返回空数组，不抛', () => {
    expect(listBackups(join(dir, 'nope'))).toEqual([])
  })
})

describe('backupIfDue', () => {
  it('距上次不足间隔就跳过', () => {
    const backupsDir = join(dir, 'backups')
    const at = new Date(2026, 7, 13, 10, 0).getTime()
    expect(backupIfDue(storage.db, backupsDir, at)).not.toBeNull()
    expect(backupIfDue(storage.db, backupsDir, at + DAY)).toBeNull()
    expect(listBackups(backupsDir)).toHaveLength(1)
  })

  it('到点了就做', () => {
    const backupsDir = join(dir, 'backups')
    const at = new Date(2026, 7, 13, 10, 0).getTime()
    backupIfDue(storage.db, backupsDir, at)
    const later = at + DEFAULT_BACKUP_POLICY.intervalMs + 1
    expect(backupIfDue(storage.db, backupsDir, later)).not.toBeNull()
    expect(listBackups(backupsDir)).toHaveLength(2)
  })

  it('失败时不抛、且记下时刻 —— 否则每轮 tick 都会重试一次同样失败的备份', () => {
    const backupsDir = join(dir, 'backups')
    const at = new Date(2026, 7, 13, 10, 0).getTime()
    backupNow(storage.db, backupsDir, at)
    // 同名文件已存在 → 底层会抛，但 backupIfDue 必须吞掉
    storage.meta.setNumber(LAST_BACKUP_KEY, 0)
    const messages: string[] = []
    expect(backupIfDue(storage.db, backupsDir, at, DEFAULT_BACKUP_POLICY, (m) => messages.push(m))).toBeNull()
    expect(messages.join('\n')).toContain('自动备份失败')
    expect(storage.meta.getNumber(LAST_BACKUP_KEY)).toBe(at)
  })
})
