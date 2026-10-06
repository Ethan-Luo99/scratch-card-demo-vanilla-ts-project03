/**
 * 刮刮卡模块唯一对外出口（设计 B2）：
 * - 唯一值导出 createScratchCard；
 * - 类型一律 `export type`，满足 verbatimModuleSyntax。
 */
export { createScratchCard } from './scratch-card.ts'
export type {
  ScratchCardHandle,
  ScratchCardOptions,
  ScratchPrize,
  ScratchRestoreOptions,
  ScratchCardEventMap,
} from './types.ts'
export type { State, Point, Stamp } from './types.ts'
