import type { BackfillRequestDTO, GroupUpRequestDTO } from './dtos.ts'

export interface LatenciesAttributesDTO {
  beacons: Record<string, number>
}

export interface BackfillTicketAttributesDTO extends LatenciesAttributesDTO {
  backfill_group_size: string[]
}

export interface AdvancedGroupUpAttributesDTO extends LatenciesAttributesDTO {
  elo_rating: number
  selected_game_mode: string
  selected_map: string[]
  backfill_group_size: string[]
}

export type SimpleBackfillRequestDTO = BackfillRequestDTO<BackfillTicketAttributesDTO>

export const simpleGroupUpRequest = (
  latencyBeacons: Record<string, number>,
  isReady = false,
): GroupUpRequestDTO<LatenciesAttributesDTO> => ({
  profile: 'simple-example',
  attributes: { beacons: latencyBeacons },
  is_ready: isReady,
})

export const backfillGroupUpRequest = (
  latencyBeacons: Record<string, number>,
  backfillGroupSize: string[],
  isReady = false,
): GroupUpRequestDTO<BackfillTicketAttributesDTO> => ({
  profile: 'backfill-example',
  attributes: { beacons: latencyBeacons, backfill_group_size: backfillGroupSize },
  is_ready: isReady,
})

export const advancedGroupUpRequest = (
  latencyBeacons: Record<string, number>,
  eloRating: number,
  selectedGameMode: string,
  selectedMap: string[],
  backfillGroupSize: string[],
): GroupUpRequestDTO<AdvancedGroupUpAttributesDTO> => ({
  profile: 'advanced-example',
  attributes: {
    beacons: latencyBeacons,
    elo_rating: eloRating,
    selected_game_mode: selectedGameMode,
    selected_map: selectedMap,
    backfill_group_size: backfillGroupSize,
  },
  is_ready: false,
})
