/**
 * 系统通知（docs/05 §3 的 L3、C5 默认无声）。
 *
 * Windows 的 toast 认 AUMID —— `app.setAppUserModelId(APP_ID)` 已在 main/index.ts 里
 * 于 app ready 之前设好。不设它，通知会显示成「electron.app.Electron」，
 * 而这个问题只在打包后暴露（见 identity.ts）。
 *
 * ## 两条纪律
 *
 * 1. **默认无声**（C5）：`silent` 默认 true，只有 `AppSettings.soundEnabled` 打开的 L3 才响。
 *    「可发声」不等于「发声」—— docs/05 §3 那张表里 L3 那格写的是「是（默认开，可关）」，
 *    指的是**可发声这件事**默认开；实际是否响由用户设置决定，出厂 `soundEnabled: false`。
 * 2. **点击通知只打开面板，不做任何交易动作。** 本产品不下单，通知里也不该出现
 *    「买入 / 卖出」这类看起来可执行的按钮。
 *
 * 文案合成是纯函数（`composeNotification`），因为措辞纪律要能写成用例：
 * 不出现「胜率」「必涨」，底部固定「仅供参考，非投资建议」（CLAUDE.md）。
 */

import { Notification } from 'electron'
import type { GatedDirection } from '@core/types'
import type { AlertPayload } from '@shared/ipc-types'

const DIRECTION_LABEL: Record<GatedDirection, string> = {
  BUY: '买入信号',
  SELL: '卖出提醒',
  REDUCE: '减仓提醒',
  NEXT_DAY_WATCH: '明日开盘观察',
  NONE: '观察',
}

export const DISCLAIMER = '仅供参考，非投资建议'

export interface NotificationText {
  title: string
  body: string
}

/** docs/05 §5 的四段结构压成通知的两段：标题一段、正文三行 */
export function composeNotification(payload: AlertPayload): NotificationText {
  const lines = [
    payload.headline,
    // 依据行最多 3 条，完整依据在面板展开
    payload.reasons.slice(0, 3).join(' / '),
    `现价 ${payload.price.toFixed(2)}（${payload.changePct > 0 ? '+' : ''}${payload.changePct.toFixed(2)}%） · 置信 ${Math.round(
      payload.score * 100
    )}%`,
    DISCLAIMER,
  ].filter((line) => line !== '')

  return {
    title: `${DIRECTION_LABEL[payload.direction]} · ${payload.name} ${payload.code}`,
    body: lines.join('\n'),
  }
}

export interface NotifyOptions {
  /** 出厂 false（C5 默认无声）。只有用户显式打开且是 L3 才为 true */
  sound?: boolean
  onClick?: () => void
  log?: { warn: (...args: unknown[]) => void }
}

/**
 * 弹一条系统通知。
 *
 * 系统不支持通知（被组策略关掉、Linux 缺 notify daemon）时**静默跳过** ——
 * 提醒已经通过面板与托盘角标到达用户了，为一个渠道不可用而抛错没有意义。
 */
export function showAlertNotification(payload: AlertPayload, options: NotifyOptions = {}): boolean {
  if (!Notification.isSupported()) return false
  const { title, body } = composeNotification(payload)
  try {
    const notification = new Notification({ title, body, silent: options.sound !== true })
    if (options.onClick) notification.on('click', options.onClick)
    notification.show()
    return true
  } catch (error) {
    options.log?.warn('[alert] 系统通知发送失败：', error)
    return false
  }
}
