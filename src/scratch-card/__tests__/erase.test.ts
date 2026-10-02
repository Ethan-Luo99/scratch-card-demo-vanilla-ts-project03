/**
 * erase.ts 纯函数单测（设计 R8 / 硬性约束 5）：
 * 仅使用 Node 内置 node:test + node:assert，无任何第三方依赖。
 * 运行：node --test --experimental-strip-types src/scratch-card/__tests__/
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createStamp,
  distance,
  eraseStamps,
  extractPoints,
  interpolateStroke,
  stampErase,
} from '../erase.ts'
import type { Point } from '../types.ts'

function makeMockCtx() {
  const calls: Array<Record<string, unknown>> = []
  const stack: string[] = []
  return {
    calls,
    save(): void {
      calls.push({ op: 'save' })
      stack.push(this.globalCompositeOperation)
    },
    restore(): void {
      calls.push({ op: 'restore' })
      this.globalCompositeOperation = stack.pop() ?? ''
    },
    beginPath(): void {
      calls.push({ op: 'beginPath' })
    },
    arc(x: number, y: number, r: number): void {
      calls.push({ op: 'arc', x, y, r })
    },
    fill(): void {
      calls.push({ op: 'fill' })
    },
    globalCompositeOperation: '',
  } as unknown as CanvasRenderingContext2D & {
    calls: Array<Record<string, unknown>>
  }
}

describe('distance', () => {
  it('computes euclidean distance', () => {
    assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
    assert.equal(distance({ x: 1, y: 2 }, { x: 1, y: 2 }), 0)
    assert.equal(distance({ x: -3, y: 0 }, { x: 0, y: -4 }), 5)
  })
})

describe('createStamp', () => {
  it('copies point coordinates with the given radius', () => {
    assert.deepEqual(createStamp({ x: 7, y: 9 }, 12), {
      x: 7,
      y: 9,
      radius: 12,
    })
  })
})

describe('interpolateStroke', () => {
  it('returns a single stamp at the target when both points coincide', () => {
    const stamps = interpolateStroke({ x: 5, y: 5 }, { x: 5, y: 5 }, 10, 8)
    assert.equal(stamps.length, 1)
    assert.deepEqual(stamps[0], { x: 5, y: 5, radius: 10 })
  })

  it('places one stamp when distance is within maxSegment', () => {
    const stamps = interpolateStroke({ x: 0, y: 0 }, { x: 6, y: 8 }, 3, 10)
    assert.equal(stamps.length, 1)
    assert.deepEqual(stamps[0], { x: 6, y: 8, radius: 3 })
  })

  it('inserts stamps at most maxSegment apart for fast swipes', () => {
    const from: Point = { x: 0, y: 0 }
    const to: Point = { x: 40, y: 0 }
    const stamps = interpolateStroke(from, to, 24, 8)
    assert.equal(stamps.length, 5) // ceil(40 / 8)
    stamps.forEach((s) => assert.equal(s.radius, 24))
    assert.equal(stamps.at(-1)!.x, 40)
    assert.equal(stamps.at(-1)!.y, 0)
    for (let i = 1; i < stamps.length; i += 1) {
      const gap = distance(
        { x: stamps[i - 1].x, y: stamps[i - 1].y },
        { x: stamps[i].x, y: stamps[i].y },
      )
      assert.ok(gap <= 8 + 1e-9, `gap ${gap} exceeds maxSegment`)
    }
  })

  it('interpolates on a straight line without overshooting the target', () => {
    const stamps = interpolateStroke({ x: 10, y: 10 }, { x: 10, y: 34 }, 5, 7)
    assert.equal(stamps.length, Math.ceil(24 / 7))
    for (const stamp of stamps) {
      assert.equal(stamp.x, 10)
      assert.ok(stamp.y > 10 && stamp.y <= 34)
    }
  })

  it('guards against a non-positive maxSegment', () => {
    const stamps = interpolateStroke({ x: 0, y: 0 }, { x: 10, y: 0 }, 2, 0)
    assert.equal(stamps.length, 10)
  })
})

describe('extractPoints', () => {
  const resolve = (event: PointerEvent): Point => ({
    x: event.clientX,
    y: event.clientY,
  })

  it('falls back to the pre-resolved point when getCoalescedEvents is absent', () => {
    const event = {
      clientX: 5,
      clientY: 7,
    } as unknown as PointerEvent
    const points = extractPoints(event, { x: 5, y: 7 }, resolve)
    assert.deepEqual(points, [{ x: 5, y: 7 }])
  })

  it('maps every coalesced event when available', () => {
    const event = {
      clientX: 30,
      clientY: 40,
      getCoalescedEvents: () => [
        { clientX: 10, clientY: 20 },
        { clientX: 20, clientY: 30 },
        { clientX: 30, clientY: 40 },
      ],
    } as unknown as PointerEvent
    const points = extractPoints(event, { x: 30, y: 40 }, resolve)
    assert.deepEqual(points, [
      { x: 10, y: 20 },
      { x: 20, y: 30 },
      { x: 30, y: 40 },
    ])
  })

  it('uses the fallback point when coalesced list is empty', () => {
    const event = {
      clientX: 3,
      clientY: 4,
      getCoalescedEvents: () => [],
    } as unknown as PointerEvent
    const points = extractPoints(event, { x: 3, y: 4 }, resolve)
    assert.deepEqual(points, [{ x: 3, y: 4 }])
  })
})

describe('stampErase / eraseStamps', () => {
  it('draws a filled arc under destination-out and restores state', () => {
    const ctx = makeMockCtx()
    stampErase(ctx, { x: 11, y: 22, radius: 9 })
    assert.equal(ctx.globalCompositeOperation, '')
    const ops = ctx.calls.map((c) => c.op)
    assert.deepEqual(ops, ['save', 'beginPath', 'arc', 'fill', 'restore'])
    assert.deepEqual(ctx.calls[2], { op: 'arc', x: 11, y: 22, r: 9 })
  })

  it('draws every stamp in order', () => {
    const ctx = makeMockCtx()
    eraseStamps(ctx, [
      { x: 0, y: 0, radius: 1 },
      { x: 5, y: 5, radius: 2 },
    ])
    const arcs = ctx.calls.filter((c) => c.op === 'arc')
    assert.equal(arcs.length, 2)
  })
})
