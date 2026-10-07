/**
 * logic.ts 纯函数单测：解锁判定、持久化序列化/校验、代际冲突合并。
 * 运行：npm test
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_RECORD_VERSION,
  RECORD_VERSION,
  createInitialCards,
  createInitialRecord,
  decideRemoteRecord,
  isAllRevealed,
  isCardUnlocked,
  migrateLegacyRecord,
  parseRecord,
  parseRecordDetailed,
  serializeRecord,
} from '../logic.ts'
import type { ActivityPhase } from '../types.ts'
import type {
  CardPersistState,
  ParsedRecord,
} from '../logic.ts'

function card(
  state: 'idle' | 'revealed',
  progress = 0,
  attempts = 0,
): CardPersistState {
  return { state, progress, round: 0, attempts }
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
      attempts: 4,
      cover: 'data:image/png;base64,x',
    }
    const parsed = parseRecord(serializeRecord(record))
    assert.deepEqual(parsed, record)
    assert.equal(parsed?.cardsCount, 3)
    assert.equal(parsed?.cards[1].attempts, 4)
  })

  it('拒绝非 JSON、错误版本、非法 phase、坏卡片', () => {
    assert.equal(parseRecord(null), null)
    assert.equal(parseRecord(''), null)
    assert.equal(parseRecord('not-json'), null)
    assert.equal(parseRecord('{"version":99}'), null)
    const base = createInitialRecord(1, 3, 1)
    const weirdPhase = { ...base, phase: 'weird' as unknown as ActivityPhase }
    assert.equal(parseRecord(serializeRecord(weirdPhase)), null)
    assert.equal(
      parseRecord(serializeRecord({ ...base, generation: 0 })),
      null,
    )
    const badCard = createInitialRecord(1, 3, 1)
    badCard.cards[0] = {
      state: 'scratching' as never,
      progress: 0,
      round: 0,
      attempts: 0,
    }
    assert.equal(parseRecord(serializeRecord(badCard)), null)
    // cardsCount 与实际卡数不一致 → 判废
    const mismatchedCount = createInitialRecord(1, 3, 1)
    mismatchedCount.cardsCount = 2
    assert.equal(parseRecord(serializeRecord(mismatchedCount)), null)
    // v2 缺 attempts / attempts 非非负整数 → 判废
    const badAttempts = serializeRecord({
      ...createInitialRecord(1, 1, 1),
      cards: [
        {
          state: 'idle',
          progress: 0,
          round: 0,
          attempts: undefined as unknown as number,
        },
      ],
    })
    assert.equal(parseRecord(badAttempts), null)
    // 卡数越界（0 或 10）→ 判废
    assert.equal(
      parseRecord(serializeRecord(createInitialRecord(1, 9, 1)))?.version,
      2,
    )
    assert.equal(
      parseRecord(
        JSON.stringify({
          ...createInitialRecord(1, 1, 1),
          cardsCount: 0,
          cards: [],
        }),
      ),
      null,
    )
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
      attempts: 1,
      cover: 'data:y',
    }
    const parsed = parseRecord(serializeRecord(record))
    assert.ok(parsed)
    assert.equal(parsed!.cards[0].progress, 1)
    assert.equal(parsed!.cards[0].cover, 'data:x')
    assert.equal(parsed!.cards[1].cover, undefined)
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

  function remote(
    generation: number,
    updatedAt: number,
    sourceVersion: 1 | 2 = 2,
  ): ParsedRecord {
    return {
      record: {
        version: RECORD_VERSION,
        generation,
        updatedAt,
        phase: 'active' as ActivityPhase,
        cardsCount: 3,
        cards: createInitialCards(3),
      },
      sourceVersion,
    }
  }

  it('远端 v1 外来记录（旧版页面写入）一律视为低代际，忽略', () => {
    // 即便代际更高/时间戳更新也不采用、不降级只读
    assert.equal(decideRemoteRecord(local, remote(99, 9999, 1)), 'ignore')
  })

  it('远端 v2 代际更高 → 本页降级只读', () => {
    assert.equal(decideRemoteRecord(local, remote(3, 50)), 'readonly')
  })

  it('远端 v2 代际更低 → 旧代际回灌，忽略', () => {
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

describe('v1 -> v2 无损迁移', () => {
  /** 按 v1 schema 手工构造旧版落盘字符串（无 cardsCount / attempts） */
  function legacyV1(
    generation: number,
    updatedAt: number,
    phase: 'active' | 'completed',
    cards: Array<{
      state: 'idle' | 'revealed'
      progress: number
      round: number
      cover?: string
    }>,
  ): string {
    return JSON.stringify({
      version: LEGACY_RECORD_VERSION,
      generation,
      updatedAt,
      phase,
      cards,
    })
  }

  it('旧 3 卡记录字段全部保全：state/progress/round/cover/phase/代际/时间戳保留', () => {
    const raw = legacyV1(7, 4242, 'active', [
      { state: 'revealed', progress: 1, round: 3 },
      { state: 'idle', progress: 0.42, round: 1, cover: 'data:image/png;base64,c0' },
      { state: 'idle', progress: 0, round: 0 },
    ])
    const parsed = parseRecordDetailed(raw)
    assert.ok(parsed)
    assert.equal(parsed!.sourceVersion, 1)
    const record = parsed!.record
    assert.equal(record.version, RECORD_VERSION)
    assert.equal(record.generation, 7)
    assert.equal(record.updatedAt, 4242)
    assert.equal(record.phase, 'active')
    assert.equal(record.cardsCount, 3)
    assert.equal(record.cards.length, 3)
    assert.deepEqual(
      record.cards.map((c) => [c.state, c.progress, c.round, c.attempts, c.cover ?? null]),
      [
        ['revealed', 1, 3, 0, null],
        ['idle', 0.42, 1, 0, 'data:image/png;base64,c0'],
        ['idle', 0, 0, 0, null],
      ],
    )
  })

  it('attempts 迁移置 0，且不以「版本不符」丢弃进行中进度', () => {
    const raw = legacyV1(2, 9, 'active', [
      { state: 'idle', progress: 0.8, round: 5, cover: 'data:image/png;base64,z' },
    ])
    // parseRecord（旧调用方）同样不判废，证明不是整体丢弃
    const parsed = parseRecord(raw)
    assert.ok(parsed)
    assert.equal(parsed!.version, 2)
    assert.equal(parsed!.cards[0].attempts, 0)
    assert.equal(parsed!.cards[0].progress, 0.8)
    assert.equal(parsed!.cards[0].round, 5)
    assert.equal(parsed!.cards[0].cover, 'data:image/png;base64,z')
  })

  it('迁移幂等：重复加载/再次迁移不产生副作用', () => {
    const raw = legacyV1(4, 100, 'completed', [
      { state: 'revealed', progress: 1, round: 2 },
      { state: 'idle', progress: 0.1, round: 1 },
    ])
    const first = parseRecordDetailed(raw)!.record
    const again = parseRecordDetailed(serializeRecord(first))
    assert.ok(again)
    assert.equal(again!.sourceVersion, 2)
    assert.deepEqual(again!.record, first)
    // 对已是 v2 的记录再跑迁移函数：原样返回，不重置 attempts / 不改时间戳
    first.cards[0].attempts = 9
    const migrated = migrateLegacyRecord(first)
    assert.equal(migrated, first)
    assert.equal(migrated.cards[0].attempts, 9)
    assert.equal(migrated.updatedAt, 100)
  })

  it('迁移后记录满足 v2 合法性（可被严格 parse 往返）', () => {
    const raw = legacyV1(1, 1, 'active', [
      { state: 'idle', progress: 0.2, round: 1 },
    ])
    const v2 = parseRecord(raw)!
    assert.deepEqual(parseRecord(serializeRecord(v2)), v2)
  })
})

