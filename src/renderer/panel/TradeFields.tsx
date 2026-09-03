/**
 * 账本流水的表单字段（录入与「改一笔」共用，017）。
 *
 * ## 为什么抽出来
 *
 * 录入表单与流水行上的行内编辑用的是**同一组字段与同一套措辞**。
 * 各写一份的症状很具体：录入时「每股派现（税后）」而编辑时写「成交价」，
 * 于是用户改一笔分红时会去填每股派现前的那个数 —— 而账上完全看不出来。
 *
 * ## 字段随 side 变，这是这个组件的全部内容
 *
 * | side | 价 | 股数 | 独有的 |
 * |---|---|---|---|
 * | `BUY` / `SELL` | 成交价（不复权、不含费） | 股数 | 成交时刻 · 照哪条提醒做的 |
 * | `OPENING` | 成本价 | 股数 | **价含不含费**（默认不含） |
 * | `DIVIDEND` | 税后每股派现 | 分红股数 | — |
 * | `SPLIT` | 无（送股没付钱） | **新增**股数 | — |
 *
 * ⚠ **没有手续费输入框。** 它一律由费率算，对不上时改的是费率
 * （持仓卡上那个「校正成本」）—— 逐笔改数字会在账本里留下一批无从校对的孤立数。
 */

import type { TradeSide } from '@shared/ipc-types'

export const FIELD =
  'rounded border border-white/15 bg-black/25 px-2 py-1 text-[11px] outline-none focus:border-white/35'

export const SIDE_LABEL: Record<TradeSide, string> = {
  BUY: '买入',
  SELL: '卖出',
  OPENING: '建仓',
  DIVIDEND: '分红',
  SPLIT: '送转',
}

/** 录入表单里能选的那些。顺序按「用得多的在前」 */
export const ENTRY_SIDES: TradeSide[] = ['BUY', 'SELL', 'DIVIDEND', 'SPLIT', 'OPENING']

const SIDE_OPTION_LABEL: Record<TradeSide, string> = {
  BUY: '买入',
  SELL: '卖出',
  OPENING: '建仓（我早就持有）',
  DIVIDEND: '现金分红',
  SPLIT: '送股 / 转增',
}

/** 这种 side 有「价」这一栏吗 —— 只有送转没有（你一分钱没付） */
export function hasPrice(side: TradeSide): boolean {
  return side !== 'SPLIT'
}

export function priceLabel(side: TradeSide): string {
  if (side === 'OPENING') return '成本价'
  if (side === 'DIVIDEND') return '每股派现'
  return '成交价'
}

export function sharesLabel(side: TradeSide): string {
  if (side === 'DIVIDEND') return '分红股数'
  if (side === 'SPLIT') return '新增股数'
  return '股数'
}

/** 每种 side 底下那句说明。**只讲这一笔会怎么记账**，不给建议（措辞纪律） */
export function sideHint(side: TradeSide): React.JSX.Element {
  if (side === 'DIVIDEND') {
    return (
      <>
        填<span className="text-white/45">税后</span>每股派现（实际到账 ÷ 股数）。
        分红会<span className="text-white/45">按每股金额扣减摊薄成本</span>，不计入已实现盈亏
        —— 除权那天价格自己会掉下来，成本跟着掉，浮亏才不会凭空多一段。
      </>
    )
  }
  if (side === 'SPLIT') {
    return (
      <>
        填<span className="text-white/45">送到账的新增股数</span>（10 送 3、持 1000 股就填 300）。
        股数增加、成本按比例摊薄，<span className="text-white/45">总成本不变</span>
        —— 移动止损的参考价也会同步缩放。
      </>
    )
  }
  if (side === 'OPENING') {
    return (
      <>
        建仓是<span className="text-white/45">账本的起点</span>：这个日期之后的持仓从这里重新起算，
        通常只该有一笔、且在最前面。手续费按费率补算（除非你勾了「价已含费」）。
      </>
    )
  }
  return (
    <>
      填<span className="text-white/45">不复权真实成交价</span>（券商 App 上那个数，不含手续费）。
      手续费按你的费率自动算 —— 与券商对不上时去上面「校正成本」，不用逐笔改。
    </>
  )
}

