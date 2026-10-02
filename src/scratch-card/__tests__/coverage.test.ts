/**
 * coverage.ts 纯函数单测（设计 R8 / 硬性约束 5）：
 * 仅使用 Node 内置 node:test + node:assert，无任何第三方依赖。
 * 运行：node --test --experimental-strip-types src/scratch-card/__tests__/
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALPHA_CLEAR,
  GRID_HEIGHT,
  GRID_WIDTH,
  isCellClear,
  reachesThreshold,
  scanErasedRatio,
} from '../coverage.ts'

/** 构造 RGBA 像素序列：每像素 4 字节 */
function rgba(pixels: Array<[number, number, number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b, a], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = a
  })
  return data
}

const SOLID: [number, number, number, number] = [160, 160, 160, 255]
const CLEAR: [number, number, number, number] = [0, 0, 0, 0]
const HALF: [number, number, number, number] = [100, 100, 100, ALPHA_CLEAR - 1]
const BOUNDARY: [number, number, number, number] = [
  100,
  100,
  100,
  ALPHA_CLEAR,
]

describe('isCellClear', () => {
  it('treats only alpha strictly below 128 as erased', () => {
    assert.equal(isCellClear(0), true)
    assert.equal(isCellClear(ALPHA_CLEAR - 1), true)
    assert.equal(isCellClear(ALPHA_CLEAR), false)
    assert.equal(isCellClear(255), false)
  })
})

describe('reachesThreshold', () => {
  it('fires at and above threshold only', () => {
    assert.equal(reachesThreshold(0.69, 0.7), false)
    assert.equal(reachesThreshold(0.7, 0.7), true)
    assert.equal(reachesThreshold(1, 0.7), true)
  })
})

describe('scanErasedRatio', () => {
  it('returns 0 for empty input', () => {
    assert.equal(scanErasedRatio([]), 0)
    assert.equal(scanErasedRatio(rgba([])), 0)
  })

  it('counts only the alpha channel', () => {
    // 4 个像素，3 个 alpha<128；RGB 不影响判定
    const data = rgba([CLEAR, CLEAR, SOLID, CLEAR])
    assert.equal(scanErasedRatio(data), 0.75)
  })

  it('uses the boundary alpha=128 as still covered', () => {
    const data = rgba([BOUNDARY, HALF])
    assert.equal(scanErasedRatio(data), 0.5)
  })

  it('returns 0 and 1 for fully covered / fully erased grids', () => {
    assert.equal(scanErasedRatio(rgba([SOLID, SOLID, SOLID])), 0)
    assert.equal(scanErasedRatio(rgba([CLEAR, CLEAR, CLEAR])), 1)
  })

  it('clamps the early-exit target and reports a threshold-bound ratio', () => {
    // 10 像素中 8 个已刮；提前退出目标设为 7 时，扫到第 7 个即退出，
    // 返回下界 7/10（保证 >= 0.7 的阈值判定成立）
    // 第 7 个已刮格子落在末像素之前（索引 6），此时立即退出
    const data = rgba([
      CLEAR,
      CLEAR,
      CLEAR,
      CLEAR,
      CLEAR,
      CLEAR,
      CLEAR,
      SOLID,
      CLEAR,
      SOLID,
    ])
    assert.equal(scanErasedRatio(data, 7), 0.7)
  })

  it('never exits before reaching the target', () => {
    // 仅 2/10 被刮，目标 7 无法达成 → 全量扫描得到精确值 0.2
    const data = rgba([
      CLEAR,
      SOLID,
      SOLID,
      SOLID,
      SOLID,
      CLEAR,
      SOLID,
      SOLID,
      SOLID,
      SOLID,
    ])
    assert.equal(scanErasedRatio(data, 7), 0.2)
  })

  it('clamps out-of-range stopAfter values', () => {
    const data = rgba([SOLID, CLEAR])
    // 目标 <=0 不触发提前退出，全量精确统计
    assert.equal(scanErasedRatio(data, -5), 0.5)
    assert.equal(scanErasedRatio(data, 0), 0.5)
    // 目标超出可达成数量时同样全量扫描
    assert.equal(scanErasedRatio(rgba([CLEAR, CLEAR]), 999), 1)
  })

  it('matches the documented 32x20 probe grid size', () => {
    assert.equal(GRID_WIDTH * GRID_HEIGHT, 640)
  })
})
