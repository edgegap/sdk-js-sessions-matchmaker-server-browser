import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type BeaconDTO, HttpRequestError, ObservableActionType as T } from '../../src/index.ts'
import { GroupAgent, type GroupUpResponseDTO, presets } from '../../src/matchmaking/index.ts'
import { mockServer, recordEvents, silenceConsole } from '../helpers.ts'

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

const REQUEST = presets.simpleGroupUpRequest({ Chicago: 20 })

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
    it('upstream: reports a conflict on the very first createGroup without abandon', async () => {
      const { agent, group } = start()

      agent.createGroup(REQUEST)
      await vi.runOnlyPendingTimersAsync()

      expect(group).toEqual([[T.Error, 'conflict, abandon and restart']])
      expect(server.count('POST /groups')).toBe(0)
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
      agent.group._update(null, 'reset')

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

    it('upstream: resumes polling on 409 and drops the follow-up action', async () => {
      server.on('DELETE /groups/g1', { status: 409, body: { message: 'matched' } })
      const { agent, group } = await created()
      const onCompleted = vi.fn()

      agent.stopMatchmaking(onCompleted)
      await vi.advanceTimersByTimeAsync(0)

      expect(group.at(-1)).toEqual([T.Warn, 'abandon failed (match found)'])
      expect(server.count('GET /groups/g1/members/m1')).toBe(1)
      expect(onCompleted).not.toHaveBeenCalled()
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

  describe('upstream timing bugs', () => {
    it('upstream: a new group within the backoff window runs two polling loops', async () => {
      const { agent } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(1050 * 3)

      expect(server.count('GET /groups/g1/members/m1')).toBe(6)
    })

    it('upstream: a stale expiry removes a newer group', async () => {
      server.on('GET /groups/g1/members/m1', { status: 200, body: member({ status: 'HOST_ASSIGNED' }) })
      const { agent, group } = start()
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(1050)

      server.on('POST /groups', { status: 201, body: member({ group_id: 'g2', member_id: 'm9' }) })
      server.on('GET /groups/g2/members/m9', { status: 200, body: member({ group_id: 'g2', member_id: 'm9' }) })
      agent.createGroup(REQUEST, true)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(group.at(-1)).toEqual([T.Update, 'removed'])
      expect(agent.group.current).toBeNull()
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

  it('dispose stops polling, timers, and subscribers', async () => {
    const { agent, group } = start()
    agent.createGroup(REQUEST, true)
    await vi.advanceTimersByTimeAsync(0)

    agent.dispose()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(server.count('GET /groups/g1/members/m1')).toBe(0)
    expect(group).toEqual([[T.Update, 'created']])
  })
})
