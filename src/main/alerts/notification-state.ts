/**
 * 全屏 / 演示模式 / 专注助手探测（docs/05 §4.4 的第 2、3 行）。
 *
 * Windows 把「现在该不该打扰用户」这件事收敛成了一个 API：`SHQueryUserNotificationState`。
 * 它一次覆盖全屏独占（D3D）、演示模式、忙碌、专注助手（QUIET_TIME）与锁屏/未登录，
 * 比自己去比较「前台窗口尺寸 == 屏幕尺寸」准得多 —— 后者对无边框最大化的编辑器会误报。
 *
 * ## 为什么是 PowerShell 而不是原生绑定
 *
 * Electron 没有这个 API，也拿不到前台窗口。要在主进程里直接 P/Invoke 得引入一个原生
 * FFI 依赖，那意味着第二个需要跟 Electron ABI 对齐、需要在打包时外置的原生模块
 * （better-sqlite3 已经是一个，见 CLAUDE.md）。为一条**降级用**的探测加这份长期负担不划算：
 * 探测失败的后果是「照常提醒」，不是功能不可用。
 *
 * ## 三条纪律
 *
 * 1. **分发路径只读缓存，绝不等子进程。** `current()` 是同步的；`refresh()` 在后台跑。
 *    一轮 tick 是 30s，探测结果最多陈旧一轮 —— 而让提醒去等一个 200ms 的进程启动，
 *    等于把「不打扰」的代价转嫁成「卡一下」。
 * 2. **连续失败即永久停用并留痕。** 精简版 Windows、组策略禁用 PowerShell、
 *    杀软拦截子进程都会让它一直失败。反复重试只会每 15 秒起一个注定失败的进程。
 * 3. **停用后状态是 `UNKNOWN`，判为「可以提醒」。** 探测不到时保守的方向是**发**：
 *    多发会被抱怨（用户能自己发现），漏发不会（docs/05 §4 的不对称）。
 */

import { execFile } from 'node:child_process'
import { platform } from 'node:process'

/** QUERY_USER_NOTIFICATION_STATE（shellapi.h）。`UNKNOWN` 是本地增加的「探测不到」 */
export type NotificationState =
  | 'NOT_PRESENT'
  | 'BUSY'
  | 'RUNNING_D3D_FULL_SCREEN'
  | 'PRESENTATION_MODE'
  | 'ACCEPTS_NOTIFICATIONS'
  | 'QUIET_TIME'
  | 'APP'
  | 'UNKNOWN'

/** 枚举值 1–7，顺序即 shellapi.h 的定义顺序 */
const STATE_BY_CODE: Record<number, NotificationState> = {
  1: 'NOT_PRESENT',
  2: 'BUSY',
  3: 'RUNNING_D3D_FULL_SCREEN',
  4: 'PRESENTATION_MODE',
  5: 'ACCEPTS_NOTIFICATIONS',
  6: 'QUIET_TIME',
  7: 'APP',
}

/**
 * 要静默的状态（docs/05 §4.4）。
 *
 * `NOT_PRESENT` 是「锁屏 / 屏保 / 用户未登录」，一并算上 —— 那时弹气泡毫无意义。
 * `APP` 是「某个应用要求全屏但不是独占」，Windows 自己也照发通知，我们跟随。
 */
export const SILENCING_STATES: readonly NotificationState[] = [
  'NOT_PRESENT',
  'BUSY',
  'RUNNING_D3D_FULL_SCREEN',
  'PRESENTATION_MODE',
  'QUIET_TIME',
]

export const STATE_REASON: Record<NotificationState, string> = {
  NOT_PRESENT: '锁屏或屏保',
  BUSY: '系统标记为忙碌',
  RUNNING_D3D_FULL_SCREEN: '全屏应用运行中',
  PRESENTATION_MODE: '演示模式',
  ACCEPTS_NOTIFICATIONS: '可以提醒',
  QUIET_TIME: '专注助手开启',
  APP: '应用请求全屏',
  UNKNOWN: '未知',
}

export function isSilencing(state: NotificationState): boolean {
  return SILENCING_STATES.includes(state)
}

