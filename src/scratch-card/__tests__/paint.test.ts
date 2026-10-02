import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRng } from '../paint.ts'

describe('createRng（mulberry32 seeded PRNG）', () => {
  it('同一种子产出完全相同的序列（纹理可复现）', () => {
    const a = createRng(20260927)
    const b = createRng(20260927)
    const seqA = Array.from({ length: 100 }, () => a())
    const seqB = Array.from({ length: 100 }, () => b())
    assert.deepEqual(seqA, seqB)
  })

  it('不同种子产出不同序列（reset 换 round 可换纹理）', () => {
    const a = createRng(1)
    const b = createRng(2)
    assert.notDeepEqual(
      Array.from({ length: 20 }, () => a()),
      Array.from({ length: 20 }, () => b()),
    )
  })

  it('输出始终落在 [0,1)', () => {
    const rng = createRng(42)
    for (let i = 0; i < 1000; i += 1) {
      const v = rng()
      assert.ok(v >= 0 && v < 1)
    }
  })
})
