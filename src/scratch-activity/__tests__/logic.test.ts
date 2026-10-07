/**
 * logic.ts 纯函数单测：解锁判定、持久化序列化/校验、代际冲突合并。
 * 运行：npm test
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CARD_COUNT,
  RECORD_VERSION,
  createInitialCards,
  createInitialRecord,
  decideRemoteRecord,
  getPngDataUrlSize,
  isAllRevealed,
  isCardUnlocked,
  isValidCardCount,
  parseStoredRecord,
  serializeRecord,
} from '../logic.ts'
import type { ActivityRecord, CardPersistState } from '../logic.ts'

function card(state: 'idle' | 'revealed', progress = 0): CardPersistState {
  return { state, progress, round: 0, attempts: 0 }
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
      attempts: 1,
      cover: 'data:image/png;base64,x',
    }
    const parsed = parseStoredRecord(serializeRecord(record))
    assert.deepEqual(parsed, record)
  })

  it('拒绝非 JSON、未知版本、非法 phase、坏卡片', () => {
    assert.equal(parseStoredRecord(null), null)
    assert.equal(parseStoredRecord(''), null)
    assert.equal(parseStoredRecord('not-json'), null)
    assert.equal(parseStoredRecord('{"version":99}'), null)
    const base = createInitialRecord(1, 3, 1)
    assert.equal(
      parseStoredRecord(serializeRecord({ ...base, phase: 'weird' })),
      null,
    )
    assert.equal(
      parseStoredRecord(serializeRecord({ ...base, generation: 0 })),
      null,
    )
    const badCard = createInitialRecord(1, 3, 1)
    badCard.cards[0] = {
      state: 'scratching' as never,
      progress: 0,
      round: 0,
      attempts: 0,
    }
    assert.equal(parseStoredRecord(serializeRecord(badCard)), null)
  })

  it('cardsCount 越界或与 cards 长度不一致时判废', () => {
    const base = createInitialRecord(1, 3, 1)
    assert.equal(
      parseStoredRecord(serializeRecord({ ...base, cardsCount: 0 })),
      null,
    )
    assert.equal(
      parseStoredRecord(serializeRecord({ ...base, cardsCount: 10 })),
      null,
    )
    assert.equal(
      parseStoredRecord(
        serializeRecord({ ...base, cardsCount: 2 }),
      ),
      null,
    )
  })

  it('attempts 缺失或非法的 v2 卡片判废', () => {
    const base = createInitialRecord(1, 2, 1)
    const noAttempts = serializeRecord({
      ...base,
      cards: [{ state: 'idle', progress: 0, round: 0 }],
    })
    assert.equal(parseStoredRecord(noAttempts), null)
    const badAttempts = serializeRecord({
      ...base,
      cards: [
        { state: 'idle', progress: 0, round: 0, attempts: -1 },
        { state: 'idle', progress: 0, round: 0, attempts: 0 },
      ],
    })
    assert.equal(parseStoredRecord(badAttempts), null)
  })

  it('progress 越界被钳制到 0~1，revealed 态丢弃 cover', () => {
    const record = createInitialRecord(1, 2, 1)
    record.cards[0] = {
      state: 'idle',
      progress: 1.7,
      round: 0,
      attempts: 0,
      cover: 'data:x',
    }
    record.cards[1] = {
      state: 'revealed',
      progress: 1,
      round: 0,
      attempts: 2,
      cover: 'data:y',
    }
    const parsed = parseStoredRecord(serializeRecord(record))
    assert.ok(parsed)
    assert.equal(parsed.cards[0].progress, 1)
    assert.equal(parsed.cards[0].cover, 'data:x')
    assert.equal(parsed.cards[1].cover, undefined)
    assert.equal(parsed.cards[1].attempts, 2)
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
      cardsCount: 3,
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

  it('v1 外来记录（旧版写入方）一律按低代际忽略，即使 generation/updatedAt 更新', () => {
    const v1Remote = parseStoredRecord(
      JSON.stringify({
        version: 1,
        generation: 99,
        updatedAt: 99999,
        phase: 'active',
        cards: [
          { state: 'idle', progress: 0, round: 0 },
          { state: 'idle', progress: 0, round: 0 },
          { state: 'idle', progress: 0, round: 0 },
        ],
      }),
    )
    assert.ok(v1Remote)
    assert.equal(v1Remote.legacy, true)
    assert.equal(decideRemoteRecord(local, v1Remote), 'ignore')
  })
})

describe('v1 → v2 无损迁移', () => {
  /** 构造一条典型 v1 旧记录（无 cardsCount / 无 attempts） */
  function legacyRaw(): string {
    return JSON.stringify({
      version: 1,
      generation: 4,
      updatedAt: 4242,
      phase: 'active',
      cards: [
        { state: 'idle', progress: 0.3, round: 1, cover: 'data:image/png;base64,x' },
        { state: 'revealed', progress: 1, round: 2 },
        { state: 'idle', progress: 0, round: 0 },
      ],
    })
  }

  it('字段保全：state/progress/round/cover/phase/generation 全部保留，补 cardsCount/attempts', () => {
    const migrated = parseStoredRecord(legacyRaw())
    assert.ok(migrated)
    assert.equal(migrated.version, RECORD_VERSION)
    assert.equal(migrated.legacy, true)
    assert.equal(migrated.generation, 4)
    assert.equal(migrated.updatedAt, 4242)
    assert.equal(migrated.phase, 'active')
    assert.equal(migrated.cardsCount, 3)
    assert.equal(migrated.cards.length, 3)
    assert.deepEqual(migrated.cards[0], {
      state: 'idle',
      progress: 0.3,
      round: 1,
      attempts: 0,
      cover: 'data:image/png;base64,x',
    })
    assert.deepEqual(migrated.cards[1], {
      state: 'revealed',
      progress: 1,
      round: 2,
      attempts: 0,
    })
    assert.deepEqual(migrated.cards[2], {
      state: 'idle',
      progress: 0,
      round: 0,
      attempts: 0,
    })
  })

  it('迁移幂等：同一 v1 原文多次解析结果完全一致', () => {
    const raw = legacyRaw()
    const first = parseStoredRecord(raw)
    const second = parseStoredRecord(raw)
    assert.deepEqual(first, second)
    // 迁移结果序列化为 v2 后仍可往返，且不再带 legacy 语义
    assert.ok(first)
    const roundTrip = parseStoredRecord(serializeRecord(first))
    assert.ok(roundTrip)
    assert.equal(roundTrip.version, RECORD_VERSION)
    assert.equal(roundTrip.legacy, undefined)
    assert.deepEqual(roundTrip.cards, first.cards)
  })

  it('completed 阶段的 v1 记录迁移后阶段保留', () => {
    const raw = JSON.stringify({
      version: 1,
      generation: 2,
      updatedAt: 7,
      phase: 'completed',
      cards: [
        { state: 'revealed', progress: 1, round: 0 },
        { state: 'revealed', progress: 1, round: 1 },
      ],
    })
    const migrated = parseStoredRecord(raw)
    assert.ok(migrated)
    assert.equal(migrated.phase, 'completed')
    assert.equal(migrated.cardsCount, 2)
  })

  it('损坏的 v1 记录（坏卡片/坏 phase）判 null，而非按版本号直接放行', () => {
    assert.equal(
      parseStoredRecord(JSON.stringify({ version: 1, generation: 1, updatedAt: 1, phase: 'x', cards: [] })),
      null,
    )
    assert.equal(
      parseStoredRecord(
        JSON.stringify({
          version: 1,
          generation: 1,
          updatedAt: 1,
          phase: 'active',
          cards: [{ state: 'nope', progress: 0, round: 0 }],
        }),
      ),
      null,
    )
  })
})

