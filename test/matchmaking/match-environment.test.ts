import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MatchEnvironment, presets } from '../../src/matchmaking/index.ts'

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

  it('upstream: throws when a ticket fails to parse', () => {
    expect(() => MatchEnvironment.fromEnv({ MM_TICKET_t1: '{' })).toThrow(TypeError)
  })
})

describe('presets', () => {
  it('build the sample group-up requests', () => {
    expect(presets.simpleGroupUpRequest({ Chicago: 20 }, true)).toEqual({
      profile: 'simple-example',
      attributes: { beacons: { Chicago: 20 } },
      is_ready: true,
    })
    expect(presets.backfillGroupUpRequest({ Chicago: 20 }, ['2'])).toEqual({
      profile: 'backfill-example',
      attributes: { beacons: { Chicago: 20 }, backfill_group_size: ['2'] },
      is_ready: false,
    })
    expect(presets.advancedGroupUpRequest({ Chicago: 20 }, 1500, 'ffa', ['dust'], ['2'])).toEqual({
      profile: 'advanced-example',
      attributes: {
        beacons: { Chicago: 20 },
        elo_rating: 1500,
        selected_game_mode: 'ffa',
        selected_map: ['dust'],
        backfill_group_size: ['2'],
      },
      is_ready: false,
    })
  })
})
