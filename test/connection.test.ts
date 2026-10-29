import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type DeploymentDTO, getConnectionUrl } from '../src/index.ts'

const deployment = (protocol: string): DeploymentDTO => ({
  fqdn: 'abc123.pr.edgegap.net',
  public_ip: '1.2.3.4',
  location: {
    city: 'Chicago',
    country: 'United States of America',
    continent: 'North America',
    administrative_division: 'Illinois',
    timezone: 'Central Time',
  },
  ports: {
    gameport: { internal: 7777, external: 31504, link: 'abc123.pr.edgegap.net:31504', protocol },
  },
})

describe('getConnectionUrl', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it.each(['WSS', 'HTTPS', 'wss'])('returns wss:// for %s', (protocol) => {
    expect(getConnectionUrl(deployment(protocol), 'gameport')).toBe('wss://abc123.pr.edgegap.net:31504')
  })

  it.each(['Websocket', 'WS', 'HTTP'])('returns wss:// for %s with TLS upgrade (default)', (protocol) => {
    expect(getConnectionUrl(deployment(protocol), 'gameport')).toBe('wss://abc123.pr.edgegap.net:31504')
  })

  it.each(['Websocket', 'WS', 'HTTP'])('returns ws:// for %s without TLS, without warning outside https pages', (protocol) => {
    expect(getConnectionUrl(deployment(protocol), 'gameport', { tls: false })).toBe('ws://abc123.pr.edgegap.net:31504')
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns about mixed content on https pages', () => {
    vi.stubGlobal('location', { protocol: 'https:' })

    expect(getConnectionUrl(deployment('Websocket'), 'gameport', { tls: false })).toBe('ws://abc123.pr.edgegap.net:31504')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Port 'gameport' uses 'Websocket' without TLS"))
  })

  it('keeps wss:// for TLS protocols even with tls: false', () => {
    expect(getConnectionUrl(deployment('WSS'), 'gameport', { tls: false })).toBe('wss://abc123.pr.edgegap.net:31504')
  })

  it.each(['TCP', 'UDP', 'TCP/UDP'])('throws for %s and suggests WS with TLS upgrade', (protocol) => {
    expect(() => getConnectionUrl(deployment(protocol), 'gameport')).toThrow(
      `Port 'gameport' uses protocol '${protocol}', which browsers can't open. Use protocol 'WS' with TLS upgrade enabled`,
    )
  })

  it('throws for an unknown port and lists the available ones', () => {
    expect(() => getConnectionUrl(deployment('WSS'), 'web')).toThrow(
      "Port 'web' not found in deployment, available ports: gameport.",
    )
  })
})
