import { Logger } from './logger.ts'
import { delay, jitter } from './timers.ts'

export interface HttpResponse {
  status: number
  headers: Headers | null
}

export type HttpSuccess = (body: string, response: HttpResponse) => void
export type HttpError = (error: string, response: HttpResponse) => void

export class HttpRequestError extends Error {
  readonly response: HttpResponse

  constructor(message: string, response: HttpResponse) {
    super(message)
    this.name = 'HttpRequestError'
    this.response = response
  }
}

export const parseResponse =
  <T>(
    onSuccess: (value: T, response: HttpResponse) => void,
    onError: HttpError,
    errorPrefix: string,
  ): HttpSuccess =>
  (body, response) => {
    let value: T
    try {
      value = JSON.parse(body) as T
    } catch (error) {
      const message = `${errorPrefix}${(error as Error).message}`
      Logger.error(message)
      return onError(message, response)
    }
    onSuccess(value, response)
  }

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

const parseRetryAfter = (value: string): number => {
  if (/^\s*\d+(\.\d+)?\s*$/.test(value)) return Number(value)
  const date = Date.parse(value)
  return Number.isNaN(date) ? 0 : Math.max(0, (date - Date.now()) / 1000)
}

const isRetryable = (status: number): boolean => status === 0 || status === 429 || status >= 500

export class RetryParameters {
  static readonly defaultBackoffSeconds: () => number = () => jitter(1)

  maxAttempts: number
  remainingAttempts: number
  backoffSeconds: () => number

  constructor(attempts = 3, backoffSeconds?: () => number) {
    this.maxAttempts = attempts
    this.remainingAttempts = attempts
    this.backoffSeconds = backoffSeconds ?? RetryParameters.defaultBackoffSeconds
  }
}

export class SafeHttpRequest {
  readonly timeoutSeconds: number
  private readonly lifetime = new AbortController()

  constructor(timeoutSeconds = 0) {
    this.timeoutSeconds = timeoutSeconds > 0 ? timeoutSeconds : 3
  }

  get(
    url: string,
    authToken: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
    signal?: AbortSignal,
  ): void {
    this.send('GET', url, authToken, undefined, onSuccess, onError, retryParameters, this.scope(signal))
  }

  post(
    url: string,
    authToken: string,
    body: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
    signal?: AbortSignal,
  ): void {
    this.send('POST', url, authToken, body, onSuccess, onError, retryParameters, this.scope(signal))
  }

  patch(
    url: string,
    authToken: string,
    body: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
    signal?: AbortSignal,
  ): void {
    this.send('PATCH', url, authToken, body, onSuccess, onError, retryParameters, this.scope(signal))
  }

  delete(
    url: string,
    authToken: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
    signal?: AbortSignal,
  ): void {
    this.send('DELETE', url, authToken, undefined, onSuccess, onError, retryParameters, this.scope(signal))
  }

  dispose(): void {
    this.lifetime.abort()
  }

  private scope(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
  }

  private send(
    method: Method,
    url: string,
    authToken: string,
    body: string | undefined,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retry: RetryParameters = new RetryParameters(),
    scope: AbortSignal,
    delaySeconds?: number,
  ): void {
    if (scope.aborted) return

    const onRetryableError: HttpError = (error, response) => {
      if (retry.remainingAttempts <= 0 || !isRetryable(response.status)) return onError(error, response)

      Logger.warn(
        `Retrying (${retry.remainingAttempts}/${retry.maxAttempts}) ${method} ${url}.\n${error}`,
      )
      retry.remainingAttempts--
      const retryAfter = response.headers?.get('Retry-After') ?? null
      this.send(
        method,
        url,
        authToken,
        body,
        onSuccess,
        onError,
        retry,
        scope,
        retryAfter === null ? retry.backoffSeconds() : jitter(parseRetryAfter(retryAfter), 1, 1.2),
      )
    }

    const request = () => this.fetch(method, url, authToken, body, scope, onSuccess, onRetryableError)

    if (delaySeconds === undefined) return request()
    delay(delaySeconds, scope, request)
  }

  private fetch(
    method: Method,
    url: string,
    authToken: string,
    body: string | undefined,
    scope: AbortSignal,
    onSuccess: HttpSuccess,
    onError: HttpError,
  ): void {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.timeoutSeconds * 1000)

    fetch(url, {
      method,
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.any([scope, timeout.signal]),
    })
      .then(async (response) => ({ response, text: await response.text() }))
      .finally(() => clearTimeout(timer))
      .then(
        ({ response, text }) => {
          if (scope.aborted) return
          const result = { status: response.status, headers: response.headers }
          if (response.ok) return onSuccess(text, result)
          const reason = `HTTP/1.1 ${response.status} ${response.statusText}`.trim()
          onError(`HTTP ${response.status}: ${reason}\n${text}`, result)
        },
        (error: unknown) => {
          if (scope.aborted) return
          const reason = timeout.signal.aborted ? 'Request timeout' : (error as Error).message
          onError(`HTTP 0: ${reason}\n`, { status: 0, headers: null })
        },
      )
      .catch((error: unknown) => Logger.error(error instanceof Error ? error.stack : error))
  }
}
