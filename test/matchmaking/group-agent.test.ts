import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type BeaconDTO, HttpRequestError, ObservableActionType as T } from '../../src/index.ts'
import { GroupAgent, type GroupUpResponseDTO, MatchmakingError } from '../../src/matchmaking/index.ts'
import { mockServer, recordEventObjects, recordEvents, silenceConsole } from '../helpers.ts'

const BASE = 'https://mm.example.com'
const MONITOR = { status: 'HEALTHY', message: 'ok', healthy_components: 6, unhealthy_components: 0 }

const member = (overrides: Partial<GroupUpResponseDTO> = {}): GroupUpResponseDTO => ({
  member_id: 'm1',
  group_id: 'g1',
  is_ready: false,
  status: null,
  ticket_id: null,
  assignment: null,
  team_id: null,
  ...overrides,
})

const REQUEST = { profile: 'simple-example', attributes: { beacons: { Chicago: 20 } }, is_ready: false }

describe('GroupAgent', () => {
  let server: ReturnType<typeof mockServer>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    silenceConsole()
    server = mockServer(BASE)
    server.on('GET /monitor', { status: 200, body: MONITOR })
    server.on('POST /groups', { status: 201, body: member() })
    server.on('DELETE /groups/g1', { status: 204 })
    server.on('GET /groups/g1/members/m1', { status: 200, body: member() })
  })

  const start = (options: Partial<ConstructorParameters<typeof GroupAgent>[0]> = {}) => {
    const agent = new GroupAgent({ baseUrl: BASE, authToken: 'token', ...options })
    const monitor = recordEvents(agent.monitor)
    const group = recordEvents(agent.group)
    agent.initialize(vi.fn(), vi.fn())
    return { agent, monitor, group }
  }

  describe('initialize', () => {
    it.each([
      [{ authToken: ' ' }, 'AuthToken not declared.'],
      [{ baseUrl: '' }, 'BaseUrl not declared.'],
    ])('throws without required settings', (options, message) => {
      expect(() => new GroupAgent({ baseUrl: BASE, authToken: 'token', ...options }).initialize(vi.fn(), vi.fn())).toThrow(
        message,
      )
    })

    it('checks the monitor with the auth token', async () => {
      const { monitor } = start()
      await vi.advanceTimersByTimeAsync(0)

      expect(server.calls[0]).toMatchObject({ method: 'GET', path: '/monitor', headers: { Authorization: 'token' } })
      expect(monitor).toEqual([[T.Update, 'healthy']])
    })

    it('reports an unhealthy monitor and monitor failures', async () => {
      server.on('GET /monitor', { status: 200, body: { ...MONITOR, status: 'DEGRADED' } })
      const { agent, monitor } = start()
      await vi.advanceTimersByTimeAsync(0)
      server.on('GET /monitor', { status: 401, body: { message: 'unauthorized' } })
      agent.status()
      await vi.advanceTimersByTimeAsync(0)

      expect(monitor).toEqual([
        [T.Update, 'unhealthy'],
        [T.Error, 'get monitor failed (unexpected error)'],
      ])
      expect(agent.monitor.current).toBeNull()
    })
  })

  describe('group lifecycle', () => {
    it('creates the first group without abandon, and reports a conflict on the second', async () => {
      const { agent, group } = start()
      expect(agent.group.current).toBeNull()

      agent.createGroup(REQUEST)
      await vi.advanceTimersByTimeAsync(0)
      agent.createGroup(REQUEST)

      expect(group).toEqual([
        [T.Update, 'created'],
        [T.Error, 'conflict, abandon and restart'],
      ])
      expect(server.count('POST /groups')).toBe(1)
    })

    it('uses the configured request timeout', async () => {
      server.on('POST /groups', () => ({ status: 201, body: member() }))
      const fetchMock = vi.mocked(fetch)
      const respond = fetchMock.getMockImplementation()!
      fetchMock.mockImplementation((input, init) =>
        String(input).endsWith('/groups')
          ? new Promise((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
            )
          : respond(input, init),
      )
      const { agent } = start({ requestTimeoutSeconds: 5 })

      agent.createGroup(REQUEST)
      await vi.advanceTimersByTimeAsync(4999)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/groups'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1 + 1050)
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/groups'))).toHaveLength(2)
    })

    it('creates a group, polls status changes, and removes it after the host is assigned', async () => {
      const { agent, group } = start()
      server.on('GET /groups/g1/members/m1', [
        { status: 200, body: member() },
        { status: 200, body: member({ status: 'SEARCHING' }) },
        { status: 200, body: member({ status: 'SEARCHING' }) },
        { status: 200, body: member({ status: 'HOST_ASSIGNED', team_id: 't1' }) },
      ])

      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      expect(server.calls.find((c) => c.path === '/groups')?.body).toEqual({
        profile: 'simple-example',
        attributes: { beacons: { Chicago: 20 } },
        is_ready: false,
      })
      expect(agent.owner).toBe(true)

      await vi.advanceTimersByTimeAsync(1050 * 4)
      expect(group).toEqual([
        [T.Update, 'created'],
        [T.Update, 'group updated [SEARCHING]'],
        [T.Update, 'group updated [HOST_ASSIGNED]'],
      ])
      expect(agent.group.current?.team_id).toBe('t1')

      await vi.advanceTimersByTimeAsync(10_000)
      expect(server.count('GET /groups/g1/members/m1')).toBe(4)

      await vi.advanceTimersByTimeAsync(20_000)
      expect(group.at(-1)).toEqual([T.Update, 'removed'])
      expect(agent.group.current).toBeNull()
    })

    it('never sends player_ip', async () => {
      const { agent } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(server.calls.find((c) => c.path === '/groups')?.body).not.toHaveProperty('player_ip')
    })

    it('expires a cancelled group', async () => {
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'CANCELLED' }) })
      const { agent, group } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050 + 30_000)

      expect(group.slice(-2)).toEqual([
        [T.Update, 'group updated [CANCELLED]'],
        [T.Update, 'removed'],
      ])
    })

    it('logs polling when enabled', async () => {
      const { agent, group } = start({ logPollingUpdates: true, maxConsecutivePollingErrors: 5 })
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050)
      agent.stopMatchmaking()
      await vi.advanceTimersByTimeAsync(1050)

      expect(group).toContainEqual([T.Log, 'polling [1/5]'])
      expect(group).toContainEqual([T.Log, 'polling stopped'])
    })

    it('reports create failures, including unparseable responses', async () => {
      server.on('POST /groups', [
        { status: 400, body: { message: 'bad' } },
        { status: 201, raw: 'not json' },
      ])
      const { agent, group } = start()

      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      expect(group).toEqual([
        [T.Error, 'group create failed'],
        [T.Error, 'group create failed'],
      ])
      expect(agent.group.error).toMatch(/^group create failed\nCouldn't parse group, consider updating Matchmaking SDK\. /)
    })

    it('joins a group as a non-owner and leaves through the member endpoint', async () => {
      server.on('POST /groups/g1/members', { status: 201, body: member({ member_id: 'm2' }) })
      server.on('GET /groups/g1/members/m2', { status: 200, body: member({ member_id: 'm2' }) })
      server.on('DELETE /groups/g1/members/m2', { status: 204 })
      const { agent, group } = start()

      agent.joinGroup(REQUEST, 'g1', true)
      await vi.advanceTimersByTimeAsync(0)
      expect(agent.owner).toBe(false)
      agent.stopMatchmaking()
      await vi.advanceTimersByTimeAsync(0)

      expect(group).toEqual([
        [T.Update, 'joined'],
        [T.Update, 'abandoned'],
      ])
      expect(server.count('DELETE /groups/g1/members/m2')).toBe(1)
    })

    it('reports missing groups and other join failures', async () => {
      server.on('POST /groups/nope/members', { status: 404, body: { message: 'missing' } })
      server.on('POST /groups/bad/members', { status: 400, body: { message: 'bad' } })
      const { agent, group } = start()

      agent.joinGroup(REQUEST, 'nope', true)
      await vi.advanceTimersByTimeAsync(0)
      agent.joinGroup(REQUEST, 'bad', true)
      await vi.advanceTimersByTimeAsync(0)

      expect(group).toEqual([
        [T.Error, 'group not found'],
        [T.Error, 'group join failed'],
      ])
    })

    it('resumes an existing group and polls it', async () => {
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'SEARCHING' }) })
      const { agent, group } = start()

      agent.resumeMatchmaking(member(), true)
      await vi.advanceTimersByTimeAsync(0)

      expect(group).toEqual([
        [T.Update, 'resumed'],
        [T.Update, 'group updated [SEARCHING]'],
      ])
    })
  })

  describe('setReady', () => {
    it('reports a missing group locally', () => {
      const { agent, group } = start()
      agent.group._update(null, { code: 'removed' })

      agent.setReady(true)

      expect(group.at(-1)).toEqual([T.Error, 'group not found'])
    })

    it.each([
      [{ status: 200, body: member({ is_ready: true }) }, [T.Update, 'member updated [True]']],
      [{ status: 409, body: { message: 'locked' } }, [T.Warn, 'member update failed']],
      [{ status: 404, body: { message: 'missing' } }, [T.Error, 'group not found']],
      [{ status: 400, body: { message: 'bad' } }, [T.Error, 'group update failed']],
    ])('emits the matching event for %j', async (reply, event) => {
      server.on('PATCH /groups/g1/members/m1', reply)
      const { agent, group } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      agent.setReady(true)
      await vi.advanceTimersByTimeAsync(0)

      expect(server.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ is_ready: true })
      expect(group.at(-1)).toEqual(event)
    })
  })

  describe('stopMatchmaking', () => {
    const created = async () => {
      const started = start()
      started.agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      return started
    }

    it('abandons an owned group and completes', async () => {
      const { agent, group } = await created()
      const onCompleted = vi.fn()

      agent.stopMatchmaking(onCompleted)
      await vi.advanceTimersByTimeAsync(0)

      expect(group.at(-1)).toEqual([T.Update, 'abandoned'])
      expect(onCompleted).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5000)
      expect(server.count('GET /groups/g1/members/m1')).toBe(0)
    })

    it('resumes polling on 409 and reports the skipped follow-up action', async () => {
      server.on('DELETE /groups/g1', { status: 409, body: { message: 'matched' } })
      const { agent, group } = await created()
      const onCompleted = vi.fn()

      agent.stopMatchmaking(onCompleted)
      await vi.advanceTimersByTimeAsync(0)

      expect(group.slice(-2)).toEqual([
        [T.Warn, 'abandon failed (match found)'],
        [T.Warn, 'restart skipped (match found)'],
      ])
      expect(server.count('GET /groups/g1/members/m1')).toBe(1)
      expect(onCompleted).not.toHaveBeenCalled()
    })

    it('passes the abandon failure reason as an event field', async () => {
      server.on('DELETE /groups/g1', { status: 409, body: { message: 'matched' } })
      const { agent } = await created()
      const events = recordEventObjects(agent.group)

      agent.stopMatchmaking(() => {})
      await vi.advanceTimersByTimeAsync(0)

      expect(events).toEqual([{ code: 'abandon_failed', reason: 'match_found' }, { code: 'restart_skipped' }])
    })

    it('resumes polling on 409 without a skip warning when there is no follow-up', async () => {
      server.on('DELETE /groups/g1', { status: 409, body: { message: 'matched' } })
      const { agent, group } = await created()

      agent.stopMatchmaking()
      await vi.advanceTimersByTimeAsync(0)

      expect(group.at(-1)).toEqual([T.Warn, 'abandon failed (match found)'])
    })

    it('clears the group on 404 and completes', async () => {
      server.on('DELETE /groups/g1', { status: 404, body: { message: 'missing' } })
      const { agent, group } = await created()
      const onCompleted = vi.fn()

      agent.stopMatchmaking(onCompleted)
      await vi.advanceTimersByTimeAsync(0)

      expect(group.at(-1)).toEqual([T.Update, 'abandon failed (not found)'])
      expect(agent.group.current).toBeNull()
      expect(onCompleted).toHaveBeenCalledOnce()
    })

    it('reports other failures after HTTP retries, clears the group, and completes', async () => {
      server.on('DELETE /groups/g1', { status: 500, body: { message: 'down' } })
      const { agent, group } = await created()
      const onCompleted = vi.fn()

      agent.stopMatchmaking(onCompleted)
      await vi.advanceTimersByTimeAsync(1050 * 3)

      expect(server.count('DELETE /groups/g1')).toBe(4)
      expect(group.at(-1)).toEqual([T.Error, 'abandon failed'])
      expect(agent.group.current).toBeNull()
      expect(onCompleted).toHaveBeenCalledOnce()
    })
  })

  describe('polling errors', () => {
    it('stops and abandons on a client error', async () => {
      server.on('GET /groups/g1/members/m1', { status: 403, body: { message: 'forbidden' } })
      const { agent, group } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050)

      expect(group.slice(-2)).toEqual([
        [T.Error, 'polling failed'],
        [T.Update, 'abandoned'],
      ])
    })

    it('keeps polling through server errors until the maximum', async () => {
      server.on('GET /groups/g1/members/m1', { status: 503, body: { message: 'down' } })
      const { agent, group } = start({ maxConsecutivePollingErrors: 1 })
      agent.createGroup(REQUEST, true)

      await vi.advanceTimersByTimeAsync(1050 + 1050 * 3)
      expect(group).toEqual([[T.Update, 'created']])

      await vi.advanceTimersByTimeAsync(1050 + 1050 * 3)
      expect(group.slice(-2)).toEqual([
        [T.Error, 'polling failed, reached maximum retries'],
        [T.Update, 'abandoned'],
      ])
    })
  })

  describe('session timing', () => {
    it('runs a single polling loop for a new group within the backoff window', async () => {
      const { agent } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(1050 * 3)

      expect(server.count('GET /groups/g1/members/m1')).toBe(3)
    })

    it('ignores a poll response that arrives after the group was replaced', async () => {
      let release: () => void = () => {}
      let polls = 0
      server.on('GET /groups/g1/members/m1', () => ({
        status: 200,
        body: member({ status: ++polls === 1 ? 'SEARCHING' : null }),
      }))
      const fetchMock = vi.mocked(fetch)
      const respond = fetchMock.getMockImplementation()!
      fetchMock.mockImplementationOnce(respond).mockImplementationOnce(respond)
      fetchMock.mockImplementationOnce(
        (input, init) => new Promise((resolve) => (release = () => resolve(respond(input, init)))),
      )
      const { agent, group } = start()
      await vi.advanceTimersByTimeAsync(0)
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050)

      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      release()
      await vi.advanceTimersByTimeAsync(1050 * 3)

      expect(group).toEqual([
        [T.Update, 'created'],
        [T.Update, 'abandoned'],
        [T.Update, 'created'],
      ])
      expect(server.count('GET /groups/g1/members/m1')).toBe(4)
    })

    it('does not let a stale expiry remove a newer group', async () => {
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'HOST_ASSIGNED' }) })
      const { agent, group } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050)

      server.on('POST /groups', { status: 201, body: member({ group_id: 'g2', member_id: 'm9' }) })
      server.on('GET /groups/g2/members/m9', { status: 200, body: member({ group_id: 'g2', member_id: 'm9' }) })
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(group).not.toContainEqual([T.Update, 'removed'])
      expect(agent.group.current?.group_id).toBe('g2')
    })
  })

  describe('beacons', () => {
    const beacon = (city: string, ip: string) => ({ public_ip: ip, location: { city } }) as BeaconDTO

    it('resolves the beacon list', async () => {
      const body = { count: 1, beacons: [beacon('Chicago', '1.1.1.1')] }
      server.on('GET /locations/beacons', { status: 200, body })
      const { agent } = start()

      await expect(agent.beacons()).resolves.toEqual(body)
    })

    it('rejects with the response and reports on the monitor', async () => {
      server.on('GET /locations/beacons', { status: 403, body: { message: 'forbidden' } })
      const { agent, monitor } = start()
      await vi.advanceTimersByTimeAsync(0)

      const error = await agent.beacons().catch((e: unknown) => e)

      expect(error).toBeInstanceOf(HttpRequestError)
      expect((error as HttpRequestError).response.status).toBe(403)
      expect(monitor.at(-1)).toEqual([T.Error, 'get beacons failed'])
    })

    it('measures each city once with the injected ping', async () => {
      const ping = { measure: vi.fn(async (b: BeaconDTO) => (b.public_ip === '1.1.1.1' ? 12.5 : 40)) }
      const { agent } = start({ ping })

      const latencies = await agent.measureBeaconsRoundTripTime(
        [beacon('Chicago', '1.1.1.1'), beacon('Chicago', '2.2.2.2'), beacon('Tokyo', '3.3.3.3')],
        5,
      )

      expect(latencies).toEqual({ Chicago: 12.5, Tokyo: 40 })
      expect(ping.measure).toHaveBeenCalledTimes(2)
      expect(ping.measure).toHaveBeenCalledWith(expect.objectContaining({ public_ip: '1.1.1.1' }), 5)
    })

    it('reports 0 for every city by default', async () => {
      const { agent } = start()

      await expect(agent.measureBeaconsRoundTripTime([beacon('Chicago', '1.1.1.1')])).resolves.toEqual({
        Chicago: 0,
      })
    })
  })

  describe('jitter', () => {
    it.each([
      [0, 800],
      [0.999, 1199],
    ])('polls after 0.8 to 1.2 times the backoff (random %d)', async (random, wait) => {
      vi.mocked(Math.random).mockReturnValue(random)
      const { agent } = start({ pollingBackoffSeconds: 1 })
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(server.count('GET /groups/g1/members/m1')).toBe(0)
      await vi.advanceTimersByTimeAsync(2)
      expect(server.count('GET /groups/g1/members/m1')).toBe(1)
    })
  })

  describe('nextAssignment', () => {
    const ASSIGNMENT = { fqdn: 'game.pr.edgegap.net', public_ip: '1.2.3.4', ports: {} } as never

    it('resolves with the assignment once the host is assigned', async () => {
      server.on('GET /groups/g1/members/m1', [
        { status: 200, body: member({ status: 'SEARCHING' }) },
        { status: 200, body: member({ status: 'HOST_ASSIGNED', assignment: ASSIGNMENT }) },
      ])
      const { agent } = start()
      agent.createGroup(REQUEST, true)

      const assignment = agent.nextAssignment()
      await vi.advanceTimersByTimeAsync(1050 * 2)

      await expect(assignment).resolves.toEqual(ASSIGNMENT)
    })

    it('keeps waiting while a previous group is abandoned for the new one', async () => {
      const { agent } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'HOST_ASSIGNED', assignment: ASSIGNMENT }) })

      agent.createGroup(REQUEST, true)
      const assignment = agent.nextAssignment()
      agent.createGroup(REQUEST)
      await vi.advanceTimersByTimeAsync(1050)

      await expect(assignment).resolves.toEqual(ASSIGNMENT)
    })

    it('rejects when the group is cancelled', async () => {
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'CANCELLED' }) })
      const { agent } = start()
      agent.createGroup(REQUEST, true)

      const assignment = agent.nextAssignment().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1050)

      const error = (await assignment) as MatchmakingError
      expect(error).toBeInstanceOf(MatchmakingError)
      expect(error.message).toBe('group updated [CANCELLED]')
      expect(error.event).toEqual({ code: 'updated', status: 'CANCELLED' })
    })

    it('rejects when matchmaking fails', async () => {
      server.on('GET /groups/g1/members/m1', { status: 403, body: { message: 'forbidden' } })
      const { agent } = start()
      agent.createGroup(REQUEST, true)

      const assignment = agent.nextAssignment().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1050)

      expect(await assignment).toMatchObject({ event: { code: 'polling_failed', reason: 'error' } })
    })

    it('rejects when matchmaking is stopped or the agent disposed', async () => {
      const { agent } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      const stopped = agent.nextAssignment().catch((error: unknown) => error)
      agent.stopMatchmaking()
      agent.createGroup(REQUEST, true)
      const disposed = agent.nextAssignment().catch((error: unknown) => error)
      agent.dispose()

      expect(await stopped).toMatchObject({ message: 'Matchmaking stopped.' })
      expect(await disposed).toMatchObject({ message: 'Matchmaking stopped.' })
    })

    it('rejects right away without matchmaking in progress', async () => {
      const { agent } = start()

      await expect(agent.nextAssignment()).rejects.toThrow('No matchmaking in progress.')
    })

    it('rejects once the group is abandoned and matchmaking ends', async () => {
      const { agent } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      const assignment = agent.nextAssignment().catch((error: unknown) => error)

      agent.stopMatchmaking()
      await vi.advanceTimersByTimeAsync(0)

      expect(await assignment).toBeInstanceOf(MatchmakingError)
      await expect(agent.nextAssignment()).rejects.toThrow('No matchmaking in progress.')
    })
  })

  describe('async iteration', () => {
    it('yields group changes until the agent is disposed', async () => {
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'SEARCHING' }) })
      const { agent } = start()
      const seen: Array<[string, string | null | undefined]> = []
      const loop = (async () => {
        for await (const { event, current } of agent.group) seen.push([event.code, current?.status])
      })()

      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050)
      agent.dispose()
      await loop

      expect(seen).toEqual([
        ['created', null],
        ['updated', 'SEARCHING'],
      ])
    })
  })

  it('emits a new state object for every group change', async () => {
    server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'SEARCHING' }) })
    const { agent } = start()
    const states: Array<[unknown, unknown]> = []
    agent.group.subscribe((obs) => states.push([obs.previous, obs.current]))

    agent.createGroup(REQUEST, true)
    await vi.advanceTimersByTimeAsync(1050)
    const [created, updated] = states

    expect(updated![0]).toBe(created![1])
    expect(updated![1]).not.toBe(updated![0])
    expect(created![1]).toEqual(member())
  })

  it('cleans up abort listeners across many sessions', async () => {
    const live = new Map<AbortSignal, Set<unknown>>()
    const { addEventListener, removeEventListener } = EventTarget.prototype
    vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (this: AbortSignal, ...args) {
      if (args[0] === 'abort') live.set(this, (live.get(this) ?? new Set()).add(args[1]))
      return addEventListener.apply(this, args)
    })
    vi.spyOn(AbortSignal.prototype, 'removeEventListener').mockImplementation(function (this: AbortSignal, ...args) {
      if (args[0] === 'abort') live.get(this)?.delete(args[1])
      return removeEventListener.apply(this, args)
    })
    server.on('GET /locations/beacons', { status: 200, body: { count: 0, beacons: [] } })
    const { agent } = start({ logPollingUpdates: true })

    for (let i = 0; i < 30; i++) {
      agent.createGroup(REQUEST, true)
      void agent.nextAssignment().catch(() => {})
      await vi.advanceTimersByTimeAsync(1050)
      void agent.beacons().catch(() => {})
    }
    agent.stopMatchmaking()
    await vi.advanceTimersByTimeAsync(0)

    const listeners = [...live].filter(([signal]) => !signal.aborted).map(([, set]) => set.size)
    expect(Math.max(0, ...listeners)).toBeLessThanOrEqual(2)
  })

  it('rejects pending beacon requests on dispose', async () => {
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    )
    const { agent } = start()

    const beacons = agent.beacons().catch((error: unknown) => error)
    agent.dispose()

    expect(await beacons).toMatchObject({ message: 'GroupAgent disposed.' })
  })

  it('dispose stops polling, timers, and subscribers', async () => {
    const { agent, group } = start()
    agent.createGroup(REQUEST, true)
    await vi.advanceTimersByTimeAsync(0)

    agent.dispose()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(server.count('GET /groups/g1/members/m1')).toBe(0)
    expect(group).toEqual([[T.Update, 'created']])
  })

  it('leaves no timers when disposed from the host assignment handler', async () => {
    server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'HOST_ASSIGNED' }) })
    const { agent } = start()
    agent.group.subscribe((obs) => {
      if (obs.current?.status === 'HOST_ASSIGNED') agent.dispose()
    })
    agent.createGroup(REQUEST, true)

    await vi.advanceTimersByTimeAsync(1050)

    expect(vi.getTimerCount()).toBe(0)
  })
})
