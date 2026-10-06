/**
 * 活动编排层唯一对外出口：
 * - 唯一值导出 createScratchActivity（另导出 ACTIVITY_PHASE 常量映射）；
 * - 类型一律 `export type`，满足 verbatimModuleSyntax。
 */
export { createScratchActivity } from './activity.ts'
export { ACTIVITY_PHASE } from './types.ts'
export type {
  ActivityPhase,
  ScratchActivityCardOptions,
  ScratchActivityHandle,
  ScratchActivityOptions,
} from './types.ts'
