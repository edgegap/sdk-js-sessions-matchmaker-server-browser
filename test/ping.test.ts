import { expect, it, vi } from 'vitest'
import { type BeaconDTO, stubPing } from '../src/index.ts'

it('stub ping reports 0 for every beacon and warns once', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const beacon = { public_ip: '1.2.3.4' } as BeaconDTO

  expect(await stubPing.measure(beacon, 3)).toBe(0)
  expect(await stubPing.measure(beacon, 3)).toBe(0)
  expect(warn).toHaveBeenCalledOnce()
})
