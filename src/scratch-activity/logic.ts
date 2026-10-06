/**
 * 编排层纯逻辑：解锁判定、持久化序列化/校验、代际冲突合并。
 * 全部为无副作用纯函数，可用 node:test 脱离 DOM 单测。
 *
 * 持久化安全约束：记录中只允许出现 state/progress/round/cover（涂层位图），
 * 严禁写入奖品标题、描述、图片等敏感内容。
 */
import { ACTIVITY_PHASE } from './types.ts'
import type { ActivityPhase } from './types.ts'

export const RECORD_VERSION = 1

/** 单卡持久化状态（cover 为涂层位图 dataURL，不含奖品内容） */
export interface CardPersistState {
  state: 'idle' | 'revealed'
  progress: number
  round: number
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
  cards: CardPersistState[]
}

export function createInitialCards(count: number): CardPersistState[] {
  const cards: CardPersistState[] = []
  for (let i = 0; i < count; i += 1) {
    cards.push({ state: 'idle', progress: 0, round: 0 })
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

function parseCard(raw: unknown): CardPersistState | null {
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
  }
  // cover 仅接受字符串；revealed 态不允许携带涂层位图
  if (typeof raw.cover === 'string' && raw.cover.length > 0 && card.state === 'idle') {
    card.cover = raw.cover
  }
  return card
}

/**
 * 解析并校验持久化记录；任何字段不合法即整体判废（返回 null），
 * 宁可丢弃也不带错恢复。
 */
export function parseRecord(raw: string | null): ActivityRecord | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(data)) return null
  if (data.version !== RECORD_VERSION) return null
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
  if (!Array.isArray(data.cards) || data.cards.length === 0) return null
  const cards: CardPersistState[] = []
  for (const rawCard of data.cards) {
    const card = parseCard(rawCard)
    if (!card) return null
    cards.push(card)
  }
  return {
    version: RECORD_VERSION,
    generation: data.generation,
    updatedAt: data.updatedAt,
    phase: data.phase,
    cards,
  }
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
  remote: ActivityRecord | null,
): RemoteDecision {
  if (!remote) return 'ignore'
  if (remote.generation > local.generation) return 'readonly'
  if (remote.generation < local.generation) return 'ignore'
  if (remote.updatedAt > local.updatedAt) return 'apply'
  return 'ignore'
}
