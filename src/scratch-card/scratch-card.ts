/**
 * 刮刮卡工厂主体（设计 B/D/C5/E）。
 *
 * 设计要点：
 * - 对外只暴露 createScratchCard，全部状态闭包私有（仿 counter.ts）；
 * - 状态机 idle → scratching → revealing → revealed（reset 回 idle），
 *   revealing 起拒收指针输入，threshold 每轮只触发一次；
 * - 所有异步回调（rAF / 计时器 / 媒体查询 / 观察器）都校验 roundId；
 * - 涂层关键样式走内联 !important，MutationObserver 自愈重插（C5）；
 * - 奖品内容在首次有效刮擦前不注入 DOM；
 * - 无 canvas / 无 Pointer Events 均有降级路径；
 * - 所有注册点进入 disposers，destroy() 幂等回收。
 */
import styleText from './scratch.css?inline'
import type {
  Point,
  ScratchCardHandle,
  ScratchCardOptions,
  ScratchCardSnapshot,
  ScratchPrize,
} from './types.ts'
import { STATE } from './types.ts'
import type { State } from './types.ts'
import { paintCover, sampleThemeColors } from './paint.ts'
import {
  eraseStamps,
  extractPoints,
  interpolateStroke,
} from './erase.ts'
import { CoverageSampler } from './coverage.ts'
import { bindPointerInput } from './pointer.ts'
import {
  bindKeyboardActivate,
  prefersReducedMotion,
  watchColorScheme,
  watchResolutionChange,
} from './a11y.ts'

type EventMap = {
  scratchstart: { progress: number }
  progress: { progress: number }
  threshold: { progress: number }
  revealed: { prize: ScratchPrize }
  reset: { round: number }
}

type EventName = keyof EventMap
type Listener<T extends EventName> = (payload: EventMap[T]) => void

const DEFAULT_BRUSH_RADIUS = 24
const DEFAULT_MAX_SEGMENT = 8
const DEFAULT_INTERVAL = 120
const DEFAULT_REVEAL_DURATION = 420
const DEFAULT_THRESHOLD = 0.7
const DEFAULT_COVER_TEXT = '刮开有奖'
const DEFAULT_SEED = 0x5c7ab1e

/** 单例样式注入守卫：仅首次创建实例时往 <head> 注入一次（设计 A1） */
let styleInjected = false
function injectStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const style = document.createElement('style')
  style.id = 'scratch-card-styles'
  style.textContent = styleText
  document.head.appendChild(style)
}

