export const SAMPLE_COLS = 32
export const SAMPLE_ROWS = 20
export const ALPHA_CUTOFF = 128

/**
 * 统计 alpha<cutoff 的格子占比（已擦除比例，0~1）。
 * 纯函数：只依赖给定 RGBA 数组，方便单测构造各种覆盖图案。
 * 提前退出：只关心是否达到 threshold 时，计到所需个数立即返回；
 * 未达标则必然扫完整个数组，返回的仍是精确比例。
 */
export function countErasedRatio(
  data: Uint8ClampedArray | Uint8Array,
  cutoff: number = ALPHA_CUTOFF,
  threshold: number = 1,
): number {
  const total = data.length / 4
  if (total <= 0) {
    return 0
  }
  const needed = Math.ceil(total * clamp01(threshold))
  let erased = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < cutoff) {
      erased += 1
      if (erased >= needed) {
        return erased / total
      }
    }
  }
  return erased / total
}

/** 实际比例统计（全扫描，无提前退出），供 getProgress/测试对照。 */
export function measureErasedRatio(
  data: Uint8ClampedArray | Uint8Array,
  cutoff: number = ALPHA_CUTOFF,
): number {
  const total = data.length / 4
  if (total <= 0) {
    return 0
  }
  let erased = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < cutoff) {
      erased += 1
    }
  }
  return erased / total
}

/**
 * 从涂层 canvas 降采样到 32×20 离屏小图并回读 alpha。
 * 回读量约为全图的 1/400，单次 <0.05ms。
 */
export function readCoverSample(
  source: CanvasImageSource,
  sample: HTMLCanvasElement,
): Uint8ClampedArray | null {
  const ctx = sample.getContext('2d')
  if (ctx === null) {
    return null
  }
  ctx.clearRect(0, 0, SAMPLE_COLS, SAMPLE_ROWS)
  ctx.drawImage(source, 0, 0, SAMPLE_COLS, SAMPLE_ROWS)
  return ctx.getImageData(0, 0, SAMPLE_COLS, SAMPLE_ROWS).data
}

/** 创建一块 32×20 降采样离屏 canvas（无 2D 支持时 null）。 */
export function createSampleCanvas(): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_COLS
  canvas.height = SAMPLE_ROWS
  if (canvas.getContext('2d') === null) {
    return null
  }
  return canvas
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0
  }
  if (value > 1) {
    return 1
  }
  return value
}
