import { vi } from 'vitest'
import type { Observable } from '../src/index.ts'

export interface Reply {
  status: number
  body?: unknown
  raw?: string
  headers?: Record<string, string>
}

export interface Call {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}

type Route = Reply | Reply[] | ((call: Call) => Reply)

export const mockServer = (baseUrl: string) => {
  const routes = new Map<string, Route>()
  const calls: Call[] = []

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input).slice(baseUrl.length)
    const method = init?.method ?? 'GET'
    const call: Call = {
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)

    const route = routes.get(`${method} ${path}`)
    const reply: Reply =
      route === undefined
        ? { status: 418, body: { message: `no route for ${method} ${path}` } }
        : typeof route === 'function'
          ? route(call)
          : Array.isArray(route)
            ? route.length > 1
              ? route.shift()!
              : route[0]!
            : route

    const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(reply.status === 204 ? null : text, {
      status: reply.status,
      headers: reply.headers,
    })
  })

  vi.stubGlobal('fetch', fetchMock)

  return {
    calls,
    on: (route: string, reply: Route) => routes.set(route, Array.isArray(reply) ? [...reply] : reply),
    count: (route: string) => calls.filter((c) => `${c.method} ${c.path}` === route).length,
  }
}

export const recordEvents = <T>(observable: Observable<T>): Array<[number, string]> => {
  const events: Array<[number, string]> = []
  observable.subscribe((_obs, type, message) => events.push([type, message.split('\n')[0]!]))
  return events
}

export const silenceConsole = () => ({
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
})
