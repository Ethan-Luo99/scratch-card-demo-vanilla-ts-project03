/**
 * 覆盖率检测（设计 C4）：
 * - 涂层 canvas 缩放到 32×20 离屏小 canvas 后 getImageData，回读量降至 ~640 像素；
 * - alpha < 128 的格子计为「已刮开」；
 * - markDirty 只置脏，rAF 循环中距上次统计 >= interval 才真算；
 * - 提前退出：已刮格子达到 total*threshold 即停止扫描（阈值判定只需要布尔结果）；
 * - flush() 供 pointerup 立即补算，防止最后一个节流窗口漏判。
 *
 * 统计相关函数均为纯函数，可用 node:test 脱离 DOM 单测。
 */

/** 降采样网格：边长约为涂层的 1/10 */
export const GRID_WIDTH = 32
export const GRID_HEIGHT = 20
/** alpha 低于该值视为涂层已被刮除 */
export const ALPHA_CLEAR = 128

/** 判断剩余 alpha 是否算「已刮开」 */
export function isCellClear(alpha: number): boolean {
  return alpha < ALPHA_CLEAR
}

/**
 * 扫描 RGBA 数据（每 4 个字节一个像素），返回已刮开格子占比（0~1）。
 * stopAfter 为提前退出目标数：到达后立即停止扫描，此时返回值基于
 * 「至少已达到该数量」的下界（阈值判定足够）；不传则全量精确统计。
 */
export function scanErasedRatio(
  data: ArrayLike<number>,
  stopAfter?: number,
): number {
  const total = Math.floor(data.length / 4)
  if (total === 0) return 0
  let erased = 0
  const limit = stopAfter === undefined
    ? -1
    : Math.max(0, Math.min(total, Math.floor(stopAfter)))
  for (let i = 0; i < total; i += 1) {
    const alpha = data[i * 4 + 3]
    if (isCellClear(alpha)) erased += 1
    if (limit > 0 && erased >= limit && i < total - 1) {
      // 提前退出：返回一个保证 >= threshold 的最小比值
      return Math.min(1, limit / total)
    }
  }
  return erased / total
}

/** 阈值判定（纯函数，便于单测） */
export function reachesThreshold(progress: number, threshold: number): boolean {
  return progress >= threshold
}

export interface CoverageSamplerOptions {
  source: HTMLCanvasElement
  interval: number
  threshold: number
  onMeasure: (progress: number) => void
  /** 可注入的 rAF（测试/降级时替换） */
  raf?: (callback: (time: number) => void) => number
  caf?: (handle: number) => void
}

/**
 * 节流覆盖率采样器。生命周期由外部 dispose() 结束；
 * 活跃状态下 rAF 自驱，但仅在 dirty 且时间窗满足时回读。
 */
export class CoverageSampler {
  private readonly source: HTMLCanvasElement
  private readonly interval: number
  private readonly threshold: number
  private readonly onMeasure: (progress: number) => void
  private readonly raf: (callback: (time: number) => void) => number
  private readonly caf: (handle: number) => void
  private readonly probe: HTMLCanvasElement
  private readonly probeCtx: CanvasRenderingContext2D | null
  private dirty = false
  private lastMeasureAt = 0
  private frame = 0
  private disposed = false

  constructor(options: CoverageSamplerOptions) {
    this.source = options.source
    this.interval = Math.max(0, options.interval)
    this.threshold = options.threshold
    this.onMeasure = options.onMeasure
    // 全局 WebIDL 方法必须绑定 window 宿主调用：直接存储裸方法再以
    // this.raf(...) 脱离宿主调用会抛 TypeError: Illegal invocation。
    // 注入的 raf/caf 由调用方自行保证绑定，仅包装默认全局方法。
    this.raf = options.raf ?? ((cb) => window.requestAnimationFrame(cb))
    this.caf = options.caf ?? ((handle) => window.cancelAnimationFrame(handle))
    this.probe = document.createElement('canvas')
    this.probe.width = GRID_WIDTH
    this.probe.height = GRID_HEIGHT
    this.probeCtx = this.probe.getContext('2d')
    this.frame = this.raf(this.tick)
  }

  /** 通知「涂层发生变化，需要重算」；仅置位，不做同步回读 */
  markDirty(): void {
    this.dirty = true
  }

  /** 强制立即统计一次（pointerup 双保险） */
  flush(time: number = performance.now()): void {
    if (this.disposed) return
    this.lastMeasureAt = time
    this.dirty = false
    this.onMeasure(this.measure())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frame) this.caf(this.frame)
    this.frame = 0
    this.probe.width = 0
    this.probe.height = 0
  }

  private readonly tick = (time: number): void => {
    if (this.disposed) return
    this.frame = this.raf(this.tick)
    if (!this.dirty) return
    if (time - this.lastMeasureAt < this.interval) return
    this.dirty = false
    this.lastMeasureAt = time
    this.onMeasure(this.measure())
  }

  private measure(): number {
    const ctx = this.probeCtx
    if (!ctx) return 0
    ctx.clearRect(0, 0, GRID_WIDTH, GRID_HEIGHT)
    ctx.drawImage(this.source, 0, 0, GRID_WIDTH, GRID_HEIGHT)
    let image: ImageData
    try {
      image = ctx.getImageData(0, 0, GRID_WIDTH, GRID_HEIGHT)
    } catch {
      return 0
    }
    // 提前退出目标数：达到即可断言 >= threshold
    const stopAfter = Math.ceil(GRID_WIDTH * GRID_HEIGHT * this.threshold)
    return scanErasedRatio(image.data, stopAfter)
  }
}
