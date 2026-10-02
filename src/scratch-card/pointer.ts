import type { Point } from './types.ts'

export interface ScrubHandlers {
  onDown: (point: Point) => void
  onMove: (point: Point) => void
  onUp: () => void
}

export function supportsPointerEvents(): boolean {
  return typeof window !== 'undefined' && 'PointerEvent' in window
}

function getCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): Point {
  const rect = canvas.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

/**
 * 绑定刮擦指针。主路径 Pointer Events（setPointerCapture + isPrimary 单指）；
 * 无 Pointer Events 的老 WebView 退化为 mouse + touch 双路
 * （touch 监听 passive:false 并 preventDefault 防页面滚动）。
 * 返回 disposer，destroy 时必须调用。
 */
export function bindScrubPointer(
  canvas: HTMLCanvasElement,
  handlers: ScrubHandlers,
): () => void {
  if (supportsPointerEvents()) {
    return bindPointerEvents(canvas, handlers)
  }
  return bindLegacyEvents(canvas, handlers)
}

function bindPointerEvents(
  canvas: HTMLCanvasElement,
  handlers: ScrubHandlers,
): () => void {
  let active = false

  const onPointerDown = (event: PointerEvent): void => {
    if (event.isPrimary === false) {
      return
    }
    active = true
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // 某些嵌入式 WebView 会在节点离文档时抛错，捕获本身不影响后续坐标
    }
    handlers.onDown(getCanvasPoint(canvas, event.clientX, event.clientY))
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!active || event.isPrimary === false) {
      return
    }
    const coalesced = event.getCoalescedEvents?.() ?? [event]
    for (const piece of coalesced) {
      handlers.onMove(getCanvasPoint(canvas, piece.clientX, piece.clientY))
    }
  }

  const finish = (event: PointerEvent): void => {
    if (!active || event.isPrimary === false) {
      return
    }
    active = false
    try {
      canvas.releasePointerCapture(event.pointerId)
    } catch {
      // 与 down 对称：捕获已随 up 自动释放时忽略
    }
    handlers.onUp()
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', finish)
  canvas.addEventListener('pointercancel', finish)

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', finish)
    canvas.removeEventListener('pointercancel', finish)
  }
}

function bindLegacyEvents(
  canvas: HTMLCanvasElement,
  handlers: ScrubHandlers,
): () => void {
  let mouseActive = false
  let touchIdentifier: number | null = null

  const onMouseDown = (event: MouseEvent): void => {
    mouseActive = true
    handlers.onDown(getCanvasPoint(canvas, event.clientX, event.clientY))
  }
  const onMouseMove = (event: MouseEvent): void => {
    if (!mouseActive) {
      return
    }
    handlers.onMove(getCanvasPoint(canvas, event.clientX, event.clientY))
  }
  const onMouseUp = (): void => {
    if (!mouseActive) {
      return
    }
    mouseActive = false
    handlers.onUp()
  }

  const onTouchStart = (event: TouchEvent): void => {
    if (touchIdentifier !== null || event.changedTouches.length === 0) {
      return
    }
    const touch = event.changedTouches[0]
    touchIdentifier = touch.identifier
    event.preventDefault()
    handlers.onDown(getCanvasPoint(canvas, touch.clientX, touch.clientY))
  }
  const onTouchMove = (event: TouchEvent): void => {
    const touch = findTrackedTouch(event.changedTouches, touchIdentifier)
    if (touch === null) {
      return
    }
    event.preventDefault()
    handlers.onMove(getCanvasPoint(canvas, touch.clientX, touch.clientY))
  }
  const onTouchEnd = (event: TouchEvent): void => {
    const touch = findTrackedTouch(event.changedTouches, touchIdentifier)
    if (touch === null) {
      return
    }
    event.preventDefault()
    touchIdentifier = null
    handlers.onUp()
  }

  canvas.addEventListener('mousedown', onMouseDown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  canvas.addEventListener('touchstart', onTouchStart, { passive: false })
  canvas.addEventListener('touchmove', onTouchMove, { passive: false })
  canvas.addEventListener('touchend', onTouchEnd, { passive: false })
  canvas.addEventListener('touchcancel', onTouchEnd, { passive: false })

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    canvas.removeEventListener('touchstart', onTouchStart)
    canvas.removeEventListener('touchmove', onTouchMove)
    canvas.removeEventListener('touchend', onTouchEnd)
    canvas.removeEventListener('touchcancel', onTouchEnd)
  }
}

