/**
 * 顺序迁移清单（docs/03 §4.4）。
 *
 * meta.schema_version 驱动，只前进不回退。新增迁移的规矩：
 *   1. 建 00N_xxx.sql，**不要**编辑已发布的迁移
 *   2. 在下面数组尾部追加一项，version 连续
 *   3. 迁移前会自动备份 market.db（见 db.ts）
 */

import init001 from './001_init.sql?raw'
import shadow002 from './002_shadow.sql?raw'
import watch003 from './003_watch.sql?raw'
import quoteTick004 from './004_quote_tick.sql?raw'
import watchVerdict005 from './005_watch_verdict.sql?raw'
import alertRepeat006 from './006_alert_repeat.sql?raw'
import tradeLog007 from './007_trade_log.sql?raw'
import aiExplain008 from './008_ai_explain.sql?raw'
import positionStop009 from './009_position_stop.sql?raw'
import reportNote010 from './010_report_note.sql?raw'

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: init001 },
  { version: 2, name: '002_shadow', sql: shadow002 },
  { version: 3, name: '003_watch', sql: watch003 },
  { version: 4, name: '004_quote_tick', sql: quoteTick004 },
  { version: 5, name: '005_watch_verdict', sql: watchVerdict005 },
  { version: 6, name: '006_alert_repeat', sql: alertRepeat006 },
  { version: 7, name: '007_trade_log', sql: tradeLog007 },
  { version: 8, name: '008_ai_explain', sql: aiExplain008 },
  { version: 9, name: '009_position_stop', sql: positionStop009 },
  { version: 10, name: '010_report_note', sql: reportNote010 },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