describe('任意卡数（1~9）串行解锁判定', () => {
  function states(n: number, revealedUpTo: number): CardPersistState[] {
    const cards: CardPersistState[] = []
    for (let i = 0; i < n; i += 1) {
      cards.push(card(i < revealedUpTo ? 'revealed' : 'idle'))
    }
    return cards
  }

  it('1 张卡：唯一一张恒解锁且即全部完成', () => {
    const one = states(1, 0)
    assert.equal(isCardUnlocked(one, 0), true)
    assert.equal(isAllRevealed(one), false)
    one[0].state = 'revealed'
    assert.equal(isAllRevealed(one), true)
  })

  it('9 张卡：仅前序连续 revealed 才解锁下一张', () => {
    const nine = states(9, 0)
    assert.equal(isCardUnlocked(nine, 0), true)
    assert.equal(isCardUnlocked(nine, 1), false)
    assert.equal(isCardUnlocked(nine, 8), false)
    for (let i = 0; i < 4; i += 1) nine[i].state = 'revealed'
    assert.equal(isCardUnlocked(nine, 4), true)
    assert.equal(isCardUnlocked(nine, 5), false)
    assert.equal(isAllRevealed(nine), false)
    for (let i = 4; i < 9; i += 1) nine[i].state = 'revealed'
    assert.equal(isAllRevealed(nine), true)
  })

  it('中间断链：断点卡之后即使后续 revealed 也不改变解锁链语义', () => {
    const cards = states(5, 0)
    cards[0].state = 'revealed'
    cards[2].state = 'revealed' // 第 3 张提前 revealed（异常态输入）
    assert.equal(isCardUnlocked(cards, 1), true)
    assert.equal(isCardUnlocked(cards, 2), false) // 前一张(1)未 revealed
    assert.equal(isAllRevealed(cards), false)
  })

  it('初始记录支持任意合法卡数并携带 cardsCount', () => {
    for (const n of [1, 2, 5, 9]) {
      const record = createInitialRecord(1, n, 0)
      assert.equal(record.cardsCount, n)
      assert.equal(record.cards.length, n)
      assert.ok(record.cards.every((c) => c.attempts === 0))
      assert.deepEqual(parseRecord(serializeRecord(record)), record)
    }
  })
})
