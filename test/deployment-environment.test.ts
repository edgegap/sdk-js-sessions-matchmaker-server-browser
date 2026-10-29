import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeploymentEnvironment } from '../src/index.ts'

const PORTS = '{"ports":{"gameport":{"name":"GamePort","internal":7777,"external":31504,"protocol":"WS"}}}'

const MOCK_ENV = {
  ARBITRIUM_REQUEST_ID: 'abc123',
  ARBITRIUM_HOST_ID: 'host-1',
  ARBITRIUM_PUBLIC_IP: '172.236.117.196',
  ARBITRIUM_DEPLOYMENT_TAGS: 'tag1,tag2',
  ARBITRIUM_HOST_BASE_CLOCK_FREQUENCY: '2000',
  ARBITRIUM_DEPLOYMENT_VCPU_UNITS: '1536',
  ARBITRIUM_DEPLOYMENT_MEMORY_MB: '3072',
  ARBITRIUM_DELETE_URL: 'https://api.edgegap.com/v1/self/stop/abc123/1',
  ARBITRIUM_DELETE_TOKEN: 'delete-token',
  ARBITRIUM_BEACON_ENABLED: 'true',
  ARBITRIUM_HOST_BEACON_PUBLIC_IP: '1.2.3.4',
  ARBITRIUM_HOST_BEACON_PORT_UDP_EXTERNAL: '30001',
  ARBITRIUM_HOST_BEACON_PORT_TCP_EXTERNAL: '30002',
  ARBITRIUM_DEPLOYMENT_LOCATION:
    '{"city":"Chicago","country":"United States of America","continent":"North America","administrative_division":"Illinois","timezone":"Central Time"}',
  ARBITRIUM_PORTS_MAPPING: PORTS,
  PATH: '/usr/bin',
}

describe('DeploymentEnvironment.fromEnv', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('parses every deployment variable', () => {
    expect(DeploymentEnvironment.fromEnv(MOCK_ENV)).toEqual({
      requestId: 'abc123',
      hostId: 'host-1',
      publicIp: '172.236.117.196',
      tags: ['tag1', 'tag2'],
      hostBaseClockFrequency: 2000,
      deploymentVcpuUnits: 1536,
      deploymentMemoryMb: 3072,
      selfStopUrl: 'https://api.edgegap.com/v1/self/stop/abc123/1',
      selfStopToken: 'delete-token',
      privateBeaconEnabled: true,
      beaconPublicIp: '1.2.3.4',
      beaconPortUdp: 30001,
      beaconPortTcp: 30002,
      location: {
        city: 'Chicago',
        country: 'United States of America',
        continent: 'North America',
        administrative_division: 'Illinois',
        timezone: 'Central Time',
      },
      portMapping: {
        gameport: {
          name: 'GamePort',
          internal: 7777,
          external: 31504,
          protocol: 'WS',
          link: 'abc123.pr.edgegap.net:31504',
        },
      },
      fqdn: 'abc123.pr.edgegap.net',
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps a link that is already set', () => {
    const env = DeploymentEnvironment.fromEnv({
      ARBITRIUM_PORTS_MAPPING: '{"ports":{"web":{"external":1,"link":"custom:1"}}}',
    })

    expect(env.portMapping?.['web']?.link).toBe('custom:1')
  })

  it('defaults unset variables and builds links from an empty fqdn', () => {
    const env = DeploymentEnvironment.fromEnv({ ARBITRIUM_PORTS_MAPPING: PORTS })

    expect(env).toMatchObject({
      requestId: null,
      tags: null,
      hostBaseClockFrequency: 0,
      privateBeaconEnabled: false,
      location: null,
      fqdn: '',
    })
    expect(env.portMapping?.['gameport']?.link).toBe(':31504')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Missing variables ARBITRIUM_REQUEST_ID,'))
  })

  it.each(['-1', '1.5', 'abc', '4294967296'])('warns and defaults to 0 for uint %s', (value) => {
    const env = DeploymentEnvironment.fromEnv({
      ARBITRIUM_PORTS_MAPPING: PORTS,
      ARBITRIUM_DEPLOYMENT_MEMORY_MB: value,
    })

    expect(env.deploymentMemoryMb).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^⚠️ Edgegap Edgegap Env \| Couldn't parse variable 'ARBITRIUM_DEPLOYMENT_MEMORY_MB', consider updating Edgegap SDK\.\n/,
      ),
    )
  })

  it('accepts uints with surrounding whitespace and a plus sign', () => {
    expect(
      DeploymentEnvironment.fromEnv({ ARBITRIUM_PORTS_MAPPING: PORTS, ARBITRIUM_DEPLOYMENT_VCPU_UNITS: ' +256 ' })
        .deploymentVcpuUnits,
    ).toBe(256)
  })

  it('treats only the exact string true as enabled', () => {
    expect(
      DeploymentEnvironment.fromEnv({ ARBITRIUM_PORTS_MAPPING: PORTS, ARBITRIUM_BEACON_ENABLED: 'True' })
        .privateBeaconEnabled,
    ).toBe(false)
  })

  it('warns and defaults to null for malformed location JSON', () => {
    const env = DeploymentEnvironment.fromEnv({ ...MOCK_ENV, ARBITRIUM_DEPLOYMENT_LOCATION: '{' })

    expect(env.location).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('warns once listing every missing variable, and continues for local runs', () => {
    const env = DeploymentEnvironment.fromEnv({ PATH: '/usr/bin' })

    expect(env.requestId).toBeNull()
    expect(env.portMapping).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      '⚠️ Edgegap Edgegap Env | Missing variables ' +
        Object.keys(MOCK_ENV)
          .filter((key) => key.startsWith('ARBITRIUM_'))
          .join(', ') +
        '. This is expected when running outside an Edgegap deployment.',
    )
  })

  it('lists only the variables that are missing', () => {
    const { ARBITRIUM_DELETE_URL: _url, ARBITRIUM_PORTS_MAPPING: _ports, ...env } = MOCK_ENV

    DeploymentEnvironment.fromEnv(env)

    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Missing variables ARBITRIUM_DELETE_URL, ARBITRIUM_PORTS_MAPPING.'),
    )
  })

  it('warns once and continues with a malformed port mapping', () => {
    expect(DeploymentEnvironment.fromEnv({ ...MOCK_ENV, ARBITRIUM_PORTS_MAPPING: '{' }).portMapping).toBeNull()
    expect(DeploymentEnvironment.fromEnv({ ...MOCK_ENV, ARBITRIUM_PORTS_MAPPING: '{}' }).portMapping).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Couldn't parse variable 'ARBITRIUM_PORTS_MAPPING'"))
  })
})
