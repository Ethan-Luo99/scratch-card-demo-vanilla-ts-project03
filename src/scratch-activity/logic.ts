/**
 * 编排层纯逻辑：解锁判定、持久化序列化/校验/迁移、代际冲突合并。
 * 全部为无副作用纯函数，可用 node:test 脱离 DOM 单测。
 *
 * 持久化安全约束：记录中只允许出现 state/progress/round/cover（涂层位图）/
 * attempts（纯计数）/ cardsCount，严禁写入奖品标题、描述、图片等敏感内容。
 */
import { ACTIVITY_PHASE } from './types.ts'
import type { ActivityPhase } from './types.ts'

/** 当前持久化 schema 版本（v2：新增 cardsCount 与每卡 attempts） */
export const RECORD_VERSION = 2
/** 旧版 schema：旧版页面仍在写入时用于共存协议判定 */
export const LEGACY_RECORD_VERSION = 1
/** 支持的卡片数量区间（运行时强制校验） */
export const MIN_CARD_COUNT = 1
export const MAX_CARD_COUNT = 9

/** 单卡持久化状态（cover 为涂层位图 dataURL，不含奖品内容） */
export interface CardPersistState {
  state: 'idle' | 'revealed'
  progress: number
  round: number
  /** 该卡累计进入刮擦状态的轮次数（每个 round 最多计 1 次） */
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
  /** 卡片总数（v2 起显式持久化；须与 cards.length 一致） */
  cardsCount: number
  cards: CardPersistState[]
}

/** v1 旧记录结构（无 cardsCount / 无 attempts；固定 3 卡） */
interface LegacyActivityRecord {
  version: typeof LEGACY_RECORD_VERSION
  generation: number
  updatedAt: number
  phase: ActivityPhase
  cards: LegacyCardPersistState[]
}

interface LegacyCardPersistState {
  state: 'idle' | 'revealed'
  progress: number
  round: number
  cover?: string
}

/** 经 parseStoredRecord 解析后的记录：legacy 标记来源版本 */
export interface ParsedRecord extends ActivityRecord {
  /** true 表示由 v1 记录迁移而来（仅内存标记，从不持久化） */
  legacy?: boolean
}

