/**
 * 活动持久化纯逻辑（无 DOM 依赖，node:test 可直接覆盖）：
 * - createSafeStorage：sessionStorage 不可用时（隐私模式抛异常）静默降级内存态；
 * - serializeActivity / parseActivity：持久化 schema 的序列化与防御性解析；
 * - resolveStorageConflict：多标签页 last-write-wins + 代际号冲突裁决。
 *
 * 持久化内容只含状态/进度/轮次/刮痕坐标，绝不包含奖品内容。
 */
import type {
  CardStage,
  PersistedActivityState,
  PersistedCardState,
  PersistedStamp,
} from './types.ts'
import { ACTIVITY_PHASE, CARD_COUNT, PERSIST_VERSION } from './types.ts'

/** 单卡持久化刮痕上限：超出后停止记录，避免 sessionStorage 膨胀 */
export const MAX_PERSISTED_STAMPS = 800

export interface SafeStorage {
  /** 底层 sessionStorage 是否真的可用（false = 内存降级） */
  readonly available: boolean
  get: (key: string) => string | null
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

/**
 * 包装 Storage；探测或运行期任何一次访问抛异常都静默降级为内存 Map。
 * area 为 null（非浏览器环境）时直接使用内存态。
 */
export function createSafeStorage(area: Storage | null): SafeStorage {
  const memory = new Map<string, string>()
  let usable = false
  if (area) {
    try {
      const probeKey = '__scratch_activity_probe__'
      area.setItem(probeKey, '1')
      area.removeItem(probeKey)
      usable = true
    } catch {
      usable = false
    }
  }
  return {
    available: usable,
    get(key) {
      if (usable && area) {
        try {
          return area.getItem(key)
        } catch {
          // 运行期异常（如隐私模式配额/策略变化）降级内存
        }
      }
      return memory.get(key) ?? null
    },
    set(key, value) {
      if (usable && area) {
        try {
          area.setItem(key, value)
          return
        } catch {
          // 同上，静默降级
        }
      }
      memory.set(key, value)
    },
    remove(key) {
      if (usable && area) {
        try {
          area.removeItem(key)
          return
        } catch {
          // 同上
        }
      }
      memory.delete(key)
    },
  }
}

export function serializeActivity(state: PersistedActivityState): string {
  return JSON.stringify(state)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp01(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function parseStamp(value: unknown): PersistedStamp | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const [x, y, radius] = value
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof radius !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return null
  }
  return [x, y, radius]
}

function parseCard(value: unknown): PersistedCardState | null {
  if (!isRecord(value)) return null
  const rawState = value.state
  const state: CardStage =
    rawState === 'revealed'
      ? 'revealed'
      : rawState === 'scratching'
        ? 'scratching'
        : 'idle'
  const rawStamps = Array.isArray(value.stamps) ? value.stamps : []
  const stamps: PersistedStamp[] = []
  for (const raw of rawStamps) {
    if (stamps.length >= MAX_PERSISTED_STAMPS) break
    const stamp = parseStamp(raw)
    if (stamp) stamps.push(stamp)
  }
  return {
    state,
    progress: clamp01(value.progress),
    round: toNonNegativeInt(value.round),
    stamps,
  }
}

/**
 * 防御性解析持久化快照：结构不合法（版本不符/缺字段/卡数不为 3）返回 null，
 * 字段级问题做钳制修复。任何异常都返回 null，绝不抛出。
 */
export function parseActivity(raw: string | null): PersistedActivityState | null {
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(data)) return null
  if (data.version !== PERSIST_VERSION) return null
  if (typeof data.tabId !== 'string' || data.tabId.length === 0) return null
  const phase =
    data.phase === ACTIVITY_PHASE.Completed
      ? ACTIVITY_PHASE.Completed
      : ACTIVITY_PHASE.Active
  if (!Array.isArray(data.cards) || data.cards.length !== CARD_COUNT) return null
  const cards: PersistedCardState[] = []
  for (const rawCard of data.cards) {
    const card = parseCard(rawCard)
    if (!card) return null
    cards.push(card)
  }
  return {
    version: PERSIST_VERSION,
    generation: toNonNegativeInt(data.generation),
    tabId: data.tabId,
    updatedAt:
      typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt)
        ? data.updatedAt
        : 0,
    phase,
    activeIndex: Math.min(
      CARD_COUNT - 1,
      toNonNegativeInt(data.activeIndex),
    ),
    cards,
  }
}

export type ConflictResolution =
  | 'foreign-newer'
  | 'foreign-stale'
  | 'ignore'

/**
 * 多标签页冲突裁决（last-write-wins + 代际号）：
 * - 外来代际更高：他页已接管 → 本页应降级只读；
 * - 外来代际更低：旧代际回灌 → 本页应重写覆盖；
 * - 同代际同 tab：回声/重复写 → 忽略；
 * - 同代际不同 tab（同时加载竞态）：tabId 字典序大者胜，双方向判定一致。
 */
export function resolveStorageConflict(
  localGeneration: number,
  localTabId: string,
  incoming: PersistedActivityState,
): ConflictResolution {
  if (incoming.generation > localGeneration) return 'foreign-newer'
  if (incoming.generation < localGeneration) return 'foreign-stale'
  if (incoming.tabId === localTabId) return 'ignore'
  return incoming.tabId > localTabId ? 'foreign-newer' : 'foreign-stale'
}
