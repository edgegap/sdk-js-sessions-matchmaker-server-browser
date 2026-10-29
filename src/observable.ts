export const ObservableActionType = {
  Log: 0,
  Update: 100,
  Warn: 200,
  Error: 300,
} as const

export type ObservableActionType = (typeof ObservableActionType)[keyof typeof ObservableActionType]

export type Subscriber<T> = (
  observable: Observable<T>,
  type: ObservableActionType,
  message: string,
) => void

export class Observable<T> {
  private _current: T | null
  private _previous: T | null = null
  private _lastError: string | null = null
  private subscribers: Subscriber<T>[] = []

  constructor(initial: T | null = null) {
    this._current = initial
  }

  get current(): T | null {
    return this._current
  }

  get previous(): T | null {
    return this._previous
  }

  get error(): string | null {
    return this._lastError
  }

  subscribe(subscriber: Subscriber<T>): () => void {
    this.subscribers.push(subscriber)
    return () => this.unsubscribe(subscriber)
  }

  unsubscribe(subscriber: Subscriber<T>): void {
    const index = this.subscribers.lastIndexOf(subscriber)
    if (index >= 0) this.subscribers.splice(index, 1)
  }

  clear(): void {
    this.subscribers = []
  }

  _notify(message: string, type: ObservableActionType = ObservableActionType.Log): void {
    this.invoke(type, message)
  }

  _update(value: T | null, message: string): void {
    this._previous = this._current
    this._current = value
    this.invoke(ObservableActionType.Update, message)
  }

  _error(error: string, ...value: [] | [T | null]): void {
    if (value.length === 1) {
      this._previous = this._current
      this._current = value[0]
    }
    this._lastError = error
    this.invoke(ObservableActionType.Error, error)
  }

  private invoke(type: ObservableActionType, message: string): void {
    this.subscribers.slice().forEach((subscriber) => subscriber(this, type, message))
  }
}
