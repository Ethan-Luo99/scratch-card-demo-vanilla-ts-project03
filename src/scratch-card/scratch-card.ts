import scratchCss from './scratch.css?inline'
import type {
  CoverColors,
  Point,
  ScratchCardEventMap,
  ScratchCardHandle,
  ScratchCardOptions,
  ScratchEventListener,
  ScratchPrize,
  ScratchState,
} from './types.ts'
import { SCRATCH_STATE } from './types.ts'
import { paintCover, readCoverColors } from './paint.ts'
import { eraseSegment } from './erase.ts'
import {
  ALPHA_CUTOFF,
  countErasedRatio,
  createSampleCanvas,
  readCoverSample,
} from './coverage.ts'
import {
  applyBitmapSize,
  bindScrubPointer,
  getDevicePixelRatio,
  observeCanvasGeometry,
  transferErasures,
} from './pointer.ts'
import {
  bindKeyboardActivate,
  prefersReducedMotion,
  subscribeMediaQuery,
} from './a11y.ts'

const STYLE_ELEMENT_ID = 'scratch-card-style'
const DEFAULT_BRUSH_RADIUS = 24
const DEFAULT_MAX_SEGMENT = 8
const DEFAULT_COVERAGE_INTERVAL = 120
const DEFAULT_REVEAL_DURATION = 420
const DEFAULT_THRESHOLD = 0.7
const DEFAULT_COVER_TEXT = '刮开有奖'

let styleInjected = false

/** A1 约束：单例守卫，仅首次调用在 <head> 注入一次样式，模块自包含。 */
function injectStylesheetOnce(): void {
  if (styleInjected || typeof document === 'undefined') {
    return
  }
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) {
    styleInjected = true
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = scratchCss
  document.head.appendChild(style)
  styleInjected = true
}

function supportsCanvas2D(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  return document.createElement('canvas').getContext('2d') !== null
}

