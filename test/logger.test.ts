import { describe, expect, it, vi } from 'vitest'
import { Logger, Observable, ObservableActionType } from '../src/index.ts'

const spyConsole = () => ({
  log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
})

describe('Logger', () => {
  it('prefixes each level', () => {
    const console = spyConsole()

    Logger.log('a')
    Logger.warn('b')
    Logger.error('c')

    expect(console.log).toHaveBeenCalledWith('ℹ️ Edgegap a')
    expect(console.warn).toHaveBeenCalledWith('⚠️ Edgegap b')
    expect(console.error).toHaveBeenCalledWith('❗ Edgegap c')
  })

  it('formats messages with JSON values and null', () => {
    expect(Logger.formatNotifyMessage('MM', 'Group', 'polling', { id: 'a' })).toBe(
      `MM | Group.notify('polling')\n{"id":"a"}`,
    )
    expect(Logger.formatUpdateMessage('MM', 'Group', 'created', null, { id: 'a' })).toBe(
      `MM | Group.changed('created')\ncurrent: {"id":"a"}\nprevious: null`,
    )
    expect(Logger.formatErrorMessage('MM', 'Group', 'failed', undefined)).toBe(
      'MM | Group.error:failed\nnull',
    )
  })

  it('routes observable events to the matching level', () => {
    const console = spyConsole()
    const observable = new Observable<{ id: string } | null>(null)
    Logger.subscribeLogger(observable, 'SB', 'Instance')

    observable._update({ id: 'a' }, { code: 'created' })
    observable._notify({ code: 'heartbeat' })
    observable._notify({ code: 'conflict' }, ObservableActionType.Warn)
    observable._error({ code: 'failed' })

    expect(console.log.mock.calls).toEqual([
      [`ℹ️ Edgegap SB | Instance.changed('created')\ncurrent: {"id":"a"}\nprevious: null`],
      [`ℹ️ Edgegap SB | Instance.notify('heartbeat')\n{"id":"a"}`],
    ])
    expect(console.warn.mock.calls).toEqual([
      [`⚠️ Edgegap SB | Instance.notify('conflict')\n{"id":"a"}`],
    ])
    expect(console.error.mock.calls).toEqual([[`❗ Edgegap SB | Instance.error:failed\n{"id":"a"}`]])
  })

  it('stays silent when disabled', () => {
    const console = spyConsole()
    const observable = new Observable(0)
    Logger.subscribeLogger(observable, 'SB', 'Instance', false)

    observable._update(1, { code: 'changed' })
    observable._error({ code: 'failed' })

    expect(console.log).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })
})
