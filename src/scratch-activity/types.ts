/**
 * 活动编排层公共类型（纯类型文件，零运行时副作用）。
 * 约束同 scratch-card/types.ts：const 对象 + 字面量联合，import type。
 */
import type {
  ScratchCardHandle,
  ScratchCardOptions,
  ScratchPrize,
} from '../scratch-card/index.ts'

/** 活动阶段（持久化到 sessionStorage） */
export const ACTIVITY_PHASE = {
  Active: 'active',
  Completed: 'completed',
} as const

export type ActivityPhase = (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE]

/** 编排层接管的卡片配置：restore 由编排层内部注入，宿主不可传 */
export type ScratchActivityCardOptions = Omit<ScratchCardOptions, 'restore'>

export interface ScratchActivityOptions {
  /** 恰好 3 张卡，按串行解锁顺序给出 */
  cards: readonly [
    ScratchActivityCardOptions,
    ScratchActivityCardOptions,
    ScratchActivityCardOptions,
  ]
  /** sessionStorage key 前缀，默认 'scratch-activity' */
  storagePrefix?: string
  /** 上一张 revealed 后下一张的解锁倒计时（ms），默认 2000；0 表示立即解锁 */
  unlockDelay?: number
  /** 全部 revealed 后触发（刷新恢复已完成的活动时不会重复触发） */
  allRevealed?: (prizes: readonly ScratchPrize[]) => void
}

export interface ScratchActivityHandle {
  /** 活动根元素，供宿主挂载 */
  readonly element: HTMLElement
  /**
   * 子卡句柄（只读数组）。activity.destroy() 不会销毁子卡，
   * 宿主可经此独立调用各卡的 destroy()。
   */
  readonly cards: readonly ScratchCardHandle[]
  /** 当前活动阶段 */
  getPhase: () => ActivityPhase
  /** 当前活动代际号（每次「再来一轮」递增） */
  getGeneration: () => number
  /** 是否已因多标签页代际冲突降级为只读 */
  isReadOnly: () => boolean
  /**
   * 回收编排层自身全部监听与 timer（storage 监听、倒计时、子卡事件
   * 订阅），并移除活动根元素；不销毁子卡句柄。
   */
  destroy: () => void
}
