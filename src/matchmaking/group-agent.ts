import type { BeaconDTO, BeaconsResponseDTO, DeploymentDTO } from '../dtos.ts'
import { type HttpResponse, HttpRequestError } from '../http.ts'
import { Logger } from '../logger.ts'
import { Observable, ObservableActionType, type Subscriber } from '../observable.ts'
import { type Ping, stubPing } from '../ping.ts'
import { child, delay, jitter } from '../timers.ts'
import { Api } from './api.ts'
import type { GroupUpRequestDTO, GroupUpResponseDTO, MonitorResponseDTO } from './dtos.ts'
import { type GroupEvent, type MonitorEvent, groupMessages, monitorMessages } from './events.ts'

export interface GroupAgentOptions {
  baseUrl: string
  authToken: string
  requestTimeoutSeconds?: number
  pollingBackoffSeconds?: number
  maxConsecutivePollingErrors?: number
  removeGroupSeconds?: number
  logGroupUpdates?: boolean
  logPollingUpdates?: boolean
  ping?: Ping
}

export class MatchmakingError extends Error {
  readonly event: GroupEvent | null

  constructor(message: string, event: GroupEvent | null = null) {
    super(message)
    this.name = 'MatchmakingError'
    this.event = event
  }
}

const ended = (): AbortController => {
  const controller = new AbortController()
  controller.abort()
  return controller
}

export class GroupAgent<A = unknown> {
  readonly baseUrl: string
  authToken: string

  requestTimeoutSeconds: number
  pollingBackoffSeconds: number
  maxConsecutivePollingErrors: number
  removeGroupSeconds: number

  logGroupUpdates: boolean
  logPollingUpdates: boolean

  readonly monitor: Observable<MonitorResponseDTO, MonitorEvent> = new Observable(null, monitorMessages)
  readonly group: Observable<GroupUpResponseDTO, GroupEvent> = new Observable(null, groupMessages)

  private api: Api | null = null
  private ping: Ping
  private _owner = false
  private readonly lifetime = new AbortController()
  private session = ended()

  constructor(options: GroupAgentOptions) {
    this.baseUrl = options.baseUrl
    this.authToken = options.authToken
    this.requestTimeoutSeconds = options.requestTimeoutSeconds ?? 3
    this.pollingBackoffSeconds = options.pollingBackoffSeconds ?? 1
    this.maxConsecutivePollingErrors = options.maxConsecutivePollingErrors ?? 10
    this.removeGroupSeconds = options.removeGroupSeconds ?? 30
    this.logGroupUpdates = options.logGroupUpdates ?? true
    this.logPollingUpdates = options.logPollingUpdates ?? false
    this.ping = options.ping ?? stubPing
  }

  get owner(): boolean {
    return this._owner
  }

  status(): void {
    this.api!.getMonitor(
      (monitor) =>
        this.monitor._update(monitor, {
          code: monitor.status.toLowerCase() === 'healthy' ? 'healthy' : 'unhealthy',
        }),
      (error) => this.monitor._error({ code: 'monitor_failed', detail: error }, null),
      this.lifetime.signal,
    )
  }

  beacons(): Promise<BeaconsResponseDTO> {
    const signal = this.lifetime.signal
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new MatchmakingError('GroupAgent disposed.'))
      if (signal.aborted) return onAbort()

