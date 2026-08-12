/**
 * 确定性的合成日线生成器。
 *
 * 为什么是合成而不是真实日线：docs/07 §2.1 要求取沪深300 成分若干只各 500 根做交叉验证，
 * 但本机到三家行情接口不通（见 docs/notes/M1-偏差报告.md），拿不到真实序列。
 * 合成序列能验证的是**算法一致性**（两套独立实现是否给出同一组数），
 * 验证不了的是**口径一致性**（我们的 MACD 柱是否与通达信显示的一致）——
 * 后者要等真机联网，见 docs/notes/M2-偏差报告.md。
 *
 * 用固定种子的 LCG，不用 Math.random：黄金用例必须每次生成都一模一样，
 * 否则「回归基线」就是每天都在变的东西。
 */

/** 数值配方（Numerical Recipes）的 LCG 常数；周期足够长，分布对本用途足够 */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Box–Muller，把均匀分布变成标准正态 */
function gaussian(rand) {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * 生成 n 根日线。刻意把三种形态串起来（上涨 → 震荡 → 下跌 → 再上涨），
 * 这样一条序列就能同时覆盖 TREND_UP / RANGE / TREND_DOWN 的判定分支，
 * 也保证 ADX / BBW 分位不会是一条直线（那种序列测不出什么）。
 */
export function syntheticCandles(n = 500, seed = 20260811) {
  const rand = lcg(seed)
  const candles = []
  let price = 10
  let date = Date.UTC(2022, 0, 3) // 从一个周一开始，便于周线聚合覆盖完整周

  for (let i = 0; i < n; i++) {
    const phase = Math.floor((i / n) * 4)
    const drift = [0.0022, 0.0, -0.0018, 0.0015][phase] ?? 0
    const vol = [0.014, 0.008, 0.02, 0.012][phase] ?? 0.012

    const change = drift + vol * gaussian(rand)
    const open = price
    const close = Math.max(0.5, price * (1 + change))
    const wick = Math.abs(gaussian(rand)) * vol * price
    const high = Math.max(open, close) + wick * 0.6
    const low = Math.max(0.3, Math.min(open, close) - wick * 0.6)
    // 成交量与当日波幅正相关，再叠一层噪音 —— 让量比有分辨力
    const volume = Math.round(1_000_000 * (1 + Math.abs(change) * 30) * (0.6 + rand() * 0.8))

    candles.push({
      date: toDate(date),
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      openAdj: round2(open),
      highAdj: round2(high),
      lowAdj: round2(low),
      closeAdj: round2(close),
      volume,
      amount: Math.round(volume * close),
    })

    price = close
    date = nextWeekday(date)
  }

  return candles
}

function round2(value) {
  return Math.round(value * 100) / 100
}

function toDate(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 跳过周末。节假日不模拟 —— 那会引入 hasGap，而缺口的处理有自己的用例 */
function nextWeekday(ms) {
  let next = ms + 86_400_000
  const day = new Date(next).getUTCDay()
  if (day === 6) next += 2 * 86_400_000
  else if (day === 0) next += 86_400_000
  return next
}
