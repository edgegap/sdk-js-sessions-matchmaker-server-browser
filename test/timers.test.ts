import { beforeEach, describe, expect, it, vi } from 'vitest'
import { child, countdown, delay, jitter } from '../src/timers.ts'

describe('jitter', () => {
  it.each([
    [0, 0.8],
    [0.5, 1],
    [0.999, 1.1996],
  ])('scales the delay by 0.8 to 1.2 by default (random %d)', (random, factor) => {
    vi.spyOn(Math, 'random').mockReturnValue(random)

    expect(jitter(10)).toBeCloseTo(10 * factor)
  })

  it('uses the given bounds', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999)

    expect(jitter(5, 1, 1.2)).toBe(5)
    expect(jitter(5, 1, 1.2)).toBeCloseTo(5.999)
  })
})

describe('delay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('runs the callback after the delay', () => {
    const callback = vi.fn()

    delay(1.5, new AbortController().signal, callback)
    vi.advanceTimersByTime(1499)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledOnce()
  })

  it('cancels pending callbacks on abort, and ignores aborted signals', () => {
    const controller = new AbortController()
    const callback = vi.fn()

    delay(1, controller.signal, callback)
    delay(2, controller.signal, callback)
    controller.abort()
    delay(1, controller.signal, callback)

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('adds a single abort listener per signal', () => {
    const { signal } = new AbortController()
    const addEventListener = vi.spyOn(signal, 'addEventListener')

    for (let i = 0; i < 50; i++) delay(60, signal, () => {})

    expect(addEventListener).toHaveBeenCalledOnce()
  })
})

describe('countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('completes after the expected calls', () => {
    const onComplete = vi.fn()
    const finished = countdown(2, new AbortController().signal, onComplete)

    finished()
    expect(onComplete).not.toHaveBeenCalled()
    finished()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('completes asynchronously with nothing expected, unless aborted', () => {
    const controller = new AbortController()
    const onComplete = vi.fn()
    const onAborted = vi.fn()

    countdown(0, new AbortController().signal, onComplete)
    countdown(0, controller.signal, onAborted)
    controller.abort()
    expect(onComplete).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onAborted).not.toHaveBeenCalled()
  })
})

describe('child', () => {
  it('aborts with its parent', () => {
    const parent = new AbortController()
    const controller = child(parent.signal)

    parent.abort('stopped')

    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe('stopped')
  })

  it('stays independent of its siblings and stops listening to the parent once aborted', () => {
    const parent = new AbortController()
    const removeEventListener = vi.spyOn(parent.signal, 'removeEventListener')
    const first = child(parent.signal)
    const second = child(parent.signal)

    first.abort()

    expect(second.signal.aborted).toBe(false)
    expect(parent.signal.aborted).toBe(false)
    expect(removeEventListener).toHaveBeenCalledOnce()
  })

  it('starts aborted under an aborted parent', () => {
    const parent = new AbortController()
    parent.abort()

    expect(child(parent.signal).signal.aborted).toBe(true)
  })
})
