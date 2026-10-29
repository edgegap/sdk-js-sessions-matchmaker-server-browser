import type { BeaconDTO, BeaconsResponseDTO } from '../dtos.ts'
import { type HttpResponse, HttpRequestError } from '../http.ts'
import { Logger } from '../logger.ts'
import { Observable, ObservableActionType, type Subscriber } from '../observable.ts'
import { type Ping, stubPing } from '../ping.ts'
import { Timers, jitter } from '../timers.ts'
import { Api } from './api.ts'
import type { GroupUpRequestDTO, GroupUpResponseDTO, MonitorResponseDTO } from './dtos.ts'

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

export class GroupAgent<A = unknown> {
  readonly baseUrl: string
  authToken: string

  requestTimeoutSeconds: number
  pollingBackoffSeconds: number
  maxConsecutivePollingErrors: number
  removeGroupSeconds: number

  logGroupUpdates: boolean
  logPollingUpdates: boolean

  readonly monitor: Observable<MonitorResponseDTO> = new Observable()
  readonly group: Observable<GroupUpResponseDTO> = new Observable()

  private api: Api | null = null
  private ping: Ping
  private timers = new Timers()
  private _owner = false
  private polling = false
  private session = 0

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
        this.monitor._update(monitor, monitor.status.toLowerCase() === 'healthy' ? 'healthy' : 'unhealthy'),
      (error) => this.monitor._error(`get monitor failed (unexpected error)\n${error}`, null),
    )
  }

  beacons(): Promise<BeaconsResponseDTO> {
    return new Promise((resolve, reject) =>
      this.api!.getBeacons(
        (beacons) => resolve(beacons),
        (error, response) => {
          this.monitor._error(`get beacons failed\n${error}`)
          reject(new HttpRequestError(error, response))
        },
      ),
    )
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

  resumeMatchmaking(group: GroupUpResponseDTO, abandon = false): void {
    if (this.group.current !== null && !abandon) {
      this.group._error('conflict, abandon and restart')
      return
    }

    this.stopMatchmaking(() => {
      this.group._update(group, 'resumed')
      this.polling = true
      this.startPollingGroup()
    })
  }

  createGroup(group: GroupUpRequestDTO<A>, abandon = false): void {
    if (this.group.current !== null && !abandon) {
      this.group._error('conflict, abandon and restart')
      return
    }

    this.stopMatchmaking(() =>
      this.api!.createGroup(
        group,
        (created) => {
          this.group._update(created, 'created')
          this._owner = true
          this.polling = true
          this.delayPollingGroup()
        },
        (error) => this.group._error(`group create failed\n${error}`),
      ),
    )
  }

  joinGroup(member: GroupUpRequestDTO<A>, groupId: string, abandon = false): void {
    if (this.group.current !== null && !abandon) {
      this.group._error('conflict, abandon and restart')
      return
    }

    this.stopMatchmaking(() =>
      this.api!.createGroupMember(
        member,
        groupId,
        (joined) => {
          this.group._update(joined, 'joined')
          this._owner = false
          this.polling = true
          this.delayPollingGroup()
        },
        (error, response) =>
          this.group._error(
            response.status === 404 ? `group not found\n${error}` : `group join failed\n${error}`,
          ),
      ),
    )
  }

  setReady(isReady: boolean): void {
    const current = this.group.current
    if (current === null) {
      this.group._error('group not found')
      return
    }

    this.api!.updateGroupMember(
      current.group_id,
      current.member_id,
      isReady,
      (group) => this.group._update(group, `member updated [${isReady ? 'True' : 'False'}]`),
      (error, response) => {
        if (response.status === 404) this.group._error(`group not found\n${error}`)
        else if (response.status === 409)
          this.group._notify('member update failed', ObservableActionType.Warn)
        else this.group._error(`group update failed\n${error}`)
      },
    )
  }

  stopMatchmaking(onCompleted?: () => void): void {
    this.polling = false
    this.session++

    const current = this.group.current
    if (current?.group_id == null) {
      onCompleted?.()
      return
    }

    const onAbandoned = () => {
      this.group._update(null, 'abandoned')
      onCompleted?.()
    }
    const onAbandonError = (error: string, response: HttpResponse) =>
      this.onStopMatchmakingError(error, response, onCompleted)

    if (this._owner) {
      this.api!.deleteGroup(current.group_id, onAbandoned, onAbandonError)
    } else {
      this.api!.deleteGroupMember(current.group_id, current.member_id, onAbandoned, onAbandonError)
    }
  }

  initialize(
    onMonitorUpdate: Subscriber<MonitorResponseDTO>,
    onGroupUpdate: Subscriber<GroupUpResponseDTO>,
  ): void {
    if (!this.baseUrl?.trim()) throw new Error('BaseUrl not declared.')
    if (!this.authToken?.trim()) throw new Error('AuthToken not declared.')

    this.api = new Api(this.authToken, this.baseUrl, this.requestTimeoutSeconds)

    Logger.subscribeLogger(this.monitor, 'MM', 'Monitor')
    this.monitor.subscribe(onMonitorUpdate)

    Logger.subscribeLogger(this.group, 'MM', 'Group', this.logGroupUpdates)
    this.group.subscribe(onGroupUpdate)

    this.status()
  }

  dispose(): void {
    this.polling = false
    this.timers.clear()
    this.api?.dispose()
    this.monitor.clear()
    this.group.clear()
  }

  private startPollingGroup(consecutiveErrors = 0, session = this.session): void {
    if (!this.polling) {
      if (this.logPollingUpdates) this.group._notify('polling stopped')
      return
    }
    if (session !== this.session) return

    if (this.logPollingUpdates) {
      this.group._notify(`polling [${consecutiveErrors + 1}/${this.maxConsecutivePollingErrors}]`)
    }

    const current = this.group.current!
    this.api!.getGroupMember(
      current.group_id,
      current.member_id,
      (group) => {
        if (session !== this.session) return
        if (this.group.current === null || group.status === this.group.current.status) {
          this.delayPollingGroup()
          return
        }

        this.group._update(group, `group updated [${group.status ?? ''}]`)
        const status = this.group.current!.status
        status === 'HOST_ASSIGNED' || status === 'CANCELLED'
          ? this.expireGroup()
          : this.delayPollingGroup()
      },
      (error, response) => {
        if (session !== this.session) return
        if (consecutiveErrors + 1 > this.maxConsecutivePollingErrors) {
          this.group._error(`polling failed, reached maximum retries\n${error}`)
          this.stopMatchmaking()
          return
        }
        if (response.status === 429 || response.status >= 500) {
          this.delayPollingGroup(consecutiveErrors + 1)
          return
        }
        this.group._error(`polling failed\n${error}`)
        this.stopMatchmaking()
      },
    )
  }

  private delayPollingGroup(consecutiveErrors = 0): void {
    const session = this.session
    this.timers.delay(jitter(this.pollingBackoffSeconds), () =>
      this.startPollingGroup(consecutiveErrors, session),
    )
  }

  private expireGroup(): void {
    this.polling = false
    const session = this.session
    this.timers.delay(this.removeGroupSeconds, () => {
      if (session === this.session) this.group._update(null, 'removed')
    })
  }

  private onStopMatchmakingError(
    error: string,
    response: HttpResponse,
    onCompleted?: () => void,
  ): void {
    if (response.status === 409) {
      this.group._notify('abandon failed (match found)', ObservableActionType.Warn)
      if (onCompleted) this.group._notify('restart skipped (match found)', ObservableActionType.Warn)
      this.polling = true
      this.startPollingGroup()
      return
    }

    if (response.status === 404) this.group._update(null, 'abandon failed (not found)')
    else this.group._error(`abandon failed\n${error}`, null)

    onCompleted?.()
  }
}
