/**
 * 时钟校准（2026-08-15）。把「现在几点」从本机系统时钟换成行情服务器的钟。
 *
 * ## 为什么需要它
 *
 * 时区那一层早就不依赖本地了（`clock.ts` 用写死的 +08:00）。依赖本地的是 **epoch 本身**，
 * 而应用对它的敏感度是**分钟级**：时段边界（09:30 / 11:30 / 15:00）、
 * `T1_LATE_BUY` 的尾盘窗口 890–910、做T的 14:50 边界、量比的时间归一化。
 *
 * 最脏的一条在风控里：`src/core/risk/index.ts` 的
 * `age = input.now.atMs - snapshot.at` —— **左边是本地钟，右边是远端成交时刻**。
 * 本机快 6 分钟，连续竞价里每一条快照都会被判 `STALE_SNAPSHOT: SUPPRESS`，
 * 于是买入信号整批被压掉，而日志只说「行情已 6 分钟未更新」。没人会想到是系统时间。
 *
 * ## 时间源是 HTTP `Date` 响应头，不是 `Snapshot.at`
 *
 * **`Snapshot.at` 不能拿来校时。** 三家 provider 都解析了它，看着像现成的源，
 * 但那是「最后成交时刻」而不是「服务器当前时刻」：停牌、冷门股几分钟没成交、收盘之后，
 * 它都会合法地落后。于是「远端比本地小 5 分钟」既可能是本地快了、也可能只是没人成交，
 * **两者无法区分**。它只是一个下界，不是估计值。
 *
 * `Date` 头则是服务器发响应那一刻的墙钟，误差由 RTT 界定。秒粒度带来 ≤ 1s 的系统性偏差，
 * 相对分钟级的敏感度富余三个数量级，**不做亚秒修正**。
 * 采样搭盘中每 30s 一次的快照请求，零额外请求。
 *
 * ## 首次可以直接跳，之后必须限幅
 *
 * 这是本模块唯一一条防「新故障模式」的纪律。冷却窗口、每小时配额、跨日重置
 * 全部假设 `now` 单调递增 —— 一次 −3 分钟的回拨会让刚发过的提醒重新变成「冷却已过」，
 * 于是同一条提醒弹两次，而日志上两行都合规。
 *
 * 所以：**第一个样本直接采用**（那一刻 `AlertDispatcher` 的冷却表、配额、防抖计数
 * 全是空的，跳多远都无害），之后每次最多挪 `maxStepMs`。代价是纠正一个 3 分钟的偏差
 * 要几十轮才追平 —— 那是刻意的，日志里能看见它在追。
 *
 * ## 哪些钟不归它管
 *
 * **只有答「现在几点」的地方用校准钟，量「过了多久」的一律用本地钟**
 * （`http.ts` 的 `latencyMs`、`registry` 的健康统计、分时的 30s 缓存 TTL）。
 * 把校准钟喂给它们的后果是：offset 一挪，正在计时的那次请求算出个负延迟，
 * 污染 provider 健康统计 —— 而健康度恰恰是判断数据源好不好的唯一依据。
 * 装配处（`data-layer.ts`）因此显式拆成 `localNow` 与 `clock.now` 两个。
 */

export interface ClockSample {
  /** 请求发出时的**本地**时刻 */
  sentAt: number
  /** 响应到达时的**本地**时刻 */
  receivedAt: number
  /** 响应 `Date` 头解析出的服务器时刻 */
  serverDateMs: number
}

export interface ClockReport {
  /** 校准量（服务器 − 本地）。正数 = 本机慢了。从未校准过时为 null */
  offsetMs: number | null
  /** 当前窗口里的有效样本数 */
  samples: number
  source: 'HTTP_DATE' | 'NONE'
  /** 最后一次采纳样本的**本地**时刻；从未校准过时为 null */
  syncedAt: number | null
}

export interface ClockSyncOptions {
  /** 注入本地钟，便于测试。生产传 `Date.now` */
  localNow?: () => number
  /** RTT 超过这个数的样本丢弃：往返太久，中点估计不可信 */
  maxRttMs?: number
  /** 滑动窗口大小，取中位数 */
  sampleSize?: number
  /** 单次最多挪多少（首次采纳不受限，见头注释） */
  maxStepMs?: number
  log?: (message: string) => void
}

export interface ClockSync {
  /** 喂一个样本。非法值静默丢弃 —— 校时失败不该拖垮取数 */
  observe(sample: ClockSample): void
  /** 校准后的「现在」。没有任何样本时等同于本地钟 */
  now(): number
  report(): ClockReport
}

const DEFAULTS = {
  maxRttMs: 2000,
  sampleSize: 7,
  maxStepMs: 2000,
} as const

/** 日志阈值：应用量每挪够 1s 打一行，既能看见它在追又不会刷屏 */
const LOG_STEP_MS = 1000

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
}

export function createClockSync(options: ClockSyncOptions = {}): ClockSync {
  const {
    localNow = () => Date.now(),
    maxRttMs = DEFAULTS.maxRttMs,
    sampleSize = DEFAULTS.sampleSize,
    maxStepMs = DEFAULTS.maxStepMs,
    log = () => {},
  } = options

  const offsets: number[] = []
  let applied: number | null = null
  let syncedAt: number | null = null
  let lastLogged = 0

  return {
    observe(sample) {
      const { sentAt, receivedAt, serverDateMs } = sample
      if (!Number.isFinite(sentAt) || !Number.isFinite(receivedAt) || !Number.isFinite(serverDateMs)) return

      const rtt = receivedAt - sentAt
      // rtt < 0 只可能是本地钟在这次请求中途被改了 —— 那个样本本身就不可信
      if (rtt < 0 || rtt > maxRttMs) return

      // 服务器只给了一个时刻，取往返中点作为它对应的本地时刻
      offsets.push(serverDateMs - (sentAt + receivedAt) / 2)
      if (offsets.length > sampleSize) offsets.shift()

      const target = median(offsets)
      syncedAt = receivedAt

      if (applied === null) {
        // 首次：冷却表还是空的，跳多远都无害（见头注释）
        applied = target
        lastLogged = applied
        log(`[clock] 已校准：本机${applied >= 0 ? '慢' : '快'} ${Math.abs(Math.round(applied))} ms（源 HTTP Date，样本 ${offsets.length}）`)
        return
      }

      const delta = target - applied
      applied += Math.max(-maxStepMs, Math.min(maxStepMs, delta))

      if (Math.abs(applied - lastLogged) >= LOG_STEP_MS) {
        lastLogged = applied
        log(
          `[clock] 校准量调整至 ${Math.round(applied)} ms（目标 ${Math.round(target)} ms，单次上限 ${maxStepMs} ms，样本 ${offsets.length}）`
        )
      }
    },

    now() {
      return localNow() + (applied ?? 0)
    },

    report() {
      return {
        offsetMs: applied === null ? null : Math.round(applied),
        samples: offsets.length,
        // 从未采纳过样本时如实说「没有源」，不假装校准过（读不到就说读不到）
        source: applied === null ? 'NONE' : 'HTTP_DATE',
        syncedAt,
      }
    },
  }
}
