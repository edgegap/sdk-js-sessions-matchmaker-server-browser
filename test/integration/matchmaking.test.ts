import { afterEach, describe, expect, it } from 'vitest'
import { type Observable, type ObservableEvent, ObservableActionType as T } from '../../src/index.ts'
import {
  type BackfillAttributes,
  GroupAgent,
  type InjectedTicketDTO,
  ServerAgent,
  presets,
} from '../../src/matchmaking/index.ts'

const baseUrl = process.env['EDGEGAP_MM_URL'] ?? ''
const authToken = process.env['EDGEGAP_MM_TOKEN'] ?? ''
const allowDeploy = process.env['EDGEGAP_MM_ALLOW_DEPLOY'] === '1'

const until = <V, E extends ObservableEvent>(
  observable: Observable<V, E>,
  predicate: (type: number, message: string) => boolean,
  timeoutSeconds = 20,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`timed out after ${timeoutSeconds}s`))
    }, timeoutSeconds * 1000)
    const unsubscribe = observable.subscribe((_obs, type, message) => {
      if (!predicate(type, message)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(message)
    })
  })

const updated = (expected: string) => (type: number, message: string) =>
  type === T.Update && message.startsWith(expected)

const failed = (type: number) => type === T.Error

describe.skipIf(!baseUrl || !authToken)('Matchmaking integration (advanced-example)', { timeout: 120_000 }, () => {
  const gameMode = `sdk-js-it-${Date.now()}`
  const request = (isReady = false) => ({
    ...presets.advancedGroupUpRequest({ Chicago: 20, Montreal: 30 }, 1500, gameMode, ['map-a'], ['2']),
    is_ready: isReady,
  })
  const agents: Array<{ dispose(): void }> = []

  const groupAgent = () => {
    const agent = new GroupAgent<ReturnType<typeof request>['attributes']>({
      baseUrl,
      authToken,
      logGroupUpdates: false,
    })
    agents.push(agent)
    return agent
  }

  afterEach(() => agents.splice(0).forEach((agent) => agent.dispose()))

  it('reports a healthy monitor and lists beacons', async () => {
    const agent = groupAgent()
    const healthy = until(agent.monitor, (type, message) => type === T.Update || failed(type))
    agent.initialize(
      () => {},
      () => {},
    )

    expect(await healthy).toBe('healthy')
    const beacons = await agent.beacons()
    expect(beacons.count).toBe(beacons.beacons.length)
    expect(typeof beacons.count).toBe('number')

    const latencies = await agent.measureBeaconsRoundTripTime(beacons.beacons)
    expect(Object.keys(latencies).length).toBeGreaterThan(0)
    expect(Object.values(latencies).every((v) => v === 0)).toBe(true)
  })

  it('creates, joins, readies, and abandons a group without starting a match', async () => {
    const leader = groupAgent()
    const follower = groupAgent()
    leader.initialize(() => {}, () => {})
    follower.initialize(() => {}, () => {})

    const created = until(leader.group, (type, message) => updated('created')(type, message) || failed(type))
    leader.createGroup(request(), true)
    expect(await created).toBe('created')
    const group = leader.group.current!
    expect(group.status).toBeNull()
    expect(leader.owner).toBe(true)

    const joined = until(follower.group, (type, message) => updated('joined')(type, message) || failed(type))
    follower.joinGroup(request(), group.group_id, true)
    expect(await joined).toBe('joined')
    expect(follower.group.current?.group_id).toBe(group.group_id)
    expect(follower.owner).toBe(false)

    const ready = until(leader.group, (type, message) => updated('member updated')(type, message) || failed(type))
    leader.setReady(true)
    expect(await ready).toBe('member updated [True]')
    expect(leader.group.current?.is_ready).toBe(true)

    const left = until(follower.group, (type, message) => updated('abandoned')(type, message) || failed(type))
    follower.stopMatchmaking()
    expect(await left).toBe('abandoned')

    const abandoned = until(leader.group, (type, message) => updated('abandoned')(type, message) || failed(type))
    leader.stopMatchmaking()
    expect(await abandoned).toBe('abandoned')
    expect(leader.group.current).toBeNull()
  })

  it('reports a missing group on join', async () => {
    const agent = groupAgent()
    agent.initialize(() => {}, () => {})

    const error = until(agent.group, (type) => type === T.Error)
    agent.joinGroup(request(), '00000000-0000-0000-0000-000000000000', true)

    expect(await error).toMatch(/^group not found\nHTTP 404/)
  })

  const backfillAttributes: BackfillAttributes = {
    assignment: {
      request_id: 'sdk-js-it',
      fqdn: 'sdk-js-it.pr.edgegap.net',
      public_ip: '127.0.0.1',
      ports: { gameport: { internal: 7777, external: 31000, link: 'sdk-js-it.pr.edgegap.net:31000', protocol: 'WS' } },
      location: {
        city: 'Chicago',
        country: 'United States of America',
        continent: 'North America',
        administrative_division: 'Illinois',
        timezone: 'Central Time',
      },
    },
  }

  const existingTicket = (): InjectedTicketDTO<ReturnType<typeof request>['attributes']> => ({
    id: `sdk-js-it-${Date.now()}`,
    created_at: new Date().toISOString(),
    player_ip: '127.0.0.1',
    group_id: `sdk-js-it-group-${Date.now()}`,
    attributes: request().attributes,
  })

  const serverAgent = (ticket: ReturnType<typeof existingTicket>) => {
    const agent = new ServerAgent<ReturnType<typeof request>['attributes']>({
      baseUrl,
      authToken,
      profile: 'advanced-example',
      attributes: backfillAttributes,
      targetTeamSize: 2,
      logBackfillUpdates: false,
    })
    agents.push(agent)
    agent.initialize({ [ticket.id]: ticket }, () => {}, () => {})
    return agent
  }

  it('creates, polls, and abandons a backfill', async () => {
    const ticket = existingTicket()
    const agent = serverAgent(ticket)

    const created = until(agent.backfills, (type, message) => updated('created')(type, message) || failed(type))
    agent.addBackfills()
    const message = await created
    expect(message).toMatch(/^created \[.+\]$/)
    const backfill = Object.values(agent.backfills.current!)[0]!
    expect(backfill.status).toBe('SEARCHING')
    expect(Object.keys(backfill.tickets)).toEqual([ticket.id])

    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(agent.backfills.current).toHaveProperty(backfill.id)

    await new Promise<void>((resolve) => agent.abandonAllBackfills(resolve))
    expect(agent.backfills.current).toEqual({})
  })

  it.skipIf(!allowDeploy)('assigns a ready group to an open backfill', async () => {
    const ticket = existingTicket()
    const server = serverAgent(ticket)
    const client = groupAgent()
    client.initialize(() => {}, () => {})

    const backfillCreated = until(server.backfills, (type, message) => updated('created')(type, message) || failed(type))
    server.addBackfills()
    expect(await backfillCreated).toMatch(/^created/)

    const assigned = until(server.backfills, (type, message) => updated('assigned')(type, message) || failed(type), 60)
    const hostAssigned = until(
      client.group,
      (type, message) => updated('group updated [HOST_ASSIGNED]')(type, message) || failed(type),
      60,
    )
    client.createGroup(request(true), true)

    expect(await hostAssigned).toBe('group updated [HOST_ASSIGNED]')
    expect(client.group.current?.assignment?.fqdn).toBe(backfillAttributes.assignment.fqdn)
    expect(await assigned).toMatch(/^assigned/)
    expect(Object.keys(server.assignments)).toHaveLength(2)
  })
})
