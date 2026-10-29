export class Timers {
  private handles = new Set<ReturnType<typeof setTimeout>>()

  delay(seconds: number, callback: () => void): void {
    const handle = setTimeout(() => {
      this.handles.delete(handle)
      callback()
    }, seconds * 1000)
    this.handles.add(handle)
  }

  countdown(expected: number, onComplete: () => void): () => void {
    let count = 0
    if (expected === 0) this.delay(0, onComplete)
    return () => {
      if (++count === expected) onComplete()
    }
  }

  clear(): void {
    this.handles.forEach(clearTimeout)
    this.handles.clear()
  }
}

export const jitter = (seconds: number): number => seconds + 0.1 * Math.random()
