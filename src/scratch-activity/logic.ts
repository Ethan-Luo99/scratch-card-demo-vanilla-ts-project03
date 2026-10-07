/**
 * 编排层纯逻辑：解锁判定、持久化序列化/校验、代际冲突合并。
 * 全部为无副作用纯函数，可用 node:test 脱离 DOM 单测。
 *
 * 持久化安全约束：记录中只允许出现 state/progress/round/attempts/cover
 * （涂层位图），严禁写入奖品标题、描述、图片等敏感内容。
 */
import { ACTIVITY_PHASE } from './types.ts'
import type { ActivityPhase } from './types.ts'

/** 当前持久化 schema 版本 */
export const RECORD_VERSION = 2
/** 旧版 schema 版本（仅用于无损迁移与共存协议识别） */
export const LEGACY_RECORD_VERSION = 1
/** 卡数运行时上下界（createScratchActivity 校验一致） */
export const MIN_CARDS = 1
export const MAX_CARDS = 9

/** 单卡持久化状态（cover 为涂层位图 dataURL，不含奖品内容） */
export interface CardPersistState {
  state: 'idle' | 'revealed'
  progress: number
  round: number
  /** 该卡累计进入刮擦状态的轮次数（v2 新增；跨代际累计，不随 reset 清零） */
  attempts: number
  cover?: string
}

/** 活动持久化记录（sessionStorage 中的唯一写入单元） */
export interface ActivityRecord {
  version: number
  /** 活动代际号：每轮新活动递增，防止旧代际数据回灌 */
  generation: number
  /** last-write-wins 比较用时间戳 */
  updatedAt: number
  phase: ActivityPhase
  /** 卡数（v2 新增顶层字段；恒等于 cards.length） */
  cardsCount: number
  cards: CardPersistState[]
}

/** parseRecordDetailed 回传：归一化后的 v2 记录 + 原始记录的 schema 版本 */
export interface ParsedRecord {
  record: ActivityRecord
  /** 该记录落盘时的版本：1 表示本次为迁移读入 */
  sourceVersion: 1 | 2
}

export function createInitialCards(count: number): CardPersistState[] {
  const cards: CardPersistState[] = []
  for (let i = 0; i < count; i += 1) {
    cards.push({ state: 'idle', progress: 0, round: 0, attempts: 0 })
  }
  return cards
}

export function createInitialRecord(
  generation: number,
  cardCount: number,
  now: number,
): ActivityRecord {
  return {
    version: RECORD_VERSION,
    generation,
    updatedAt: now,
    phase: ACTIVITY_PHASE.Active,
    cardsCount: cardCount,
    cards: createInitialCards(cardCount),
  }
}

/** 串行解锁：第 0 张恒解锁；第 N 张仅当第 N-1 张 revealed 后解锁 */
export function isCardUnlocked(
  cards: ReadonlyArray<Pick<CardPersistState, 'state'>>,
  index: number,
): boolean {
  if (index <= 0) return true
  return cards[index - 1]?.state === 'revealed'
}

export function isAllRevealed(
  cards: ReadonlyArray<Pick<CardPersistState, 'state'>>,
): boolean {
  return cards.length > 0 && cards.every((card) => card.state === 'revealed')
}

export function serializeRecord(record: ActivityRecord): string {
  return JSON.stringify(record)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function parseCard(raw: unknown, schemaVersion: 1 | 2): CardPersistState | null {
  if (!isPlainObject(raw)) return null
  if (raw.state !== 'idle' && raw.state !== 'revealed') return null
  if (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress)) {
    return null
  }
  if (
    typeof raw.round !== 'number' ||
    !Number.isInteger(raw.round) ||
    raw.round < 0
  ) {
    return null
  }
  const card: CardPersistState = {
    state: raw.state,
    progress: clamp01(raw.progress),
    round: raw.round,
    // v1 记录无 attempts 字段：无损迁移时该卡累计刮擦轮次置 0。
    // v2 要求非负整数；缺失/非法同样归零（该字段不影响进行中进度保全）。
    attempts: 0,
  }
  if (schemaVersion === 2) {
    if (
      typeof raw.attempts === 'number' &&
      Number.isInteger(raw.attempts) &&
      raw.attempts >= 0
    ) {
      card.attempts = raw.attempts
    } else {
      return null
    }
  }
  // cover 仅接受字符串；revealed 态不允许携带涂层位图
  if (typeof raw.cover === 'string' && raw.cover.length > 0 && card.state === 'idle') {
    card.cover = raw.cover
  }
  return card
}

