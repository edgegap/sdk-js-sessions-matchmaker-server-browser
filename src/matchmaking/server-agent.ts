import { Logger } from '../logger.ts'
import { Observable, ObservableActionType, type Subscriber } from '../observable.ts'
import { Timers, jitter } from '../timers.ts'
import { Api } from './api.ts'
import type {
  BackfillAttributes,
  BackfillResponseDTO,
  InjectedTicketDTO,
  MonitorResponseDTO,
} from './dtos.ts'

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

  readonly monitor: Observable<MonitorResponseDTO> = new Observable()
  readonly backfills: Observable<Backfills<A>> = new Observable<Backfills<A>>({})
  readonly assignments: Record<string, InjectedTicketDTO<A>> = {}

  private api: Api | null = null
  private timers = new Timers()
  private _connectedAt = new Map<string, Date>()
  private polling = false
  private creatingBackfills = 0
  private backfillRunning = false
  private backfillPending = false

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

  get connectedAt(): ReadonlyMap<string, Date> {
    return this._connectedAt
  }

  abandonPlayer(ticketId: string, expiredGrace = false): boolean {
    if (ticketId in this.assignments) {
      delete this.assignments[ticketId]
      this._connectedAt.delete(ticketId)
      Logger.log(
        `MM | Backfill - ticket abandoned${expiredGrace ? ' (connection grace period expired)' : ''} [${ticketId}]`,
      )
      this.addBackfills()
      return true
    }

    Logger.warn(`MM | Backfill - ticket abandon failed [${ticketId}]`)
    return false
  }

  playerConnected(ticketId: string): InjectedTicketDTO<A> | null {
    const ticket = this.assignments[ticketId]
    if (!ticket) return null
    if (!this._connectedAt.has(ticketId)) this._connectedAt.set(ticketId, new Date())
    return ticket
  }

  status(): void {
    this.api!.getMonitor(
      (monitor) =>
        this.monitor._update(monitor, monitor.status.toLowerCase() === 'healthy' ? 'healthy' : 'unhealthy'),
      (error) => this.monitor._error(`get monitor failed (unexpected error)\n${error}`, null),
    )
  }

  addBackfills(): void {
    if (this.backfillRunning) {
      this.backfillPending = true
      return
    }

    this.backfillRunning = true
    try {
      do {
        this.backfillPending = false
        const plannedBackfills =
          this.targetTeamSize - (Object.keys(this.assignments).length + this.backfillCount())
        for (let i = 0; i < plannedBackfills; ++i) this.startNewBackfill()
      } while (this.backfillPending)
    } finally {
      this.backfillRunning = false
      this.backfillPending = false
    }
  }

  abandonBackfill(backfillId: string, onCompleted?: () => void): void {
    if (!(backfillId in this.backfills.current!)) {
      this.backfills._notify(`abandon failed (not found) [${backfillId}]`, ObservableActionType.Warn)
      return
    }

    this.api!.deleteBackfill(
      backfillId,
      () => {
        this.backfills._notify(`abandoned [${backfillId}]`)
        this.removeBackfill(this.backfills.current!, backfillId, onCompleted)
      },
      (error, response) => {
        this.backfills._notify(
          response.status === 404
            ? `abandon failed (not found) [${backfillId}]`
            : `abandon failed [${backfillId}]\n${error}`,
          ObservableActionType.Warn,
        )
        this.removeBackfill(this.backfills.current!, backfillId, onCompleted)
      },
    )
  }

  abandonAllBackfills(onCompleted?: () => void): void {
    this.polling = false

    const ids = Object.keys(this.backfills.current!)
    const finished = this.timers.countdown(ids.length, () => onCompleted?.())
    ids.forEach((id) => this.abandonBackfill(id, finished))
  }

  initialize(
    tickets: Record<string, InjectedTicketDTO<A>>,
    onMonitorUpdate: Subscriber<MonitorResponseDTO>,
    onBackfillUpdate: Subscriber<Backfills<A>>,
  ): void {
    if (!this.baseUrl?.trim()) throw new Error('BaseUrl not declared.')
    if (!this.authToken?.trim()) throw new Error('AuthToken not declared.')

    this.api = new Api(this.authToken, this.baseUrl, this.requestTimeoutSeconds)

    Logger.subscribeLogger(this.monitor, 'MM', 'Monitor')
    this.monitor.subscribe(onMonitorUpdate)

    Logger.subscribeLogger(this.backfills, 'MM', 'Backfill', this.logBackfillUpdates)
    this.backfills.subscribe(onBackfillUpdate)

    Object.values(tickets).forEach((ticket) => this.assign(ticket))

    this.status()
  }

  dispose(): void {
    this.polling = false
    this.timers.clear()
    this.api?.dispose()
    this.monitor.clear()
    this.backfills.clear()
  }

  private backfillCount(): number {
    return Object.keys(this.backfills.current!).length + this.creatingBackfills
  }

  private assign(ticket: InjectedTicketDTO<A>): void {
    this.assignments[ticket.id] = assignedTicket(ticket)
    this._connectedAt.delete(ticket.id)
    this.timers.delay(this.connectionGracePeriodSeconds, () => {
      if (ticket.id in this.assignments && !this._connectedAt.has(ticket.id)) {
        this.abandonPlayer(ticket.id, true)
      }
    })
  }

  private removeBackfill(backfills: Backfills<A>, backfillId: string, onCompleted?: () => void): void {
    if (backfillId in backfills) {
      const { [backfillId]: _removed, ...remaining } = backfills
      this.backfills._update(remaining, `removed [${backfillId}]`)
    } else {
      this.backfills._notify(`remove failed (not found) [${backfillId}]`, ObservableActionType.Warn)
    }

    onCompleted?.()
  }

  private startNewBackfill(): void {
    if (Object.keys(this.assignments).length + this.backfillCount() >= this.targetTeamSize) {
      this.backfills._error('maximum capacity currently reached')
      return
    }

    this.creatingBackfills++
    this.api!.createBackfill<A>(
      { profile: this.profile, attributes: this.backfillAttributes, tickets: this.assignments },
      (backfill) => {
        this.creatingBackfills--
        this.backfills._update(
          { ...this.backfills.current, [backfill.id]: backfill },
          `created [${backfill.id}]`,
        )

        if (!this.polling && this.backfillCount() > 0) {
          this.polling = true
          this.timers.delay(jitter(this.pollingBackoffSeconds), () => this.startPollingBackfills())
        }
      },
      (error) => {
        this.creatingBackfills--
        this.backfills._error(`create failed\n${error}`)
      },
    )
  }

  private startPollingBackfills(consecutiveErrors = 0, failedIds: string[] = []): void {
    if (!this.polling) {
      this.backfills._notify('polling stopped')
      return
    }

    if (consecutiveErrors > this.maxConsecutivePollingErrors) {
      this.polling = false
      failedIds
        .filter((id) => id in this.backfills.current!)
        .forEach((id) => this.backfills._error(`polling failed (reached maximum retries) [${id}]`))
      this.abandonAllBackfills()
      return
    }

    const current = Object.values(this.backfills.current!)
    if (current.length === 0) {
      this.polling = false
      this.backfills._notify('polling stopped')
      return
    }

    if (this.logPollingUpdates) {
      this.backfills._notify(`polling [${consecutiveErrors + 1}/${this.maxConsecutivePollingErrors}]`)
    }

    const failed: string[] = []
    const finished = this.timers.countdown(current.length, () => {
      const next = failed.length > 0 ? consecutiveErrors + 1 : 0
      this.timers.delay(jitter(this.pollingBackoffSeconds), () => this.startPollingBackfills(next, failed))
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
              `assigned [${backfill.id}]`,
            )
            this.removeBackfill(this.backfills.current!, backfill.id)
          }
          finished()
        },
        (error, response) => {
          failed.push(b.id)
          if (response.status === 404) {
            this.backfills._notify(`polling failed (not found) [${b.id}]`, ObservableActionType.Warn)
            this.removeBackfill(this.backfills.current!, b.id, () => this.startNewBackfill())
          } else if (response.status !== 429 && response.status < 500) {
            this.backfills._error(`polling failed [${b.id}]\n${error}`)
            this.abandonBackfill(b.id, () => this.startNewBackfill())
          }
          finished()
        },
      ),
    )
  }
}
