export interface LocationDTO {
  city: string
  country: string
  continent: string
  administrative_division: string
  timezone: string
}

export interface PortMappingDTO {
  internal: number
  external: number
  link: string
  protocol: string
}

export interface DeploymentDTO {
  fqdn: string
  public_ip: string
  ports: Record<string, PortMappingDTO>
  location: LocationDTO
}

export interface BeaconDTO {
  fqdn: string
  public_ip: string
  tcp_port: number
  udp_port: number
  location: LocationDTO
}

export interface BeaconsResponseDTO {
  count: number
  beacons: BeaconDTO[]
}
