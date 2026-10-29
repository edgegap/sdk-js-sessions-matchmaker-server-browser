import type { DeploymentDTO } from './dtos.ts'
import { Logger } from './logger.ts'

export interface ConnectionOptions {
  tls?: boolean
}

export const getConnectionUrl = (
  deployment: DeploymentDTO,
  portName: string,
  { tls = true }: ConnectionOptions = {},
): string => {
  const port = deployment.ports?.[portName]
  if (!port) {
    const available = Object.keys(deployment.ports ?? {}).join(', ') || 'none'
    throw new Error(`Port '${portName}' not found in deployment, available ports: ${available}.`)
  }

  const protocol = port.protocol.toUpperCase()
  if (protocol === 'WSS' || protocol === 'HTTPS') return `wss://${port.link}`
  if (protocol !== 'WS' && protocol !== 'WEBSOCKET' && protocol !== 'HTTP') {
    throw new Error(
      `Port '${portName}' uses protocol '${port.protocol}', which browsers can't open. ` +
        `Use protocol 'WS' with TLS upgrade enabled for this port in your app version.`,
    )
  }
  if (tls) return `wss://${port.link}`

  if ((globalThis as { location?: { protocol?: string } }).location?.protocol === 'https:') {
    Logger.warn(
      `Connection | Port '${portName}' uses '${port.protocol}' without TLS, browsers block ws:// from https:// pages. ` +
        `Enable TLS upgrade for this port in your app version.`,
    )
  }
  return `ws://${port.link}`
}
