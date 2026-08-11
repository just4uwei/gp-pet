/**
 * 顺序迁移清单（docs/03 §4.4）。
 *
 * meta.schema_version 驱动，只前进不回退。新增迁移的规矩：
 *   1. 建 00N_xxx.sql，**不要**编辑已发布的迁移
 *   2. 在下面数组尾部追加一项，version 连续
 *   3. 迁移前会自动备份 market.db（见 db.ts）
 */

import init001 from './001_init.sql?raw'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: '001_init', sql: init001 }]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
