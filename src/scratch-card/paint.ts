/**
 * 涂层程序化绘制（设计 C1）：
 * 1. 45° 金属渐变（含一道窄高光 stop）
 * 2. 沿梯度方向的拉丝细线（seeded PRNG，可复现）
 * 3. 64×64 灰度噪点 pattern 低 alpha 叠加（磨砂颗粒）
 * 4. 印刷提示文字 + 虚线圆角框
 * 5. 内侧 1px 深色描边（涂层厚度）
 *
 * 所有颜色均由调用方在运行时从 CSS 变量采样后传入，本文件不硬编码主题色；
 * 高光/噪点/拉丝等结构性效果使用与亮度无关的固定数值。
 */

export interface PaintColors {
  cover1: string
  cover2: string
  edge: string
  text: string
}

/** mulberry32 —— 确定性 32 位 PRNG，同种子同纹理 */
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

/** 运行时从 :root CSS 变量采样当前主题色；变量缺失时回退到中性银灰 */
export function sampleThemeColors(): PaintColors {
  const read = (name: string, fallback: string): string => {
    if (typeof window === 'undefined' || !window.getComputedStyle) return fallback
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim()
    return value.length > 0 ? value : fallback
  }
  return {
    cover1: read('--scratch-cover-1', '#c9ccd4'),
    cover2: read('--scratch-cover-2', '#9a9ea8'),
    edge: read('--scratch-cover-edge', '#7d818c'),
    text: read('--scratch-hint', '#5b5f69'),
  }
}

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
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * 在涂层画布上绘制完整银色涂层。
 * 调用前 ctx 必须已完成 DPR setTransform，坐标一律使用 CSS 像素。
 */
export function paintCover(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  seed: number,
  colors: PaintColors,
  coverText: string,
): void {
  const w = Math.max(1, Math.round(cssWidth))
  const h = Math.max(1, Math.round(cssHeight))
  const rng = createRng(seed)

  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, w, h)

  // 1) 斜向金属渐变：3~5 个 stop，中间夹窄高光环
  const gradient = ctx.createLinearGradient(0, 0, w, h)
  gradient.addColorStop(0, colors.cover1)
  gradient.addColorStop(0.34, colors.cover2)
  gradient.addColorStop(0.47, 'rgba(255,255,255,0.55)')
  gradient.addColorStop(0.53, 'rgba(255,255,255,0.12)')
  gradient.addColorStop(0.72, colors.cover2)
  gradient.addColorStop(1, colors.cover1)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, w, h)

  // 2) 拉丝：沿梯度方向（约 45°）的数百条 0.5 CSS px 细线
  const lineCount = Math.round((w * h) / 180)
  ctx.lineWidth = 0.5
  for (let i = 0; i < lineCount; i += 1) {
    const cx = rng() * w
    const cy = rng() * h
    const length = 12 + rng() * 48
    const angle = Math.PI / 4 + (rng() - 0.5) * 0.25
    const dx = Math.cos(angle) * length * 0.5
    const dy = Math.sin(angle) * length * 0.5
    const light = rng() > 0.5
    const alpha = 0.03 + rng() * 0.05
    ctx.strokeStyle = light
      ? `rgba(255,255,255,${alpha.toFixed(3)})`
      : `rgba(40,42,48,${alpha.toFixed(3)})`
    ctx.beginPath()
    ctx.moveTo(cx - dx, cy - dy)
    ctx.lineTo(cx + dx, cy + dy)
    ctx.stroke()
  }

  // 3) 噪点：64×64 随机灰度块 → repeat pattern 低 alpha
  const noiseSize = 64
  const noise = document.createElement('canvas')
  noise.width = noiseSize
  noise.height = noiseSize
  const noiseCtx = noise.getContext('2d')
  if (noiseCtx) {
    const image = noiseCtx.createImageData(noiseSize, noiseSize)
    const pixels = image.data
    for (let i = 0; i < pixels.length; i += 4) {
      const shade = Math.floor(rng() * 255)
      pixels[i] = shade
      pixels[i + 1] = shade
      pixels[i + 2] = shade
      pixels[i + 3] = 18 + Math.floor(rng() * 26)
    }
    noiseCtx.putImageData(image, 0, 0)
    const pattern = ctx.createPattern(noise, 'repeat')
    if (pattern) {
      ctx.globalAlpha = 0.16
      ctx.fillStyle = pattern
      ctx.fillRect(0, 0, w, h)
      ctx.globalAlpha = 1
    }
  }

  // 4) 印刷层：虚线圆角框 + 居中提示文字
  ctx.save()
  ctx.strokeStyle = colors.text
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1
  ctx.setLineDash([7, 5])
  roundedRectPath(ctx, 9, 9, w - 18, h - 18, Math.min(12, h * 0.12))
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.fillStyle = colors.text
  ctx.globalAlpha = 0.85
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const fontSize = Math.max(15, Math.min(28, h * 0.15))
  ctx.font = `600 ${fontSize}px system-ui, 'Segoe UI', Roboto, sans-serif`
  ctx.fillText(coverText, w / 2, h / 2, w - 48)
  ctx.restore()

  // 5) 内边缘 1px 深色描边
  ctx.save()
  ctx.strokeStyle = colors.edge
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
  ctx.restore()
}
