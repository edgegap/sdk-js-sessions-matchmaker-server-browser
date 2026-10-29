import { type Observable, ObservableActionType } from './observable.ts'

const toStringOrNull = (value: unknown): string => {
  if (value === null || value === undefined) return 'null'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const formatNotifyMessage = (
  service: string,
  subject: string,
  message: string,
  value: unknown,
): string => `${service} | ${subject}.notify('${message}')\n${toStringOrNull(value)}`

const formatUpdateMessage = (
  service: string,
  subject: string,
  message: string,
  previous: unknown,
  current: unknown,
): string =>
  [
    `${service} | ${subject}.changed('${message}')`,
    `current: ${toStringOrNull(current)}`,
    `previous: ${toStringOrNull(previous)}`,
  ].join('\n')

const formatErrorMessage = (
  service: string,
  subject: string,
  message: string,
  value: unknown,
): string => `${service} | ${subject}.error:${message}\n${toStringOrNull(value)}`

const log = (message: unknown): void => console.log(`ℹ️ Edgegap ${message}`)
const warn = (message: unknown): void => console.warn(`⚠️ Edgegap ${message}`)
const error = (message: unknown): void => console.error(`❗ Edgegap ${message}`)

export const Logger: {
  log: typeof log
  warn: typeof warn
  error: typeof error
  formatNotifyMessage: typeof formatNotifyMessage
  formatUpdateMessage: typeof formatUpdateMessage
  formatErrorMessage: typeof formatErrorMessage
  toStringOrNull: typeof toStringOrNull
  subscribeLogger: <T>(
    observable: Observable<T>,
    service: string,
    subject: string,
    enabled?: boolean,
  ) => () => void
} = {
  log,
  warn,
  error,
  formatNotifyMessage,
  formatUpdateMessage,
  formatErrorMessage,
  toStringOrNull,
  subscribeLogger: (observable, service, subject, enabled = true) =>
    observable.subscribe((obs, type, message) => {
      if (!enabled) return
      if (type === ObservableActionType.Update) {
        log(formatUpdateMessage(service, subject, message, obs.previous, obs.current))
        return
      }
      if (type === ObservableActionType.Error) {
        error(formatErrorMessage(service, subject, message, obs.current))
        return
      }
      const notify = formatNotifyMessage(service, subject, message, obs.current)
      type === ObservableActionType.Log ? log(notify) : warn(notify)
    }),
}
