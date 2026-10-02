/**
 * 指针输入（设计 C2/C3/E 矩阵）：
 * - 主路径 Pointer Events（pointerdown/move/up/cancel + setPointerCapture）；
 * - 降级路径（'PointerEvent' in window 为假）：mouse + touch 双套，
 *   touch 使用 { passive: false } + preventDefault 阻止页面滚动；
 * - 坐标一律 clientX/Y 减 getBoundingClientRect，与 DPR setTransform 后的
 *   CSS 像素绘图坐标系对齐（不使用有浏览器差异的 offsetX/Y）；
 * - 仅主指针/单指有效，额外手指忽略。
 */
import type { Point } from './types.ts'

export interface PointerInputHandlers {
  onDown: (point: Point, event: PointerEvent) => void
  onMove: (point: Point, event: PointerEvent) => void
  onUp: (point: Point, event: PointerEvent) => void
  onCancel: (point: Point, event: PointerEvent) => void
}

/** 客户端坐标 → 相对 canvas 的 CSS 像素坐标 */
export function clientToCanvasPoint(
  target: HTMLElement,
  clientX: number,
  clientY: number,
): Point {
  const rect = target.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

export function supportsPointerEvents(): boolean {
  return typeof window !== 'undefined' && 'PointerEvent' in window
}

/**
 * 把输入事件绑定到目标元素，返回解绑函数。
 * Pointer Events 路径监听挂在元素上并在 down 时捕获指针，
 * 划出画布后仍能收到 move/up/cancel，因此无需 window 兜底。
 */
export function bindPointerInput(
  target: HTMLElement,
  handlers: PointerInputHandlers,
): () => void {
  if (supportsPointerEvents()) {
    return bindModern(target, handlers)
  }
  return bindLegacy(target, handlers)
}

function bindModern(
  target: HTMLElement,
  handlers: PointerInputHandlers,
): () => void {
  let activeId = -1

  const resolve = (event: PointerEvent): Point =>
    clientToCanvasPoint(target, event.clientX, event.clientY)

  const handleDown = (event: PointerEvent): void => {
    // 仅主键（鼠标左键）与单指；右键/中键/多指忽略
    if (activeId !== -1) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    activeId = event.pointerId
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // 某些环境下指针已释放，忽略捕获失败即可
    }
    handlers.onDown(resolve(event), event)
  }

  const handleMove = (event: PointerEvent): void => {
    if (event.pointerId !== activeId) return
    handlers.onMove(resolve(event), event)
  }

  const finish = (
    event: PointerEvent,
    fn: (point: Point, event: PointerEvent) => void,
  ): void => {
    if (event.pointerId !== activeId) return
    activeId = -1
    try {
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId)
      }
    } catch {
      // 忽略释放失败
    }
    fn(resolve(event), event)
  }

  const handleUp = (event: PointerEvent): void => finish(event, handlers.onUp)
  const handleCancel = (event: PointerEvent): void =>
    finish(event, handlers.onCancel)

  target.addEventListener('pointerdown', handleDown)
  target.addEventListener('pointermove', handleMove)
  target.addEventListener('pointerup', handleUp)
  target.addEventListener('pointercancel', handleCancel)

  return () => {
    target.removeEventListener('pointerdown', handleDown)
    target.removeEventListener('pointermove', handleMove)
    target.removeEventListener('pointerup', handleUp)
    target.removeEventListener('pointercancel', handleCancel)
  }
}

/**
 * 旧 WebView 降级：mouse + touch。
 * touch 监听 passive:false 以便 preventDefault（touch-action 不被识别时的防线）。
 * 用时间戳抑制 touch 后浏览器合成的模拟 mouse 事件，避免双路竞态。
 */
function bindLegacy(
  target: HTMLElement,
  handlers: PointerInputHandlers,
): () => void {
  let mouseDown = false
  let touchId: number | null = null
  let lastTouchEndAt = 0

  const fromMouse = (event: MouseEvent): Point =>
    clientToCanvasPoint(target, event.clientX, event.clientY)
  const fromTouch = (touch: Touch): Point =>
    clientToCanvasPoint(target, touch.clientX, touch.clientY)
  const toPointerLike = (
    point: Point,
    pointerType: 'mouse' | 'touch',
  ): PointerEvent =>
    ({
      clientX: point.x,
      clientY: point.y,
      pointerType,
      pointerId: pointerType === 'mouse' ? -1 : (touchId ?? 0),
      button: 0,
      getCoalescedEvents: undefined,
    }) as unknown as PointerEvent

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    if (performance.now() - lastTouchEndAt < 500) return
    mouseDown = true
    const point = fromMouse(event)
    handlers.onDown(point, toPointerLike(point, 'mouse'))
  }
  const handleMouseMove = (event: MouseEvent): void => {
    if (!mouseDown) return
    const point = fromMouse(event)
    handlers.onMove(point, toPointerLike(point, 'mouse'))
  }
  const handleMouseUp = (event: MouseEvent): void => {
    if (!mouseDown) return
    mouseDown = false
    const point = fromMouse(event)
    handlers.onUp(point, toPointerLike(point, 'mouse'))
  }

  const handleTouchStart = (event: TouchEvent): void => {
    if (touchId !== null) return
    const touch = event.changedTouches[0]
    if (!touch) return
    touchId = touch.identifier
    event.preventDefault()
    const point = fromTouch(touch)
    handlers.onDown(point, toPointerLike(point, 'touch'))
  }
  const handleTouchMove = (event: TouchEvent): void => {
    const touch = findTouch(event.changedTouches, touchId)
    if (!touch) return
    event.preventDefault()
    const point = fromTouch(touch)
    handlers.onMove(point, toPointerLike(point, 'touch'))
  }
  const endTouch = (
    event: TouchEvent,
    fn: (point: Point, event: PointerEvent) => void,
  ): void => {
    const touch = findTouch(event.changedTouches, touchId)
    if (!touch) return
    touchId = null
    lastTouchEndAt = performance.now()
    const point = fromTouch(touch)
    fn(point, toPointerLike(point, 'touch'))
  }
  const handleTouchEnd = (event: TouchEvent): void => {
    endTouch(event, (point, synthetic) => {
      event.preventDefault()
      handlers.onUp(point, synthetic)
    })
  }
  const handleTouchCancel = (event: TouchEvent): void =>
    endTouch(event, handlers.onCancel)

  target.addEventListener('mousedown', handleMouseDown)
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
  target.addEventListener('touchstart', handleTouchStart, { passive: false })
  target.addEventListener('touchmove', handleTouchMove, { passive: false })
  target.addEventListener('touchend', handleTouchEnd, { passive: false })
  target.addEventListener('touchcancel', handleTouchCancel, { passive: false })

  return () => {
    target.removeEventListener('mousedown', handleMouseDown)
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mouseup', handleMouseUp)
    target.removeEventListener('touchstart', handleTouchStart)
    target.removeEventListener('touchmove', handleTouchMove)
    target.removeEventListener('touchend', handleTouchEnd)
    target.removeEventListener('touchcancel', handleTouchCancel)
  }
}

function findTouch(list: TouchList, id: number | null): Touch | undefined {
  if (id === null) return undefined
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].identifier === id) return list[i]
  }
  return undefined
}
