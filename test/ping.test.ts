import { expect, it, vi } from 'vitest'
import { type BeaconDTO, stubPing } from '../src/index.ts'

it('stub ping measures nothing and warns once', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const beacon = { public_ip: '1.2.3.4' } as BeaconDTO

  expect(await stubPing.measure(beacon, 3)).toBeNull()
  expect(await stubPing.measure(beacon, 3)).toBeNull()
  expect(warn).toHaveBeenCalledOnce()
})