function findTrackedTouch(list: TouchList, identifier: number | null): Touch | null {
  if (identifier === null) {
    return null
  }
  for (let i = 0; i < list.length; i += 1) {
    const touch = list[i]
    if (touch.identifier === identifier) {
      return touch
    }
  }
  return null
}

export function getDevicePixelRatio(): number {
  if (typeof window === 'undefined' || typeof window.devicePixelRatio !== 'number') {
    return 1
  }
  return Math.max(1, window.devicePixelRatio)
}

/**
 * 重建涂层位图：设置设备像素尺寸并一次性 setTransform(dpr)，
 * 此后所有绘制统一使用 CSS 像素坐标。返回 2D ctx（无 canvas 支持时 null）。
 */
export function applyBitmapSize(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): CanvasRenderingContext2D | null {
  canvas.width = Math.max(1, Math.round(cssWidth * dpr))
  canvas.height = Math.max(1, Math.round(cssHeight * dpr))
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return null
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

/**
 * 尺寸/DPR 变化后迁移已刮进度。
 * 目标 ctx 已重绘好完整新涂层，需要在「旧涂层透明」处再次抠穿。
 * 做法：把旧位图 alpha 反相得到擦除掩码（destination-out 叠黑底再做反相 alpha），
 * 再以 destination-out 绘制到目标。全流程按设备像素操作，不经过 DPR 变换。
 */
export function transferErasures(
  ctx: CanvasRenderingContext2D,
  oldCanvas: HTMLCanvasElement,
): void {
  if (oldCanvas.width === 0 || oldCanvas.height === 0) {
    return
  }
  const target = ctx.canvas

  const mask = document.createElement('canvas')
  mask.width = target.width
  mask.height = target.height
  const maskCtx = mask.getContext('2d')
  if (maskCtx === null) {
    return
  }

  // 1) 把旧位图缩放画进 mask（设备像素空间，仅取其 alpha：有涂层不透明，已刮透明）
  maskCtx.drawImage(
    oldCanvas,
    0,
    0,
    oldCanvas.width,
    oldCanvas.height,
    0,
    0,
    mask.width,
    mask.height,
  )

  // 2) 反相 alpha 得到「已刮掩码」：destination-out 一张全白 mask，
  //    白色被旧涂层 alpha 抠掉（有涂层处变透明），旧透明处（已刮）保留不透明白。
  const inverse = document.createElement('canvas')
  inverse.width = mask.width
  inverse.height = mask.height
  const inverseCtx = inverse.getContext('2d')
  if (inverseCtx === null) {
    return
  }
  inverseCtx.fillStyle = '#ffffff'
  inverseCtx.fillRect(0, 0, inverse.width, inverse.height)
  inverseCtx.globalCompositeOperation = 'destination-out'
  inverseCtx.drawImage(mask, 0, 0)

  // 3) 以已刮掩码 destination-out 抠穿新涂层
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(inverse, 0, 0)
  ctx.restore()
}

/**
 * 监听 CSS 尺寸变化（ResizeObserver）与跨屏 DPR 变化（resolution 媒体查询）。
 * 任一变化都回调，由工厂决定重建位图还是仅重绘。返回 disposer。
 */
export function observeCanvasGeometry(
  element: Element,
  onChange: () => void,
): () => void {
  const cleanups: Array<() => void> = []

  let resizeObserver: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => onChange())
    resizeObserver.observe(element)
    cleanups.push(() => resizeObserver?.disconnect())
  } else {
    window.addEventListener('resize', onChange)
    cleanups.push(() => window.removeEventListener('resize', onChange))
  }

  // 跨屏拖窗 DPR 变化（同 CSS 尺寸 ResizeObserver 不触发）：用 dpr 边界查询，
  // 1/4 dpr 精度覆盖 1.5/2.5/3 等真实设备，跨越任一边界即重建位图。
  if (typeof window.matchMedia === 'function') {
    for (let step = 5; step <= 16; step += 1) {
      const dpr = step / 4
      const query = window.matchMedia(`(resolution: ${dpr}dppx)`)
      query.addEventListener('change', onChange)
      cleanups.push(() => query.removeEventListener('change', onChange))
    }
  }

  return () => {
    for (const dispose of cleanups) {
      dispose()
    }
  }
}
