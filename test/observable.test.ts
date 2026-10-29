import { describe, expect, it, vi } from 'vitest'
import { Observable, ObservableActionType } from '../src/index.ts'

describe('Observable', () => {
  it('starts with the initial value, like new T() in Unity', () => {
    const observable = new Observable<{ id?: string }>({})

    expect(observable.current).toEqual({})
    expect(observable.current).not.toBeNull()
    expect(observable.previous).toBeNull()
    expect(observable.error).toBeNull()
  })

  it('emits updates with previous and current values', () => {
    const observable = new Observable<{ id: string } | null>(null)
    const subscriber = vi.fn()
    observable.subscribe(subscriber)

    observable._update({ id: 'a' }, { code: 'created' })
    observable._update(null, { code: 'removed' })

    expect(subscriber.mock.calls).toEqual([
      [observable, ObservableActionType.Update, 'created', { code: 'created' }],
      [observable, ObservableActionType.Update, 'removed', { code: 'removed' }],
    ])
    expect(observable.previous).toEqual({ id: 'a' })
    expect(observable.current).toBeNull()
  })

  it('notifies with Log by default and keeps the value', () => {
    const observable = new Observable({ id: 'a' })
    const subscriber = vi.fn()
    observable.subscribe(subscriber)

    observable._notify({ code: 'polling' })
    observable._notify({ code: 'conflict' }, ObservableActionType.Warn)

    expect(subscriber.mock.calls).toEqual([
      [observable, ObservableActionType.Log, 'polling', { code: 'polling' }],
      [observable, ObservableActionType.Warn, 'conflict', { code: 'conflict' }],
    ])
    expect(observable.current).toEqual({ id: 'a' })
  })

  it('keeps the value on error without one, and replaces it when given one', () => {
    const observable = new Observable<{ id: string } | null>({ id: 'a' })

    observable._error({ code: 'failed' })
    expect(observable.current).toEqual({ id: 'a' })
    expect(observable.error).toBe('failed')

    observable._error({ code: 'removed' }, null)
    expect(observable.current).toBeNull()
    expect(observable.previous).toEqual({ id: 'a' })
    expect(observable.error).toBe('removed')
  })

  it('builds messages from the event, and appends the detail on a new line', () => {
    type Event = { code: 'removed'; id: string } | { code: 'failed'; id: string; detail: string }
    const observable = new Observable<number, Event>(0, {
      removed: ({ id }) => `removed [${id}]`,
      failed: ({ id }) => `failed [${id}]`,
    })
    const subscriber = vi.fn()
    observable.subscribe(subscriber)

    observable._update(null, { code: 'removed', id: 'a' })
    observable._error({ code: 'failed', id: 'b', detail: '500 Internal Server Error' })

    expect(subscriber.mock.calls.map(([, , message, event]) => [message, event])).toEqual([
      ['removed [a]', { code: 'removed', id: 'a' }],
      ['failed [b]\n500 Internal Server Error', { code: 'failed', id: 'b', detail: '500 Internal Server Error' }],
    ])
    expect(observable.error).toBe('failed [b]\n500 Internal Server Error')
  })

  it('unsubscribes through the returned function, unsubscribe, and clear', () => {
    const observable = new Observable(0)
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()
    const unsubscribe = observable.subscribe(first)
    observable.subscribe(second)
    observable.subscribe(third)

    unsubscribe()
    observable.unsubscribe(second)
    observable._notify({ code: 'one' })
    observable.clear()
    observable._notify({ code: 'two' })

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(third).toHaveBeenCalledOnce()
  })

  it('delivers to subscribers registered at emit time only', () => {
    const observable = new Observable(0)
    const late = vi.fn()
    observable.subscribe(() => observable.subscribe(late))

    observable._notify({ code: 'first' })
    expect(late).not.toHaveBeenCalled()

    observable._notify({ code: 'second' })
    expect(late).toHaveBeenCalledOnce()
  })
})
