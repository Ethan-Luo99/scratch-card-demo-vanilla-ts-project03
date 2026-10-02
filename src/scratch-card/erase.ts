import type { Point } from './types.ts'

export interface StampContext {
  beginPath: () => void
  arc: (
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ) => void
  fill: () => void
  save: () => void
  restore: () => void
  globalCompositeOperation: GlobalCompositeOperation
}

/**
 * 在 from→to 之间按 maxSegment 线性插值补点。
 * - 距离为 0（含首点）时仅返回 [to]，保证 pointerdown 也能立刻戳出一个点；
 * - 否则按 ceil(dist/maxSegment) 等分，返回 1..steps 上的插值点（不含 from，含 to）。
 * 纯函数：不触碰 DOM/canvas，便于 node:test 直接验证。
 */
export function interpolatePath(
  from: Point,
  to: Point,
  maxSegment: number,
): Point[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance === 0) {
    return [{ x: to.x, y: to.y }]
  }
  if (maxSegment <= 0) {
    return [{ x: to.x, y: to.y }]
  }
  const steps = Math.max(1, Math.ceil(distance / maxSegment))
  const points: Point[] = []
  for (let i = 1; i <= steps; i += 1) {
    const ratio = i / steps
    points.push({ x: from.x + dx * ratio, y: from.y + dy * ratio })
  }
  return points
}

/** 两点距离（纯函数）。 */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 把单个点以 destination-out 合成模式戳成实心圆，实现擦除。 */
export function eraseStamp(
  ctx: StampContext,
  point: Point,
  brushRadius: number,
): void {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(point.x, point.y, brushRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * 沿 from→to 整段擦除：插值补点后逐点戳圆，快速滑动不断线。
 * 返回实际戳出的点数（供测试/调试）。
 */
export function eraseSegment(
  ctx: StampContext,
  from: Point,
  to: Point,
  brushRadius: number,
  maxSegment: number,
): number {
  const points = interpolatePath(from, to, maxSegment)
  for (const point of points) {
    eraseStamp(ctx, point, brushRadius)
  }
  return points.length
}