/**
 * v1 -> v2 无损迁移（纯函数，且幂等）：
 * - 旧 3 卡数据原样映射进新结构，state/progress/round/cover 全部保留；
 * - 新增顶层 cardsCount（取实际卡数，旧生产记录恒为 3）；
 * - 每卡新增 attempts 置 0；
 * - 不改动 generation/updatedAt/phase，保证代际裁决与 last-write-wins 语义连续。
 *
 * 幂等性：入参为已归一化的 v2 结构时原样返回（不重排字段、不重置
 * attempts、不改写 updatedAt），因此同一 v1 记录被多次加载也无副作用。
 *
 * 关于 cover 位图：v1 的 cover 是按当时卡片宽高导出的 dataURL；若该位图
 * 与本卡当前尺寸不一致（宿主改版尺寸/分辨率），restore 加载方按既定取舍
 * 「保留 progress/round 数值进度、丢弃位图」处理（见 scratch-card.ts），
 * 此处迁移不主动删除 cover，以免尺寸恰好一致时平白丢失涂层。
 */
export function migrateLegacyRecord(
  record: ActivityRecord,
): ActivityRecord {
  if (record.version === RECORD_VERSION && record.cardsCount === record.cards.length) {
    return record
  }
  return {
    version: RECORD_VERSION,
    generation: record.generation,
    updatedAt: record.updatedAt,
    phase: record.phase,
    cardsCount: record.cards.length,
    cards: record.cards.map((card) => ({ ...card })),
  }
}

/**
 * 解析并校验持久化记录，同时回传其落盘 schema 版本（供迁移落盘与
 * 新旧版本共存协议判断）。
 *
 * 支持 version 1 与 version 2：v1 记录经无损迁移为 v2 后返回
 * （sourceVersion 标记为 1），绝不以「版本不符」整体丢弃进行中进度；
 * 其余任何字段不合法仍整体判废（返回 null），不带错恢复。
 */
export function parseRecordDetailed(raw: string | null): ParsedRecord | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(data)) return null
  if (
    data.version !== LEGACY_RECORD_VERSION &&
    data.version !== RECORD_VERSION
  ) {
    return null
  }
  const schemaVersion: 1 | 2 = data.version === LEGACY_RECORD_VERSION ? 1 : 2
  if (
    typeof data.generation !== 'number' ||
    !Number.isInteger(data.generation) ||
    data.generation < 1
  ) {
    return null
  }
  if (typeof data.updatedAt !== 'number' || !Number.isFinite(data.updatedAt)) {
    return null
  }
  if (
    data.phase !== ACTIVITY_PHASE.Active &&
    data.phase !== ACTIVITY_PHASE.Completed
  ) {
    return null
  }
  if (!Array.isArray(data.cards)) return null
  if (data.cards.length < MIN_CARDS || data.cards.length > MAX_CARDS) {
    return null
  }
  const cards: CardPersistState[] = []
  for (const rawCard of data.cards) {
    const card = parseCard(rawCard, schemaVersion)
    if (!card) return null
    cards.push(card)
  }
  // v2 顶层 cardsCount 必须为与卡数组一致的非负整数；不一致即判废。
  // v1 无该字段，迁移时以实际卡数补入（不在这里拒绝旧记录）。
  if (schemaVersion === 2) {
    if (
      typeof data.cardsCount !== 'number' ||
      !Number.isInteger(data.cardsCount) ||
      data.cardsCount !== cards.length
    ) {
      return null
    }
  }
  const normalized: ActivityRecord = {
    version: RECORD_VERSION,
    generation: data.generation,
    updatedAt: data.updatedAt,
    phase: data.phase,
    cardsCount: cards.length,
    cards,
  }
  return { record: normalized, sourceVersion: schemaVersion }
}

/**
 * 解析并校验持久化记录；任何字段不合法即判废（返回 null）。
 * 返回值统一为归一化后的 v2 结构（v1 记录已完成内存迁移）。
 */
export function parseRecord(raw: string | null): ActivityRecord | null {
  return parseRecordDetailed(raw)?.record ?? null
}

export type RemoteDecision =
  | 'apply'
  | 'readonly'
  | 'ignore'

/**
 * 多标签页冲突合并（last-write-wins + 代际号）：
 * - 远端代际更高：本页已落后，降级只读并提示刷新；
 * - 远端代际更低：旧代际回灌，直接忽略；
 * - 同代际：updatedAt 更新者胜（apply），否则忽略。
 */
export function decideRemoteRecord(
  local: { generation: number; updatedAt: number },
  remote: { record: ActivityRecord; sourceVersion: 1 | 2 } | null,
): RemoteDecision {
  if (!remote) return 'ignore'
  // 新旧版本共存协议：storage 事件中收到 version 1 的外来记录，说明仍有
  // 旧版页面在写入。旧版写入方一律视为「低代际」方：本页绝不采用其内容
  // （旧结构不含 attempts/cardsCount，apply 会丢字段），也绝不把 v1 原样
  // 回写（本页 persist 恒写 v2）。同时它也不构成「更新代际回灌」，故不
  // 触发只读降级——直接忽略即可，避免旧页误锁死新页。
  if (remote.sourceVersion === LEGACY_RECORD_VERSION) return 'ignore'
  const remoteRecord = remote.record
  if (remoteRecord.generation > local.generation) return 'readonly'
  if (remoteRecord.generation < local.generation) return 'ignore'
  if (remoteRecord.updatedAt > local.updatedAt) return 'apply'
  return 'ignore'
}
