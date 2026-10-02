import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALPHA_CUTOFF,
  countErasedRatio,
  measureErasedRatio,
  SAMPLE_COLS,
  SAMPLE_ROWS,
} from '../coverage.ts'

/** 构造 length 个像素的 RGBA 数据：前 erased 个像素 alpha=0，其余 alpha=255。 */
function buildGrid(pixelCount: number, erased: number): Uint8Array {
  const data = new Uint8Array(pixelCount * 4)
  for (let i = 0; i < pixelCount; i += 1) {
    data[i * 4] = 200
    data[i * 4 + 1] = 200
    data[i * 4 + 2] = 200
    data[i * 4 + 3] = i < erased ? 0 : 255
  }
  return data
}

const TOTAL = SAMPLE_COLS * SAMPLE_ROWS

describe('measureErasedRatio', () => {
  it('完整涂层比例为 0', () => {
    assert.equal(measureErasedRatio(buildGrid(TOTAL, 0)), 0)
  })

  it('全部擦除比例为 1', () => {
    assert.equal(measureErasedRatio(buildGrid(TOTAL, TOTAL)), 1)
  })

  it('32×20 网格中 70% 透明像素给出 0.7', () => {
    const erased = Math.round(TOTAL * 0.7)
    assert.equal(measureErasedRatio(buildGrid(TOTAL, erased)), erased / TOTAL)
  })

  it('alpha 恰为 cutoff 时算未擦除（严格小于判定）', () => {
    const data = new Uint8Array(4)
    data[3] = ALPHA_CUTOFF
    assert.equal(measureErasedRatio(data), 0)
    data[3] = ALPHA_CUTOFF - 1
    assert.equal(measureErasedRatio(data), 1)
  })

  it('空数据返回 0 而非 NaN', () => {
    assert.equal(measureErasedRatio(new Uint8Array(0)), 0)
  })
})

describe('countErasedRatio（阈值提前退出）', () => {
  it('未达阈值时扫完全部格子，结果与精确统计一致', () => {
    const erased = Math.round(TOTAL * 0.5)
    const data = buildGrid(TOTAL, erased)
    assert.equal(countErasedRatio(data, ALPHA_CUTOFF, 0.7), erased / TOTAL)
  })

  it('达到阈值时提前返回，比例必 >= threshold 且 <= 1', () => {
    const erased = Math.round(TOTAL * 0.9)
    const ratio = countErasedRatio(buildGrid(TOTAL, erased), ALPHA_CUTOFF, 0.7)
    assert.ok(ratio >= 0.7)
    assert.ok(ratio <= 1)
  })

  it('threshold=0 时首个透明像素即退出', () => {
    const data = buildGrid(TOTAL, 1)
    assert.equal(countErasedRatio(data, ALPHA_CUTOFF, 0), 1 / TOTAL)
  })

  it('threshold 超出 0~1 时被钳制', () => {
    const data = buildGrid(TOTAL, TOTAL)
    assert.equal(countErasedRatio(data, ALPHA_CUTOFF, 5), 1)
  })

  it('采样网格规格与设计 C4 一致（32×20=640 格）', () => {
    assert.equal(SAMPLE_COLS, 32)
    assert.equal(SAMPLE_ROWS, 20)
    assert.equal(TOTAL, 640)
  })
})
