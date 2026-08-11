/**
 * 桌宠窗口 —— C2 点击穿透的判定端（docs/06 §2.2）。
 *
 * Electron 只有窗口级的 setIgnoreMouseEvents，没有像素级命中测试，所以判定必须在这里做：
 *   默认穿透 + forward:true → 窗口仍收得到 mousemove
 *   → 本文件用矩形命中区判断鼠标是否压在本体上
 *   → 状态翻转时才发一次 IPC 让主进程开/关穿透
 *
 * 只在状态翻转时发 IPC 是关键：mousemove 每秒可达上百次，每次都跨进程会把
 * C7「休市零开销」的预算吃光。
 *
 * M0 只画静态首帧。逐帧动画属 M3（docs/08）—— 骨架阶段不需要动起来，需要的是穿透判得准。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hitTest } from '@shared/hit-test'
import type { PetAnimationKey, PetSkinView, PetState } from '@shared/ipc-types'

const STATE_TO_ANIMATION: Record<PetState, PetAnimationKey> = {
  SLEEPY: 'sleepy',
  IDLE: 'idle',
  WATCHING: 'watching',
  EXCITED: 'excited',
  ALERT: 'alert',
  OFFLINE: 'offline',
}

/** 位移超过这个距离就算拖拽，不再当作单击 */
const DRAG_SLOP_PX = 4
/** 区分单击与双击的等待窗口 */
const DOUBLE_CLICK_MS = 250

interface DragState {
  lastScreenX: number
  lastScreenY: number
  travelled: number
}

export function App(): React.JSX.Element {
  const [skin, setSkin] = useState<PetSkinView | null>(null)
  const [petState, setPetState] = useState<PetState>('IDLE')

  const dragRef = useRef<DragState | null>(null)
  /** 本地缓存的穿透状态，避免每次 mousemove 都发 IPC */
  const interactiveRef = useRef(false)
  const clickTimerRef = useRef<number | null>(null)

  useEffect(() => {
    void window.gp.invoke('pet:getSkin').then(setSkin)
    return window.gp.on('push:petState', setPetState)
  }, [])

  const canvas = skin?.canvas ?? { width: 200, height: 200 }
  // 窗口比 canvas 大一圈（220 vs 200），本体居中放置；命中区坐标要补上这个偏移
  const offset = useMemo(
    () => ({
      x: Math.round((window.innerWidth - canvas.width) / 2),
      y: Math.round((window.innerHeight - canvas.height) / 2),
    }),
    [canvas.width, canvas.height]
  )

  useEffect(() => {
    if (skin) void window.gp.invoke('pet:setHitRegion', skin.hitRects)
  }, [skin])

  const setInteractive = useCallback((next: boolean) => {
    if (interactiveRef.current === next) return
    interactiveRef.current = next
    void window.gp.invoke('pet:setInteractive', next)
  }, [])

  // ── 命中判定 + 拖拽 ────────────────────────────────────────────────
  useEffect(() => {
    if (!skin) return

    const onMouseMove = (event: MouseEvent): void => {
      const drag = dragRef.current
      if (drag) {
        const dx = event.screenX - drag.lastScreenX
        const dy = event.screenY - drag.lastScreenY
        if (dx !== 0 || dy !== 0) {
          drag.lastScreenX = event.screenX
          drag.lastScreenY = event.screenY
          drag.travelled += Math.abs(dx) + Math.abs(dy)
          void window.gp.invoke('pet:dragBy', dx, dy)
        }
        return // 拖拽期间不做命中判定，否则拖出本体范围会立刻穿透并丢掉拖拽
      }
      setInteractive(hitTest(skin.hitRects, event.clientX, event.clientY, offset.x, offset.y))
    }

    const onMouseUp = (): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      if (drag.travelled > DRAG_SLOP_PX) void window.gp.invoke('pet:dragEnd')
    }

    // 鼠标快速掠出窗口时可能收不到最后一个 mousemove，
    // 不补这一手会让窗口停在「可交互」状态，把下层应用的点击吃掉 —— C2 的典型破法
    const onMouseLeave = (): void => {
      if (!dragRef.current) setInteractive(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [skin, offset.x, offset.y, setInteractive])

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    }
  }, [])

  // ── 手势（docs/06 §4）────────────────────────────────────────────
  const onMouseDown = (event: React.MouseEvent): void => {
    if (event.button !== 0) return
    dragRef.current = { lastScreenX: event.screenX, lastScreenY: event.screenY, travelled: 0 }
  }

  const onClick = (): void => {
    // 单击要等一个双击窗口期，否则双击会先触发一次面板开关（docs/06 §4）
    if (clickTimerRef.current !== null) return
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      void window.gp.invoke('panel:toggle')
    }, DOUBLE_CLICK_MS)
  }

  const onDoubleClick = (): void => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    void window.gp.invoke('pet:toggleDoNotDisturb')
  }

  const onContextMenu = (event: React.MouseEvent): void => {
    event.preventDefault()
    void window.gp.invoke('pet:contextMenu')
  }

  // ── 绘制 ─────────────────────────────────────────────────────────
  const animation = skin?.states[STATE_TO_ANIMATION[petState]]
  const useRetina = window.devicePixelRatio >= 1.5 && animation?.url2x
  const sheetUrl = useRetina ? animation?.url2x : animation?.url

  const petStyle: React.CSSProperties = {
    left: offset.x,
    top: offset.y,
    width: canvas.width,
    height: canvas.height,
    ...(sheetUrl
      ? {
          backgroundImage: `url("${sheetUrl}")`,
          // 图集是单行 N 列（docs/09 §2.3）；@2x 图按 CSS 像素缩回 @1x 尺寸，
          // 由浏览器在高 DPI 屏上用足原始像素
          backgroundSize: `${canvas.width * (animation?.frames ?? 1)}px ${canvas.height}px`,
        }
      : {}),
  }

  return (
    <div
      className="stage"
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className={sheetUrl ? 'pet' : 'pet pet--placeholder'} style={petStyle} />

      {import.meta.env.DEV && skin
        ? skin.hitRects.map((rect, index) => (
            <div
              key={`${rect.x}:${rect.y}:${index}`}
              className="hitbox"
              style={{
                left: offset.x + rect.x,
                top: offset.y + rect.y,
                width: rect.w,
                height: rect.h,
              }}
            />
          ))
        : null}

      {import.meta.env.DEV ? (
        <div className="debug">
          {petState} · {skin?.fallback ? '占位皮肤' : (skin?.id ?? '…')}
        </div>
      ) : null}
    </div>
  )
}
