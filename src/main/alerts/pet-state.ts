/**
 * 桌宠 / 状态点的状态机（docs/06 §3）。
 *
 * 状态优先级：`OFFLINE > ALERT > EXCITED > WATCHING > IDLE > SLEEPY`。
 * 前三态由**实际发出的提醒**驱动，后三态由数据层给（离线 / 休市 / 盘中）。
 *
 * ## 三条约束
 *
 * 1. **只有过了四道闸门的提醒才能点亮表情。** 这是 M2 期间反复写在注释里的那条纪律
 *    （src/renderer/bar/App.tsx、controller.ts）：表情是提醒的**表现层**，
 *    绕过闸门直接点亮等于用一个没人管的通道骚扰用户。被丢弃与被降级的候选
 *    因此不进这里 —— 但**降级到 L1 的会进**，L1 的定义本来就是「只改表情 + 角标」。
 *
 * 2. **高优先级状态有最短驻留（3s）。** 一轮 tick 30s，若不设驻留，
 *    一条 EXCITED 会一直挂到下一轮才回落，看起来像卡住了；而若立刻回落，
 *    动画根本来不及播完（docs/09 的 `minHold`）。
 *
 * 3. **免打扰期间只做一次极轻微的表情变化，不进 WATCHING**（docs/05 §4.4 低调态）。
 *    所以驻留期结束后直接回到 SLEEPY，不经过 WATCHING 那一档。
 *
 * 不读时钟：`now` 一律由调用方传入，与 AlertDispatcher 同一条纪律。
 */

import type { GatedDirection } from '@core/types'
import type { PetState } from '@shared/ipc-types'

export interface PetStateOptions {
  /** 高优先级状态的最短驻留（docs/06 §3：3s） */
  minHoldMs?: number
  /** 出过提醒之后维持 WATCHING 的时长 —— 「刚刚有事发生」比「无事发生」多一档 */
  watchingMs?: number
}

/** 卖出类给警戒，买入类给兴奋；明日观察这种降级方向不值得一个高优先级动画 */
function highStateOf(direction: GatedDirection): 'ALERT' | 'EXCITED' | null {
  if (direction === 'SELL' || direction === 'REDUCE') return 'ALERT'
  if (direction === 'BUY') return 'EXCITED'
  return null
}

export class PetStateMachine {
  private readonly minHoldMs: number
  private readonly watchingMs: number

  private highState: 'ALERT' | 'EXCITED' | null = null
  private highUntil = 0
  private watchUntil = 0

  constructor(options: PetStateOptions = {}) {
    this.minHoldMs = options.minHoldMs ?? 3_000
    this.watchingMs = options.watchingMs ?? 60_000
  }

  /**
   * 一条提醒**实际发出**时调用（含被降级为 L1 的）。
   *
   * 同一轮里多条提醒时，ALERT 压过 EXCITED —— 「有仓位要处理」比「有机会」更该被看见。
   */
  onAlert(direction: GatedDirection, now: number): void {
    this.watchUntil = now + this.watchingMs
    const next = highStateOf(direction)
    if (!next) return
    const keepCurrent = this.highState === 'ALERT' && next === 'EXCITED' && now < this.highUntil
    if (keepCurrent) return
    this.highState = next
    this.highUntil = now + this.minHoldMs
  }

  /** 本轮有候选在算但一条都没发出（被闸门挡了）：够得上 WATCHING，够不上表情 */
  onActivity(now: number): void {
    if (this.watchUntil < now + this.watchingMs) this.watchUntil = now + this.watchingMs
  }

  /**
   * 当前应显示的状态。
   * `base` 是数据层给的底：OFFLINE / SLEEPY（休市或免打扰）/ IDLE（盘中无事）。
   */
  resolve(base: PetState, now: number): PetState {
    // 数据源全挂时不谈信号：那时的信号都是拿旧数据算出来的
    if (base === 'OFFLINE') return 'OFFLINE'
    if (this.highState !== null && now < this.highUntil) return this.highState
    // 免打扰 / 休市的低调态：不进 WATCHING（docs/05 §4.4）
    if (base === 'IDLE' && now < this.watchUntil) return 'WATCHING'
    return base
  }

  /**
   * 下一次状态会自己变化的时刻，null = 不需要定时器。
   *
   * 调用方据此安排一次重推：状态机是时间驱动的，而 tick 每 30s 才来一次 ——
   * 不补这一下，3s 的驻留会变成 30s。
   */
  nextChangeAt(now: number): number | null {
    const pending = [this.highUntil, this.watchUntil].filter((at) => at > now)
    return pending.length > 0 ? Math.min(...pending) : null
  }
}
