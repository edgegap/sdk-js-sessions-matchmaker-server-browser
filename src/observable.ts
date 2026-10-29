export const ObservableActionType = {
  Log: 0,
  Update: 100,
  Warn: 200,
  Error: 300,
} as const

export type ObservableActionType = (typeof ObservableActionType)[keyof typeof ObservableActionType]

export interface ObservableEvent {
  code: string
  detail?: string
}

export type EventMessages<E extends ObservableEvent> = {
  [C in E['code']]: (event: Extract<E, { code: C }>) => string
}

export type Subscriber<T, E extends ObservableEvent = ObservableEvent> = (
  observable: Observable<T, E>,
  type: ObservableActionType,
  message: string,
  event: E,
) => void

export class Observable<T, E extends ObservableEvent = ObservableEvent> {
  private _current: T | null
  private _previous: T | null = null
  private _lastError: string | null = null
  private subscribers: Subscriber<T, E>[] = []
  private readonly messages: EventMessages<E> | undefined

  constructor(initial: T | null = null, messages?: EventMessages<E>) {
    this._current = initial
    this.messages = messages
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

  subscribe(subscriber: Subscriber<T, E>): () => void {
    this.subscribers.push(subscriber)
    return () => this.unsubscribe(subscriber)
  }

  unsubscribe(subscriber: Subscriber<T, E>): void {
    const index = this.subscribers.lastIndexOf(subscriber)
    if (index >= 0) this.subscribers.splice(index, 1)
  }

  clear(): void {
    this.subscribers = []
  }

  _notify(event: E, type: ObservableActionType = ObservableActionType.Log): void {
    this.invoke(type, event)
  }

  _update(value: T | null, event: E): void {
    this._previous = this._current
    this._current = value
    this.invoke(ObservableActionType.Update, event)
  }

  _error(event: E, ...value: [] | [T | null]): void {
    if (value.length === 1) {
      this._previous = this._current
      this._current = value[0]
    }
    this._lastError = this.format(event)
    this.invoke(ObservableActionType.Error, event, this._lastError)
  }

  private format(event: E): string {
    const format = this.messages?.[event.code as E['code']] as ((event: E) => string) | undefined
    const message = format?.(event) ?? event.code
    return event.detail === undefined ? message : `${message}\n${event.detail}`
  }

  private invoke(type: ObservableActionType, event: E, message = this.format(event)): void {
    this.subscribers.slice().forEach((subscriber) => subscriber(this, type, message, event))
  }
}
