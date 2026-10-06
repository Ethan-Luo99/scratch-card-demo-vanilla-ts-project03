/**
 * logic.ts 纯函数单测：解锁判定、持久化序列化/校验、代际冲突合并。
 * 运行：npm test
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RECORD_VERSION,
  createInitialCards,
  createInitialRecord,
  decideRemoteRecord,
  isAllRevealed,
  isCardUnlocked,
  parseRecord,
  serializeRecord,
} from '../logic.ts'
import type { ActivityRecord, CardPersistState } from '../logic.ts'

function card(state: 'idle' | 'revealed', progress = 0): CardPersistState {
  return { state, progress, round: 0 }
}

describe('isCardUnlocked（串行解锁）', () => {
  it('第 0 张恒解锁', () => {
    assert.equal(isCardUnlocked([card('idle')], 0), true)
    assert.equal(isCardUnlocked([], 0), true)
  })

  it('第 N 张仅当第 N-1 张 revealed 后解锁', () => {
    const cards = [card('revealed'), card('idle'), card('idle')]
    assert.equal(isCardUnlocked(cards, 1), true)
    assert.equal(isCardUnlocked(cards, 2), false)
  })

  it('前序未 revealed 时后续全部锁定', () => {
    const cards = [card('idle'), card('idle'), card('idle')]
    assert.equal(isCardUnlocked(cards, 1), false)
    assert.equal(isCardUnlocked(cards, 2), false)
  })
})

describe('isAllRevealed', () => {
  it('全部 revealed 才为真', () => {
    assert.equal(isAllRevealed([card('revealed'), card('revealed')]), true)
    assert.equal(isAllRevealed([card('revealed'), card('idle')]), false)
    assert.equal(isAllRevealed([]), false)
  })
})

describe('serializeRecord / parseRecord', () => {
  it('合法记录可完整往返', () => {
    const record = createInitialRecord(3, 3, 123456)
    record.phase = 'completed'
    record.cards[1] = {
      state: 'idle',
      progress: 0.5,
      round: 2,
      cover: 'data:image/png;base64,x',
    }
    const parsed = parseRecord(serializeRecord(record))
    assert.deepEqual(parsed, record)
  })

  it('拒绝非 JSON、错误版本、非法 phase、坏卡片', () => {
    assert.equal(parseRecord(null), null)
    assert.equal(parseRecord(''), null)
    assert.equal(parseRecord('not-json'), null)
    assert.equal(parseRecord('{"version":2}'), null)
    const base = createInitialRecord(1, 3, 1)
    assert.equal(
      parseRecord(serializeRecord({ ...base, phase: 'weird' })),
      null,
    )
    assert.equal(
      parseRecord(serializeRecord({ ...base, generation: 0 })),
      null,
    )
    const badCard = createInitialRecord(1, 3, 1)
    badCard.cards[0] = { state: 'scratching' as never, progress: 0, round: 0 }
    assert.equal(parseRecord(serializeRecord(badCard)), null)
  })

  it('progress 越界被钳制到 0~1，revealed 态丢弃 cover', () => {
    const record = createInitialRecord(1, 2, 1)
    record.cards[0] = {
      state: 'idle',
      progress: 1.7,
      round: 0,
      cover: 'data:x',
    }
    record.cards[1] = {
      state: 'revealed',
      progress: 1,
      round: 0,
      cover: 'data:y',
    }
    const parsed = parseRecord(serializeRecord(record))
    assert.ok(parsed)
    assert.equal(parsed.cards[0].progress, 1)
    assert.equal(parsed.cards[0].cover, 'data:x')
    assert.equal(parsed.cards[1].cover, undefined)
  })

  it('记录中不包含奖品字段（防敏感信息回灌）', () => {
    const record = createInitialRecord(1, 3, 1)
    const raw = serializeRecord(record)
    assert.equal(raw.includes('prize'), false)
    assert.equal(raw.includes('title'), false)
  })
})

describe('decideRemoteRecord（last-write-wins + 代际号）', () => {
  const local = { generation: 2, updatedAt: 100 }

  function remote(generation: number, updatedAt: number): ActivityRecord {
    return {
      version: RECORD_VERSION,
      generation,
      updatedAt,
      phase: 'active',
      cards: createInitialCards(3),
    }
  }

  it('远端代际更高 → 本页降级只读', () => {
    assert.equal(decideRemoteRecord(local, remote(3, 50)), 'readonly')
  })

  it('远端代际更低 → 旧代际回灌，忽略', () => {
    assert.equal(decideRemoteRecord(local, remote(1, 9999)), 'ignore')
  })

  it('同代际且更新 → apply；否则忽略', () => {
    assert.equal(decideRemoteRecord(local, remote(2, 101)), 'apply')
    assert.equal(decideRemoteRecord(local, remote(2, 100)), 'ignore')
    assert.equal(decideRemoteRecord(local, remote(2, 99)), 'ignore')
  })

  it('远端记录缺失/非法 → 忽略', () => {
    assert.equal(decideRemoteRecord(local, null), 'ignore')
  })
})
