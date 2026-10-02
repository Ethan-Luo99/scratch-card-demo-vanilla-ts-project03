/**
 * 擦除几何（设计 C2）：
 * - 纯 destination-out 圆戳，露出下层奖品 DOM；
 * - 相邻采样点线性插值补点，maxSegment 控制圆戳间距，快速滑动不断线；
 * - 坐标均为 CSS 像素（ctx 已由 pointer 模块完成 DPR setTransform）。
 *
 * 几何计算全部是纯函数，可用 node:test 直接单测；
 * 唯一接触 Canvas API 的 stampErase 也只依赖传入的 ctx。
 */
import type { Point, Stamp } from './types.ts'

/** 欧氏距离 */
export function distance(a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function createStamp(point: Point, radius: number): Stamp {
  return { x: point.x, y: point.y, radius }
}

/**
 * 从 from 向 to 插值生成一系列擦除圆戳（含 to，不含 from）。
 * - d <= maxSegment 或两点重合时仅在 to 落一个圆戳，保证单点也被擦除；
 * - 插值点恒距 from 不超过 d，不会越过 to。
 */
export function interpolateStroke(
  from: Point,
  to: Point,
  radius: number,
  maxSegment: number,
): Stamp[] {
  const stepLength = maxSegment > 0 ? maxSegment : 1
  const d = distance(from, to)
  if (d === 0) return [createStamp(to, radius)]
  const steps = Math.max(1, Math.ceil(d / stepLength))
  const stamps: Stamp[] = []
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    stamps.push(
      createStamp(
        { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
        radius,
      ),
    )
  }
  return stamps
}

/**
 * 从指针事件取本帧的采样点：优先 getCoalescedEvents（高刷屏硬件采样），
 * 旧浏览器缺方法时可选链兜底为单点 [event]（设计 F8）。
 */
export function extractPoints(
  event: PointerEvent,
  fallback: Point,
  resolve: (event: PointerEvent) => Point,
): Point[] {
  const coalesced = event.getCoalescedEvents?.()
  if (coalesced && coalesced.length > 0) {
    return coalesced.map(resolve)
  }
  // 旧浏览器降级路径的合成事件 clientX/Y 并不可靠，
  // 直接使用 pointer 模块已换算好的回调点。
  return [fallback]
}

/** 以 destination-out 在指定位置画实心圆，alpha 被扣减即露出下层 */
export function stampErase(
  ctx: CanvasRenderingContext2D,
  stamp: Stamp,
): void {
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.beginPath()
  ctx.arc(stamp.x, stamp.y, stamp.radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 把一组圆戳依次打到涂层上 */
export function eraseStamps(
  ctx: CanvasRenderingContext2D,
  stamps: readonly Stamp[],
): void {
  for (const stamp of stamps) stampErase(ctx, stamp)
}
