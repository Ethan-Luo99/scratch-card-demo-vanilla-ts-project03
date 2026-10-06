/**
 * 刮刮卡活动编排层公共类型（纯类型 + as const 常量，零运行时副作用）。
 *
 * 约束同 scratch-card：erasableSyntaxOnly / verbatimModuleSyntax，
 * 状态用「const 对象 + 字符串字面量联合类型」，跨模块类型一律 import type。
 */
import type { ScratchCardHandle, ScratchPrize } from '../scratch-card/index.ts'

/** 活动固定编排 3 张卡 */
export const CARD_COUNT = 3

/** 活动阶段（持久化到 sessionStorage） */
export const ACTIVITY_PHASE = {
  Active: 'active',
  Completed: 'completed',
} as const

export type ActivityPhase = (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE]

/** 单张卡在编排层视角下的阶段（revealing 为子卡内部瞬态，编排层不感知） */
export const CARD_STAGE = {
  Idle: 'idle',
  Scratching: 'scratching',
  Revealed: 'revealed',
} as const

export type CardStage = (typeof CARD_STAGE)[keyof typeof CARD_STAGE]

/** 单张卡的编排配置 */
export interface ScratchActivityCardSpec {
  prize: ScratchPrize
  /** 涂层提示文字，透传给子卡 */
  coverText?: string
  /** 涂层纹理种子，透传给子卡 */
  seed?: number
}

export interface ScratchActivityOptions {
  /** 恰好 3 张卡，按串行解锁顺序给出 */
  cards: readonly [ScratchActivityCardSpec, ScratchActivityCardSpec, ScratchActivityCardSpec]
  /** 单卡宽度（CSS px 或百分比），默认 320 */
  width?: number | string
  /** 单卡高度（CSS px），默认 200 */
  height?: number
  /** 子卡自动揭示阈值 0~1，默认沿用子卡默认 0.7 */
  threshold?: number
  /** 擦除笔刷半径（CSS px），默认 24；刮痕录制与回放共用该值 */
  brushRadius?: number
  /** sessionStorage key 前缀，默认 'scratch-activity' */
  keyPrefix?: string
  /** 上一张 revealed 后下一张的解锁倒计时（ms），默认 3000；0 表示立即解锁 */
  unlockDelayMs?: number
  /** 汇总层标题，默认「全部揭晓！」 */
  summaryTitle?: string
  /** 汇总层描述文案，可选 */
  summaryDescription?: string
  /** 全部 revealed 后的回调（与 allRevealed 事件并行触发） */
  onAllRevealed?: () => void
}

export interface ScratchActivityEventMap {
  /** 第 index 张卡解锁（倒计时结束） */
  unlock: { index: number }
  /** 3 张全部 revealed */
  allRevealed: { generation: number }
  /** 检测到其他标签页持有更新代际，本页已降级只读 */
  readonly: { generation: number }
}

/** 编排层对外命令式句柄 */
export interface ScratchActivityHandle {
  /** 活动根元素，供宿主插入页面 */
  readonly element: HTMLElement
  /** 3 张子卡句柄（编排层 destroy 不会销毁它们，调用方可独立 destroy） */
  readonly cards: readonly ScratchCardHandle[]
  getPhase: () => ActivityPhase
  /** 当前已解锁到的最大卡索引（0 起） */
  getActiveIndex: () => number
  /** 是否已因多标签页代际冲突降级为只读 */
  isReadOnly: () => boolean
  on: <K extends keyof ScratchActivityEventMap>(
    type: K,
    listener: (ev: ScratchActivityEventMap[K]) => void,
  ) => () => void
  /** 重新开始活动：全部子卡 reset、代际号 +1、回到第 1 张 */
  reset: () => void
  /** 回收编排层自身全部监听与 timer；不销毁子卡句柄 */
  destroy: () => void
}

// ---------- 持久化 schema（不含任何奖品内容） ----------

export const PERSIST_VERSION = 1

/** 持久化的刮痕圆戳元组 [x, y, radius]（CSS px，保留 1 位小数） */
export type PersistedStamp = [number, number, number]

export interface PersistedCardState {
  state: CardStage
  progress: number
  round: number
  stamps: PersistedStamp[]
}

export interface PersistedActivityState {
  version: number
  /** 活动代际号：每次加载/重新开始 +1，多标签页 last-write-wins 依据 */
  generation: number
  /** 写入方标签页标识，用于同代际冲突的确定性裁决 */
  tabId: string
  updatedAt: number
  phase: ActivityPhase
  activeIndex: number
  cards: PersistedCardState[]
}
