/**
 * 「小猫」皮肤调色板（docs/09 §1.3 语义色 + §2.4 限色）。
 *
 * 形象选了**奶白灰虎斑猫**而不是常见的橘猫，是被语义色逼出来的：
 * §1.3 规定风险提示一律暖橙（#E8721C）、机会提示一律金黄（#F2C230）。
 * 橘猫的固有色会和这两个色系糊在一起，`alert` 举起的橙色小旗子就看不出来了。
 * 奶白灰底色与两个语义色都拉开了距离，同时在深浅两种壁纸上都靠深色描边保住轮廓。
 *
 * 眼睛用蓝灰而非猫常见的琥珀/绿：琥珀撞语义色，绿撞 A 股跌色（§7.2）。
 */

/** 索引 0 恒为透明槽 */
const SLOTS = [
  null,

  // 描边 —— 全皮肤唯一一个描边色（§2.4）
  ['outline', '#2A2028'],

  // 毛色四档。部件分界用其中的暗部色，不另加深色描边（§2.4）
  ['furLight', '#FDFBF5'],
  ['furBase', '#EFE7DA'],
  ['furMid', '#D9CDBB'],
  ['furDeep', '#B5A692'],

  // 耳内 / 鼻头 / 肉垫
  ['nosePink', '#E8A0A8'],

  // 眼睛
  ['eyeIris', '#5B7FA6'],

  // 语义色：风险（§1.3，逐字固定）
  ['riskAmber', '#E8721C'],
  ['riskAmberLight', '#F59D4E'],

  // 语义色：机会（§1.3，逐字固定）
  ['chanceGold', '#F2C230'],
  ['chanceGoldLight', '#F8DE7A'],

  // 语义色：离线灰阶四档（§1.3，逐字固定）
  ['offlineDarkest', '#4A4E5A'],
  ['offlineDark', '#9AA0B4'],
  ['offlineLight', '#C8CCD9'],
  ['offlineLightest', '#ECEEF2'],

  // 极简色点专用（§6.1，跨皮肤统一）
  ['dotSleepyStroke', '#6F748A'],
  ['dotWatching', '#6C8EBF'],
  ['dotOffline', '#6B7080'],
]

export const C = {}
SLOTS.forEach((slot, index) => {
  if (slot) C[slot[0]] = index
})

const HEX = SLOTS.map((slot) => (slot ? slot[1] : null))

export function rgb(index) {
  const hex = HEX[index]
  if (!hex) throw new Error(`索引 ${index} 不是实色`)
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

export const palette = { rgb }

/** palette.json 的 colors 字段：全皮肤实际用色 */
export const allColors = HEX.filter(Boolean)

export const OUTLINE_HEX = '#2A2028'

/**
 * 离线去饱和映射（docs/09 §4.8：同一套形体换色，不重画）。
 * 四档毛色一一对应四档离线灰，明暗层次原样保留 —— 去饱和不等于降对比。
 */
export const OFFLINE_MAP = {
  [C.furLight]: C.offlineLightest,
  [C.furBase]: C.offlineLight,
  [C.furMid]: C.offlineDark,
  [C.furDeep]: C.offlineDarkest,
  [C.nosePink]: C.offlineDark,
  [C.eyeIris]: C.offlineDarkest,
}

export function desaturate(grid) {
  for (let i = 0; i < grid.px.length; i++) {
    const mapped = OFFLINE_MAP[grid.px[i]]
    if (mapped !== undefined) grid.px[i] = mapped
  }
  return grid
}