export function createScratchCard(
  options: ScratchCardOptions,
): ScratchCardHandle {
  injectStylesheetOnce()

  const threshold = clamp01(options.threshold ?? DEFAULT_THRESHOLD)
  const brushRadius = options.brushRadius ?? DEFAULT_BRUSH_RADIUS
  const maxSegment = Math.max(1, options.maxSegment ?? DEFAULT_MAX_SEGMENT)
  const coverageInterval = Math.max(
    0,
    options.coverageInterval ?? DEFAULT_COVERAGE_INTERVAL,
  )
  const configuredRevealDuration =
    options.revealDuration ?? DEFAULT_REVEAL_DURATION
  const coverText = options.coverText ?? DEFAULT_COVER_TEXT
  const noCanvas = !supportsCanvas2D()

  let prize: ScratchPrize = options.prize

  const root = document.createElement('div')
  root.className = 'scratch-card'
  root.style.width =
    typeof options.width === 'number' ? `${options.width}px` : options.width
  root.style.height = `${options.height}px`

  const prizeLayer = document.createElement('div')
  prizeLayer.className = 'scratch-prize'
  prizeLayer.setAttribute('aria-live', 'polite')

  const hint = document.createElement('p')
  hint.className = 'scratch-hint'
  hint.textContent = '刮开查看奖品'

  const revealButton = document.createElement('button')
  revealButton.type = 'button'
  revealButton.className = 'scratch-reveal-btn'
  revealButton.textContent = '直接揭晓'

  const resetButton = document.createElement('button')
  resetButton.type = 'button'
  resetButton.className = 'scratch-reset-btn'
  resetButton.textContent = '再刮一次'
  resetButton.hidden = true

  root.append(prizeLayer, hint, revealButton, resetButton)

  if (noCanvas) {
    root.classList.add('is-no-canvas')
    root.setAttribute('role', 'group')
    root.setAttribute(
      'aria-label',
      '刮刮卡（当前环境不支持刮擦画布，点击按钮揭晓奖品）',
    )
    revealButton.textContent = '点击揭晓奖品'
  } else {
    root.tabIndex = 0
    root.setAttribute('role', 'button')
    root.setAttribute('aria-label', '刮刮卡，按回车键揭晓奖品')
  }

  let canvas: HTMLCanvasElement | null = null
  let ctx: CanvasRenderingContext2D | null = null
  let sampleCanvas: HTMLCanvasElement | null = null
  if (!noCanvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'scratch-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    lockCanvasStyles(canvas)
    root.insertBefore(canvas, hint)
    sampleCanvas = createSampleCanvas()
  }

  const listeners = new Map<
    keyof ScratchCardEventMap,
    Set<ScratchEventListener<keyof ScratchCardEventMap>>
  >()

  function emit<K extends keyof ScratchCardEventMap>(
    type: K,
    payload: ScratchCardEventMap[K],
  ): void {
    const set = listeners.get(type)
    if (set === undefined) {
      return
    }
    for (const listener of [...set]) {
      ;(listener as ScratchEventListener<K>)(payload)
    }
  }

  const disposers: Array<() => void> = []
  let destroyed = false
  let state: ScratchState = SCRATCH_STATE.Idle
  let roundId = 0
  let thresholdFired = false
  let started = false
  let progress = 0
  let lastPoint: Point | null = null
  let colors: CoverColors = readCoverColors(root)
  let revealTimer: ReturnType<typeof setTimeout> | null = null
  let coverageFrame: number | null = null
  let coverageLastRun = 0
  let coverageDirty = false
  let cssWidth = 0
  let cssHeight = 0
  let observer: MutationObserver | null = null

  /** C5：奖品内容在首次有效刮擦前不注入 DOM（删 canvas 也只看到空框）。 */
  function injectPrizeContent(): void {
    prizeLayer.replaceChildren()
    if (prize.image !== undefined) {
      const image = document.createElement('img')
      image.className = 'scratch-prize-img'
      image.src = prize.image.src
      image.alt = prize.image.alt
      image.style.objectFit = prize.image.fit ?? 'contain'
      prizeLayer.append(image)
    }
    const textBlock = document.createElement('div')
    textBlock.className = 'scratch-prize-text'
    const title = document.createElement('h3')
    title.textContent = prize.title
    textBlock.append(title)
    if (prize.description !== undefined) {
      const description = document.createElement('p')
      description.textContent = prize.description
      textBlock.append(description)
    }
    prizeLayer.append(textBlock)
  }

  function clearPrizeContent(): void {
    prizeLayer.replaceChildren()
  }

  function repaintCover(): void {
    if (ctx === null || canvas === null || cssWidth === 0 || cssHeight === 0) {
      return
    }
    paintCover(ctx, {
      width: cssWidth,
      height: cssHeight,
      coverText,
      seed: (roundId * 2654435761 + 1) >>> 0,
      colors,
    })
  }

  function measureSize(): void {
    const rect = root.getBoundingClientRect()
    cssWidth = rect.width
    cssHeight = rect.height
  }

  function snapshotCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
    if (source.width === 0 || source.height === 0) {
      return null
    }
    const snapshot = document.createElement('canvas')
    snapshot.width = source.width
    snapshot.height = source.height
    const snapshotCtx = snapshot.getContext('2d')
    if (snapshotCtx === null) {
      return null
    }
    snapshotCtx.drawImage(source, 0, 0)
    return snapshot
  }

  /** C4：降采样 + 时间节流 + 阈值提前退出（单次扫描，既得精确进度又不重复回读）。 */
  function flushCoverage(force: boolean): void {
    if (canvas === null || sampleCanvas === null) {
      return
    }
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (!force && (!coverageDirty || now - coverageLastRun < coverageInterval)) {
      return
    }
    coverageDirty = false
    coverageLastRun = now

    const data = readCoverSample(canvas, sampleCanvas)
    if (data === null) {
      return
    }
    const ratio = countErasedRatio(data, ALPHA_CUTOFF, threshold)
    progress = ratio
    emit('progress', { progress: ratio })
    if (!thresholdFired && ratio >= threshold) {
      thresholdFired = true
      emit('threshold', { progress: ratio })
      enterRevealing(roundId)
    }
  }

  function scheduleCoverage(): void {
    if (coverageFrame !== null) {
      return
    }
    coverageFrame = requestAnimationFrame(() => {
      coverageFrame = null
      flushCoverage(false)
      if (coverageDirty) {
        scheduleCoverage()
      }
    })
  }

  function clearRevealTimer(): void {
    if (revealTimer !== null) {
      clearTimeout(revealTimer)
      revealTimer = null
    }
  }

  /** D 节：进入揭示态。从这里起刮擦输入一律被状态守卫与 pointer-events 拒收。 */
  function enterRevealing(round: number): void {
    if (destroyed || round !== roundId) {
      return
    }
    if (state === SCRATCH_STATE.Revealing || state === SCRATCH_STATE.Revealed) {
      return
    }
    state = SCRATCH_STATE.Revealing
    root.classList.add('is-revealing')
    root.classList.remove('is-scratching')
    if (!started) {
      started = true
      injectPrizeContent()
    }
    if (canvas !== null) {
      canvas.style.setProperty('pointer-events', 'none', 'important')
    }

    const duration = prefersReducedMotion() ? 0 : configuredRevealDuration
    root.style.setProperty('--reveal-dur', `${duration}ms`)
    if (duration === 0) {
      finishReveal(round)
      return
    }
    clearRevealTimer()
    revealTimer = setTimeout(() => finishReveal(round), duration + 60)
  }

  function finishReveal(round: number): void {
    if (destroyed || round !== roundId) {
      return
    }
    clearRevealTimer()
    state = SCRATCH_STATE.Revealed
    progress = 1
    root.classList.remove('is-revealing')
    root.classList.add('is-revealed')
    if (canvas !== null) {
      canvas.style.setProperty('visibility', 'hidden', 'important')
    }
    resetButton.hidden = false
    emit('revealed', { prize })
    if (typeof resetButton.focus === 'function') {
      resetButton.focus()
    }
  }

  function handleDown(point: Point): void {
    if (state !== SCRATCH_STATE.Idle && state !== SCRATCH_STATE.Scratching) {
      return
    }
    if (!started) {
      started = true
      injectPrizeContent()
      emit('scratchstart', { progress: 0 })
    }
    state = SCRATCH_STATE.Scratching
    root.classList.add('is-scratching')
    lastPoint = point
    if (ctx !== null) {
      eraseSegment(ctx, point, point, brushRadius, maxSegment)
    }
    coverageDirty = true
    scheduleCoverage()
  }

  function handleMove(point: Point): void {
    if (state !== SCRATCH_STATE.Scratching || ctx === null) {
      return
    }
    const from = lastPoint ?? point
    eraseSegment(ctx, from, point, brushRadius, maxSegment)
    lastPoint = point
    coverageDirty = true
    scheduleCoverage()
  }

  /** pointercancel 与 pointerup 同路径：收尾补算，但不主动揭示。 */
  function handleUp(): void {
    if (state !== SCRATCH_STATE.Scratching) {
      return
    }
    if (coverageFrame !== null) {
      cancelAnimationFrame(coverageFrame)
      coverageFrame = null
    }
    flushCoverage(true)
  }

  function reveal(): void {
    if (state === SCRATCH_STATE.Revealing || state === SCRATCH_STATE.Revealed) {
      return
    }
    if (!started) {
      started = true
      injectPrizeContent()
    }
    enterRevealing(roundId)
  }

  /** D 节：任意状态可调且幂等；round+1 使在途 timer/rAF/transitionend 全部失效。 */
  function reset(nextPrize?: ScratchPrize): void {
    if (nextPrize !== undefined) {
      prize = nextPrize
    }
    roundId += 1
    state = SCRATCH_STATE.Idle
    thresholdFired = false
    started = false
    progress = 0
    lastPoint = null
    coverageDirty = false
    coverageLastRun = 0
    clearRevealTimer()
    if (coverageFrame !== null) {
      cancelAnimationFrame(coverageFrame)
      coverageFrame = null
    }

    root.classList.remove('is-revealing', 'is-revealed', 'is-scratching', 'is-fallback')
    resetButton.hidden = true
    clearPrizeContent()
    colors = readCoverColors(root)

    if (canvas !== null) {
      measureSize()
      const nextCtx = applyBitmapSize(
        canvas,
        cssWidth,
        cssHeight,
        getDevicePixelRatio(),
      )
      if (nextCtx !== null) {
        ctx = nextCtx
        // 新一轮：重绘完整涂层，旧擦痕不迁移（迁移仅用于 DPR/尺寸变化）。
        repaintCover()
      }
      canvas.style.setProperty('pointer-events', 'auto', 'important')
      canvas.style.setProperty('visibility', 'visible', 'important')
      canvas.style.setProperty('opacity', '1', 'important')
    } else {
      measureSize()
    }

    emit('reset', { round: roundId })
  }

  function getProgress(): number {
    if (state === SCRATCH_STATE.Revealed) {
      return 1
    }
    return progress
  }

  /** C3/E：尺寸或跨屏 DPR 变化时重建位图，旧位图 drawImage 掩码迁移进度。 */
  function handleGeometryChange(): void {
    if (destroyed || canvas === null) {
      return
    }
    const snapshot = snapshotCanvas(canvas)
    measureSize()
    if (cssWidth === 0 || cssHeight === 0) {
      return
    }
    const nextCtx = applyBitmapSize(
      canvas,
      cssWidth,
      cssHeight,
      getDevicePixelRatio(),
    )
    if (nextCtx === null) {
      return
    }
    ctx = nextCtx
    repaintCover()
    if (snapshot !== null) {
      transferErasures(nextCtx, snapshot)
    }
  }

  function handleColorSchemeChange(): void {
    if (destroyed) {
      return
    }
    colors = readCoverColors(root)
    // 仅 idle（未刮）重绘，保护用户进度；其他态等下次 reset。
    if (state === SCRATCH_STATE.Idle && ctx !== null) {
      repaintCover()
    }
  }

  /** C5：canvas 被删/被改样式且未揭示时自愈重插并复位内联 important。 */
  function healDom(): void {
    if (
      canvas === null ||
      state === SCRATCH_STATE.Revealing ||
      state === SCRATCH_STATE.Revealed
    ) {
      return
    }
    let needsRepaint = false
    if (canvas.parentElement !== root) {
      root.insertBefore(canvas, hint)
      needsRepaint = canvas.width === 0 || canvas.height === 0
    }
    if (canvas.getAttribute('class') !== 'scratch-canvas') {
      canvas.className = 'scratch-canvas'
    }
    lockCanvasStyles(canvas)
    if (needsRepaint) {
      measureSize()
      const nextCtx = applyBitmapSize(
        canvas,
        cssWidth,
        cssHeight,
        getDevicePixelRatio(),
      )
      if (nextCtx !== null) {
        ctx = nextCtx
        repaintCover()
      }
    }
  }

  function onRevealClick(): void {
    if (noCanvas) {
      // 无 canvas 降级：点击直接展示奖品（功能不缺失）。
      if (state === SCRATCH_STATE.Revealed) {
        return
      }
      injectPrizeContent()
      started = true
      state = SCRATCH_STATE.Revealed
      progress = 1
      root.classList.add('is-revealed', 'is-fallback')
      resetButton.hidden = false
      emit('threshold', { progress: 1 })
      emit('revealed', { prize })
      resetButton.focus()
      return
    }
    reveal()
  }

  if (canvas !== null) {
    disposers.push(
      bindScrubPointer(canvas, {
        onDown: handleDown,
        onMove: handleMove,
        onUp: handleUp,
      }),
    )
    disposers.push(observeCanvasGeometry(root, handleGeometryChange))

    const themeDisposer = subscribeMediaQuery(
      '(prefers-color-scheme: dark)',
      handleColorSchemeChange,
    )
    if (themeDisposer !== null) {
      disposers.push(themeDisposer)
    }

    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (
          record.type === 'childList' ||
          (record.type === 'attributes' && record.target === canvas)
        ) {
          healDom()
          return
        }
      }
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    disposers.push(() => observer?.disconnect())
  }

  disposers.push(bindKeyboardActivate(root, reveal))
  revealButton.addEventListener('click', onRevealClick)
  const onResetClick = (): void => reset()
  resetButton.addEventListener('click', onResetClick)
  disposers.push(() => revealButton.removeEventListener('click', onRevealClick))
  disposers.push(() => resetButton.removeEventListener('click', onResetClick))

  measureSize()
  if (canvas !== null) {
    const nextCtx = applyBitmapSize(
      canvas,
      cssWidth,
      cssHeight,
      getDevicePixelRatio(),
    )
    if (nextCtx !== null && cssWidth > 0) {
      ctx = nextCtx
      repaintCover()
    }
  }

  const handle: ScratchCardHandle = {
    element: root,
    reset,
    reveal,
    getProgress,
    on(type, listener) {
      let set = listeners.get(type)
      if (set === undefined) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener as ScratchEventListener<keyof ScratchCardEventMap>)
      return () =>
        set?.delete(
          listener as ScratchEventListener<keyof ScratchCardEventMap>,
        )
    },
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      roundId += 1
      clearRevealTimer()
      if (coverageFrame !== null) {
        cancelAnimationFrame(coverageFrame)
        coverageFrame = null
      }
      for (const dispose of disposers) {
        dispose()
      }
      disposers.length = 0
      listeners.clear()
      if (canvas !== null) {
        canvas.width = 0
        canvas.height = 0
      }
      canvas = null
      ctx = null
      sampleCanvas = null
      root.remove()
    },
  }

  return handle
}

function lockCanvasStyles(canvas: HTMLCanvasElement): void {
  canvas.style.setProperty('opacity', '1', 'important')
  canvas.style.setProperty('visibility', 'visible', 'important')
  canvas.style.setProperty('display', 'block', 'important')
  canvas.style.setProperty('pointer-events', 'auto', 'important')
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
