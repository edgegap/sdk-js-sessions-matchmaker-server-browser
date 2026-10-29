import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ObservableActionType as T } from '../../src/index.ts'
import {
  type BackfillAttributes,
  type BackfillResponseDTO,
  type InjectedTicketDTO,
  ServerAgent,
} from '../../src/matchmaking/index.ts'
import { mockServer, recordEventObjects, recordEvents, silenceConsole } from '../helpers.ts'

const BASE = 'https://mm.example.com'
const MONITOR = { status: 'HEALTHY', message: 'ok', healthy_components: 6, unhealthy_components: 0 }

type Attributes = { beacons: Record<string, number> }

const ticket = (id: string): InjectedTicketDTO<Attributes> => ({
  id,
  created_at: '2026-10-29T12:00:00Z',
  player_ip: '1.2.3.4',
  group_id: `group-${id}`,
  team_id: 'team-1',
  attributes: { beacons: { Chicago: 20 } },
})

const backfill = (
  id: string,
  overrides: Partial<BackfillResponseDTO<Attributes>> = {},
): BackfillResponseDTO<Attributes> => ({
  id,
  profile: 'backfill-example',
  tickets: {},
  status: 'SEARCHING',
  ...overrides,
})

const ATTRIBUTES: BackfillAttributes = {
  assignment: {
    request_id: 'req-1',
    fqdn: 'req-1.pr.edgegap.net',
    public_ip: '1.2.3.4',
    ports: {},
    location: {
      city: 'Chicago',
      country: 'United States of America',
      continent: 'North America',
      administrative_division: 'Illinois',
      timezone: 'Central Time',
    },
  },
}

