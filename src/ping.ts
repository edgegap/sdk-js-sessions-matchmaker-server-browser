import type { BeaconDTO } from './dtos.ts'
import { Logger } from './logger.ts'

export interface Ping {
  /**
   * Resolves with the beacon's round trip time in milliseconds, or `null` when it can't be measured.
   * Beacons without a measurement are left out of the latencies, so players aren't matched in regions
   * they can't reach.
   */
  measure(beacon: BeaconDTO, requests: number): Promise<number | null>
}

let warned = false

export const stubPing: Ping = {
  measure: () => {
    if (!warned) {
      warned = true
      Logger.warn(
        "Ping | Beacons can't be pinged from browsers or unprivileged runtimes yet, leaving every beacon out of the latencies.",
      )
    }
    return Promise.resolve(null)
  },
}
