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

    observable._update({ id: 'a' }, 'created')
    observable._update(null, 'removed')

    expect(subscriber.mock.calls).toEqual([
      [observable, ObservableActionType.Update, 'created'],
      [observable, ObservableActionType.Update, 'removed'],
    ])
    expect(observable.previous).toEqual({ id: 'a' })
    expect(observable.current).toBeNull()
  })

  it('notifies with Log by default and keeps the value', () => {
    const observable = new Observable({ id: 'a' })
    const subscriber = vi.fn()
    observable.subscribe(subscriber)

    observable._notify('polling')
    observable._notify('conflict', ObservableActionType.Warn)

    expect(subscriber.mock.calls).toEqual([
      [observable, ObservableActionType.Log, 'polling'],
      [observable, ObservableActionType.Warn, 'conflict'],
    ])
    expect(observable.current).toEqual({ id: 'a' })
  })

  it('keeps the value on error without one, and replaces it when given one', () => {
    const observable = new Observable<{ id: string } | null>({ id: 'a' })

    observable._error('failed')
    expect(observable.current).toEqual({ id: 'a' })
    expect(observable.error).toBe('failed')

    observable._error('removed', null)
    expect(observable.current).toBeNull()
    expect(observable.previous).toEqual({ id: 'a' })
    expect(observable.error).toBe('removed')
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
    observable._notify('one')
    observable.clear()
    observable._notify('two')

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    expect(third).toHaveBeenCalledOnce()
  })

  it('delivers to subscribers registered at emit time only', () => {
    const observable = new Observable(0)
    const late = vi.fn()
    observable.subscribe(() => observable.subscribe(late))

    observable._notify('first')
    expect(late).not.toHaveBeenCalled()

    observable._notify('second')
    expect(late).toHaveBeenCalledOnce()
  })
})
