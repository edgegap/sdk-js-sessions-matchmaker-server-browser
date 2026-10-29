import { Logger } from './logger.ts'
import { jitter } from './timers.ts'

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

const parseSeconds = (value: string): number =>
  /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(value) ? Number(value) : 0

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
  private controllers = new Set<AbortController>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(timeoutSeconds = 0) {
    this.timeoutSeconds = timeoutSeconds > 0 ? timeoutSeconds : 3
  }

  get(
    url: string,
    authToken: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
  ): void {
    this.send('GET', url, authToken, undefined, onSuccess, onError, retryParameters)
  }

  post(
    url: string,
    authToken: string,
    body: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
  ): void {
    this.send('POST', url, authToken, body, onSuccess, onError, retryParameters)
  }

  patch(
    url: string,
    authToken: string,
    body: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
  ): void {
    this.send('PATCH', url, authToken, body, onSuccess, onError, retryParameters)
  }

  delete(
    url: string,
    authToken: string,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retryParameters?: RetryParameters,
  ): void {
    this.send('DELETE', url, authToken, undefined, onSuccess, onError, retryParameters)
  }

  dispose(): void {
    this.disposed = true
    this.timers.forEach(clearTimeout)
    this.timers.clear()
    this.controllers.forEach((controller) => controller.abort())
    this.controllers.clear()
  }

  private send(
    method: Method,
    url: string,
    authToken: string,
    body: string | undefined,
    onSuccess: HttpSuccess,
    onError: HttpError,
    retry: RetryParameters = new RetryParameters(),
    delaySeconds?: number,
  ): void {
    if (this.disposed) return

    const onRetryableError: HttpError = (error, response) => {
      if (response.headers === null) return onError(error, response)

      const retryAfter = response.headers.get('Retry-After')
      if (
        retry.remainingAttempts <= 0 ||
        (retryAfter === null && response.status !== 429 && response.status < 500)
      ) {
        return onError(error, response)
      }

      Logger.warn(
        `Retrying (${retry.remainingAttempts}/${retry.maxAttempts}) ${method} ${url}.\n${error}`,
      )
      retry.remainingAttempts--
      this.send(
        method,
        url,
        authToken,
        body,
        onSuccess,
        onError,
        retry,
        retryAfter === null ? undefined : jitter(parseSeconds(retryAfter)),
      )
    }

    const request = () =>
      this.fetch(method, url, authToken, body, onSuccess, onRetryableError)

    if (retry.remainingAttempts >= retry.maxAttempts) return request()

    const timer = setTimeout(() => {
      this.timers.delete(timer)
      request()
    }, (delaySeconds ?? retry.backoffSeconds()) * 1000)
    this.timers.add(timer)
  }

  private fetch(
    method: Method,
    url: string,
    authToken: string,
    body: string | undefined,
    onSuccess: HttpSuccess,
    onError: HttpError,
  ): void {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutSeconds * 1000)
    this.controllers.add(controller)

    fetch(url, {
      method,
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
      .then(async (response) => ({ response, text: await response.text() }))
      .finally(() => {
        clearTimeout(timer)
        this.controllers.delete(controller)
      })
      .then(
        ({ response, text }) => {
          if (this.disposed) return
          const result = { status: response.status, headers: response.headers }
          if (response.ok) return onSuccess(text, result)
          const reason = `HTTP/1.1 ${response.status} ${response.statusText}`.trim()
          onError(`HTTP ${response.status}: ${reason}\n${text}`, result)
        },
        (error: unknown) => {
          if (this.disposed) return
          const reason = timedOut ? 'Request timeout' : (error as Error).message
          onError(`HTTP 0: ${reason}\n`, { status: 0, headers: null })
        },
      )
      .catch((error: unknown) => Logger.error(error instanceof Error ? error.stack : error))
  }
}
