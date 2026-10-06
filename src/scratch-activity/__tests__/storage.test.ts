/**
 * storage.ts 单测：隐私模式降级与运行期故障切换。
 * 运行：npm test
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSafeStorage } from '../storage.ts'
import type { StorageLike } from '../storage.ts'

function throwingStorage(): StorageLike {
  return {
    getItem(): string | null {
      throw new DOMException('denied', 'SecurityError')
    },
    setItem(): void {
      throw new DOMException('denied', 'SecurityError')
    },
    removeItem(): void {
      throw new DOMException('denied', 'SecurityError')
    },
  }
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

describe('createSafeStorage', () => {
  it('正常后端：持久化读写往返', () => {
    const backend = memoryStorage()
    const storage = createSafeStorage(backend)
    assert.equal(storage.persistent, true)
    storage.setItem('k', 'v')
    assert.equal(storage.getItem('k'), 'v')
    assert.equal(backend.data.get('k'), 'v')
    storage.removeItem('k')
    assert.equal(storage.getItem('k'), null)
  })

  it('隐私模式（探测即抛错）：静默降级内存态，功能不缺失', () => {
    const storage = createSafeStorage(throwingStorage())
    assert.equal(storage.persistent, false)
    storage.setItem('k', 'v')
    assert.equal(storage.getItem('k'), 'v')
    storage.removeItem('k')
    assert.equal(storage.getItem('k'), null)
  })

  it('运行期 setItem 抛错（配额满）：切换内存后端且不抛异常', () => {
    const backend = memoryStorage()
    const storage = createSafeStorage(backend)
    assert.equal(storage.persistent, true)
    backend.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    storage.setItem('k', 'v')
    assert.equal(storage.persistent, false)
    assert.equal(storage.getItem('k'), 'v')
  })

  it('node 环境（无 window）：默认即为内存降级', () => {
    const storage = createSafeStorage()
    assert.equal(storage.persistent, false)
    storage.setItem('a', 'b')
    assert.equal(storage.getItem('a'), 'b')
  })
})