describe('任意卡数（1~9）通用化', () => {
  it('初始记录卡数按实际数量创建并写入 cardsCount', () => {
    for (const count of [1, 2, 5, 9]) {
      const record = createInitialRecord(1, count, 1)
      assert.equal(record.cards.length, count)
      assert.equal(record.cardsCount, count)
      assert.ok(record.cards.every((c) => c.attempts === 0))
    }
  })

  it('串行解锁对任意卡数成立：只有紧邻前一张 revealed 才解锁', () => {
    const states = (revealedPrefix: number, total: number): CardPersistState[] =>
      Array.from({ length: total }, (_, i) =>
        card(i < revealedPrefix ? 'revealed' : 'idle'),
      )

    const five = states(2, 5)
    assert.equal(isCardUnlocked(five, 0), true)
    assert.equal(isCardUnlocked(five, 1), true)
    assert.equal(isCardUnlocked(five, 2), true)
    assert.equal(isCardUnlocked(five, 3), false)
    assert.equal(isCardUnlocked(five, 4), false)

    const one = states(0, 1)
    assert.equal(isCardUnlocked(one, 0), true)
    assert.equal(isAllRevealed(one), false)

    const nine = states(9, 9)
    for (let i = 0; i < 9; i += 1) assert.equal(isCardUnlocked(nine, i), true)
    assert.equal(isAllRevealed(nine), true)

    // 严格相邻：第 N 张只取决于第 N-1 张，与更早卡片无关。
    // 下方序列第 1 张前邻已揭示故解锁，第 2 张前邻未揭示即为断点；
    // isAllRevealed 要求全部揭示，序列不为全揭示。
    const broken: CardPersistState[] = [
      card('revealed'),
      card('idle'),
      card('revealed'),
      card('idle'),
    ]
    assert.equal(isCardUnlocked(broken, 1), true)
    assert.equal(isCardUnlocked(broken, 2), false)
    assert.equal(isAllRevealed(broken), false)
  })

  it('非 1~9 的 cardsCount 记录无法通过解析', () => {
    for (const count of [0, 10, 100, 1.5]) {
      const record = createInitialRecord(1, 3, 1)
      const raw = serializeRecord({ ...record, cardsCount: count })
      assert.equal(parseStoredRecord(raw), null)
    }
  })
})

describe('isValidCardCount（运行时卡数边界）', () => {
  it('仅接受 1~9 的整数', () => {
    for (const n of [1, 2, 5, 9]) assert.equal(isValidCardCount(n), true)
    for (const n of [0, -1, 10, 100, 1.5, Number.NaN, 2.0001]) {
      assert.equal(isValidCardCount(n), false)
    }
    assert.equal(MAX_CARD_COUNT, 9)
  })
})

describe('getPngDataUrlSize（v1 位图尺寸回退判定）', () => {
  // 最小合法 PNG：宽 4 高 3，RGBA，由 zlib 压缩空扫描行构造
  const PNG_4x3 =
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7iAAAAGVJREFUCNdjYGBg6AAAAAEg' +
    'AAEA3X0AAQYDqwAAAABJRU5ErkJggg=='

  it('从合法 PNG dataURL 读出宽高', () => {
    const size = getPngDataUrlSize(PNG_4x3)
    assert.ok(size)
    assert.equal(size.width, 4)
    assert.equal(size.height, 3)
  })

  it('非 PNG / 损坏 / 非 dataURL 返回 null（调用方保留原位图）', () => {
    assert.equal(getPngDataUrlSize('data:image/jpeg;base64,AAAA'), null)
    assert.equal(getPngDataUrlSize('not-a-data-url'), null)
    assert.equal(getPngDataUrlSize('data:image/png;base64,!!!!'), null)
    assert.equal(getPngDataUrlSize(''), null)
  })
})
