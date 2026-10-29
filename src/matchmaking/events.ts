import type { EventMessages } from '../observable.ts'
import type { GroupStatus } from './dtos.ts'

export type MonitorEvent =
  | { code: 'healthy' }
  | { code: 'unhealthy' }
  | { code: 'monitor_failed'; detail: string }
  | { code: 'beacons_failed'; detail: string }

export type GroupEvent =
  | { code: 'conflict' }
  | { code: 'resumed' }
  | { code: 'created' }
  | { code: 'create_failed'; detail: string }
  | { code: 'joined' }
  | { code: 'join_failed'; detail: string }
  | { code: 'not_found'; detail?: string }
  | { code: 'member_updated'; isReady: boolean }
  | { code: 'member_update_failed' }
  | { code: 'update_failed'; detail: string }
  | { code: 'updated'; status: GroupStatus | null }
  | { code: 'polling'; attempt: number; maxAttempts: number }
  | { code: 'polling_stopped' }
  | { code: 'polling_failed'; reason: 'max_retries' | 'error'; detail: string }
  | { code: 'abandoned' }
  | { code: 'abandon_failed'; reason: 'match_found' | 'not_found' | 'error'; detail?: string }
  | { code: 'restart_skipped' }
  | { code: 'removed' }

export type BackfillEvent =
  | { code: 'created'; backfillId: string }
  | { code: 'create_failed'; detail: string }
  | { code: 'capacity_reached' }
  | { code: 'assigned'; backfillId: string; ticketId: string }
  | { code: 'removed'; backfillId: string }
  | { code: 'remove_failed'; backfillId: string }
  | { code: 'abandoned'; backfillId: string }
  | { code: 'abandon_failed'; backfillId: string; reason: 'not_found' | 'error'; detail?: string }
  | { code: 'polling'; attempt: number; maxAttempts: number }
  | { code: 'polling_stopped' }
  | {
      code: 'polling_failed'
      backfillId: string
      reason: 'max_retries' | 'not_found' | 'error'
      detail?: string
    }

export const monitorMessages: EventMessages<MonitorEvent> = {
  healthy: () => 'healthy',
  unhealthy: () => 'unhealthy',
  monitor_failed: () => 'get monitor failed (unexpected error)',
  beacons_failed: () => 'get beacons failed',
}

export const groupMessages: EventMessages<GroupEvent> = {
  conflict: () => 'conflict, abandon and restart',
  resumed: () => 'resumed',
  created: () => 'created',
  create_failed: () => 'group create failed',
  joined: () => 'joined',
  join_failed: () => 'group join failed',
  not_found: () => 'group not found',
  member_updated: ({ isReady }) => `member updated [${isReady ? 'True' : 'False'}]`,
  member_update_failed: () => 'member update failed',
  update_failed: () => 'group update failed',
  updated: ({ status }) => `group updated [${status ?? ''}]`,
  polling: ({ attempt, maxAttempts }) => `polling [${attempt}/${maxAttempts}]`,
  polling_stopped: () => 'polling stopped',
  polling_failed: ({ reason }) =>
    reason === 'max_retries' ? 'polling failed, reached maximum retries' : 'polling failed',
  abandoned: () => 'abandoned',
  abandon_failed: ({ reason }) =>
    ({ match_found: 'abandon failed (match found)', not_found: 'abandon failed (not found)', error: 'abandon failed' })[
      reason
    ],
  restart_skipped: () => 'restart skipped (match found)',
  removed: () => 'removed',
}

export const backfillMessages: EventMessages<BackfillEvent> = {
  created: ({ backfillId }) => `created [${backfillId}]`,
  create_failed: () => 'create failed',
  capacity_reached: () => 'maximum capacity currently reached',
  assigned: ({ backfillId }) => `assigned [${backfillId}]`,
  removed: ({ backfillId }) => `removed [${backfillId}]`,
  remove_failed: ({ backfillId }) => `remove failed (not found) [${backfillId}]`,
  abandoned: ({ backfillId }) => `abandoned [${backfillId}]`,
  abandon_failed: ({ backfillId, reason }) =>
    reason === 'not_found' ? `abandon failed (not found) [${backfillId}]` : `abandon failed [${backfillId}]`,
  polling: ({ attempt, maxAttempts }) => `polling [${attempt}/${maxAttempts}]`,
  polling_stopped: () => 'polling stopped',
  polling_failed: ({ backfillId, reason }) =>
    ({
      max_retries: `polling failed (reached maximum retries) [${backfillId}]`,
      not_found: `polling failed (not found) [${backfillId}]`,
      error: `polling failed [${backfillId}]`,
    })[reason],
}
