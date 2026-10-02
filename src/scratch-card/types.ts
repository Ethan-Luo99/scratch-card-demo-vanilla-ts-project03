export interface ScratchPrize {
  /** 奖品主标题，必填，如「一等奖」 */
  title: string
  /** 副标题/描述，可选，与图片可同时存在并叠加 */
  description?: string
  /** 奖品图片 URL（由调用方经 Vite import 得到的 hash URL），可选 */
  image?: {
    src: string
    alt: string
    /** CSS 尺寸提示，默认 contain */
    fit?: 'contain' | 'cover'
  }
}

export interface ScratchCardOptions {
  prize: ScratchPrize
  /** CSS 像素尺寸；为响应式，宽度也支持传 '100%'（高度按 ratio 推） */
  width: number | string
  height: number
  /** 自动揭示阈值，0~1，默认 0.7 */
  threshold?: number
  /** 擦除笔刷半径（CSS px），默认 24；移动端建议 28 */
  brushRadius?: number
  /** 快速滑动相邻点插值的最大线段长（CSS px），默认 8 */
  maxSegment?: number
  /** 覆盖率检测节流（ms），默认 120（rAF 合帧） */
  coverageInterval?: number
  /** 揭示动画时长 ms；reduced-motion 下自动归零 */
  revealDuration?: number
  /** 涂层上的印刷提示文字，如「刮开有奖」 */
  coverText?: string
}

export interface ScratchCardEventMap {
  /** 首次开始刮 */
  scratchstart: { progress: number }
  /** 每帧节流后的进度 */
  progress: { progress: number }
  /** 越过阈值（只触发一次/轮） */
  threshold: { progress: number }
  /** 完全揭示动画结束 */
  revealed: { prize: ScratchPrize }
  /** 调用 reset 完成 */
  reset: { round: number }
}

export interface ScratchCardHandle {
  /** 卡片根元素（已挂载奖品与 canvas），供插入页面 */
  readonly element: HTMLElement
  /** 编程式重置：恢复完整涂层，round+1，可换新奖品 */
  reset: (nextPrize?: ScratchPrize) => void
  /** 编程式直接揭示（无障碍/键盘用）；同样走 revealing 状态机 */
  reveal: () => void
  /** 当前进度（0~1，降采样近似值） */
  getProgress: () => number
  on: <K extends keyof ScratchCardEventMap>(
    type: K,
    listener: (ev: ScratchCardEventMap[K]) => void,
  ) => () => void
  destroy: () => void
}

/** 生命周期状态：union 字面量 + 常量对象（禁用 enum） */
export const SCRATCH_STATE = {
  Idle: 'idle',
  Scratching: 'scratching',
  Revealing: 'revealing',
  Revealed: 'revealed',
} as const

export type ScratchState = (typeof SCRATCH_STATE)[keyof typeof SCRATCH_STATE]

/** CSS 像素坐标点 */
export interface Point {
  x: number
  y: number
}

/** 涂层绘制参数 */
export interface PaintOptions {
  width: number
  height: number
  coverText: string
  /** 纹理 PRNG 种子，reset 时随 round 变化即可复现/换纹 */
  seed: number
  /** CSS 变量运行时采样结果 */
  colors: CoverColors
}

export interface CoverColors {
  /** 渐变起点色 --scratch-cover-1 */
  start: string
  /** 渐变终点色 --scratch-cover-2 */
  end: string
  /** 金属高光色 --scratch-cover-highlight */
  highlight: string
  /** 内边缘描边色 --scratch-cover-edge */
  edge: string
  /** 印刷提示文字色 --scratch-hint */
  text: string
}

export type ScratchEventListener<K extends keyof ScratchCardEventMap> = (
  ev: ScratchCardEventMap[K],
) => void
