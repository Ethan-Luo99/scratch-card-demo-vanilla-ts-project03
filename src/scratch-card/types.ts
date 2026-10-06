/**
 * 刮刮卡模块公共类型（纯类型文件，零运行时副作用）。
 *
 * 受 tsconfig 的 erasableSyntaxOnly / verbatimModuleSyntax 约束：
 * - 状态枚举只能用「const 对象 + 字符串字面量联合类型」表达；
 * - 所有跨模块引用类型必须使用 `import type`。
 */

/** 奖品主数据：文字 / 描述 / 图片可叠加 */
export interface ScratchPrize {
  /** 奖品主标题，必填，如「一等奖」 */
  title: string
  /** 副标题/描述，可选，可与图片同时存在 */
  description?: string
  /** 奖品图片 URL（由调用方经 Vite import 得到的 hash URL），可选 */
  image?: {
    src: string
    alt: string
    /** CSS object-fit，默认 contain */
    fit?: 'contain' | 'cover'
  }
}

export interface ScratchCardOptions {
  prize: ScratchPrize
  /** CSS 像素尺寸；宽度也支持 '100%' 等百分比（高度按固定像素） */
  width: number | string
  height: number
  /** 自动揭示阈值，0~1，默认 0.7 */
  threshold?: number
  /** 擦除笔刷半径（CSS px），默认 24 */
  brushRadius?: number
  /** 快速滑动相邻点插值的最大线段长（CSS px），默认 8 */
  maxSegment?: number
  /** 覆盖率检测节流（ms），默认 120 */
  coverageInterval?: number
  /** 揭示动画时长 ms；reduced-motion 下自动归零，默认 420 */
  revealDuration?: number
  /** 涂层上的印刷提示文字，默认「刮开有奖」 */
  coverText?: string
  /** 涂层随机纹理基础种子；不传则由工厂自行取默认值 */
  seed?: number
  /**
   * 可选：构造时恢复快照（编排层用于刷新后状态恢复）。
   * - state 'revealed'：构造即同步进入 revealed 终态（无动画、事件派发于
   *   订阅之前，对外不可见）；
   * - state 'idle' 且带 cover：异步回贴涂层位图并恢复 progress/round，
   *   位图加载失败时静默回退为全新涂层（progress 归零）。
   * 不传时行为与既有版本完全一致。
   */
  restore?: ScratchCardSnapshot
}

/**
 * 卡片可持久化快照（由 handle.snapshot() 产出、options.restore 消费）。
 * cover 为涂层 canvas 的 dataURL：涂层位图只含银色遮盖层与刮除空洞，
 * 奖品内容在独立 DOM 层、从不进入 canvas，因此快照不含奖品信息。
 */
export interface ScratchCardSnapshot {
  /** 生命周期状态（仅 idle / revealed 可持久化；revealing 归并为 idle） */
  state: 'idle' | 'revealed'
  /** 已刮进度 0~1 */
  progress: number
  /** 卡片内部轮次号（reset 递增），恢复后续接编号 */
  round: number
  /** 涂层位图 dataURL；仅进行中（0<progress 且未揭示）时存在 */
  cover?: string
}

export interface ScratchCardEventMap {
  /** 首次开始刮 */
  scratchstart: { progress: number }
  /** 节流后的进度更新 */
  progress: { progress: number }
  /** 越过阈值（每轮只触发一次） */
  threshold: { progress: number }
  /** 完全揭示（动画结束 / reduced-motion 立即） */
  revealed: { prize: ScratchPrize }
  /** reset 完成 */
  reset: { round: number }
}

/** 工厂对外命令式句柄 */
export interface ScratchCardHandle {
  /** 卡片根元素（已挂载奖品层与 canvas），供宿主插入页面 */
  readonly element: HTMLElement
  /** 编程式重置：恢复完整涂层，round+1，可换新奖品；任何状态下调用均安全 */
  reset: (nextPrize?: ScratchPrize) => void
  /** 编程式直接揭示（无障碍/键盘用）；走 revealing 状态机 */
  reveal: () => void
  /** 当前进度（0~1，降采样近似值） */
  getProgress: () => number
  /** 导出当前可持久化快照（供编排层写入 sessionStorage） */
  snapshot: () => ScratchCardSnapshot
  /** 订阅事件，返回退订函数 */
  on: <K extends keyof ScratchCardEventMap>(
    type: K,
    listener: (ev: ScratchCardEventMap[K]) => void,
  ) => () => void
  /** 解绑所有监听、取消 rAF/计时器、释放 canvas 位图；可重复调用 */
  destroy: () => void
}

/** 生命周期状态（D 节状态机） */
export const STATE = {
  Idle: 'idle',
  Scratching: 'scratching',
  Revealing: 'revealing',
  Revealed: 'revealed',
} as const

export type State = (typeof STATE)[keyof typeof STATE]

/** CSS 像素坐标系下的点 */
export interface Point {
  x: number
  y: number
}

/** 擦除圆戳 */
export interface Stamp {
  x: number
  y: number
  radius: number
}