/** stdout → 状态。拿到别的东西（报错信息、空行）一律 UNKNOWN，不猜 */
export function parseNotificationState(stdout: string): NotificationState {
  const code = Number.parseInt(stdout.trim(), 10)
  return STATE_BY_CODE[code] ?? 'UNKNOWN'
}

/**
 * 探测脚本。用 `-EncodedCommand`（UTF-16LE base64）传，绕开所有引号转义问题 ——
 * 这段 C# 里同时有双引号与方括号，任何一层 shell 都可能把它啃掉一半。
 */
const PROBE_SCRIPT = [
  `$sig = '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int pquns);'`,
  `$t = Add-Type -MemberDefinition $sig -Name 'GpQuns' -Namespace 'GpPet' -PassThru`,
  `$state = 0`,
  `[void]$t::SHQueryUserNotificationState([ref]$state)`,
  `Write-Output $state`,
].join('; ')

export function encodedProbeCommand(): string {
  return Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64')
}

/** 起一个 PowerShell 问一次。超时即失败 —— 探测卡住比探测不到更糟 */
export function powershellProbe(timeoutMs = 3000): () => Promise<string> {
  return () =>
    new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedProbeCommand()],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        }
      )
    })
}

export interface ProbeOptions {
  /** 注入点：单测传假 exec，不起进程 */
  exec?: () => Promise<string>
  now?: () => number
  /** 缓存有效期。一轮 tick 是 30s，15s 足够让每轮都拿到一次新值 */
  ttlMs?: number
  /** 连续失败几次后永久停用 */
  maxFailures?: number
  /** 非 Windows 直接停用（这个 API 是 Windows 独有的） */
  enabled?: boolean
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export interface NotificationStateProbe {
  /** 最近一次已知状态。**同步**，分发路径只用这个 */
  current(): NotificationState
  /** 后台刷新一次（TTL 内或已有在途请求时直接返回）。刻意不返回 Promise：调用方不该等它 */
  refresh(): void
  /** 供单测与日志用：等这一次刷新落地 */
  refreshNow(): Promise<NotificationState>
  readonly disabled: boolean
}

export function createNotificationStateProbe(options: ProbeOptions = {}): NotificationStateProbe {
  const {
    now = () => Date.now(),
    ttlMs = 15_000,
    maxFailures = 3,
    enabled = platform === 'win32',
    log = { info: () => {}, warn: () => {} },
  } = options
  const exec = options.exec ?? powershellProbe()

  let state: NotificationState = 'UNKNOWN'
  let fetchedAt = 0
  let failures = 0
  let disabled = !enabled
  let inflight: Promise<NotificationState> | null = null

  if (!enabled) log.info('[dnd] 非 Windows 平台，全屏/专注助手探测不启用')

  async function run(): Promise<NotificationState> {
    try {
      const next = parseNotificationState(await exec())
      fetchedAt = now()
      if (next === 'UNKNOWN') {
        // 进程跑通了但输出不认识 —— 与进程起不来是两回事，但同样不能用
        failures += 1
      } else {
        failures = 0
        state = next
      }
    } catch (error) {
      failures += 1
      fetchedAt = now()
      if (failures === 1) log.warn(`[dnd] 免打扰探测失败（将重试）：${String(error)}`)
    }
    if (failures >= maxFailures && !disabled) {
      disabled = true
      state = 'UNKNOWN'
      log.warn(
        `[dnd] 免打扰探测连续失败 ${failures} 次，已停用 —— 全屏/演示/专注助手不再自动静默，` +
          '手动免打扰与静默时段不受影响'
      )
    }
    inflight = null
    return state
  }

  function start(): Promise<NotificationState> {
    if (disabled) return Promise.resolve<NotificationState>('UNKNOWN')
    if (inflight) return inflight
    inflight = run()
    return inflight
  }

  return {
    current: () => (disabled ? 'UNKNOWN' : state),

    refresh() {
      if (disabled || inflight || now() - fetchedAt < ttlMs) return
      void start()
    },

    refreshNow: () => start(),

    get disabled() {
      return disabled
    },
  }
}