      signal.addEventListener('abort', onAbort, { once: true })
      this.api!.getBeacons(
        (beacons) => {
          signal.removeEventListener('abort', onAbort)
          resolve(beacons)
        },
        (error, response) => {
          signal.removeEventListener('abort', onAbort)
          this.monitor._error({ code: 'beacons_failed', detail: error })
          reject(new HttpRequestError(error, response))
        },
        signal,
      )
    })
  }

  async measureBeaconsRoundTripTime(
    beacons: BeaconDTO[],
    requests = 3,
  ): Promise<Record<string, number>> {
    const unique = beacons.filter(
      (beacon, index) => beacons.findIndex((b) => b.location.city === beacon.location.city) === index,
    )
    return Object.fromEntries(
      await Promise.all(
        unique.map(async (beacon) => [beacon.location.city, await this.ping.measure(beacon, requests)]),
      ),
    )
  }

  nextAssignment(): Promise<DeploymentDTO> {
    const signal = this.session.signal
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new MatchmakingError('No matchmaking in progress.'))

      const settle = (outcome: () => void) => {
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        outcome()
      }
      const onAbort = () => settle(() => reject(new MatchmakingError('Matchmaking stopped.')))
      const unsubscribe = this.group.subscribe((group, type, message, event) => {
        const status = event.code === 'updated' ? event.status : null
        if (status === 'HOST_ASSIGNED') return settle(() => resolve(group.current!.assignment!))
        if (status === 'CANCELLED' || (type === ObservableActionType.Error && event.code !== 'conflict')) {
          settle(() => reject(new MatchmakingError(message, event)))
        }
      })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  resumeMatchmaking(group: GroupUpResponseDTO, abandon = false): void {
    if (this.group.current !== null && !abandon) {
      this.group._error({ code: 'conflict' })
      return
    }

    this.stopMatchmaking(() => {
      this.group._update(group, { code: 'resumed' })
      this.pollGroup(this.session.signal)
    })
  }

  createGroup(group: GroupUpRequestDTO<A>, abandon = false): void {
    if (this.group.current !== null && !abandon) {
      this.group._error({ code: 'conflict' })
      return
    }

    this.stopMatchmaking(() => {
      const signal = this.session.signal
      this.api!.createGroup(
        group,
        (created) => {
          this.group._update(created, { code: 'created' })
          this._owner = true
          this.schedulePoll(this.startPolling(signal))
        },
        (error) => this.group._error({ code: 'create_failed', detail: error }),
        signal,
      )
    })
  }

  joinGroup(member: GroupUpRequestDTO<A>, groupId: string, abandon = false): void {
    if (this.group.current !== null && !abandon) {
      this.group._error({ code: 'conflict' })
      return
    }

    this.stopMatchmaking(() => {
      const signal = this.session.signal
      this.api!.createGroupMember(
        member,
        groupId,
        (joined) => {
          this.group._update(joined, { code: 'joined' })
          this._owner = false
          this.schedulePoll(this.startPolling(signal))
        },
        (error, response) =>
          this.group._error({ code: response.status === 404 ? 'not_found' : 'join_failed', detail: error }),
        signal,
      )
    })
  }

  setReady(isReady: boolean): void {
    const current = this.group.current
    if (current === null) {
      this.group._error({ code: 'not_found' })
      return
    }

    this.api!.updateGroupMember(
      current.group_id,
      current.member_id,
      isReady,
      (group) => this.group._update(group, { code: 'member_updated', isReady }),
      (error, response) => {
        if (response.status === 404) this.group._error({ code: 'not_found', detail: error })
        else if (response.status === 409)
          this.group._notify({ code: 'member_update_failed' }, ObservableActionType.Warn)
        else this.group._error({ code: 'update_failed', detail: error })
      },
      this.session.signal,
    )
  }

  stopMatchmaking(onCompleted?: () => void): void {
    this.session.abort()
    this.session = child(this.lifetime.signal)
    const signal = this.session.signal
    const complete = () => (onCompleted ? onCompleted() : this.session.abort())

    const current = this.group.current
    if (current?.group_id == null) return complete()

    const onAbandoned = () => {
      this.group._update(null, { code: 'abandoned' })
      complete()
    }
    const onAbandonError = (error: string, response: HttpResponse) =>
      this.onStopMatchmakingError(error, response, signal, onCompleted)

    if (this._owner) {
      this.api!.deleteGroup(current.group_id, onAbandoned, onAbandonError, signal)
    } else {
      this.api!.deleteGroupMember(current.group_id, current.member_id, onAbandoned, onAbandonError, signal)
    }
  }

  initialize(
    onMonitorUpdate?: Subscriber<MonitorResponseDTO, MonitorEvent>,
    onGroupUpdate?: Subscriber<GroupUpResponseDTO, GroupEvent>,
  ): void {
    if (!this.baseUrl?.trim()) throw new Error('BaseUrl not declared.')
    if (!this.authToken?.trim()) throw new Error('AuthToken not declared.')

    this.api = new Api(this.authToken, this.baseUrl, this.requestTimeoutSeconds)

    Logger.subscribeLogger(this.monitor, 'MM', 'Monitor')
    if (onMonitorUpdate) this.monitor.subscribe(onMonitorUpdate)

    Logger.subscribeLogger(this.group, 'MM', 'Group', this.logGroupUpdates)
    if (onGroupUpdate) this.group.subscribe(onGroupUpdate)

    this.status()
  }

  dispose(): void {
    this.monitor.clear()
    this.group.clear()
    this.lifetime.abort()
    this.api?.dispose()
  }

  private startPolling(session: AbortSignal): AbortController {
    const loop = child(session)
    if (this.logPollingUpdates) {
      loop.signal.addEventListener('abort', () => this.group._notify({ code: 'polling_stopped' }), { once: true })
    }
    return loop
  }

  private pollGroup(session: AbortSignal): void {
    this.poll(this.startPolling(session))
  }

  private poll(loop: AbortController, consecutiveErrors = 0): void {
    if (this.logPollingUpdates) {
      this.group._notify({
        code: 'polling',
        attempt: consecutiveErrors + 1,
        maxAttempts: this.maxConsecutivePollingErrors,
      })
    }

    const current = this.group.current!
    this.api!.getGroupMember(
      current.group_id,
      current.member_id,
      (group) => {
        if (this.group.current === null || group.status === this.group.current.status) {
          this.schedulePoll(loop)
          return
        }

        this.group._update(group, { code: 'updated', status: group.status })
        if (group.status !== 'HOST_ASSIGNED' && group.status !== 'CANCELLED') return this.schedulePoll(loop)

        loop.abort()
        this.expireGroup()
      },
      (error, response) => {
        if (consecutiveErrors + 1 > this.maxConsecutivePollingErrors) {
          this.group._error({ code: 'polling_failed', reason: 'max_retries', detail: error })
          this.stopMatchmaking()
          return
        }
        if (response.status === 429 || response.status >= 500) {
          this.schedulePoll(loop, consecutiveErrors + 1)
          return
        }
        this.group._error({ code: 'polling_failed', reason: 'error', detail: error })
        this.stopMatchmaking()
      },
      loop.signal,
    )
  }

  private schedulePoll(loop: AbortController, consecutiveErrors = 0): void {
    delay(jitter(this.pollingBackoffSeconds), loop.signal, () => this.poll(loop, consecutiveErrors))
  }

  private expireGroup(): void {
    delay(this.removeGroupSeconds, this.session.signal, () => {
      this.group._update(null, { code: 'removed' })
      this.session.abort()
    })
  }

  private onStopMatchmakingError(
    error: string,
    response: HttpResponse,
    session: AbortSignal,
    onCompleted?: () => void,
  ): void {
    if (response.status === 409) {
      this.group._notify({ code: 'abandon_failed', reason: 'match_found' }, ObservableActionType.Warn)
      if (onCompleted) this.group._notify({ code: 'restart_skipped' }, ObservableActionType.Warn)
      this.pollGroup(session)
      return
    }

    if (response.status === 404) this.group._update(null, { code: 'abandon_failed', reason: 'not_found' })
    else this.group._error({ code: 'abandon_failed', reason: 'error', detail: error }, null)

    onCompleted ? onCompleted() : this.session.abort()
  }
}
