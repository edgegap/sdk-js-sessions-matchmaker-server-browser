import type { DeploymentDTO } from '../dtos.ts'

export type GroupStatus = 'SEARCHING' | 'TEAM_FOUND' | 'MATCH_FOUND' | 'HOST_ASSIGNED' | 'CANCELLED'

export type BackfillStatus = 'SEARCHING' | 'ASSIGNED'

export interface MonitorResponseDTO {
  status: string
  message: string
  healthy_components: number
  unhealthy_components: number
}

export interface TicketsRequestDTO<A> {
  profile: string
  attributes: A
  player_ip?: string | null
}

export interface GroupUpRequestDTO<A> extends TicketsRequestDTO<A> {
  is_ready: boolean
}

export interface GroupUpResponseDTO {
  member_id: string
  group_id: string
  is_ready: boolean
  status: GroupStatus | null
  ticket_id: string | null
  assignment: DeploymentDTO | null
  team_id: string | null
}

export interface GroupDetailResponse {
  status: GroupStatus | null
  assignment: DeploymentDTO | null
  team_id: string | null
}

export interface InjectedTicketDTO<A> {
  id: string
  created_at: string
  player_ip: string
  group_id: string
  team_id?: string | null
  attributes: A
}

export interface BackfillAssignment extends DeploymentDTO {
  request_id: string
}

export interface BackfillAttributes {
  assignment: BackfillAssignment
}

export interface BackfillRequestDTO<A> {
  profile: string
  attributes: BackfillAttributes
  tickets: Record<string, InjectedTicketDTO<A>>
}

export interface BackfillResponseDTO<A> {
  id: string
  profile: string
  tickets: Record<string, InjectedTicketDTO<A>>
  status: BackfillStatus
  assigned_ticket?: InjectedTicketDTO<A> | null
}
