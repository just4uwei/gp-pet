/**
 * 桌宠 / 状态点状态机（src/main/alerts/pet-state.ts，docs/06 §3）。
 *
 * 要验的是优先级与**回落时机**：3s 最短驻留、tick 间隔 30s，
 * 若回落时机写错，一个动画会挂满半分钟（看起来像卡住），或者根本来不及播完。
 *
 * 还有一条容易写错的：免打扰（base = SLEEPY）期间只做一次极轻微的表情变化，
 * 不进 WATCHING（docs/05 §4.4 的低调态）。
 */

import { describe, expect, it } from 'vitest'
import { PetStateMachine } from '@main/alerts/pet-state'

const T0 = 1_700_000_000_000

describe('优先级（OFFLINE > ALERT > EXCITED > WATCHING > IDLE > SLEEPY）', () => {
  it('买入提醒点亮 EXCITED，卖出提醒点亮 ALERT', () => {
    const buy = new PetStateMachine()
    buy.onAlert('BUY', T0)
    expect(buy.resolve('IDLE', T0)).toBe('EXCITED')

    const sell = new PetStateMachine()
    sell.onAlert('SELL', T0)
    expect(sell.resolve('IDLE', T0)).toBe('ALERT')

    const reduce = new PetStateMachine()
    reduce.onAlert('REDUCE', T0)
    expect(reduce.resolve('IDLE', T0)).toBe('ALERT')
  })

  it('同一轮里 ALERT 压过 EXCITED —— 有仓位要处理比有机会更该被看见', () => {
    const pet = new PetStateMachine()
    pet.onAlert('SELL', T0)
    pet.onAlert('BUY', T0)
    expect(pet.resolve('IDLE', T0)).toBe('ALERT')
  })

  it('数据源全挂时不谈信号：OFFLINE 压过一切', () => {
    const pet = new PetStateMachine()
    pet.onAlert('SELL', T0)
    expect(pet.resolve('OFFLINE', T0)).toBe('OFFLINE')
  })

  it('明日观察这种降级方向不点亮高优先级表情，但仍算「刚有事发生」', () => {
    const pet = new PetStateMachine()
    pet.onAlert('NEXT_DAY_WATCH', T0)
    expect(pet.resolve('IDLE', T0)).toBe('WATCHING')
  })
})

describe('最短驻留与回落', () => {
  it('高优先级状态驻留 3s 后回落到 WATCHING，再过 watchingMs 回到 IDLE', () => {
    const pet = new PetStateMachine({ minHoldMs: 3_000, watchingMs: 60_000 })
    pet.onAlert('BUY', T0)

    expect(pet.resolve('IDLE', T0 + 2_999)).toBe('EXCITED')
    expect(pet.resolve('IDLE', T0 + 3_000)).toBe('WATCHING')
    expect(pet.resolve('IDLE', T0 + 59_999)).toBe('WATCHING')
    expect(pet.resolve('IDLE', T0 + 60_000)).toBe('IDLE')
  })

  it('nextChangeAt 报出下一次会自己变化的时刻 —— 没有它，3s 的驻留会变成 30s', () => {
    const pet = new PetStateMachine({ minHoldMs: 3_000, watchingMs: 60_000 })
    expect(pet.nextChangeAt(T0)).toBeNull()

    pet.onAlert('BUY', T0)
    expect(pet.nextChangeAt(T0)).toBe(T0 + 3_000)
    // 驻留过了之后还剩 WATCHING → IDLE 那一档
    expect(pet.nextChangeAt(T0 + 3_000)).toBe(T0 + 60_000)
    expect(pet.nextChangeAt(T0 + 60_000)).toBeNull()
  })

  it('驻留期内来第二条同向提醒会续上驻留', () => {
    const pet = new PetStateMachine({ minHoldMs: 3_000 })
    pet.onAlert('BUY', T0)
    pet.onAlert('BUY', T0 + 2_000)
    expect(pet.resolve('IDLE', T0 + 4_000)).toBe('EXCITED')
  })
})

describe('低调态（docs/05 §4.4）', () => {
  it('免打扰 / 休市期间仍做一次极轻微的表情变化', () => {
    const pet = new PetStateMachine({ minHoldMs: 3_000 })
    pet.onAlert('SELL', T0)
    expect(pet.resolve('SLEEPY', T0 + 1_000)).toBe('ALERT')
  })

  it('但驻留结束后直接回 SLEEPY，不经过 WATCHING', () => {
    const pet = new PetStateMachine({ minHoldMs: 3_000, watchingMs: 60_000 })
    pet.onAlert('SELL', T0)
    expect(pet.resolve('SLEEPY', T0 + 3_000)).toBe('SLEEPY')
  })
})

describe('onActivity：有候选但一条都没发出', () => {
  it('够得上 WATCHING，够不上表情 —— 被闸门挡下的不许点亮 EXCITED/ALERT', () => {
    const pet = new PetStateMachine({ watchingMs: 60_000 })
    pet.onActivity(T0)
    expect(pet.resolve('IDLE', T0)).toBe('WATCHING')
    expect(pet.resolve('IDLE', T0 + 60_000)).toBe('IDLE')
  })
})
