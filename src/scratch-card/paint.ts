import type { CoverColors, PaintOptions } from './types.ts'

/**
 * 可复现的 seeded PRNG（mulberry32）。
 * 同一 seed 产出同一纹理：reset/重绘/自愈重插时涂层质感稳定可复现。
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 运行时从 CSS 变量采样涂层配色；变量缺失时回退中性银灰，保证不崩。 */
export function readCoverColors(target: Element | Document): CoverColors {
  const element =
    target.nodeType === 9
      ? (target as Document).documentElement
      : (target as Element)
  const style = getComputedStyle(element)
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value.length > 0 ? value : fallback
  }
  return {
    start: read('--scratch-cover-1', '#c7c9d1'),
    end: read('--scratch-cover-2', '#8f929c'),
    highlight: read('--scratch-cover-highlight', 'rgba(255,255,255,0.9)'),
    edge: read('--scratch-cover-edge', 'rgba(0,0,0,0.25)'),
    text: read('--scratch-hint', '#ffffff'),
  }
}

/**
 * 在「已做过 DPR setTransform、以 CSS 像素为坐标」的 ctx 上整层重绘银色涂层。
 * 分层：斜向金属渐变 → 拉丝 → 噪点颗粒 → 内边缘 → 印刷提示。
 */
export function paintCover(
  ctx: CanvasRenderingContext2D,
  options: PaintOptions,
): void {
  const { width, height, coverText, seed, colors } = options
  const rng = createRng(seed)

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, width, height)

  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, colors.start)
  gradient.addColorStop(0.32, mixRgba(colors.start, colors.end, 0.35))
  gradient.addColorStop(0.5, colors.highlight)
  gradient.addColorStop(0.68, mixRgba(colors.start, colors.end, 0.65))
  gradient.addColorStop(1, colors.end)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  paintBrushedLines(ctx, width, height, rng)
  paintNoise(ctx, width, height, rng)
  paintInnerEdge(ctx, width, height, colors.edge)
  if (coverText.length > 0) {
    paintPrintedText(ctx, width, height, coverText, colors.text)
  }
  ctx.restore()
}

/** 沿梯度方向的 1px 半透明拉丝长线（结构参数固定，不随主题变化）。 */
function paintBrushedLines(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rng: () => number,
): void {
  const diagonal = Math.hypot(width, height)
  const count = Math.max(120, Math.floor((width * height) / 260))
  ctx.save()
  ctx.lineWidth = 0.5
  for (let i = 0; i < count; i += 1) {
    const start = rng() * diagonal - diagonal / 2
    const run = diagonal * (0.25 + rng() * 0.9)
    const alpha = 0.03 + rng() * 0.05
    ctx.strokeStyle = rng() > 0.5
      ? `rgba(255,255,255,${alpha})`
      : `rgba(0,0,0,${alpha})`
    ctx.beginPath()
    ctx.moveTo(start, -20)
    ctx.lineTo(start + run, height + 20)
    ctx.stroke()
  }
  ctx.restore()
}

/** 64×64 灰度噪点小块 → pattern 低 alpha 平铺，制造磨砂颗粒。 */
function paintNoise(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rng: () => number,
): void {
  const tile = 64
  const tileCanvas = document.createElement('canvas')
  tileCanvas.width = tile
  tileCanvas.height = tile
  const tileCtx = tileCanvas.getContext('2d')
  if (tileCtx === null) {
    return
  }
  const image = tileCtx.createImageData(tile, tile)
  for (let i = 0; i < image.data.length; i += 4) {
    const shade = Math.floor(rng() * 255)
    image.data[i] = shade
    image.data[i + 1] = shade
    image.data[i + 2] = shade
    image.data[i + 3] = 50 + Math.floor(rng() * 60)
  }
  tileCtx.putImageData(image, 0, 0)

  const pattern = ctx.createPattern(tileCanvas, 'repeat')
  if (pattern === null) {
    return
  }
  ctx.save()
  ctx.globalAlpha = 0.18
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

function paintInnerEdge(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  edgeColor: string,
): void {
  ctx.save()
  ctx.strokeStyle = edgeColor
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
  ctx.restore()
}

function paintPrintedText(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  textColor: string,
): void {
  const fontSize = Math.max(14, Math.min(28, Math.floor(height * 0.16)))
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`

  const metrics = ctx.measureText(text)
  const boxWidth = Math.min(width - 24, metrics.width + 36)
  const boxHeight = fontSize + 18
  const radius = boxHeight / 2

  ctx.strokeStyle = textColor
  ctx.globalAlpha = 0.85
  ctx.setLineDash([8, 6])
  ctx.lineWidth = 1.5
  roundedRectPath(
    ctx,
    width / 2 - boxWidth / 2,
    height / 2 - boxHeight / 2,
    boxWidth,
    boxHeight,
    radius,
  )
  ctx.stroke()
  ctx.setLineDash([])

  ctx.globalAlpha = 0.95
  ctx.fillStyle = textColor
  ctx.fillText(text, width / 2, height / 2 + 1)
  ctx.restore()
}

/** 圆角矩形路径：优先用原生 roundRect，老 WebView 缺失时用弧线段兜底。 */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
    return
  }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 两色简单线性混合；颜色为 #rrggbb 时可用，其他格式直接返回起点色。 */
function mixRgba(from: string, to: string, ratio: number): string {
  const a = parseHexColor(from)
  const b = parseHexColor(to)
  if (a === null || b === null) {
    return from
  }
  const r = Math.round(a[0] + (b[0] - a[0]) * ratio)
  const g = Math.round(a[1] + (b[1] - a[1]) * ratio)
  const blue = Math.round(a[2] + (b[2] - a[2]) * ratio)
  return `rgb(${r}, ${g}, ${blue})`
}

function parseHexColor(value: string): [number, number, number] | null {
  const matched = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (matched === null) {
    return null
  }
  const hex = matched[1]
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}
