import type { BeaconDTO } from './dtos.ts'
import { Logger } from './logger.ts'

export interface Ping {
  measure(beacon: BeaconDTO, requests: number): Promise<number>
}

let warned = false

export const stubPing: Ping = {
  measure: () => {
    if (!warned) {
      warned = true
      Logger.warn(
        "Ping | Beacons can't be pinged from browsers or unprivileged runtimes yet, reporting 0 for every beacon.",
      )
    }
    return Promise.resolve(0)
  },
}
