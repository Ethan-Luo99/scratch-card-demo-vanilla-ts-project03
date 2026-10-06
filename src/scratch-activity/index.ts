/**
 * 刮刮卡活动编排层唯一对外出口：
 * - 值导出 createScratchActivity 与只读常量；
 * - 类型一律 export type，满足 verbatimModuleSyntax。
 */
export { createScratchActivity } from './scratch-activity.ts'
export { ACTIVITY_PHASE, CARD_COUNT } from './types.ts'
export type {
  ActivityPhase,
  CardStage,
  PersistedActivityState,
  PersistedCardState,
  PersistedStamp,
  ScratchActivityCardSpec,
  ScratchActivityEventMap,
  ScratchActivityHandle,
  ScratchActivityOptions,
} from './types.ts'