export function createScratchCard(
  options: ScratchCardOptions,
): ScratchCardHandle {
  injectStyles()

  const threshold = clamp(options.threshold ?? DEFAULT_THRESHOLD, 0.01, 1)
  const brushRadius = options.brushRadius ?? DEFAULT_BRUSH_RADIUS
  const maxSegment = options.maxSegment ?? DEFAULT_MAX_SEGMENT
  const interval = options.coverageInterval ?? DEFAULT_INTERVAL
  const revealDuration = Math.max(0, options.revealDuration ?? DEFAULT_REVEAL_DURATION)
  const coverText = options.coverText ?? DEFAULT_COVER_TEXT
  const baseSeed = options.seed ?? DEFAULT_SEED

  let state: State = STATE.Idle
  let roundId = 0
  let progress = 0
  let prize: ScratchPrize = options.prize
  let destroyed = false
  let prizeInjected = false
  let lastPoint: Point | null = null

  // ---------- DOM 构建（createElement，避免 HTML 字符串转义问题） ----------
  const root = document.createElement('div')
  root.className = 'scratch-card'
  root.style.width = cssLength(options.width)
  root.style.height = `${Math.round(options.height)}px`

  const prizeLayer = document.createElement('div')
  prizeLayer.className = 'scratch-prize'
  prizeLayer.setAttribute('aria-live', 'polite')

  const canvas = document.createElement('canvas')
  canvas.className = 'scratch-canvas'
  canvas.setAttribute('aria-hidden', 'true')

  const hint = document.createElement('p')
  hint.className = 'scratch-sr-only'

  const revealBtn = document.createElement('button')
  revealBtn.type = 'button'
  revealBtn.className = 'scratch-reveal-btn'
  revealBtn.textContent = '直接揭晓'

  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.className = 'scratch-reset-btn'
  resetBtn.textContent = '再刮一次'
  resetBtn.hidden = true

  root.append(prizeLayer, canvas, hint, revealBtn, resetBtn)

  // ---------- 降级检测 ----------
  const ctx = canvas.getContext('2d')
  const fallback = ctx === null
  if (fallback) {
    root.classList.add('is-fallback')
    root.setAttribute('role', 'button')
    root.tabIndex = 0
    root.setAttribute('aria-label', '刮刮卡，按回车揭晓奖品')
    hint.textContent = '当前环境不支持刮擦涂层，按回车或点击卡片直接揭晓奖品。'
  } else {
    root.setAttribute('role', 'button')
    root.tabIndex = 0
    root.setAttribute('aria-label', '刮刮卡，在涂层上刮动，或按回车直接揭晓')
    hint.textContent = '刮刮卡涂层区域。刮开约七成可自动揭晓，也可按回车直接揭晓。'
  }

  // ---------- 资源回收登记 ----------
  const disposers: Array<() => void> = []
  const addDisposer = (dispose: () => void): void => {
    disposers.push(dispose)
  }

  // ---------- 事件订阅 ----------
  const listeners = new Map<EventName, Set<(payload: never) => void>>()
  const emit = <T extends EventName>(name: T, payload: EventMap[T]): void => {
    const set = listeners.get(name)
    if (!set) return
    for (const listener of set) listener(payload as never)
  }

  // ---------- 奖品内容延迟注入（C5：首次刮擦前 DOM 内无答案） ----------
  function clearPrizeContent(): void {
    prizeLayer.replaceChildren()
    prizeInjected = false
  }

  function injectPrizeContent(): void {
    if (prizeInjected) return
    prizeInjected = true
    if (prize.image) {
      const img = document.createElement('img')
      img.className = 'scratch-prize-img'
      img.src = prize.image.src
      img.alt = prize.image.alt
      img.style.objectFit = prize.image.fit ?? 'contain'
      prizeLayer.appendChild(img)
    }
    const title = document.createElement('h3')
    title.className = 'scratch-prize-title'
    title.textContent = prize.title
    prizeLayer.appendChild(title)
    if (prize.description) {
      const desc = document.createElement('p')
      desc.className = 'scratch-prize-desc'
      desc.textContent = prize.description
      prizeLayer.appendChild(desc)
    }
  }

  // ---------- 涂层关键样式内联 !important（C5） ----------
  function lockCanvasStyles(interactive: boolean): void {
    const important = (name: string, value: string): void =>
      canvas.style.setProperty(name, value, 'important')
    important('position', 'absolute')
    important('inset', '0')
    important('z-index', '1')
    important('display', 'block')
    important('width', '100%')
    important('height', '100%')
    important('opacity', '1')
    important('visibility', 'visible')
    important('transform', 'none')
    important(
      'pointer-events',
      interactive && !fallback ? 'auto' : 'none',
    )
    important('touch-action', 'none')
    const duration = prefersReducedMotion() ? 0 : revealDuration
    important(
      'transition',
      duration > 0 ? `opacity ${duration}ms ease-out` : 'none',
    )
  }

  function repaintCover(): void {
    if (fallback || !ctx) return
    paintCover(
      ctx,
      canvas.clientWidth,
      canvas.clientHeight,
      baseSeed + roundId,
      sampleThemeColors(),
      coverText,
    )
  }

  // ---------- HiDPI 位图：尺寸 + DPR transform，resize 迁移旧位图（C3） ----------
  let cssWidth = 0
  let cssHeight = 0
  let hasFreshCover = false

  function resizeCanvas(): void {
    if (fallback || !ctx) return
    const nextWidth = canvas.clientWidth
    const nextHeight = canvas.clientHeight
    if (nextWidth === 0 || nextHeight === 0) return
    const dpr =
      typeof window !== 'undefined' && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1

    // 先把旧位图快照下来（CSS 像素坐标空间）
    let snapshot: HTMLCanvasElement | null = null
    if (
      cssWidth > 0 &&
      cssHeight > 0 &&
      progress > 0 &&
      hasFreshCover &&
      canvas.width > 0 &&
      canvas.height > 0
    ) {
      snapshot = document.createElement('canvas')
      snapshot.width = canvas.width
      snapshot.height = canvas.height
      const snapshotCtx = snapshot.getContext('2d')
      if (snapshotCtx) snapshotCtx.drawImage(canvas, 0, 0)
    }

    canvas.width = Math.round(nextWidth * dpr)
    canvas.height = Math.round(nextHeight * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    cssWidth = nextWidth
    cssHeight = nextHeight
    lockCanvasStyles(state !== STATE.Revealing && state !== STATE.Revealed)

    if (snapshot) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(snapshot, 0, 0, canvas.width, canvas.height)
      ctx.restore()
    } else if (restoredCoverImage && !restoredCoverApplied) {
      applyRestoredCover()
    } else {
      repaintCover()
    }
    hasFreshCover = true
    if (sampler) sampler.markDirty()
  }

  lockCanvasStyles(true)
  clearPrizeContent()

  // ---------- 覆盖率采样器（C4） ----------
  let sampler: CoverageSampler | null = null
  if (!fallback) {
    sampler = new CoverageSampler({
      source: canvas,
      interval,
      threshold,
      onMeasure: (measured: number) => {
        if (destroyed) return
        if (state !== STATE.Scratching && state !== STATE.Idle) return
        progress = measured
        emit('progress', { progress })
        if (state === STATE.Scratching && measured >= threshold) {
          beginReveal(measured, true)
        }
      },
    })
    addDisposer(() => sampler?.dispose())
  }

  // ---------- 尺寸 / DPR / 主题监听 ----------
  if (typeof ResizeObserver === 'function' && !fallback) {
    const resizeObserver = new ResizeObserver(() => {
      if (destroyed) return
      resizeCanvas()
    })
    resizeObserver.observe(canvas)
    addDisposer(() => resizeObserver.disconnect())
  } else if (!fallback) {
    const handleWindowResize = (): void => resizeCanvas()
    window.addEventListener('resize', handleWindowResize)
    addDisposer(() => window.removeEventListener('resize', handleWindowResize))
  }

  addDisposer(
    watchResolutionChange(() => {
      if (!destroyed) resizeCanvas()
    }),
  )

  addDisposer(
    watchColorScheme(() => {
      // 仅 idle 且未刮过时重绘，保护用户进度（设计 F10）
      if (
        destroyed ||
        state !== STATE.Idle ||
        progress > 0
      ) return
      repaintCover()
    }),
  )

  // ---------- 指针输入（C2/C3） ----------
  function handleScratchMove(_point: Point, event: PointerEvent): void {
    if (fallback || !ctx) return
    if (state === STATE.Revealing || state === STATE.Revealed) return
    if (state !== STATE.Scratching) return
    const rect = canvas.getBoundingClientRect()
    const points = extractPoints(event, _point, (e) => ({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }))
    for (const point of points) {
      const from = lastPoint ?? point
      const stamps = interpolateStroke(from, point, brushRadius, maxSegment)
      eraseStamps(ctx, stamps)
      lastPoint = point
    }
    sampler?.markDirty()
  }

  if (!fallback) {
    const unbindPointer = bindPointerInput(canvas, {
      onDown: (point) => {
        if (state !== STATE.Idle && state !== STATE.Scratching) return
        if (!prizeInjected) {
          injectPrizeContent()
          emit('scratchstart', { progress })
        }
        if (state === STATE.Idle) state = STATE.Scratching
        root.classList.add('is-scratching')
        lastPoint = point
        const stamps = interpolateStroke(point, point, brushRadius, maxSegment)
        if (ctx) eraseStamps(ctx, stamps)
        sampler?.markDirty()
      },
      onMove: handleScratchMove,
      onUp: () => {
        if (state !== STATE.Scratching) return
        // 先在 scratching 态补算：越过阈值时同帧进入 revealing（C4 双保险）
        sampler?.flush()
        if (state !== STATE.Scratching) {
          lastPoint = null
          return
        }
        state = STATE.Idle
        root.classList.remove('is-scratching')
        lastPoint = null
      },
      onCancel: () => {
        // pointercancel 同 pointerup 收尾：保留进度，不触发揭示
        if (state !== STATE.Scratching) return
        state = STATE.Idle
        root.classList.remove('is-scratching')
        lastPoint = null
        sampler?.flush()
      },
    })
    addDisposer(unbindPointer)
  } else {
    // 无 canvas 降级：点击/键盘直接揭示
    const handleFallbackActivate = (): void => {
      if (state === STATE.Revealed || state === STATE.Revealing) return
      injectPrizeContent()
      beginReveal(1, false)
    }
    root.addEventListener('click', handleFallbackActivate)
    addDisposer(() => root.removeEventListener('click', handleFallbackActivate))
    addDisposer(bindKeyboardActivate(root, handleFallbackActivate))
  }

  // ---------- 状态机：揭示（D 节） ----------
  let revealTimer = 0

  function beginReveal(measuredProgress: number, fromThreshold: boolean): void {
    if (state === STATE.Revealing || state === STATE.Revealed) return
    if (fromThreshold) {
      progress = Math.max(progress, measuredProgress)
      emit('threshold', { progress })
    }
    state = STATE.Revealing
    root.classList.add('is-revealing')
    root.classList.remove('is-scratching')
    injectPrizeContent()
    lastPoint = null

    const duration = prefersReducedMotion() ? 0 : revealDuration
    const currentRound = roundId
    lockCanvasStyles(false)
    if (duration > 0) {
      // 下一帧再切 opacity，保证过渡真正触发
      requestAnimationFrame(() => {
        if (destroyed || currentRound !== roundId) return
        canvas.style.setProperty('opacity', '0', 'important')
        canvas.style.setProperty('transform', 'scale(1.04)', 'important')
      })
      revealTimer = window.setTimeout(() => {
        if (destroyed || currentRound !== roundId) return
        finishReveal()
      }, duration)
    } else {
      canvas.style.setProperty('opacity', '0', 'important')
      finishReveal()
    }
  }

  function finishReveal(): void {
    if (state !== STATE.Revealing) return
    state = STATE.Revealed
    root.classList.remove('is-revealing')
    root.classList.add('is-revealed')
    canvas.style.setProperty('visibility', 'hidden', 'important')
    canvas.style.setProperty('pointer-events', 'none', 'important')
    resetBtn.hidden = false
    emit('revealed', { prize })
    // revealed 后焦点移到「再刮一次」（设计 E：焦点管理）
    if (resetBtn.isConnected) resetBtn.focus()
  }

  function reveal(): void {
    if (state === STATE.Revealing || state === STATE.Revealed) return
    if (fallback) {
      injectPrizeContent()
      beginReveal(1, false)
      return
    }
    injectPrizeContent()
    beginReveal(progress, false)
  }

  // ---------- reset：任何状态幂等，roundId 使旧回调失效（D4） ----------
  function reset(nextPrize?: ScratchPrize): void {
    if (destroyed) return
    if (revealTimer) {
      clearTimeout(revealTimer)
      revealTimer = 0
    }
    roundId += 1
    state = STATE.Idle
    progress = 0
    lastPoint = null
    if (nextPrize) prize = nextPrize
    root.classList.remove('is-revealing', 'is-revealed', 'is-scratching')
    resetBtn.hidden = true
    lockCanvasStyles(!fallback)
    canvas.style.setProperty('opacity', '1', 'important')
    canvas.style.setProperty('visibility', 'visible', 'important')
    canvas.style.setProperty('transform', 'none', 'important')
    clearPrizeContent()
    if (!fallback && ctx) {
      ctx.setTransform(
        (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
        0,
        0,
        (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
        0,
        0,
      )
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
      repaintCover()
      sampler?.markDirty()
    }
    emit('reset', { round: roundId })
  }

  // ---------- 防篡改自检（C5） ----------
  let selfHealing = false
  if (typeof MutationObserver === 'function' && !fallback) {
    const observer = new MutationObserver((records) => {
      if (destroyed || selfHealing) return
      if (state === STATE.Revealing || state === STATE.Revealed) return

      let needReinsert = false
      let needRestyle = false
      for (const record of records) {
        if (record.type === 'childList') {
          if (record.removedNodes && Array.from(record.removedNodes).includes(canvas)) {
            needReinsert = true
          }
        } else if (record.type === 'attributes') {
          if (record.target === canvas) needRestyle = true
        }
      }
      if (!needReinsert && !needRestyle) return
      if (!canvas.isConnected) needReinsert = true

      selfHealing = true
      try {
        if (needReinsert) {
          // 放回涂层之后的原位置（奖品层之上、控件之下）
          if (hint.isConnected) root.insertBefore(canvas, hint)
          else root.appendChild(canvas)
        }
        if (needRestyle || needReinsert) lockCanvasStyles(true)
        // 全新替换的 canvas 位图为空（宽高为 0 或透明），
        // 原节点重插则位图仍在；仅在需要补全涂层时重绘。
        const blankBitmap =
          canvas.width === 0 ||
          canvas.height === 0 ||
          (needReinsert && progress === 0)
        if (blankBitmap) resizeCanvas()
      } finally {
        // 等本次回调引发的连锁记录消化完再解除守卫，避免自愈动作触发自愈
        requestAnimationFrame(() => {
          selfHealing = false
        })
      }
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    addDisposer(() => observer.disconnect())
  }

  // ---------- 按钮与键盘 ----------
  const handleRevealClick = (): void => reveal()
  revealBtn.addEventListener('click', handleRevealClick)
  addDisposer(() => revealBtn.removeEventListener('click', handleRevealClick))

  const handleResetClick = (): void => {
    reset()
    root.focus()
  }
  resetBtn.addEventListener('click', handleResetClick)
  addDisposer(() => resetBtn.removeEventListener('click', handleResetClick))

  addDisposer(bindKeyboardActivate(root, () => reveal()))

  // ---------- destroy：幂等，回收全部资源 ----------
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    if (revealTimer) clearTimeout(revealTimer)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 单项回收失败不影响其余资源释放
      }
    }
    disposers.length = 0
    listeners.clear()
    if (!fallback) {
      canvas.width = 0
      canvas.height = 0
    }
    if (root.isConnected) root.remove()
  }

  const handle: ScratchCardHandle = {
    element: root,
    reset,
    reveal,
    getProgress: () => progress,
    snapshot,
    on<T extends EventName>(type: T, listener: Listener<T>): () => void {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set as Set<(payload: never) => void>)
      }
      const wrapped = listener as (payload: never) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    },
    destroy,
  }

  // ---------- 可选恢复快照（编排层刷新恢复；不影响默认行为） ----------
  // restoredCoverImage / restoredCoverApplied 被上方 resizeCanvas 引用，
  // 函数声明提升保证此处赋值先于首次 resizeCanvas() 调用执行。
  let restoredCoverImage: HTMLImageElement | null = null
  let restoredCoverApplied = false

  function applyRestoredCover(): void {
    if (!restoredCoverImage || restoredCoverApplied || fallback || !ctx) return
    if (canvas.width === 0 || canvas.height === 0) return
    restoredCoverApplied = true
    hasFreshCover = true
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(restoredCoverImage, 0, 0, canvas.width, canvas.height)
    ctx.restore()
    sampler?.markDirty()
  }

  function snapshot(): ScratchCardSnapshot {
    const revealed = state === STATE.Revealed
    let cover: string | undefined
    if (!fallback && !revealed && progress > 0 && canvas.width > 0) {
      try {
        cover = canvas.toDataURL('image/png')
      } catch {
        cover = undefined
      }
    }
    const result: ScratchCardSnapshot = {
      state: revealed ? 'revealed' : 'idle',
      progress,
      round: roundId,
    }
    if (cover !== undefined) result.cover = cover
    return result
  }

  const restore = options.restore
  if (restore) {
    if (
      Number.isInteger(restore.round) &&
      restore.round >= 0 &&
      restore.round < 1_000_000_000
    ) {
      roundId = restore.round
    }
    if (restore.state === 'revealed') {
      // 同步进入 revealed 终态：无动画；构造期监听集为空，emit 对外不可见
      progress = 1
      injectPrizeContent()
      state = STATE.Revealing
      root.classList.add('is-revealing')
      lockCanvasStyles(false)
      canvas.style.setProperty('opacity', '0', 'important')
      finishReveal()
    } else if (!fallback && restore.progress > 0 && restore.cover) {
      const expectedRound = roundId
      progress = clamp(restore.progress, 0, 1)
      const image = new Image()
      image.onload = () => {
        if (destroyed || roundId !== expectedRound) return
        restoredCoverImage = image
        applyRestoredCover()
      }
      image.onerror = () => {
        if (destroyed || roundId !== expectedRound) return
        // 位图损坏：回退全新涂层，进度归零保持一致
        progress = 0
      }
      image.src = restore.cover
    }
  }

  // 已在文档中（占位 replaceWith 后才构造）时立即建位图；
  // 否则 ResizeObserver 首次回调会补齐。
  resizeCanvas()

  return handle
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

function cssLength(value: number | string): string {
  if (typeof value === 'number') return `${Math.round(value)}px`
  return value
}
