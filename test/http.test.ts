import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetryParameters, SafeHttpRequest } from '../src/index.ts'

const URL = 'https://mm.example.com/monitor'

const respond = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, statusText: status === 200 ? 'OK' : 'Error', headers })

const hangUntilAborted: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) =>
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
  )

describe('SafeHttpRequest', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the auth token and JSON content type, and returns the body', async () => {
    fetchMock.mockResolvedValue(respond(200, '{"ok":true}'))
    const onSuccess = vi.fn()
    const onError = vi.fn()

    new SafeHttpRequest().post(URL, 'token', '{"a":1}', onSuccess, onError)
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(URL)
    expect(init).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: { Authorization: 'token', 'Content-Type': 'application/json' },
    })
    expect(onSuccess).toHaveBeenCalledWith('{"ok":true}', expect.objectContaining({ status: 200 }))
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports client errors without retrying', async () => {
    fetchMock.mockResolvedValue(respond(404, 'not found'))
    const onError = vi.fn()

    new SafeHttpRequest().get(URL, 'token', vi.fn(), onError)
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      'HTTP 404: HTTP/1.1 404 Error\nnot found',
      expect.objectContaining({ status: 404 }),
    )
  })

  it.each([429, 500, 503])('retries %i three times with a 1s backoff, then reports', async (status) => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(status)))
    const onError = vi.fn()

    new SafeHttpRequest().delete(URL, 'token', vi.fn(), onError)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1049)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(onError).toHaveBeenCalledOnce()
    expect(warn.mock.calls.map(([message]: unknown[]) => String(message).split('\n')[0])).toEqual([
      `⚠️ Edgegap Retrying (3/3) DELETE ${URL}.`,
      `⚠️ Edgegap Retrying (2/3) DELETE ${URL}.`,
      `⚠️ Edgegap Retrying (1/3) DELETE ${URL}.`,
    ])
  })

  it('stops retrying once a retry succeeds', async () => {
    fetchMock.mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(200, 'ok'))
    const onSuccess = vi.fn()

    new SafeHttpRequest().get(URL, 'token', onSuccess, vi.fn())
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onSuccess).toHaveBeenCalledWith('ok', expect.objectContaining({ status: 200 }))
  })

  it('waits Retry-After seconds plus jitter', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, '', { 'Retry-After': '5' }))
      .mockResolvedValueOnce(respond(200))

    new SafeHttpRequest().get(URL, 'token', vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(5049)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('upstream: retries any status that carries Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(409, '', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(respond(200))

    new SafeHttpRequest().get(URL, 'token', vi.fn(), vi.fn())
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('upstream: parses an HTTP-date Retry-After as 0 seconds', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, '', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }))
      .mockResolvedValueOnce(respond(200))

    new SafeHttpRequest().get(URL, 'token', vi.fn(), vi.fn())
    await vi.advanceTimersByTimeAsync(50)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('upstream: reports network failures without retrying', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const onError = vi.fn()

    new SafeHttpRequest().get(URL, 'token', vi.fn(), onError)
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith('HTTP 0: fetch failed\n', { status: 0, headers: null })
  })

  it('times out after 3s by default, or the given timeout', async () => {
    fetchMock.mockImplementation(hangUntilAborted)
    const onDefault = vi.fn()
    const onCustom = vi.fn()

    new SafeHttpRequest().get(URL, 'token', vi.fn(), onDefault)
    new SafeHttpRequest(5).get(URL, 'token', vi.fn(), onCustom)
    await vi.advanceTimersByTimeAsync(3000)
    expect(onDefault).toHaveBeenCalledWith('HTTP 0: Request timeout\n', { status: 0, headers: null })
    expect(onCustom).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(onCustom).toHaveBeenCalledOnce()
  })

  it('uses a custom backoff for every retry', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(respond(500)))
    const onError = vi.fn()

    new SafeHttpRequest().get(URL, 'token', vi.fn(), onError, new RetryParameters(2, () => 10))
    await vi.advanceTimersByTimeAsync(9999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.runAllTimersAsync()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('waits for Retry-After once, then returns to the custom backoff', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(503, '', { 'Retry-After': '2' }))
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(200))

    new SafeHttpRequest().get(URL, 'token', vi.fn(), vi.fn(), new RetryParameters(3, () => 10))
    await vi.advanceTimersByTimeAsync(2050)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('upstream: delays the first request when remaining attempts are below the maximum', async () => {
    fetchMock.mockResolvedValue(respond(200))
    const retry = Object.assign(new RetryParameters(), { maxAttempts: 10 })

    new SafeHttpRequest().get(URL, 'token', vi.fn(), vi.fn(), retry)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1050)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('dispose aborts requests in flight and pending retries without callbacks', async () => {
    fetchMock.mockImplementationOnce(hangUntilAborted)
    fetchMock.mockResolvedValueOnce(respond(500))
    const http = new SafeHttpRequest()
    const callbacks = [vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const

    http.get(URL, 'token', callbacks[0], callbacks[1])
    http.get(URL, 'token', callbacks[2], callbacks[3])
    await vi.advanceTimersByTimeAsync(0)
    http.dispose()
    http.get(URL, 'token', vi.fn(), vi.fn())
    await vi.runAllTimersAsync()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    callbacks.forEach((callback) => expect(callback).not.toHaveBeenCalled())
  })

  it('logs exceptions thrown by callbacks instead of rejecting', async () => {
    fetchMock.mockResolvedValue(respond(200))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()

    new SafeHttpRequest().get(
      URL,
      'token',
      () => {
        throw new Error('boom')
      },
      onError,
    )
    await vi.runAllTimersAsync()

    expect(onError).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
