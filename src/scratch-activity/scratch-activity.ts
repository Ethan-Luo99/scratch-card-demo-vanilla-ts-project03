/**
 * 刮刮卡活动编排层工厂（复用 createScratchCard，不修改其事件语义）：
 * - 3 张子卡串行解锁：第 N 张 revealed 后，第 N+1 张倒计时结束才可刮；
 * - 未解锁卡覆盖遮罩层 + 解锁倒计时文案；全部 revealed 触发 allRevealed 并展示汇总层；
 * - 进度持久化 sessionStorage（key 前缀可配置），隐私模式抛异常时静默降级内存态；
 * - 多标签页：storage 事件 + 代际号 last-write-wins，代际不一致本页降级只读；
 * - 所有异步回调（timer / storage / 子卡事件）校验「代际号 + 轮次号」；
 * - destroy() 只回收编排层自身监听与 timer，不销毁子卡句柄。
 */
import styleText from './activity.css?inline'
import { createScratchCard } from '../scratch-card/index.ts'
import type {
  Point,
  ScratchCardHandle,
  ScratchRestoreOptions,
} from '../scratch-card/index.ts'
import { interpolateStroke } from '../scratch-card/erase.ts'
import type {
  ActivityPhase,
  CardStage,
  PersistedActivityState,
  PersistedCardState,
  PersistedStamp,
  ScratchActivityEventMap,
  ScratchActivityHandle,
  ScratchActivityOptions,
} from './types.ts'
import { ACTIVITY_PHASE, CARD_COUNT, PERSIST_VERSION } from './types.ts'
import {
  createSafeStorage,
  parseActivity,
  resolveStorageConflict,
  serializeActivity,
} from './persistence.ts'
import { appendStamps, firstLockedIndex, tupleToStamp } from './logic.ts'

const DEFAULT_WIDTH = 320
const DEFAULT_HEIGHT = 200
const DEFAULT_BRUSH_RADIUS = 24
const DEFAULT_KEY_PREFIX = 'scratch-activity'
const DEFAULT_UNLOCK_DELAY = 3000
const DEFAULT_SUMMARY_TITLE = '全部揭晓！'
/** 刮痕录制插值粒度，与子卡默认 maxSegment 对齐 */
const MAX_SEGMENT = 8
/** 进度事件持久化节流（ms） */
const PERSIST_THROTTLE = 200
/** 解锁倒计时文案刷新间隔（ms） */
const COUNTDOWN_TICK = 250

/** 单例样式注入守卫（与 scratch-card 同策略） */
let styleInjected = false
function injectStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const style = document.createElement('style')
  style.id = 'scratch-activity-styles'
  style.textContent = styleText
  document.head.appendChild(style)
}

/** 隐私模式下访问 window.sessionStorage 本身可能抛异常 */
function readSessionStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

