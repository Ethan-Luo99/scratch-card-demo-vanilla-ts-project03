/**
 * 活动编排层工厂（createScratchActivity）：
 * - 1~9 张刮刮卡串行解锁：第 N 张 revealed 后第 N+1 张倒计时解锁，
 *   未解锁卡覆盖遮罩层 + 解锁倒计时文案；
 * - 全部 revealed 后触发 allRevealed 回调并展示汇总层；
 * - 进度持久化 schema v2（cardsCount + 每卡 attempts）到 sessionStorage，
 *   key 前缀可配置，隐私模式抛异常时静默降级为内存态；
 *   记录只含 state/progress/round/cover/attempts/cardsCount，不写入奖品内容；
 * - 首次加载命中 v1 旧记录时无损迁移并立即落盘 v2（迁移幂等）；
 * - storage 事件做 last-write-wins + 代际号合并：远端代际更高时本页
 *   降级只读并提示刷新，旧代际 / 旧版（v1）写入方直接忽略；
 * - 所有异步回调（倒计时 timer / storage 事件 / 子卡事件）一律校验
 *   「代际号 + 轮次号」，过期回调直接丢弃；
 * - destroy() 只回收编排层自身监听与 timer，不销毁子卡句柄。
 */
import styleText from './activity.css?inline'
import { createScratchCard } from '../scratch-card/index.ts'
import type { ScratchCardSnapshot } from '../scratch-card/index.ts'
import { ACTIVITY_PHASE } from './types.ts'
import type {
  ActivityPhase,
  ScratchActivityHandle,
  ScratchActivityOptions,
} from './types.ts'
import { createSafeStorage } from './storage.ts'
import {
  MAX_CARD_COUNT,
  MIN_CARD_COUNT,
  RECORD_VERSION,
  createInitialCards,
  decideRemoteRecord,
  getPngDataUrlSize,
  isAllRevealed,
  isCardUnlocked,
  isValidCardCount,
  parseStoredRecord,
  serializeRecord,
} from './logic.ts'
import type { ParsedRecord, CardPersistState } from './logic.ts'

const DEFAULT_STORAGE_PREFIX = 'scratch-activity'
const DEFAULT_UNLOCK_DELAY = 2000
const COUNTDOWN_TICK = 200

/** 单例样式注入守卫（与 scratch-card 同一模式） */
let styleInjected = false
function injectStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const style = document.createElement('style')
  style.id = 'scratch-activity-styles'
  style.textContent = styleText
  document.head.appendChild(style)
}