/** 校验并归一化卡片数量（1~9） */
export function isValidCardCount(count: number): boolean {
  return Number.isInteger(count) && count >= MIN_CARD_COUNT && count <= MAX_CARD_COUNT
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

/**
 * 从 PNG dataURL 同步提取位图像素尺寸（IHDR 在 8 字节签名之后：
 * 4 字节块长 + 'IHDR' + 4 字节宽 + 4 字节高，均为大端）。
 * 仅用于 v1 位图与当前卡片尺寸的适配判定；非 PNG、数据损坏或
 * base64 解码失败时返回 null（调用方据此保留原位图，交由加载裁决）。
 * 用全局 atob 解码，浏览器与 node:test 环境均原生可用、零依赖。
 */
export function getPngDataUrlSize(
  dataUrl: string,
): { width: number; height: number } | null {
  const prefix = /^data:image\/png;base64,/i.exec(dataUrl)
  if (!prefix) return null
  // 前 24 字节只需 base64 的前 32 个字符
  const head64 = dataUrl.slice(prefix[0].length).replace(/\s/g, '').slice(0, 32)
  let bytes: string
  try {
    bytes = atob(head64)
  } catch {
    return null
  }
  if (bytes.length < 24) return null
  const code = (i: number): number => bytes.charCodeAt(i)
  // PNG 签名：89 50 4E 47 0D 0A 1A 0A
  if (
    code(0) !== 0x89 ||
    bytes[1] !== 'P' ||
    bytes[2] !== 'N' ||
    bytes[3] !== 'G' ||
    code(4) !== 0x0d ||
    code(5) !== 0x0a ||
    code(6) !== 0x1a ||
    code(7) !== 0x0a
  ) {
    return null
  }
  if (bytes.slice(12, 16) !== 'IHDR') return null
  const readUInt32BE = (offset: number): number =>
    code(offset) * 0x1000000 +
    code(offset + 1) * 0x10000 +
    code(offset + 2) * 0x100 +
    code(offset + 3)
  const width = readUInt32BE(16)
  const height = readUInt32BE(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 校验非负整数 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function parseCard(raw: unknown): CardPersistState | null {
  if (!isPlainObject(raw)) return null
  if (raw.state !== 'idle' && raw.state !== 'revealed') return null
  if (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress)) {
    return null
  }
  if (!isNonNegativeInteger(raw.round)) {
    return null
  }
  // v2：attempts 必填，须为非负整数
  if (!isNonNegativeInteger(raw.attempts)) return null
  const card: CardPersistState = {
    state: raw.state,
    progress: clamp01(raw.progress),
    round: raw.round,
    attempts: raw.attempts,
  }
  // cover 仅接受字符串；revealed 态不允许携带涂层位图
  if (typeof raw.cover === 'string' && raw.cover.length > 0 && card.state === 'idle') {
    card.cover = raw.cover
  }
  return card
}

/**
 * 解析并校验 v2 持久化记录；任何字段不合法即判废（返回 null）。
 * cardsCount 必须为 1~9 且与 cards.length 一致。
 */
function parseV2(data: Record<string, unknown>): ParsedRecord | null {
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
  if (!isNonNegativeInteger(data.cardsCount) || !isValidCardCount(data.cardsCount)) {
    return null
  }
  if (!Array.isArray(data.cards) || data.cards.length !== data.cardsCount) {
    return null
  }
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
    cardsCount: data.cardsCount,
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
/** v1 单卡解析（宽松但仍做字段级校验；任一字段非法的卡片判 null） */
function parseLegacyCard(raw: unknown): LegacyCardPersistState | null {
  if (!isPlainObject(raw)) return null
  if (raw.state !== 'idle' && raw.state !== 'revealed') return null
  if (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress)) {
    return null
  }
  if (!isNonNegativeInteger(raw.round)) return null
  const card: LegacyCardPersistState = {
    state: raw.state,
    progress: clamp01(raw.progress),
    round: raw.round,
  }
  if (typeof raw.cover === 'string' && raw.cover.length > 0 && card.state === 'idle') {
    card.cover = raw.cover
  }
  return card
}

/**
 * 无损迁移 v1 旧记录到 v2：
 * - state/progress/round/cover 全部保留；
 * - attempts 置 0（旧版无此统计，迁移无法回溯历史刮擦轮次）；
 * - 以 cards 实际长度推导 cardsCount（v1 固定 3 卡，但仍以数据为准）。
 * 纯函数：同一 v1 记录重复迁移结果完全一致，天然幂等。
 */
function migrateLegacy(record: LegacyActivityRecord): ParsedRecord {
  return {
    version: RECORD_VERSION,
    generation: record.generation,
    updatedAt: record.updatedAt,
    phase: record.phase,
    cardsCount: record.cards.length,
    cards: record.cards.map((card) => {
      const next: CardPersistState = {
        state: card.state,
        progress: card.progress,
        round: card.round,
        attempts: 0,
      }
      if (card.cover !== undefined) next.cover = card.cover
      return next
    }),
    legacy: true,
  }
}

/** 解析 v1 旧记录；任一字段不合法返回 null（但绝不因「版本旧」丢弃） */
function parseLegacy(data: Record<string, unknown>): ParsedRecord | null {
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
  const cards: LegacyCardPersistState[] = []
  for (const rawCard of data.cards) {
    const card = parseLegacyCard(rawCard)
    if (!card) return null
    cards.push(card)
  }
  const record: LegacyActivityRecord = {
    version: LEGACY_RECORD_VERSION,
    generation: data.generation,
    updatedAt: data.updatedAt,
    phase: data.phase,
    cards,
  }
  return migrateLegacy(record)
}

/**
 * 统一持久化入口：兼容解析 v2 与 v1 记录。
 * - v1 记录迁移为 v2 内存结构（legacy: true），由调用方负责落盘，
 *   重复加载同一 v1 记录只会得到相同的迁移结果，迁移幂等；
 * - JSON 损坏等真正无法解析的情况返回 null。
 */
export function parseStoredRecord(raw: string | null): ParsedRecord | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(data)) return null
  if (data.version === RECORD_VERSION) return parseV2(data)
  if (data.version === LEGACY_RECORD_VERSION) return parseLegacy(data)
  return null
}
export function decideRemoteRecord(
  local: { generation: number; updatedAt: number },
  remote: ParsedRecord | null,
): RemoteDecision {
  if (!remote) return 'ignore'
  // 新旧版本共存协议：storage 事件里来自旧版页面的 v1 记录（已迁移为
  // legacy: true 的内存结构）一律视为「低代际写入方」直接忽略——
  // 协议含义：旧版页面无法理解 v2 字段，也不能感知本页的 v2 进度，
  // 若按 updatedAt 采纳其记录会把 cardsCount/attempts 信息抹回旧结构，
  // 甚至误触发整卡应用。忽略它既不会崩溃，也不会把 v1 原样写回覆盖
  // 本页 v2 记录（本页 persist 永远写当前 v2 结构）；旧版标签页继续
  // 按其自身逻辑运行，待其关闭或刷新升级后再重新协同。
  if (remote.legacy) return 'ignore'
  if (remote.generation > local.generation) return 'readonly'
  if (remote.generation < local.generation) return 'ignore'
  if (remote.updatedAt > local.updatedAt) return 'apply'
  return 'ignore'
}
