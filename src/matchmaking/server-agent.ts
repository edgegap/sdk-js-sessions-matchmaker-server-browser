import { Logger } from '../logger.ts'
import { Observable, ObservableActionType, type Subscriber } from '../observable.ts'
import { child, countdown, delay, jitter } from '../timers.ts'
import { Api } from './api.ts'
import type {
  BackfillAttributes,
  BackfillResponseDTO,
  InjectedTicketDTO,
  MonitorResponseDTO,
} from './dtos.ts'
import { type BackfillEvent, type MonitorEvent, backfillMessages, monitorMessages } from './events.ts'

export type Backfills<A> = Record<string, BackfillResponseDTO<A>>

export interface ServerAgentOptions {
  baseUrl: string
  authToken: string
  profile: string
  attributes: BackfillAttributes
  targetTeamSize?: number
  requestTimeoutSeconds?: number
  pollingBackoffSeconds?: number
  maxConsecutivePollingErrors?: number
  connectionGracePeriodSeconds?: number
  logBackfillUpdates?: boolean
  logPollingUpdates?: boolean
}

const assignedTicket = <A>(ticket: InjectedTicketDTO<A>): InjectedTicketDTO<A> => ({
  id: ticket.id,
  created_at: ticket.created_at,
  player_ip: ticket.player_ip,
  group_id: ticket.group_id,
  attributes: ticket.attributes,
})

export class ServerAgent<A = unknown> {
  readonly baseUrl: string
  authToken: string
  profile: string
  backfillAttributes: BackfillAttributes
  targetTeamSize: number

  requestTimeoutSeconds: number
  pollingBackoffSeconds: number
  maxConsecutivePollingErrors: number
  connectionGracePeriodSeconds: number

  logBackfillUpdates: boolean
  logPollingUpdates: boolean

  readonly monitor: Observable<MonitorResponseDTO, MonitorEvent> = new Observable(null, monitorMessages)
  readonly backfills: Observable<Backfills<A>, BackfillEvent> = new Observable({}, backfillMessages)

  private api: Api | null = null
  private _assignments: Readonly<Record<string, InjectedTicketDTO<A>>> = {}
  private _connectedAt: ReadonlyMap<string, Date> = new Map()
  private creatingBackfills = 0
  private readonly lifetime = new AbortController()
  private polling: AbortController | null = null

  constructor(options: ServerAgentOptions) {
    this.baseUrl = options.baseUrl
    this.authToken = options.authToken
    this.profile = options.profile
    this.backfillAttributes = options.attributes
    this.targetTeamSize = options.targetTeamSize ?? -1
    this.requestTimeoutSeconds = options.requestTimeoutSeconds ?? 3
    this.pollingBackoffSeconds = options.pollingBackoffSeconds ?? 1
    this.maxConsecutivePollingErrors = options.maxConsecutivePollingErrors ?? 10
    this.connectionGracePeriodSeconds = options.connectionGracePeriodSeconds ?? 60
    this.logBackfillUpdates = options.logBackfillUpdates ?? true
    this.logPollingUpdates = options.logPollingUpdates ?? false
  }

  get assignments(): Readonly<Record<string, InjectedTicketDTO<A>>> {
    return this._assignments
  }

  get connectedAt(): ReadonlyMap<string, Date> {
    return this._connectedAt
  }

  abandonPlayer(ticketId: string, expiredGrace = false): boolean {
    if (!(ticketId in this._assignments)) {
      Logger.warn(`MM | Backfill - ticket abandon failed [${ticketId}]`)
      return false
    }

    const { [ticketId]: _abandoned, ...remaining } = this._assignments
    this._assignments = remaining
    this.disconnect(ticketId)
    Logger.log(
      `MM | Backfill - ticket abandoned${expiredGrace ? ' (connection grace period expired)' : ''} [${ticketId}]`,
    )
    this.addBackfills()
    return true
  }

  playerConnected(ticketId: string): InjectedTicketDTO<A> | null {
    const ticket = this._assignments[ticketId]
    if (!ticket) return null
    if (!this._connectedAt.has(ticketId)) this._connectedAt = new Map([...this._connectedAt, [ticketId, new Date()]])
    return ticket
  }

  status(): void {
    this.api!.getMonitor(
      (monitor) =>
        this.monitor._update(monitor, {
          code: monitor.status.toLowerCase() === 'healthy' ? 'healthy' : 'unhealthy',
        }),
      (error) => this.monitor._error({ code: 'monitor_failed', detail: error }, null),
    )
  }

  addBackfills(): void {
    while (!this.lifetime.signal.aborted && this.seatsTaken() < this.targetTeamSize) this.startNewBackfill()
  }

  abandonBackfill(backfillId: string, onCompleted?: () => void): void {
    if (!(backfillId in this.backfills.current!)) {
      this.backfills._notify({ code: 'abandon_failed', backfillId, reason: 'not_found' }, ObservableActionType.Warn)
      return
    }

    this.api!.deleteBackfill(
      backfillId,
      () => {
        this.backfills._notify({ code: 'abandoned', backfillId })
        this.removeBackfill(backfillId, onCompleted)
      },
      (error, response) => {
        this.backfills._notify(
          response.status === 404
            ? { code: 'abandon_failed', backfillId, reason: 'not_found' }
            : { code: 'abandon_failed', backfillId, reason: 'error', detail: error },
          ObservableActionType.Warn,
        )
        this.removeBackfill(backfillId, onCompleted)
      },
    )
  }

  abandonAllBackfills(onCompleted?: () => void): void {
    this.polling?.abort()

    const ids = Object.keys(this.backfills.current!)
    const finished = countdown(ids.length, this.lifetime.signal, () => onCompleted?.())
    ids.forEach((id) => this.abandonBackfill(id, finished))
  }

