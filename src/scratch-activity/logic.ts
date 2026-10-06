/**
 * 编排层纯逻辑（无 DOM 依赖，node:test 可直接覆盖）：
 * - 串行解锁判定；
 * - 刮痕元组与 Stamp 互转、刮痕记录上限。
 */
import type { Stamp } from '../scratch-card/index.ts'
import type { CardStage, PersistedStamp } from './types.ts'
import { MAX_PERSISTED_STAMPS } from './persistence.ts'

/**
 * 第一个尚未 revealed 的卡索引；全部 revealed 时返回卡数。
 * 串行解锁不变式：索引 <= firstLockedIndex 的卡允许刮擦。
 */
export function firstLockedIndex(stages: readonly CardStage[]): number {
  const index = stages.findIndex((stage) => stage !== 'revealed')
  return index === -1 ? stages.length : index
}

/** Stamp → 持久化元组（坐标保留 1 位小数，控制体积） */
export function stampToTuple(stamp: Stamp): PersistedStamp {
  return [
    Math.round(stamp.x * 10) / 10,
    Math.round(stamp.y * 10) / 10,
    Math.round(stamp.radius * 10) / 10,
  ]
}

/** 持久化元组 → Stamp（回放用） */
export function tupleToStamp(tuple: PersistedStamp): Stamp {
  return { x: tuple[0], y: tuple[1], radius: tuple[2] }
}

/**
 * 向刮痕缓冲追加一批圆戳；达到 MAX_PERSISTED_STAMPS 后丢弃多余部分。
 * 返回实际追加的数量。
 */
export function appendStamps(
  buffer: PersistedStamp[],
  stamps: readonly Stamp[],
): number {
  let appended = 0
  for (const stamp of stamps) {
    if (buffer.length >= MAX_PERSISTED_STAMPS) break
    buffer.push(stampToTuple(stamp))
    appended += 1
  }
  return appended
}
