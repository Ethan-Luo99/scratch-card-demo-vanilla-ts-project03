import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  distance,
  eraseSegment,
  eraseStamp,
  interpolatePath,
  type StampContext,
} from '../erase.ts'
import type { Point } from '../types.ts'

/** 记录每次戳圆参数的假 ctx，零 DOM 依赖。 */
function createRecordingContext(): StampContext & { stamps: Point[] } {
  const stamps: Point[] = []
  return {
    stamps,
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    beginPath() {},
    fill() {},
    arc(x, y) {
      stamps.push({ x, y })
    },
  }
}

describe('interpolatePath', () => {
  it('距离为 0 时只返回目标点（pointerdown 首点）', () => {
    const point: Point = { x: 10, y: 20 }
    assert.deepEqual(interpolatePath(point, point, 8), [{ x: 10, y: 20 }])
  })

  it('短距离（<= maxSegment）只补一个终点', () => {
    assert.deepEqual(interpolatePath({ x: 0, y: 0 }, { x: 8, y: 0 }, 8), [
      { x: 8, y: 0 },
    ])
  })

  it('按 ceil(d/maxSegment) 等分，相邻点间距不超过 maxSegment', () => {
    const points = interpolatePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 8)
    assert.equal(points.length, Math.ceil(100 / 8))
    assert.equal(points[points.length - 1].x, 100)
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(distance(points[i - 1], points[i]) <= 8 + 1e-9)
    }
  })

  it('斜向滑动插值点严格落在线段上', () => {
    const points = interpolatePath({ x: 0, y: 0 }, { x: 30, y: 40 }, 10)
    for (const point of points) {
      const ratio = point.x / 30
      assert.ok(Math.abs(point.y - 40 * ratio) < 1e-9)
    }
  })

  it('maxSegment 非法（<=0）时退化为单点，不产生死循环', () => {
    assert.equal(interpolatePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0).length, 1)
  })
})

describe('eraseStamp', () => {
  it('以 destination-out 合成并画一个半径为笔刷的圆', () => {
    const ctx = createRecordingContext()
    eraseStamp(ctx, { x: 5, y: 6 }, 24)
    assert.equal(ctx.globalCompositeOperation, 'destination-out')
    assert.deepEqual(ctx.stamps, [{ x: 5, y: 6 }])
  })
})

describe('eraseSegment', () => {
  it('沿插值点逐个戳圆，快速滑动不断线', () => {
    const ctx = createRecordingContext()
    const count = eraseSegment(
      ctx,
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      24,
      8,
    )
    assert.equal(count, 10)
    assert.equal(ctx.stamps.length, 10)
    assert.deepEqual(ctx.stamps[0], { x: 8, y: 0 })
    assert.deepEqual(ctx.stamps[9], { x: 80, y: 0 })
    assert.equal(ctx.globalCompositeOperation, 'destination-out')
  })

  it('每个戳点都会 save/restore，合成模式不泄漏到后续绘制', () => {
    let saves = 0
    let restores = 0
    const ctx: StampContext = {
      globalCompositeOperation: 'source-over',
      save() {
        saves += 1
      },
      restore() {
        restores += 1
      },
      beginPath() {},
      arc() {},
      fill() {},
    }
    eraseSegment(ctx, { x: 0, y: 0 }, { x: 30, y: 0 }, 10, 8)
    assert.equal(saves, restores)
    assert.ok(saves >= 4)
  })
})
