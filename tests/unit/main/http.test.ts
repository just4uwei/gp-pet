import { describe, expect, it, vi } from 'vitest'
import { chainLimiters, createLimiter } from '@main/net/limiter'
import { createHttpClient, HttpError, parseHttpDate, USER_AGENT, type Transport } from '@main/net/http'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function client(transport: Transport, over: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({
    transport,
    sleep: async () => {},
    now: (() => {
      let t = 1000
      return () => (t += 25)
    })(),
    ...over,
  })
}

describe('createLimiter', () => {
  it('并发不超过上限，排队 FIFO', async () => {
    const limiter = createLimiter(2)
    let active = 0
    let peak = 0
    const order: number[] = []
    const resolvers: (() => void)[] = []

    const tasks = [0, 1, 2, 3].map((i) =>
      limiter(async () => {
        active++
        peak = Math.max(peak, active)
        order.push(i)
        await new Promise<void>((resolve) => resolvers.push(resolve))
        active--
        return i
      })
    )

    // 让已启动的任务逐个完成，腾出的槽位按入队顺序被占用
    while (resolvers.length > 0) {
      resolvers.shift()?.()
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(tasks)

    expect(peak).toBe(2)
    expect(order).toEqual([0, 1, 2, 3])
  })

  it('任务抛错也要放开槽位，否则一次失败就永久堵死', async () => {
    const limiter = createLimiter(1)
    await expect(limiter(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(limiter(async () => 'ok')).resolves.toBe('ok')
  })

  it('chainLimiters 全局与单源同时生效，取更严的那个', async () => {
    const limiter = chainLimiters(createLimiter(4), createLimiter(1))
    let active = 0
    let peak = 0
    await Promise.all(
      [1, 2, 3].map(() =>
        limiter(async () => {
          active++
          peak = Math.max(peak, active)
          await Promise.resolve()
          active--
        })
      )
    )
    expect(peak).toBe(1)
  })
})

describe('createHttpClient', () => {
  it('带上统一 UA，允许 provider 追加 Referer', async () => {
    const seen: Record<string, string>[] = []
    const http = client(async (_url, init) => {
      seen.push(init.headers)
      return { status: 200, bytes: utf8('ok') }
    })
    await http.get('https://example.com', { headers: { Referer: 'https://finance.sina.com.cn' } })
    expect(seen[0]?.['User-Agent']).toBe(USER_AGENT)
    expect(seen[0]?.['Referer']).toBe('https://finance.sina.com.cn')
  })

  it('GBK 响应按 GBK 解码 —— 否则股票名会静默变成乱码', async () => {
    // “浦发银行” 的 GBK 字节
    const gbk = new Uint8Array([0xc6, 0xd6, 0xb7, 0xa2, 0xd2, 0xf8, 0xd0, 0xd0])
    const http = client(async () => ({ status: 200, bytes: gbk }))
    expect((await http.get('u', { encoding: 'gbk' })).body).toBe('浦发银行')
    expect((await http.get('u')).body).not.toBe('浦发银行')
  })

  it('返回耗时，供健康度统计', async () => {
    const http = client(async () => ({ status: 200, bytes: utf8('ok') }))
    expect((await http.get('u')).latencyMs).toBe(25)
  })

  it('带 Date 头时回调计时，供时钟校准取样', async () => {
    const seen: unknown[] = []
    const http = client(async () => ({ status: 200, bytes: utf8('ok'), serverDateMs: 777_000 }), {
      onTiming: (t) => seen.push(t),
    })

    const response = await http.get('u')

    expect(response.serverDateMs).toBe(777_000)
    // now 每调一次 +25：sentAt=1025、receivedAt=1050
    expect(seen).toEqual([{ sentAt: 1025, receivedAt: 1050, serverDateMs: 777_000 }])
  })

  it('没有 Date 头就不回调 —— 「没有样本」不能退化成「样本是 0」', async () => {
    let calls = 0
    const http = client(async () => ({ status: 200, bytes: utf8('ok') }), {
      onTiming: () => {
        calls++
      },
    })

    const response = await http.get('u')

    expect(calls).toBe(0)
    expect(response.serverDateMs).toBeUndefined()
  })

  it('onTiming 抛错不能把一次成功的取数变成失败', async () => {
    const http = client(async () => ({ status: 200, bytes: utf8('ok'), serverDateMs: 1 }), {
      onTiming: () => {
        throw new Error('校时炸了')
      },
    })

    await expect(http.get('u')).resolves.toMatchObject({ body: 'ok' })
  })

  it('非 2xx 不取样：被挡下来的中间页上那个 Date 不是数据源的钟', async () => {
    let calls = 0
    const http = client(async () => ({ status: 403, bytes: utf8(''), serverDateMs: 1 }), {
      onTiming: () => {
        calls++
      },
    })

    await expect(http.get('u', { retries: 0 })).rejects.toThrow()
    expect(calls).toBe(0)
  })

  it('5xx 重试一次后成功', async () => {
    let calls = 0
    const http = client(async () => {
      calls++
      return calls === 1 ? { status: 502, bytes: utf8('') } : { status: 200, bytes: utf8('ok') }
    })
    expect((await http.get('u')).body).toBe('ok')
    expect(calls).toBe(2)
  })

  it('4xx 不重试 —— 请求本身就是错的', async () => {
    let calls = 0
    const http = client(async () => {
      calls++
      return { status: 404, bytes: utf8('') }
    })
    await expect(http.get('u')).rejects.toThrow(/HTTP 404/)
    expect(calls).toBe(1)
  })

  it('网络错误重试，重试次数可配为 0', async () => {
    let calls = 0
    const transport: Transport = async () => {
      calls++
      throw new Error('ECONNRESET')
    }
    const http = client(transport)
    await expect(http.get('u')).rejects.toThrow('ECONNRESET')
    expect(calls).toBe(2)

    calls = 0
    await expect(http.get('u', { retries: 0 })).rejects.toThrow('ECONNRESET')
    expect(calls).toBe(1)
  })

  it('退避是指数的，且第一次不等待', async () => {
    const sleeps: number[] = []
    const http = createHttpClient({
      transport: async () => {
        throw new Error('down')
      },
      retries: 3,
      backoffMs: 300,
      sleep: async (ms) => void sleeps.push(ms),
    })
    await expect(http.get('u')).rejects.toThrow('down')
    expect(sleeps).toEqual([300, 600, 1200])
  })

  it('超时按超时报错，并中止底层请求', async () => {
    vi.useFakeTimers()
    try {
      const aborted: boolean[] = []
      const http = createHttpClient({
        transport: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              aborted.push(true)
              reject(new Error('aborted'))
            })
          }),
        retries: 0,
        sleep: async () => {},
      })
      const pending = http.get('u', { timeoutMs: 3000 }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(3000)
      const error = await pending
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).kind).toBe('timeout')
      expect((error as HttpError).message).toContain('3000ms')
      expect(aborted).toEqual([true])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseHttpDate', () => {
  it('解析标准 HTTP 日期', () => {
    expect(parseHttpDate('Sat, 15 Aug 2026 07:31:20 GMT')).toBe(Date.UTC(2026, 7, 15, 7, 31, 20))
  })

  it('同名头出现多次时取第一条', () => {
    expect(parseHttpDate(['Sat, 15 Aug 2026 07:31:20 GMT', 'bogus'])).toBe(
      Date.UTC(2026, 7, 15, 7, 31, 20)
    )
  })

  /*
    这一条是「绝不用 0 兜底」那条纪律在这里的形状：解析失败返回 0 的话，
    校准量会变成「服务器停在 1970 年」≈ −56 年，而应用会一声不响地照着它算时段。
  */
  it('解析不出返回 null，不返回 0', () => {
    expect(parseHttpDate(undefined)).toBeNull()
    expect(parseHttpDate('')).toBeNull()
    expect(parseHttpDate('不是日期')).toBeNull()
  })
})
