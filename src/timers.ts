type Handle = ReturnType<typeof setTimeout>

const pending = new WeakMap<AbortSignal, Set<Handle>>()

const handlesFor = (signal: AbortSignal): Set<Handle> => {
  const existing = pending.get(signal)
  if (existing) return existing

  const handles = new Set<Handle>()
  pending.set(signal, handles)
  signal.addEventListener(
    'abort',
    () => {
      handles.forEach(clearTimeout)
      handles.clear()
    },
    { once: true },
  )
  return handles
}

export const delay = (seconds: number, signal: AbortSignal, callback: () => void): void => {
  if (signal.aborted) return

  const handles = handlesFor(signal)
  const handle = setTimeout(() => {
    handles.delete(handle)
    callback()
  }, seconds * 1000)
  handles.add(handle)
}

export const countdown = (expected: number, signal: AbortSignal, onComplete: () => void): (() => void) => {
  let count = 0
  if (expected === 0) delay(0, signal, onComplete)
  return () => {
    if (++count === expected) onComplete()
  }
}

export const child = (parent: AbortSignal): AbortController => {
  const controller = new AbortController()
  if (parent.aborted) {
    controller.abort(parent.reason)
    return controller
  }

  const abort = () => controller.abort(parent.reason)
  parent.addEventListener('abort', abort, { once: true })
  controller.signal.addEventListener('abort', () => parent.removeEventListener('abort', abort), { once: true })
  return controller
}

export const jitter = (seconds: number, min = 0.8, max = 1.2): number =>
  seconds * (min + (max - min) * Math.random())