/** 一组受控字段。父组件持有状态，这里只管布局与措辞 */
export function TradeFields({
  side,
  price,
  shares,
  tradedAt,
  tradedTime,
  feeIncluded,
  note,
  onSide,
  onPrice,
  onShares,
  onTradedAt,
  onTradedTime,
  onFeeIncluded,
  onNote,
  onNow,
  /** 编辑一笔已有流水时，side 下拉里要能出现 `OPENING`（它不在 ENTRY_SIDES 的常用位） */
  sides = ENTRY_SIDES,
}: {
  side: TradeSide
  price: string
  shares: string
  tradedAt: string
  /** `HH:mm`。空串 = 不知道 —— **提交时整个键不带**，落 NULL 而不是 12:00 */
  tradedTime: string
  feeIncluded: boolean
  note: string
  onSide: (next: TradeSide) => void
  onPrice: (next: string) => void
  onShares: (next: string) => void
  onTradedAt: (next: string) => void
  onTradedTime: (next: string) => void
  onFeeIncluded: (next: boolean) => void
  onNote: (next: string) => void
  onNow?: () => void
  sides?: TradeSide[]
}): React.JSX.Element {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <select className={FIELD} value={side} onChange={(e) => onSide(e.target.value as TradeSide)}>
          {sides.map((option) => (
            <option key={option} value={option}>
              {SIDE_OPTION_LABEL[option]}
            </option>
          ))}
        </select>

        {hasPrice(side) ? (
          <input
            className={`${FIELD} w-24 text-right font-mono`}
            value={price}
            placeholder={priceLabel(side)}
            inputMode="decimal"
            onChange={(e) => onPrice(e.target.value)}
          />
        ) : null}

        <input
          className={`${FIELD} w-24 text-right font-mono`}
          value={shares}
          placeholder={sharesLabel(side)}
          inputMode="numeric"
          onChange={(e) => onShares(e.target.value)}
        />

        <input
          className={`${FIELD} w-32`}
          type="date"
          value={tradedAt}
          title={
            side === 'DIVIDEND' || side === 'SPLIT'
              ? '除权除息日 / 到账日 —— 补录以前的也没问题，软件会按日期把它放回流水中间重算'
              : '成交日'
          }
          onChange={(e) => onTradedAt(e.target.value)}
        />

        {/* 真实成交时刻只对真成交有意义：分红送转不是一次决策，不进 IS 分解（016/017） */}
        {side === 'BUY' || side === 'SELL' ? (
          <>
            <input
              className={`${FIELD} w-20 font-mono`}
              type="time"
              value={tradedTime}
              title="真实成交时刻（可留空）。留空就是「不记得」—— 不会被当成中午 12 点"
              onChange={(e) => onTradedTime(e.target.value)}
            />
            {onNow ? (
              <button
                type="button"
                className="rounded border border-white/15 px-1.5 py-1 text-[10px] text-white/45 hover:border-white/35 hover:text-white/70"
                title="按现在的北京时间填上"
                onClick={onNow}
              >
                刚刚成交
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {/*
        建仓那个开关。**默认不含费**（用户手上多半是成交价而不是摊薄成本）——
        勾上之后那个价直接就是摊薄成本，不再补算费用。
      */}
      {side === 'OPENING' ? (
        <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-white/45">
          <input
            type="checkbox"
            checked={feeIncluded}
            onChange={(e) => onFeeIncluded(e.target.checked)}
          />
          这个价已经含手续费了（= 券商显示的摊薄成本）。不勾就按你的费率补算一笔
        </label>
      ) : null}

      <input
        className={`${FIELD} mt-1.5 w-full`}
        value={note}
        placeholder="备注（可空）"
        onChange={(e) => onNote(e.target.value)}
      />
    </>
  )
}
