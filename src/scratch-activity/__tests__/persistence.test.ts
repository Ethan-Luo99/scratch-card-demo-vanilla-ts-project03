/**
 * persistence.ts 纯逻辑单测：
 * 仅使用 Node 内置 node:test + node:assert，无任何第三方依赖。
 * 运行：npm test
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSafeStorage,
  MAX_PERSISTED_STAMPS,
  parseActivity,
  resolveStorageConflict,
  serializeActivity,
} from '../persistence.ts'
import type { PersistedActivityState } from '../types.ts'

/** 构造一个可用的内存 Storage 替身 */
function makeArea(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  } as Storage
}

/** 构造一个所有访问都抛异常的 Storage（模拟隐私模式） */
function makeThrowingArea(): Storage {
  const boom = (): never => {
    throw new DOMException('Access is denied', 'SecurityError')
  }
  return {
    getItem: boom,
    setItem: boom,
    removeItem: boom,
    clear: boom,
    key: boom,
    length: 0,
  } as unknown as Storage
}

function makeSnapshot(
  overrides: Partial<PersistedActivityState> = {},
): PersistedActivityState {
  return {
    version: 1,
    generation: 3,
    tabId: 'tab-a',
    updatedAt: 1727800000000,
    phase: 'active',
    activeIndex: 1,
    cards: [
      { state: 'revealed', progress: 1, round: 0, stamps: [] },
      {
        state: 'scratching',
        progress: 0.42,
        round: 2,
        stamps: [
          [10.5, 20, 24],
          [30, 40.4, 24],
        ],
      },
      { state: 'idle', progress: 0, round: 0, stamps: [] },
    ],
    ...overrides,
  }
}

describe('createSafeStorage', () => {
  it('uses the underlying area when it works', () => {
    const area = makeArea()
    const storage = createSafeStorage(area)
    assert.equal(storage.available, true)
    storage.set('k', 'v')
    assert.equal(area.getItem('k'), 'v')
    assert.equal(storage.get('k'), 'v')
    storage.remove('k')
    assert.equal(storage.get('k'), null)
  })

  it('silently falls back to memory when sessionStorage throws', () => {
    const storage = createSafeStorage(makeThrowingArea())
    assert.equal(storage.available, false)
    storage.set('k', 'v')
    assert.equal(storage.get('k'), 'v')
    storage.remove('k')
    assert.equal(storage.get('k'), null)
  })

  it('falls back to memory when no area exists', () => {
    const storage = createSafeStorage(null)
    assert.equal(storage.available, false)
    storage.set('k', 'v')
    assert.equal(storage.get('k'), 'v')
  })

  it('degrades to memory if the area starts throwing at runtime', () => {
    const area = makeArea()
    const storage = createSafeStorage(area)
    assert.equal(storage.available, true)
    const throwing = makeThrowingArea()
    area.setItem = throwing.setItem
    area.getItem = throwing.getItem
    storage.set('k', 'v')
    assert.equal(storage.get('k'), 'v')
  })
})

describe('serializeActivity / parseActivity', () => {
  it('round-trips a valid snapshot', () => {
    const snapshot = makeSnapshot()
    const parsed = parseActivity(serializeActivity(snapshot))
    assert.deepEqual(parsed, snapshot)
  })

  it('returns null for missing or invalid payloads', () => {
    assert.equal(parseActivity(null), null)
    assert.equal(parseActivity(''), null)
    assert.equal(parseActivity('not json'), null)
    assert.equal(parseActivity('[]'), null)
    assert.equal(parseActivity('{}'), null)
  })

  it('rejects wrong version, empty tabId and wrong card count', () => {
    assert.equal(parseActivity(serializeActivity(makeSnapshot({ version: 2 }))), null)
    assert.equal(parseActivity(serializeActivity(makeSnapshot({ tabId: '' }))), null)
    const snapshot = makeSnapshot()
    const broken = { ...snapshot, cards: snapshot.cards.slice(0, 2) }
    assert.equal(parseActivity(JSON.stringify(broken)), null)
  })

  it('clamps out-of-range fields instead of crashing', () => {
    const snapshot = makeSnapshot()
    const raw = JSON.parse(serializeActivity(snapshot))
    raw.generation = -4
    raw.activeIndex = 99
    raw.cards[1].progress = 7
    raw.cards[1].round = -1
    raw.cards[1].stamps = [[1, 2], [1, 2, 0], ['a', 2, 3], [1, 2, 3]]
    const parsed = parseActivity(JSON.stringify(raw))
    assert.ok(parsed)
    assert.equal(parsed.generation, 0)
    assert.equal(parsed.activeIndex, 2)
    assert.equal(parsed.cards[1].progress, 1)
    assert.equal(parsed.cards[1].round, 0)
    assert.deepEqual(parsed.cards[1].stamps, [[1, 2, 3]])
  })

  it('caps persisted stamps at MAX_PERSISTED_STAMPS', () => {
    const snapshot = makeSnapshot()
    const raw = JSON.parse(serializeActivity(snapshot))
    raw.cards[1].stamps = Array.from(
      { length: MAX_PERSISTED_STAMPS + 50 },
      () => [1, 2, 3],
    )
    const parsed = parseActivity(JSON.stringify(raw))
    assert.ok(parsed)
    assert.equal(parsed.cards[1].stamps.length, MAX_PERSISTED_STAMPS)
  })
})

describe('resolveStorageConflict', () => {
  const incoming = makeSnapshot({ generation: 5, tabId: 'tab-b' })

  it('foreign newer generation wins → local goes read-only', () => {
    assert.equal(resolveStorageConflict(4, 'tab-a', incoming), 'foreign-newer')
  })

  it('foreign stale generation is rewritten (anti-rollback)', () => {
    assert.equal(resolveStorageConflict(6, 'tab-a', incoming), 'foreign-stale')
  })

  it('same generation and same tab is ignored', () => {
    const own = makeSnapshot({ generation: 5, tabId: 'tab-a' })
    assert.equal(resolveStorageConflict(5, 'tab-a', own), 'ignore')
  })

  it('same generation across tabs resolves deterministically by tabId', () => {
    assert.equal(resolveStorageConflict(5, 'tab-a', incoming), 'foreign-newer')
    assert.equal(resolveStorageConflict(5, 'tab-c', incoming), 'foreign-stale')
  })
})