function createTabId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createScratchActivity(
  options: ScratchActivityOptions,
): ScratchActivityHandle {
  injectStyles()

  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
  const storageKey = `${keyPrefix}:state`
  const unlockDelay = Math.max(0, options.unlockDelayMs ?? DEFAULT_UNLOCK_DELAY)
  const brushRadius = options.brushRadius ?? DEFAULT_BRUSH_RADIUS
  const storage = createSafeStorage(readSessionStorage())
  const tabId = createTabId()

  // ---------- 读取持久化快照并恢复运行时状态 ----------
  const restored = parseActivity(storage.get(storageKey))
  // 每次加载即开启新代际：最新加载/重置的标签页赢得 last-write-wins
  let generation = (restored?.generation ?? 0) + 1

  let phase: ActivityPhase = ACTIVITY_PHASE.Active
  let activeIndex = 0
  let readOnly = false
  let destroyed = false
  const stages: CardStage[] = []
  const progressed: number[] = []
  const rounds: number[] = []
  const strokeBuffers: PersistedStamp[][] = []
  for (let i = 0; i < CARD_COUNT; i += 1) {
    const persisted = restored?.cards[i]
    const stage: CardStage = persisted?.state ?? 'idle'
    stages.push(stage)
    progressed.push(stage === 'revealed' ? 1 : (persisted?.progress ?? 0))
    rounds.push(persisted?.round ?? 0)
    strokeBuffers.push(stage === 'revealed' ? [] : [...(persisted?.stamps ?? [])])
  }
  // 串行不变式对齐：已解锁索引不得超过第一个未 revealed 的卡
  const lockedAt = firstLockedIndex(stages)
  if (lockedAt >= CARD_COUNT) {
    phase = ACTIVITY_PHASE.Completed
    activeIndex = CARD_COUNT - 1
  } else {
    phase = ACTIVITY_PHASE.Active
    activeIndex = Math.min(restored?.activeIndex ?? 0, lockedAt)
  }

  // ---------- DOM 骨架 ----------
  const root = document.createElement('div')
  root.className = 'scratch-activity'

  const notice = document.createElement('p')
  notice.className = 'scratch-activity__notice'
  notice.setAttribute('role', 'alert')
  notice.textContent =
    '检测到其他标签页已继续本活动，本页已切换为只读展示，请刷新页面获取最新状态。'
  notice.hidden = true

  const slotsWrap = document.createElement('div')
  slotsWrap.className = 'scratch-activity__slots'

  const summary = document.createElement('div')
  summary.className = 'scratch-activity__summary'
  summary.setAttribute('role', 'status')
  summary.hidden = true
  const summaryTitle = document.createElement('h3')
  summaryTitle.className = 'scratch-activity__summary-title'
  summaryTitle.textContent = options.summaryTitle ?? DEFAULT_SUMMARY_TITLE
  summary.appendChild(summaryTitle)
  if (options.summaryDescription) {
    const summaryDesc = document.createElement('p')
    summaryDesc.className = 'scratch-activity__summary-desc'
    summaryDesc.textContent = options.summaryDescription
    summary.appendChild(summaryDesc)
  }
  const restartBtn = document.createElement('button')
  restartBtn.type = 'button'
  restartBtn.className = 'scratch-activity__restart'
  restartBtn.textContent = '重新开始'
  summary.appendChild(restartBtn)

  root.append(notice, slotsWrap, summary)

  // ---------- 子卡创建（按持久化快照注入 restore，不改动子卡事件语义） ----------
  function restoreFor(
    persisted: PersistedCardState | undefined,
  ): ScratchRestoreOptions | undefined {
    if (!persisted) return undefined
    if (persisted.state === 'revealed') return { revealed: true }
    if (persisted.progress > 0) {
      return {
        progress: persisted.progress,
        stamps: persisted.stamps.map(tupleToStamp),
      }
    }
    return undefined
  }

  const slots: HTMLElement[] = []
  const masks: HTMLElement[] = []
  const maskTexts: HTMLElement[] = []
  const cards: ScratchCardHandle[] = options.cards.map((spec, index) => {
    const card = createScratchCard({
      prize: spec.prize,
      width: options.width ?? DEFAULT_WIDTH,
      height: options.height ?? DEFAULT_HEIGHT,
      threshold: options.threshold,
      brushRadius,
      coverText: spec.coverText,
      seed: spec.seed,
      restore: restoreFor(restored?.cards[index]),
    })
    const slot = document.createElement('div')
    slot.className = 'scratch-activity__slot'
    const mask = document.createElement('div')
    mask.className = 'scratch-activity__mask'
    mask.setAttribute('role', 'status')
    const lockIcon = document.createElement('span')
    lockIcon.className = 'scratch-activity__mask-lock'
    lockIcon.setAttribute('aria-hidden', 'true')
    lockIcon.textContent = '🔒'
    const maskText = document.createElement('span')
    maskText.className = 'scratch-activity__mask-text'
    mask.append(lockIcon, maskText)
    slot.append(card.element, mask)
    slotsWrap.appendChild(slot)
    slots.push(slot)
    masks.push(mask)
    maskTexts.push(maskText)
    return card
  })

  // ---------- 资源回收登记 ----------
  const disposers: Array<() => void> = []
  const addDisposer = (dispose: () => void): void => {
    disposers.push(dispose)
  }

  // ---------- 事件订阅 ----------
  const listeners = new Map<
    keyof ScratchActivityEventMap,
    Set<(payload: never) => void>
  >()
  const emit = <K extends keyof ScratchActivityEventMap>(
    type: K,
    payload: ScratchActivityEventMap[K],
  ): void => {
    const set = listeners.get(type)
    if (!set) return
    for (const listener of set) listener(payload as never)
  }

  // ---------- 持久化（只写状态/进度/轮次/刮痕坐标，绝不写奖品内容） ----------
  let persistTimer = 0

  function buildSnapshot(): PersistedActivityState {
    return {
      version: PERSIST_VERSION,
      generation,
      tabId,
      updatedAt: Date.now(),
      phase,
      activeIndex,
      cards: stages.map((stage, index) => ({
        state:
          stage === 'revealed'
            ? 'revealed'
            : progressed[index] > 0
              ? 'scratching'
              : 'idle',
        progress: progressed[index],
        round: rounds[index],
        stamps: stage === 'revealed' ? [] : strokeBuffers[index],
      })),
    }
  }

  function persist(): void {
    if (destroyed || readOnly) return
    storage.set(storageKey, serializeActivity(buildSnapshot()))
  }

  /** 进度事件高频，节流落盘；回调校验代际号 */
  function schedulePersist(): void {
    if (persistTimer !== 0) return
    const gen = generation
    persistTimer = window.setTimeout(() => {
      persistTimer = 0
      if (destroyed || readOnly || gen !== generation) return
      persist()
    }, PERSIST_THROTTLE)
  }

  // ---------- 遮罩与解锁倒计时 ----------
  let unlockTimer = 0
  let countdownTimer = 0
  let unlockTarget = -1
  let unlockAt = 0

  function refreshMasks(): void {
    for (let i = 0; i < CARD_COUNT; i += 1) {
      const locked = i > activeIndex
      slots[i].classList.toggle('is-locked', locked)
      masks[i].setAttribute('aria-hidden', String(!locked))
      if (locked && i !== unlockTarget) {
        maskTexts[i].textContent = `完成第 ${i} 张后解锁`
      }
    }
  }

  function updateCountdown(gen: number): void {
    if (destroyed || readOnly || gen !== generation) return
    if (unlockTarget < 0) return
    const remaining = Math.max(0, unlockAt - Date.now())
    const seconds = Math.ceil(remaining / 1000)
    maskTexts[unlockTarget].textContent =
      `第 ${unlockTarget + 1} 张 · 约 ${seconds} 秒后解锁`
  }

  function cancelUnlock(): void {
    if (unlockTimer !== 0) {
      clearTimeout(unlockTimer)
      unlockTimer = 0
    }
    if (countdownTimer !== 0) {
      clearInterval(countdownTimer)
      countdownTimer = 0
    }
    unlockTarget = -1
  }

  /**
   * 解锁完成回调：校验代际号 + 触发卡轮次号，
   * 任一不匹配即为过期回调（reset/新代际/只读），直接丢弃。
   */
  function completeUnlock(gen: number, roundToken: number, index: number): void {
    if (destroyed || readOnly || gen !== generation) return
    if (roundToken !== rounds[index - 1]) return
    if (countdownTimer !== 0) {
      clearInterval(countdownTimer)
      countdownTimer = 0
    }
    unlockTimer = 0
    unlockTarget = -1
    activeIndex = index
    refreshMasks()
    emit('unlock', { index })
    persist()
  }

  function scheduleUnlock(index: number): void {
    cancelUnlock()
    const gen = generation
    const roundToken = rounds[index - 1]
    if (unlockDelay <= 0) {
      completeUnlock(gen, roundToken, index)
      return
    }
    unlockTarget = index
    unlockAt = Date.now() + unlockDelay
    unlockTimer = window.setTimeout(() => {
      unlockTimer = 0
      completeUnlock(gen, roundToken, index)
    }, unlockDelay)
    countdownTimer = window.setInterval(
      () => updateCountdown(gen),
      COUNTDOWN_TICK,
    )
    updateCountdown(gen)
    refreshMasks()
  }
  // ---------- 汇总层 ----------
  function showSummary(): void {
    summary.hidden = false
    root.classList.add('is-completed')
  }

  function hideSummary(): void {
    summary.hidden = true
    root.classList.remove('is-completed')
  }

  // ---------- 只读降级（多标签页代际冲突） ----------
  function enterReadOnly(): void {
    if (readOnly || destroyed) return
    readOnly = true
    cancelUnlock()
    if (persistTimer !== 0) {
      clearTimeout(persistTimer)
      persistTimer = 0
    }
    root.classList.add('is-readonly')
    notice.hidden = false
    emit('readonly', { generation })
  }

  // ---------- 子卡事件接线（revealed 驱动串行解锁链） ----------
  cards.forEach((card, index) => {
    addDisposer(
      card.on('revealed', () => {
        if (destroyed || readOnly) return
        stages[index] = 'revealed'
        progressed[index] = 1
        strokeBuffers[index] = []
        if (index === CARD_COUNT - 1) {
          phase = ACTIVITY_PHASE.Completed
          showSummary()
          emit('allRevealed', { generation })
          options.onAllRevealed?.()
        } else if (index === activeIndex) {
          scheduleUnlock(index + 1)
        }
        persist()
      }),
    )
    addDisposer(
      card.on('progress', (ev) => {
        if (destroyed || readOnly) return
        progressed[index] = ev.progress
        if (stages[index] !== 'revealed') stages[index] = 'scratching'
        schedulePersist()
      }),
    )
    addDisposer(
      card.on('reset', (ev) => {
        if (destroyed || readOnly) return
        rounds[index] = ev.round
        progressed[index] = 0
        stages[index] = 'idle'
        strokeBuffers[index] = []
        schedulePersist()
      }),
    )
  })

  // ---------- 刮痕录制（供刷新后回放涂层；只记坐标，不碰子卡内部） ----------
  cards.forEach((card, index) => {
    const canvas = card.element.querySelector('canvas')
    if (!canvas) return
    let lastPoint: Point | null = null
    const toPoint = (event: PointerEvent): Point => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const recording = (): boolean =>
      !destroyed && !readOnly && stages[index] !== 'revealed'
    const onDown = (event: PointerEvent): void => {
      if (!recording()) return
      lastPoint = toPoint(event)
      appendStamps(
        strokeBuffers[index],
        interpolateStroke(lastPoint, lastPoint, brushRadius, MAX_SEGMENT),
      )
    }
    const onMove = (event: PointerEvent): void => {
      if (!recording() || event.buttons === 0) return
      const point = toPoint(event)
      const from = lastPoint ?? point
      appendStamps(
        strokeBuffers[index],
        interpolateStroke(from, point, brushRadius, MAX_SEGMENT),
      )
      lastPoint = point
    }
    const onUp = (): void => {
      lastPoint = null
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    addDisposer(() => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    })
  })

  // ---------- 多标签页：storage 事件 + 代际号仲裁 ----------
  const handleStorage = (event: StorageEvent): void => {
    if (destroyed || event.key !== storageKey) return
    const incoming = parseActivity(event.newValue)
    if (!incoming || incoming.tabId === tabId) return
    const resolution = resolveStorageConflict(generation, tabId, incoming)
    if (resolution === 'foreign-stale') {
      // 旧代际回灌：用本页更高代际的快照覆盖回去
      persist()
    } else if (resolution === 'foreign-newer') {
      enterReadOnly()
    }
  }
  window.addEventListener('storage', handleStorage)
  addDisposer(() => window.removeEventListener('storage', handleStorage))

  // 页面隐藏/刷新前冲刷一次节流中的持久化，避免丢失最后一个窗口的进度
  const handlePageHide = (): void => {
    if (persistTimer !== 0) {
      clearTimeout(persistTimer)
      persistTimer = 0
    }
    persist()
  }
  window.addEventListener('pagehide', handlePageHide)
  addDisposer(() => window.removeEventListener('pagehide', handlePageHide))
  // ---------- 活动级 reset：全部子卡重置、代际号 +1、回到第 1 张 ----------
  function resetActivity(): void {
    if (destroyed || readOnly) return
    cancelUnlock()
    generation += 1
    phase = ACTIVITY_PHASE.Active
    activeIndex = 0
    hideSummary()
    for (let i = 0; i < CARD_COUNT; i += 1) {
      stages[i] = 'idle'
      progressed[i] = 0
      strokeBuffers[i] = []
      // 同步触发子卡 reset 事件 → rounds[i] 由事件回调更新
      cards[i].reset()
    }
    refreshMasks()
    persist()
  }

  const handleRestartClick = (): void => resetActivity()
  restartBtn.addEventListener('click', handleRestartClick)
  addDisposer(() => restartBtn.removeEventListener('click', handleRestartClick))

  // ---------- destroy：只回收编排层自身资源，不销毁子卡句柄 ----------
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    cancelUnlock()
    if (persistTimer !== 0) {
      clearTimeout(persistTimer)
      persistTimer = 0
    }
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 单项回收失败不影响其余资源释放
      }
    }
    disposers.length = 0
    listeners.clear()
    if (root.isConnected) root.remove()
    // 子卡句柄由调用方经 handle.cards 持有，可独立 destroy（幂等）
  }

  const handle: ScratchActivityHandle = {
    element: root,
    cards,
    getPhase: () => phase,
    getActiveIndex: () => activeIndex,
    isReadOnly: () => readOnly,
    on<K extends keyof ScratchActivityEventMap>(
      type: K,
      listener: (ev: ScratchActivityEventMap[K]) => void,
    ): () => void {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      const wrapped = listener as (payload: never) => void
      set.add(wrapped)
      return () => {
        set?.delete(wrapped)
      }
    },
    reset: resetActivity,
    destroy,
  }

  // ---------- 初始化序列：恢复汇总层/解锁倒计时，刷新遮罩，落盘认领代际 ----------
  if (phase === ACTIVITY_PHASE.Completed) {
    showSummary()
  } else if (
    activeIndex < CARD_COUNT - 1 &&
    stages[activeIndex] === 'revealed'
  ) {
    // 刷新发生在解锁倒计时窗口内：重新调度剩余倒计时
    scheduleUnlock(activeIndex + 1)
  }
  refreshMasks()
  persist()

  return handle
}