  initialize(
    tickets: Record<string, InjectedTicketDTO<A>>,
    onMonitorUpdate?: Subscriber<MonitorResponseDTO, MonitorEvent>,
    onBackfillUpdate?: Subscriber<Backfills<A>, BackfillEvent>,
  ): void {
    if (!this.baseUrl?.trim()) throw new Error('BaseUrl not declared.')
    if (!this.authToken?.trim()) throw new Error('AuthToken not declared.')

    this.api = new Api(this.authToken, this.baseUrl, this.requestTimeoutSeconds)

    Logger.subscribeLogger(this.monitor, 'MM', 'Monitor')
    if (onMonitorUpdate) this.monitor.subscribe(onMonitorUpdate)

    Logger.subscribeLogger(this.backfills, 'MM', 'Backfill', this.logBackfillUpdates)
    if (onBackfillUpdate) this.backfills.subscribe(onBackfillUpdate)

    Object.values(tickets).forEach((ticket) => this.assign(ticket))

    this.status()
  }

  dispose(): void {
    this.monitor.clear()
    this.backfills.clear()
    this.lifetime.abort()
    this.api?.dispose()
  }

  private seatsTaken(): number {
    return Object.keys(this._assignments).length + Object.keys(this.backfills.current!).length + this.creatingBackfills
  }

  private disconnect(ticketId: string): void {
    if (!this._connectedAt.has(ticketId)) return
    this._connectedAt = new Map([...this._connectedAt].filter(([id]) => id !== ticketId))
  }

  private assign(ticket: InjectedTicketDTO<A>): void {
    this._assignments = { ...this._assignments, [ticket.id]: assignedTicket(ticket) }
    this.disconnect(ticket.id)
    delay(this.connectionGracePeriodSeconds, this.lifetime.signal, () => {
      if (ticket.id in this._assignments && !this._connectedAt.has(ticket.id)) {
        this.abandonPlayer(ticket.id, true)
      }
    })
  }

  private removeBackfill(backfillId: string, onCompleted?: () => void): void {
    const { [backfillId]: removed, ...remaining } = this.backfills.current!
    if (removed) this.backfills._update(remaining, { code: 'removed', backfillId })
    else this.backfills._notify({ code: 'remove_failed', backfillId }, ObservableActionType.Warn)

    onCompleted?.()
  }

  private startNewBackfill(): void {
    if (this.seatsTaken() >= this.targetTeamSize) {
      this.backfills._error({ code: 'capacity_reached' })
      return
    }

    this.creatingBackfills++
    this.api!.createBackfill<A>(
      { profile: this.profile, attributes: this.backfillAttributes, tickets: this._assignments },
      (backfill) => {
        this.creatingBackfills--
        this.backfills._update(
          { ...this.backfills.current, [backfill.id]: backfill },
          { code: 'created', backfillId: backfill.id },
        )
        this.startPolling()
      },
      (error) => {
        this.creatingBackfills--
        this.backfills._error({ code: 'create_failed', detail: error })
      },
    )
  }

  private startPolling(): void {
    if (this.polling && !this.polling.signal.aborted) return

    const loop = child(this.lifetime.signal)
    loop.signal.addEventListener('abort', () => this.backfills._notify({ code: 'polling_stopped' }), { once: true })
    this.polling = loop
    delay(jitter(this.pollingBackoffSeconds), loop.signal, () => this.pollBackfills(loop))
  }

  private pollBackfills(loop: AbortController, consecutiveErrors = 0, failedIds: string[] = []): void {
    if (consecutiveErrors > this.maxConsecutivePollingErrors) {
      failedIds
        .filter((id) => id in this.backfills.current!)
        .forEach((backfillId) =>
          this.backfills._error({ code: 'polling_failed', backfillId, reason: 'max_retries' }),
        )
      this.abandonAllBackfills()
      return
    }

    const current = Object.values(this.backfills.current!)
    if (current.length === 0) return loop.abort()

    if (this.logPollingUpdates) {
      this.backfills._notify({
        code: 'polling',
        attempt: consecutiveErrors + 1,
        maxAttempts: this.maxConsecutivePollingErrors,
      })
    }

    const failed: string[] = []
    const finished = countdown(current.length, loop.signal, () => {
      const next = failed.length > 0 ? consecutiveErrors + 1 : 0
      delay(jitter(this.pollingBackoffSeconds), loop.signal, () => this.pollBackfills(loop, next, failed))
    })

    current.forEach((b) =>
      this.api!.getBackfill<A>(
        b.id,
        (backfill) => {
          if (backfill.status === 'ASSIGNED') {
            const ticket = backfill.assigned_ticket!
            this.assign(ticket)
            this.backfills._update(
              { ...this.backfills.current, [backfill.id]: backfill },
              { code: 'assigned', backfillId: backfill.id, ticketId: ticket.id },
            )
            this.removeBackfill(backfill.id)
          }
          finished()
        },
        (error, response) => {
          failed.push(b.id)
          if (response.status === 404) {
            this.backfills._notify(
              { code: 'polling_failed', backfillId: b.id, reason: 'not_found' },
              ObservableActionType.Warn,
            )
            this.removeBackfill(b.id, () => this.startNewBackfill())
          } else if (response.status !== 429 && response.status < 500) {
            this.backfills._error({ code: 'polling_failed', backfillId: b.id, reason: 'error', detail: error })
            this.abandonBackfill(b.id, () => this.startNewBackfill())
          }
          finished()
        },
      ),
    )
  }
}
