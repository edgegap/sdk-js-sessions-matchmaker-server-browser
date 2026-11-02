import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MatchEnvironment } from '../../src/matchmaking/index.ts'

const TICKET = {
  id: 't1',
  created_at: '2026-10-29T12:00:00Z',
  player_ip: '1.2.3.4',
  group_id: 'g1',
  attributes: { beacons: { Chicago: 20 } },
}

describe('MatchEnvironment.fromEnv', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('parses every match variable and collects tickets', () => {
    const env = MatchEnvironment.fromEnv<{ beacons: Record<string, number> }>({
      MM_MATCH_PROFILE: 'advanced-example',
      MM_TICKET_IDS: '["t1"]',
      MM_TICKET_t1: JSON.stringify(TICKET),
      MM_GROUPS: '{"g1":["t1"]}',
      MM_TEAMS: '{"team-1":["t1"]}',
      MM_MATCH_ID: 'match-1',
      MM_EQUALITY: '{"selected_game_mode":"ffa"}',
      MM_INTERSECTION: '{"selected_map":["dust"]}',
      PATH: '/usr/bin',
    })

    expect(env).toEqual({
      matchProfile: 'advanced-example',
      ticketIds: ['t1'],
      tickets: { t1: TICKET },
      groups: { g1: ['t1'] },
      teams: { 'team-1': ['t1'] },
      matchId: 'match-1',
      equality: { selected_game_mode: 'ffa' },
      intersection: { selected_map: ['dust'] },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('defaults to empty tickets and null fields', () => {
    expect(MatchEnvironment.fromEnv({})).toEqual({
      matchProfile: null,
      ticketIds: null,
      tickets: {},
      groups: null,
      teams: null,
      matchId: null,
      equality: null,
      intersection: null,
    })
  })

  it('warns and defaults to null for malformed JSON', () => {
    expect(MatchEnvironment.fromEnv({ MM_GROUPS: '{' }).groups).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('warns and skips a ticket that fails to parse', () => {
    const env = MatchEnvironment.fromEnv({
      MM_TICKET_t1: '{',
      MM_TICKET_t2: '{"id":"t2","created_at":"2026-10-29T12:00:00Z","player_ip":"1.2.3.4","group_id":"g","team_id":"t","attributes":{}}',
    })

    expect(Object.keys(env.tickets)).toEqual(['t2'])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Couldn't parse variable 'MM_TICKET_t1'"))
  })
})
