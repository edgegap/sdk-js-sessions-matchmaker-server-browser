import type { LocationDTO, PortMappingDTO } from './dtos.ts'
import { Logger } from './logger.ts'

export type Env = Record<string, string | undefined>

export interface DeploymentEnvironment {
  requestId: string | null
  hostId: string | null
  publicIp: string | null
  tags: string[] | null
  hostBaseClockFrequency: number
  deploymentVcpuUnits: number
  deploymentMemoryMb: number
  selfStopUrl: string | null
  selfStopToken: string | null
  privateBeaconEnabled: boolean
  beaconPublicIp: string | null
  beaconPortUdp: number
  beaconPortTcp: number
  location: LocationDTO | null
  portMapping: Record<string, PortMappingDTO> | null
  fqdn: string
}

const UINT_MAX = 0xffffffff

const requireValue = (value: string | undefined): string => {
  if (value === undefined) throw new TypeError('Object reference not set to an instance of an object.')
  return value
}

const parseUInt = (raw: string): number => {
  if (!/^\s*\+?\d+\s*$/.test(raw)) throw new Error('Input string was not in a correct format.')
  const value = Number(raw)
  if (value > UINT_MAX) throw new Error('Value was either too large or too small for a UInt32.')
  return value
}

export const tryParseEnvVariable = <V>(
  key: string,
  value: string | undefined,
  convert: (raw: string) => V,
  fallback: V,
): V => {
  try {
    return convert(requireValue(value))
  } catch (error) {
    Logger.warn(
      `Edgegap Env | Couldn't parse variable '${key}', consider updating Edgegap SDK.\n${(error as Error).message}`,
    )
    return fallback
  }
}

export const tryParseEnvVariableString = (key: string, value: string | undefined): string | null =>
  tryParseEnvVariable(key, value, (raw) => raw, null)

export const tryParseEnvVariableUInt = (key: string, value: string | undefined): number =>
  tryParseEnvVariable(key, value, parseUInt, 0)

export const tryParseEnvVariableBool = (key: string, value: string | undefined): boolean =>
  tryParseEnvVariable(key, value, (raw) => raw === 'true', false)

export const tryParseEnvVariableJSON = <V>(key: string, value: string | undefined): V | null =>
  tryParseEnvVariable<V | null>(key, value, (raw) => JSON.parse(raw) as V | null, null)

const fromEnv = (env: Env): DeploymentEnvironment => {
  const result: Omit<DeploymentEnvironment, 'fqdn'> = {
    requestId: null,
    hostId: null,
    publicIp: null,
    tags: null,
    hostBaseClockFrequency: 0,
    deploymentVcpuUnits: 0,
    deploymentMemoryMb: 0,
    selfStopUrl: null,
    selfStopToken: null,
    privateBeaconEnabled: false,
    beaconPublicIp: null,
    beaconPortUdp: 0,
    beaconPortTcp: 0,
    location: null,
    portMapping: null,
  }

  const parsers = new Map<string, (key: string, value: string | undefined) => void>([
    ['ARBITRIUM_REQUEST_ID', (k, v) => (result.requestId = tryParseEnvVariableString(k, v))],
    ['ARBITRIUM_HOST_ID', (k, v) => (result.hostId = tryParseEnvVariableString(k, v))],
    ['ARBITRIUM_PUBLIC_IP', (k, v) => (result.publicIp = tryParseEnvVariableString(k, v))],
    ['ARBITRIUM_DEPLOYMENT_TAGS', (k, v) => (result.tags = tryParseEnvVariableString(k, v)?.split(',') ?? null)],
    ['ARBITRIUM_HOST_BASE_CLOCK_FREQUENCY', (k, v) => (result.hostBaseClockFrequency = tryParseEnvVariableUInt(k, v))],
    ['ARBITRIUM_DEPLOYMENT_VCPU_UNITS', (k, v) => (result.deploymentVcpuUnits = tryParseEnvVariableUInt(k, v))],
    ['ARBITRIUM_DEPLOYMENT_MEMORY_MB', (k, v) => (result.deploymentMemoryMb = tryParseEnvVariableUInt(k, v))],
    ['ARBITRIUM_DELETE_URL', (k, v) => (result.selfStopUrl = tryParseEnvVariableString(k, v))],
    ['ARBITRIUM_DELETE_TOKEN', (k, v) => (result.selfStopToken = tryParseEnvVariableString(k, v))],
    ['ARBITRIUM_BEACON_ENABLED', (k, v) => (result.privateBeaconEnabled = tryParseEnvVariableBool(k, v))],
    ['ARBITRIUM_HOST_BEACON_PUBLIC_IP', (k, v) => (result.beaconPublicIp = tryParseEnvVariableString(k, v))],
    ['ARBITRIUM_HOST_BEACON_PORT_UDP_EXTERNAL', (k, v) => (result.beaconPortUdp = tryParseEnvVariableUInt(k, v))],
    ['ARBITRIUM_HOST_BEACON_PORT_TCP_EXTERNAL', (k, v) => (result.beaconPortTcp = tryParseEnvVariableUInt(k, v))],
    ['ARBITRIUM_DEPLOYMENT_LOCATION', (k, v) => (result.location = tryParseEnvVariableJSON<LocationDTO>(k, v))],
    [
      'ARBITRIUM_PORTS_MAPPING',
      (k, v) =>
        (result.portMapping =
          tryParseEnvVariableJSON<{ ports?: Record<string, PortMappingDTO> }>(k, v)?.ports ?? null),
    ],
  ])

  Object.entries(env).forEach(([key, value]) => parsers.get(key)?.(key, value))

  const missing = [...parsers.keys()].filter((key) => env[key] === undefined)
  if (missing.length > 0) {
    Logger.warn(
      `Edgegap Env | Missing variables ${missing.join(', ')}. This is expected when running outside an Edgegap deployment.`,
    )
  }

  const fqdn = result.requestId ? `${result.requestId}.pr.edgegap.net` : ''
  Object.values(result.portMapping ?? {}).forEach((port) => {
    port.link ??= `${fqdn}:${port.external}`
  })

  return { ...result, fqdn }
}

export const DeploymentEnvironment: { fromEnv: (env: Env) => DeploymentEnvironment } = { fromEnv }