export function createScratchActivity(
  options: ScratchActivityOptions,
): ScratchActivityHandle {
  injectStyles()
  const cardCount = options.cards.length
  if (!isValidCardCount(cardCount)) {
    throw new Error(
      `createScratchActivity 需要 ${MIN_CARD_COUNT}~${MAX_CARD_COUNT} 张卡片配置，实际收到 ${cardCount} 张`,
    )
  }

  const storageKey = `${options.storagePrefix ?? DEFAULT_STORAGE_PREFIX}:state`
  const unlockDelay = Math.max(0, options.unlockDelay ?? DEFAULT_UNLOCK_DELAY)
  const storage = createSafeStorage()

  // ---------- 闭包状态 ----------
  let destroyed = false
  let readOnly = false
  let generation = 1
  let phase: ActivityPhase = ACTIVITY_PHASE.Active
  let lastPersistAt = 0
  let cardsState: CardPersistState[] = createInitialCards(cardCount)
  // 首次加载命中 v1 记录时置位：恢复完成后立即以 v2 落盘，完成迁移
  let legacyNeedsPersist = false

  // 载入持久化记录：parseStoredRecord 兼容解析 v1/v2，v1 记录无损迁移为
  // v2 内存结构（字段保全、attempts 置 0）；卡数与当前配置不一致（如宿主
  // 改版了卡数、或 v1 残留 3 卡而当前为其他数量）时无法逐卡对应恢复，
  // 视为无匹配记录，从当前配置起新活动；JSON 损坏等真正无法解析才丢弃。
  const stored: ParsedRecord | null = parseStoredRecord(storage.getItem(storageKey))
  if (stored && stored.cards.length === cardCount) {
    generation = stored.generation
    phase = stored.phase
    lastPersistAt = stored.updatedAt
    cardsState = stored.cards
    legacyNeedsPersist = stored.legacy === true
  }

  /**
   * v1 迁移位图尺寸适配判定：v1 位图可能保存在旧卡片尺寸（或旧 DPR）下。
   * 取舍：能确定当前配置为固定像素宽时，若位图像素尺寸与
   * round(宽×DPR)×round(高×DPR) 不一致，则放弃位图、仅保留 progress——
   * 「保留进度、丢弃位图」优先于把一张错尺寸的涂层贴回（拉伸/错位会让
   * 已刮区域与视觉对不上）；子卡会以全新涂层重建，编排层持久化的
   * progress 不丢，首次覆盖率采样后位图会按真实进度自然回正。
   * 宽度为百分比等无法在构造期同步确定的尺寸时不做判定，保留位图交给
   * 子卡图片加载与缩放路径处理（其本身按位图加载，不崩溃）。
   * v2 记录的位图来自同一版本结构，不经此回退。
   */
  function legacyCoverFitsCurrent(index: number, cover: string): boolean {
    if (!stored || stored.legacy !== true) return true
    const size = getPngDataUrlSize(cover)
    if (!size) return true
    const configured = options.cards[index]
    if (typeof configured.width !== 'number') return true
    const dpr =
      typeof window !== 'undefined' && window.devicePixelRatio
        ? window.devicePixelRatio
        : 1
    const expectedWidth = Math.round(configured.width * dpr)
    const expectedHeight = Math.round(configured.height * dpr)
    return size.width === expectedWidth && size.height === expectedHeight
  }

  /** 由持久化状态推导子卡 restore 选项 */
  function restoreFor(index: number): ScratchCardSnapshot | undefined {
    const persisted = cardsState[index]
    if (persisted.state === 'revealed') {
      return { state: 'revealed', progress: 1, round: persisted.round }
    }
    const cover =
      persisted.cover !== undefined &&
      legacyCoverFitsCurrent(index, persisted.cover)
        ? persisted.cover
        : undefined
    if (persisted.progress > 0 && cover) {
      return {
        state: 'idle',
        progress: persisted.progress,
        round: persisted.round,
        cover,
      }
    }
    if (persisted.round > 0) {
      return { state: 'idle', progress: 0, round: persisted.round }
    }
    return undefined
  }

  // ---------- 子卡创建（复用 createScratchCard，行为不变） ----------
  const cards = options.cards.map((cardOptions, index) =>
    createScratchCard({ ...cardOptions, restore: restoreFor(index) }),
  )

  // ---------- DOM 构建 ----------
  const root = document.createElement('div')
  root.className = 'scratch-activity'

  const notice = document.createElement('p')
  notice.className = 'scratch-activity-notice'
  notice.setAttribute('role', 'status')
  notice.textContent =
    '检测到其他标签页已开启新一轮活动，本页已切换为只读展示，请刷新页面。'
  notice.hidden = true
  root.appendChild(notice)

  const lockEls: HTMLElement[] = []
  const lockCountdownEls: HTMLParagraphElement[] = []
  const cardWraps: HTMLElement[] = []

  for (let index = 0; index < cardCount; index += 1) {
    const slot = document.createElement('div')
    slot.className = 'scratch-activity-slot'
    const wrap = document.createElement('div')
    wrap.className = 'scratch-activity-card'
    wrap.appendChild(cards[index].element)
    const lock = document.createElement('div')
    lock.className = 'scratch-activity-lock'
    const lockTitle = document.createElement('p')
    lockTitle.className = 'scratch-activity-lock-title'
    lockTitle.textContent = `第 ${index + 1} 张 · 未解锁`
    const lockCountdown = document.createElement('p')
    lockCountdown.className = 'scratch-activity-lock-countdown'
    lockCountdown.textContent = '刮开上一张卡片后解锁'
    lock.append(lockTitle, lockCountdown)
    slot.append(wrap, lock)
    root.appendChild(slot)
    cardWraps.push(wrap)
    lockEls.push(lock)
    lockCountdownEls.push(lockCountdown)
  }

  const summary = document.createElement('section')
  summary.className = 'scratch-activity-summary'
  summary.hidden = true
  const summaryTitle = document.createElement('h2')
  summaryTitle.className = 'scratch-activity-summary-title'
  summaryTitle.textContent = '全部刮开，奖品汇总'
  const summaryList = document.createElement('ul')
  summaryList.className = 'scratch-activity-summary-list'
  for (const cardOptions of options.cards) {
    const item = document.createElement('li')
    item.className = 'scratch-activity-summary-item'
    item.textContent = cardOptions.prize.description
      ? `${cardOptions.prize.title} · ${cardOptions.prize.description}`
      : cardOptions.prize.title
    summaryList.appendChild(item)
  }
  const restartBtn = document.createElement('button')
  restartBtn.type = 'button'
  restartBtn.className = 'scratch-activity-restart'
  restartBtn.textContent = '再来一轮'
  summary.append(summaryTitle, summaryList, restartBtn)
  root.appendChild(summary)

  // ---------- 解锁标志与资源登记 ----------
  const unlockedFlags: boolean[] = []
  for (let index = 0; index < cardCount; index += 1) {
    unlockedFlags.push(
      cardsState[index].state === 'revealed' ||
        isCardUnlocked(cardsState, index),
    )
  }

  const disposers: Array<() => void> = []
  /** 每张卡的「代际+轮次」动态订阅（rewire 时整体替换） */
  const dynamicUnsubs: Array<Array<() => void>> = []
  for (let index = 0; index < cardCount; index += 1) dynamicUnsubs.push([])

  let countdownTimer = 0
  let countdownTarget = -1

  // ---------- 持久化 ----------
  function copyCardState(card: CardPersistState): CardPersistState {
    const copy: CardPersistState = {
      state: card.state,
      progress: card.progress,
      round: card.round,
      attempts: card.attempts,
    }
    if (card.cover !== undefined) copy.cover = card.cover
    return copy
  }

  function persist(): void {
    if (destroyed || readOnly) return
    const record: ParsedRecord = {
      version: RECORD_VERSION,
      generation,
      updatedAt: Date.now(),
      phase,
      cardsCount: cardsState.length,
      cards: cardsState.map(copyCardState),
    }
    lastPersistAt = record.updatedAt
    storage.setItem(storageKey, serializeRecord(record))
  }

  function syncFromSnapshot(index: number): void {
    const snap = cards[index].snapshot()
    const previous = cardsState[index]
    const next: CardPersistState = {
      state: snap.state,
      progress: snap.progress,
      round: snap.round,
      // attempts 为编排层维护的跨轮次累计计数，不来自子卡快照
      attempts: previous.attempts,
    }
    if (snap.cover !== undefined) next.cover = snap.cover
    cardsState[index] = next
  }

  // ---------- 代际号 + 轮次号守卫（所有异步回调统一校验） ----------
  function isCurrent(gen: number, index: number, round: number): boolean {
    return (
      !destroyed &&
      !readOnly &&
      gen === generation &&
      cardsState[index].round === round
    )
  }

  // ---------- 子卡事件接线 ----------
  function rewireCard(index: number): void {
    for (const unsub of dynamicUnsubs[index]) unsub()
    const gen = generation
    const round = cardsState[index].round
    const card = cards[index]
    dynamicUnsubs[index] = [
      card.on('scratchstart', () => {
        // attempts：该卡累计进入刮擦状态的轮次数。子卡每轮仅首次有效
        // 刮擦派发一次 scratchstart，订阅随 round 重接，因此每个 round
        // 至多累加 1；代际/轮次守卫保证过期回放过期不计。
        if (!isCurrent(gen, index, round)) return
        cardsState[index] = {
          ...cardsState[index],
          attempts: cardsState[index].attempts + 1,
        }
        persist()
      }),
      card.on('progress', () => {
        if (!isCurrent(gen, index, round)) return
        syncFromSnapshot(index)
        persist()
      }),
      card.on('revealed', () => {
        handleCardRevealed(index, gen, round)
      }),
    ]
  }

  function handleCardRevealed(
    index: number,
    gen: number,
    round: number,
  ): void {
    if (!isCurrent(gen, index, round)) return
    syncFromSnapshot(index)
    unlockedFlags[index] = true
    updateLockUI(index)
    if (index + 1 < cardCount) startUnlockCountdown(index + 1)
    if (isAllRevealed(cardsState)) {
      completeActivity()
    } else {
      persist()
    }
  }

  /** reset 为常驻订阅：任何来源的 reset 都回收串行不变量 */
  function handleCardReset(index: number, round: number): void {
    if (destroyed || readOnly) return
    cardsState[index] = {
      state: 'idle',
      progress: 0,
      round,
      attempts: cardsState[index].attempts,
    }
    clearCountdown()
    if (phase === ACTIVITY_PHASE.Completed) {
      phase = ACTIVITY_PHASE.Active
      hideSummary()
    }
    for (let j = index; j < cardCount; j += 1) {
      if (cardsState[j].state === 'revealed') continue
      unlockedFlags[j] = isCardUnlocked(cardsState, j)
      updateLockUI(j)
    }
    rewireCard(index)
    persist()
  }

  function wireAll(): void {
    for (let index = 0; index < cardCount; index += 1) {
      disposers.push(
        cards[index].on('reset', (ev) => handleCardReset(index, ev.round)),
      )
      rewireCard(index)
    }
  }

  // ---------- 解锁与倒计时 ----------
  function updateLockUI(index: number): void {
    const unlocked = unlockedFlags[index]
    lockEls[index].classList.toggle('is-hidden', unlocked)
    cardWraps[index].toggleAttribute('inert', !unlocked)
    if (!unlocked && countdownTarget !== index) {
      lockCountdownEls[index].textContent = '刮开上一张卡片后解锁'
    }
  }

  function unlockCard(index: number): void {
    unlockedFlags[index] = true
    updateLockUI(index)
  }

  function clearCountdown(): void {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = 0
    }
    countdownTarget = -1
  }

  function startUnlockCountdown(target: number): void {
    if (unlockedFlags[target]) return
    if (unlockDelay <= 0) {
      unlockCard(target)
      return
    }
    clearCountdown()
    const gen = generation
    const prevRound = cardsState[target - 1].round
    const deadline = Date.now() + unlockDelay
    countdownTarget = target
    let lastSeconds = -1
    const tick = (): void => {
      if (
        destroyed ||
        readOnly ||
        gen !== generation ||
        countdownTarget !== target ||
        cardsState[target - 1].round !== prevRound
      ) {
        clearCountdown()
        return
      }
      const remain = deadline - Date.now()
      if (remain <= 0) {
        clearCountdown()
        unlockCard(target)
        return
      }
      const seconds = Math.ceil(remain / 1000)
      if (seconds !== lastSeconds) {
        lastSeconds = seconds
        lockCountdownEls[target].textContent = `距离解锁还有 ${seconds} 秒`
      }
    }
    tick()
    countdownTimer = window.setInterval(tick, COUNTDOWN_TICK)
  }

  // ---------- 完成与汇总层 ----------
  function showSummary(): void {
    summary.hidden = false
    summary.classList.add('is-open')
  }

  function hideSummary(): void {
    summary.hidden = true
    summary.classList.remove('is-open')
  }

  function completeActivity(): void {
    if (phase === ACTIVITY_PHASE.Completed) return
    phase = ACTIVITY_PHASE.Completed
    persist()
    showSummary()
    if (options.allRevealed) {
      options.allRevealed(options.cards.map((card) => card.prize))
    }
  }

  // ---------- 多标签页：storage 事件 + 代际合并 ----------
  function applyRemote(remote: ParsedRecord): void {
    if (remote.cards.length !== cardCount) return
    clearCountdown()
    for (let index = 0; index < cardCount; index += 1) {
      const remoteCard = remote.cards[index]
      const wasRevealed = cardsState[index].state === 'revealed'
      cardsState[index] = copyCardState(remoteCard)
      if (remoteCard.state === 'revealed' && !wasRevealed) {
        // 程序化揭示补齐视觉态；随后的 revealed 事件走常规守卫，幂等
        cards[index].reveal()
      }
      unlockedFlags[index] =
        remoteCard.state === 'revealed' ||
        isCardUnlocked(remote.cards, index)
      updateLockUI(index)
      rewireCard(index)
    }
    if (
      remote.phase === ACTIVITY_PHASE.Completed &&
      phase !== ACTIVITY_PHASE.Completed
    ) {
      // 远端完成：展示汇总但不重复触发 allRevealed（避免双倍副作用）
      phase = ACTIVITY_PHASE.Completed
      showSummary()
    } else if (
      remote.phase === ACTIVITY_PHASE.Active &&
      phase === ACTIVITY_PHASE.Completed
    ) {
      phase = ACTIVITY_PHASE.Active
      hideSummary()
    }
    lastPersistAt = remote.updatedAt
  }

  function enterReadOnly(): void {
    readOnly = true
    clearCountdown()
    root.classList.add('is-readonly')
    root.toggleAttribute('inert', true)
    notice.hidden = false
  }

  function handleStorage(event: StorageEvent): void {
    if (destroyed || readOnly) return
    if (event.key !== storageKey) return
    // 外来记录同样走 v1/v2 兼容解析：v1 记录迁移后带 legacy 标记，
    // decideRemoteRecord 按「旧版写入方视为低代际」直接忽略，
    // 不会崩溃、不会把 v1 结构写回覆盖本页 v2 记录。
    const remote = parseStoredRecord(event.newValue)
    const decision = decideRemoteRecord(
      { generation, updatedAt: lastPersistAt },
      remote,
    )
    if (decision === 'ignore' || !remote) return
    if (decision === 'readonly') {
      enterReadOnly()
      return
    }
    applyRemote(remote)
  }

  // ---------- 再来一轮：新代际 ----------
  function restart(): void {
    if (destroyed || readOnly) return
    generation += 1
    phase = ACTIVITY_PHASE.Active
    hideSummary()
    clearCountdown()
    // reset 事件（常驻订阅）逐卡回收状态、重接线并持久化
    for (let index = 0; index < cardCount; index += 1) {
      cards[index].reset()
    }
    persist()
  }

  // ---------- destroy：只回收编排层自身资源，不动子卡句柄 ----------
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    clearCountdown()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 单项回收失败不影响其余
      }
    }
    disposers.length = 0
    for (const unsubs of dynamicUnsubs) {
      for (const unsub of unsubs) {
        try {
          unsub()
        } catch {
          // 同上
        }
      }
      unsubs.length = 0
    }
    if (root.isConnected) root.remove()
    // 子卡句柄不随编排层销毁：宿主可经 handle.cards 独立 destroy()
  }

  const handle: ScratchActivityHandle = {
    element: root,
    cards,
    getPhase: () => phase,
    getGeneration: () => generation,
    isReadOnly: () => readOnly,
    destroy,
  }

  // ---------- 初始化收尾 ----------
  wireAll()
  for (let index = 0; index < cardCount; index += 1) {
    updateLockUI(index)
  }
  if (phase === ACTIVITY_PHASE.Completed) showSummary()

  window.addEventListener('storage', handleStorage)
  disposers.push(() => window.removeEventListener('storage', handleStorage))

  const handleRestartClick = (): void => restart()
  restartBtn.addEventListener('click', handleRestartClick)
  disposers.push(() =>
    restartBtn.removeEventListener('click', handleRestartClick),
  )

  // 全新活动：落一条初始记录，让其他标签页能感知代际；
  // 命中 v1 旧记录：首次加载即把无损迁移后的 v2 结构落盘（迁移幂等：
  // 同一 v1 记录重复加载都得到同一 v2 结果，再次落盘无额外副作用）。
  // 卡数不匹配的 v1 残留不会进入恢复分支，此处按全新 v2 覆盖，
  // 不存在把 v1 原样写回的路径。
  if (!stored || stored.cards.length !== cardCount) {
    persist()
  } else if (legacyNeedsPersist) {
    persist()
  }

  return handle
}
