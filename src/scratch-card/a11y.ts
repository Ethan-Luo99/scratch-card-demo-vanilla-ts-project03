/** 无障碍与媒体查询小工具集合（无 DOM 状态，全部返回可清理 disposer）。 */

export function prefersReducedMotion(): boolean {
  return queryMatches('(prefers-reduced-motion: reduce)')
}

export function prefersDarkColorScheme(): boolean {
  return queryMatches('(prefers-color-scheme: dark)')
}

function queryMatches(query: string): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches
  )
}

/**
 * 订阅媒体查询变化。老版 Safari 用 addListener/removeListener 兜底；
 * 环境不支持 matchMedia 时返回 null（调用方按一次性能力处理）。
 */
export function subscribeMediaQuery(
  query: string,
  onChange: () => void,
): (() => void) | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  const media = window.matchMedia(query)
  const modern = typeof media.addEventListener === 'function'
  if (modern) {
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }
  media.addListener(onChange)
  return () => media.removeListener(onChange)
}

/**
 * 键盘激活：Enter / Space 触发回调（刮擦无键盘等价物，直接揭晓是公认替代）。
 * Space 会同时滚动页面，这里拦截默认行为。
 */
export function bindKeyboardActivate(
  element: HTMLElement,
  onActivate: () => void,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onActivate()
    }
  }
  element.addEventListener('keydown', onKeyDown)
  return () => element.removeEventListener('keydown', onKeyDown)
}
