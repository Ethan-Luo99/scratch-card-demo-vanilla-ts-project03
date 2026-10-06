/**
 * sessionStorage 安全封装：
 * - 隐私模式下访问 sessionStorage 可能直接抛 SecurityError，
 *   探测失败即静默降级为内存态（Map），功能不缺失；
 * - 运行期任意一次读写抛错也会永久切换到内存后端；
 * - 全部接口不抛异常，调用方无需 try/catch。
 *
 * 可注入后端便于 node:test 覆盖降级路径。
 */

export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface SafeStorage extends StorageLike {
  /** true 表示落在真实 sessionStorage；false 表示内存降级 */
  readonly persistent: boolean
}

const PROBE_KEY = '__scratch_activity_probe__'

function detectSessionStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null
    return window.sessionStorage
  } catch {
    return null
  }
}

function probe(backend: StorageLike): boolean {
  try {
    backend.setItem(PROBE_KEY, '1')
    backend.removeItem(PROBE_KEY)
    return true
  } catch {
    return false
  }
}

export function createSafeStorage(raw?: StorageLike): SafeStorage {
  let backend: StorageLike | null = raw ?? detectSessionStorage()
  if (backend && !probe(backend)) backend = null

  const memory = new Map<string, string>()

  return {
    get persistent(): boolean {
      return backend !== null
    },
    getItem(key: string): string | null {
      try {
        if (backend) return backend.getItem(key)
      } catch {
        backend = null
      }
      return memory.get(key) ?? null
    },
    setItem(key: string, value: string): void {
      try {
        if (backend) {
          backend.setItem(key, value)
          return
        }
      } catch {
        backend = null
      }
      memory.set(key, value)
    },
    removeItem(key: string): void {
      try {
        if (backend) {
          backend.removeItem(key)
          return
        }
      } catch {
        backend = null
      }
      memory.delete(key)
    },
  }
}
