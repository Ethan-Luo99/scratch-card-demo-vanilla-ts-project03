/**
 * logic.ts 纯逻辑单测：
 * 仅使用 Node 内置 node:test + node:assert，无任何第三方依赖。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendStamps,
  firstLockedIndex,
  stampToTuple,
  tupleToStamp,
} from '../logic.ts'
import { MAX_PERSISTED_STAMPS } from '../persistence.ts'
import type { CardStage, PersistedStamp } from '../types.ts'

describe('firstLockedIndex', () => {
  it('returns 0 when nothing is revealed', () => {
    assert.equal(firstLockedIndex(['idle', 'idle', 'idle']), 0)
  })

  it('returns the first non-revealed index', () => {
    const stages: CardStage[] = ['revealed', 'scratching', 'idle']
    assert.equal(firstLockedIndex(stages), 1)
  })

  it('returns card count when all revealed', () => {
    const stages: CardStage[] = ['revealed', 'revealed', 'revealed']
    assert.equal(firstLockedIndex(stages), 3)
  })
})

describe('stamp tuple conversion', () => {
  it('round-trips with 0.1px precision', () => {
    const tuple = stampToTuple({ x: 10.04, y: 20.06, radius: 24 })
    assert.deepEqual(tuple, [10, 20.1, 24])
    assert.deepEqual(tupleToStamp(tuple), { x: 10, y: 20.1, radius: 24 })
  })
})

describe('appendStamps', () => {
  it('appends converted tuples and reports the count', () => {
    const buffer: PersistedStamp[] = []
    const appended = appendStamps(buffer, [
      { x: 1, y: 2, radius: 24 },
      { x: 3, y: 4, radius: 24 },
    ])
    assert.equal(appended, 2)
    assert.deepEqual(buffer, [
      [1, 2, 24],
      [3, 4, 24],
    ])
  })

  it('stops at MAX_PERSISTED_STAMPS', () => {
    const buffer: PersistedStamp[] = Array.from(
      { length: MAX_PERSISTED_STAMPS - 1 },
      () => [0, 0, 24],
    )
    const appended = appendStamps(buffer, [
      { x: 1, y: 1, radius: 24 },
      { x: 2, y: 2, radius: 24 },
    ])
    assert.equal(appended, 1)
    assert.equal(buffer.length, MAX_PERSISTED_STAMPS)
  })
})