describe('ServerAgent', () => {
  let server: ReturnType<typeof mockServer>
  let console: ReturnType<typeof silenceConsole>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    console = silenceConsole()
    server = mockServer(BASE)
    server.on('GET /monitor', { status: 200, body: MONITOR })
    let next = 0
    server.on('POST /backfills', () => ({ status: 201, body: backfill(`b${++next}`) }))
    server.on('GET /backfills/b1', { status: 200, body: backfill('b1') })
    server.on('GET /backfills/b2', { status: 200, body: backfill('b2') })
    server.on('DELETE /backfills/b1', { status: 204 })
    server.on('DELETE /backfills/b2', { status: 204 })
  })

  const start = (
    tickets: Record<string, InjectedTicketDTO<Attributes>> = {},
    options: Partial<ConstructorParameters<typeof ServerAgent>[0]> = {},
  ) => {
    const agent = new ServerAgent<Attributes>({
      baseUrl: BASE,
      authToken: 'server-token',
      profile: 'backfill-example',
      attributes: ATTRIBUTES,
      targetTeamSize: 2,
      ...options,
    })
    const events = recordEvents(agent.backfills)
    agent.initialize(tickets, vi.fn(), vi.fn())
    return { agent, events }
  }

  it('throws without an auth token', () => {
    const agent = new ServerAgent({ baseUrl: BASE, authToken: '', profile: 'p', attributes: ATTRIBUTES })
    expect(() => agent.initialize({}, vi.fn(), vi.fn())).toThrow('AuthToken not declared.')
  })

  it('starts with injected tickets as assignments, without team_id', () => {
    const { agent } = start({ t1: ticket('t1') })

    expect(agent.assignments).toEqual({
      t1: {
        id: 't1',
        created_at: '2026-10-29T12:00:00Z',
        player_ip: '1.2.3.4',
        group_id: 'group-t1',
        attributes: { beacons: { Chicago: 20 } },
      },
    })
  })

  it('creates backfills up to the target team size with current assignments', async () => {
    const { agent, events } = start({ t1: ticket('t1') })

    agent.addBackfills()
    await vi.advanceTimersByTimeAsync(0)

    expect(server.count('POST /backfills')).toBe(1)
    expect(server.calls.find((c) => c.method === 'POST')?.body).toEqual({
      profile: 'backfill-example',
      attributes: ATTRIBUTES,
      tickets: { t1: agent.assignments['t1'] },
    })
    expect(events).toEqual([[T.Update, 'created [b1]']])
    expect(Object.keys(agent.backfills.current!)).toEqual(['b1'])
  })

  it('does nothing with the default target team size', async () => {
    const { agent } = start({}, { targetTeamSize: undefined })

    agent.addBackfills()
    await vi.advanceTimersByTimeAsync(0)

    expect(server.count('POST /backfills')).toBe(0)
  })

  it('polls backfills and turns an assigned ticket into an assignment', async () => {
    server.on('GET /backfills/b1', [
      { status: 200, body: backfill('b1') },
      { status: 200, body: backfill('b1', { status: 'ASSIGNED', assigned_ticket: ticket('t2') }) },
    ])
    const { agent, events } = start({ t1: ticket('t1') })
    agent.addBackfills()

    await vi.advanceTimersByTimeAsync(1050 * 2)

    expect(events).toEqual([
      [T.Update, 'created [b1]'],
      [T.Update, 'assigned [b1]'],
      [T.Update, 'removed [b1]'],
    ])
    expect(Object.keys(agent.assignments)).toEqual(['t1', 't2'])
    expect(agent.backfills.current).toEqual({})
  })

  it('passes backfill and ticket IDs as event fields', async () => {
    server.on('GET /backfills/b1', {
      status: 200,
      body: backfill('b1', { status: 'ASSIGNED', assigned_ticket: ticket('t2') }),
    })
    const { agent } = start({ t1: ticket('t1') })
    const events = recordEventObjects(agent.backfills)
    agent.addBackfills()

    await vi.advanceTimersByTimeAsync(1050)

    expect(events).toEqual([
      { code: 'created', backfillId: 'b1' },
      { code: 'assigned', backfillId: 'b1', ticketId: 't2' },
      { code: 'removed', backfillId: 'b1' },
    ])
  })

  it('emits the assigned backfill as a new state', async () => {
    server.on('GET /backfills/b1', {
      status: 200,
      body: backfill('b1', { status: 'ASSIGNED', assigned_ticket: ticket('t2') }),
    })
    const { agent } = start({ t1: ticket('t1') })
    const snapshots: Array<[unknown, unknown]> = []
    agent.backfills.subscribe((obs, _type, message) => {
      if (message.startsWith('assigned')) snapshots.push([obs.previous, obs.current])
    })
    agent.addBackfills()

    await vi.advanceTimersByTimeAsync(1050)

    expect(snapshots).toHaveLength(1)
    const [previous, current] = snapshots[0] as [Record<string, { status: string }>, Record<string, { status: string }>]
    expect(previous).not.toBe(current)
    expect(previous['b1']?.status).toBe('SEARCHING')
    expect(current['b1']?.status).toBe('ASSIGNED')
  })

  it('stops polling with zero backfills and resumes with a new one', async () => {
    server.on('GET /backfills/b1', {
      status: 200,
      body: backfill('b1', { status: 'ASSIGNED', assigned_ticket: ticket('t2') }),
    })
    const { agent, events } = start({ t1: ticket('t1') }, { logPollingUpdates: true })
    agent.addBackfills()

    await vi.advanceTimersByTimeAsync(1050 * 5)

    expect(server.count('GET /backfills/b1')).toBe(1)
    expect(events.filter(([, m]) => m.startsWith('polling ['))).toHaveLength(1)
    expect(events.at(-1)).toEqual([T.Log, 'polling stopped'])

    agent.abandonPlayer('t2')
    await vi.advanceTimersByTimeAsync(1050)

    expect(server.count('GET /backfills/b2')).toBe(1)
  })

  describe('players', () => {
    it('abandons players that never connect within the grace period', async () => {
      const { agent } = start({ t1: ticket('t1') }, { targetTeamSize: 1 })

      await vi.advanceTimersByTimeAsync(60_000)

      expect(agent.assignments).toEqual({})
      expect(console.log).toHaveBeenCalledWith(
        'ℹ️ Edgegap MM | Backfill - ticket abandoned (connection grace period expired) [t1]',
      )
      expect(server.count('POST /backfills')).toBe(1)
    })

    it('keeps connected players and never sends connection times', async () => {
      const { agent } = start({ t1: ticket('t1') })

      const connected = agent.playerConnected('t1')
      const connectedAt = agent.connectedAt.get('t1')
      agent.playerConnected('t1')
      await vi.advanceTimersByTimeAsync(60_000)
      agent.addBackfills()
      await vi.advanceTimersByTimeAsync(0)

      expect(connected).toBe(agent.assignments['t1'])
      expect(connectedAt).toBeInstanceOf(Date)
      expect(agent.connectedAt.get('t1')).toBe(connectedAt)
      expect(Object.keys(agent.assignments)).toEqual(['t1'])
      expect(JSON.stringify(server.calls.find((c) => c.method === 'POST')?.body)).not.toMatch(/connect/i)
    })

    it('returns null for unknown players and warns when abandoning them', () => {
      const { agent } = start()

      expect(agent.playerConnected('nope')).toBeNull()
      expect(agent.abandonPlayer('nope')).toBe(false)
      expect(console.warn).toHaveBeenCalledWith('⚠️ Edgegap MM | Backfill - ticket abandon failed [nope]')
    })

    it('counts in-flight creations, so quick abandons fill exactly the open seats', async () => {
      const { agent } = start({ t1: ticket('t1'), t2: ticket('t2') }, { targetTeamSize: 2 })

      agent.abandonPlayer('t1')
      agent.abandonPlayer('t2')
      await vi.advanceTimersByTimeAsync(0)

      expect(server.count('POST /backfills')).toBe(2)
    })

    it('frees the in-flight slot when a creation fails', async () => {
      server.on('POST /backfills', [{ status: 400, body: {} }, { status: 201, body: backfill('b1') }])
      const { agent } = start({}, { targetTeamSize: 1 })

      agent.addBackfills()
      await vi.advanceTimersByTimeAsync(0)
      agent.addBackfills()
      await vi.advanceTimersByTimeAsync(0)

      expect(server.count('POST /backfills')).toBe(2)
      expect(Object.keys(agent.backfills.current!)).toEqual(['b1'])
    })
  })

  describe('polling errors', () => {
    it('replaces a backfill that is not found', async () => {
      server.on('GET /backfills/b1', { status: 404, body: { message: 'missing' } })
      const { agent, events } = start({}, { targetTeamSize: 1 })
      agent.addBackfills()

      await vi.advanceTimersByTimeAsync(1050)

      expect(events).toEqual([
        [T.Update, 'created [b1]'],
        [T.Warn, 'polling failed (not found) [b1]'],
        [T.Update, 'removed [b1]'],
        [T.Update, 'created [b2]'],
      ])
    })

    it('abandons and replaces a backfill on a client error', async () => {
      server.on('GET /backfills/b1', { status: 400, body: { message: 'bad' } })
      const { agent, events } = start({}, { targetTeamSize: 1 })
      agent.addBackfills()

      const objects = recordEventObjects(agent.backfills)
      await vi.advanceTimersByTimeAsync(1050)

      expect(objects).toContainEqual({
        code: 'polling_failed',
        backfillId: 'b1',
        reason: 'error',
        detail: expect.stringContaining('400'),
      })
      expect(events).toEqual([
        [T.Update, 'created [b1]'],
        [T.Error, 'polling failed [b1]'],
        [T.Log, 'abandoned [b1]'],
        [T.Update, 'removed [b1]'],
        [T.Update, 'created [b2]'],
      ])
    })

    it('reports capacity when a replacement no longer fits', async () => {
      server.on('GET /backfills/b1', { status: 404, body: { message: 'missing' } })
      const { agent, events } = start({}, { targetTeamSize: 1 })
      agent.addBackfills()
      await vi.advanceTimersByTimeAsync(0)
      agent.targetTeamSize = 0

      await vi.advanceTimersByTimeAsync(1050)

      expect(events.at(-1)).toEqual([T.Error, 'maximum capacity currently reached'])
    })

    it('gives up after the maximum with the failing backfill IDs, and abandons all', async () => {
      server.on('GET /backfills/b1', { status: 503, body: { message: 'down' } })
      const { agent, events } = start({}, { targetTeamSize: 2, maxConsecutivePollingErrors: 0 })
      agent.addBackfills()

      await vi.advanceTimersByTimeAsync(1050 + 1050 * 3 + 1050)

      expect(events.slice(2)).toEqual([
        [T.Error, 'polling failed (reached maximum retries) [b1]'],
        [T.Log, 'abandoned [b1]'],
        [T.Update, 'removed [b1]'],
        [T.Log, 'abandoned [b2]'],
        [T.Update, 'removed [b2]'],
      ])
    })
  })

  describe('abandoning backfills', () => {
    it('abandons all backfills, stops polling, and completes', async () => {
      const { agent, events } = start({}, { targetTeamSize: 2 })
      agent.addBackfills()
      await vi.advanceTimersByTimeAsync(0)
      const onCompleted = vi.fn()

      agent.abandonAllBackfills(onCompleted)
      await vi.advanceTimersByTimeAsync(1050)

      expect(onCompleted).toHaveBeenCalledOnce()
      expect(agent.backfills.current).toEqual({})
      expect(events.slice(2)).toEqual([
        [T.Log, 'abandoned [b1]'],
        [T.Update, 'removed [b1]'],
        [T.Log, 'abandoned [b2]'],
        [T.Update, 'removed [b2]'],
        [T.Log, 'polling stopped'],
      ])
    })

    it('completes immediately with no backfills', async () => {
      const { agent } = start()
      const onCompleted = vi.fn()

      agent.abandonAllBackfills(onCompleted)
      await vi.advanceTimersByTimeAsync(0)

      expect(onCompleted).toHaveBeenCalledOnce()
    })

    it('warns for unknown backfills without a request', () => {
      const { agent, events } = start()

      agent.abandonBackfill('nope')

      expect(events).toEqual([[T.Warn, 'abandon failed (not found) [nope]']])
      expect(server.count('DELETE /backfills/nope')).toBe(0)
    })

    it('removes the backfill locally when the delete fails', async () => {
      server.on('DELETE /backfills/b1', { status: 404, body: { message: 'missing' } })
      const { agent, events } = start({}, { targetTeamSize: 1 })
      agent.addBackfills()
      await vi.advanceTimersByTimeAsync(0)

      agent.abandonBackfill('b1')
      await vi.advanceTimersByTimeAsync(0)

      expect(events.slice(-2)).toEqual([
        [T.Warn, 'abandon failed (not found) [b1]'],
        [T.Update, 'removed [b1]'],
      ])
    })
  })

  it('leaves no timers when disposed from the creation handler', async () => {
    const { agent } = start({}, { targetTeamSize: 1 })
    agent.backfills.subscribe((_obs, _type, _message, event) => {
      if (event.code === 'created') agent.dispose()
    })
    agent.addBackfills()

    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose stops polling and grace timers', async () => {
    const { agent, events } = start({ t1: ticket('t1') })
    agent.addBackfills()
    await vi.advanceTimersByTimeAsync(0)

    agent.dispose()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(server.count('GET /backfills/b1')).toBe(0)
    expect(Object.keys(agent.assignments)).toEqual(['t1'])
    expect(events).toEqual([[T.Update, 'created [b1]']])
  })
})
