import {
  type Env,
  tryParseEnvVariableJSON,
  tryParseEnvVariableString,
} from '../deployment-environment.ts'
import type { InjectedTicketDTO } from './dtos.ts'

export interface MatchEnvironment<A> {
  matchProfile: string | null
  ticketIds: string[] | null
  tickets: Record<string, InjectedTicketDTO<A>>
  groups: Record<string, string[]> | null
  teams: Record<string, string[]> | null
  matchId: string | null
  equality: Record<string, string> | null
  intersection: Record<string, string[]> | null
}

const fromEnv = <A>(env: Env): MatchEnvironment<A> => {
  const result: MatchEnvironment<A> = {
    matchProfile: null,
    ticketIds: null,
    tickets: {},
    groups: null,
    teams: null,
    matchId: null,
    equality: null,
    intersection: null,
  }

  Object.entries(env).forEach(([key, value]) => {
    if (key === 'MM_MATCH_PROFILE') result.matchProfile = tryParseEnvVariableString(key, value)
    else if (key === 'MM_TICKET_IDS') result.ticketIds = tryParseEnvVariableJSON(key, value)
    else if (key === 'MM_GROUPS') result.groups = tryParseEnvVariableJSON(key, value)
    else if (key === 'MM_TEAMS') result.teams = tryParseEnvVariableJSON(key, value)
    else if (key === 'MM_MATCH_ID') result.matchId = tryParseEnvVariableString(key, value)
    else if (key === 'MM_EQUALITY') result.equality = tryParseEnvVariableJSON(key, value)
    else if (key === 'MM_INTERSECTION') result.intersection = tryParseEnvVariableJSON(key, value)
    else if (key.startsWith('MM_TICKET_')) {
      const ticket = tryParseEnvVariableJSON<InjectedTicketDTO<A>>(key, value)
      if (ticket?.id != null) result.tickets[ticket.id] = ticket
    }
  })

  return result
}

export const MatchEnvironment: { fromEnv: <A = unknown>(env: Env) => MatchEnvironment<A> } = {
  fromEnv,
}
