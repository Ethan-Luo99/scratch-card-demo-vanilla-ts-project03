/**
 * 无障碍与媒体查询小工具（设计 E 矩阵 / A3）：
 * - prefers-reduced-motion 检测（揭示动效归零，双重保险由 CSS 再兜底）；
 * - prefers-color-scheme 变化监听（仅 idle 态是否重绘由工厂裁决）；
 * - DPR 变化监听（跨屏拖窗，与 ResizeObserver 双触发）；
 * - Enter/Space 键盘激活（刮擦无键盘等价物，「直接揭晓」是公认替代）。
 *
 * 所有监听均返回解绑函数，供 destroy() 统一回收。
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function watchMedia(
  query: string,
  listener: (event: MediaQueryListEvent) => void,
): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {}
  }
  const mql = window.matchMedia(query)
  mql.addEventListener('change', listener)
  return () => mql.removeEventListener('change', listener)
}

/** 主题切换 */
export function watchColorScheme(
  listener: (dark: boolean) => void,
): () => void {
  return watchMedia('(prefers-color-scheme: dark)', (event) =>
    listener(event.matches),
  )
}

/**
 * 监听 devicePixelRatio 变化（跨屏幕拖动）。matchMedia 无法用任意 dpr 值
 * 静态表达，这里监听常见档位；命中后工厂重新读取 window.devicePixelRatio。
 */
export function watchResolutionChange(
  listener: () => void,
): () => void {
  const disposers: Array<() => void> = []
  const queries = [
    '(resolution: 1.5dppx)',
    '(resolution: 2dppx)',
    '(resolution: 2.5dppx)',
    '(resolution: 3dppx)',
    '(resolution: 3.5dppx)',
    '(resolution: 4dppx)',
  ]
  for (const query of queries) {
    disposers.push(watchMedia(query, listener))
  }
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** Enter / Space 视为激活（与 role="button" 约定一致），返回是否命中 */
export function isActivationKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar'
}

/** 在元素上绑定键盘激活，返回解绑函数；自动阻止 Space 翻页 */
export function bindKeyboardActivate(
  target: HTMLElement,
  onActivate: () => void,
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (isActivationKey(event)) {
      event.preventDefault()
      onActivate()
    }
  }
  target.addEventListener('keydown', handleKeyDown)
  return () => target.removeEventListener('keydown', handleKeyDown)
}
