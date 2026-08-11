/**
 * 并发闸门（docs/03 §2.4 的请求礼节）。
 *
 * 免费接口没有配额说明，但滥用会被封。硬性上限：全局并发 ≤ 4、单 provider 并发 ≤ 2。
 * 这不是性能优化，是「别把接口用坏」——所以闸门在最底层，绕不过去。
 */

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

export function createLimiter(limit: number): Limiter {
  const max = Math.max(1, Math.floor(limit))
  let active = 0
  const queue: (() => void)[] = []

  const release = (): void => {
    active--
    // FIFO：先排队的先走，避免高频 tick 把低频的日线补齐永久饿死
    queue.shift()?.()
  }

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }
    active++
    try {
      return await task()
    } finally {
      release()
    }
  }
}

/** 串联多个闸门（全局 + 单源），外层先过 */
export function chainLimiters(...limiters: Limiter[]): Limiter {
  return async <T>(task: () => Promise<T>): Promise<T> =>
    limiters.reduceRight<() => Promise<T>>((next, limiter) => () => limiter(next), task)()
}
