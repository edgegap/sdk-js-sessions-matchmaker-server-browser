# Edgegap SDK for JavaScript

[![npm](https://img.shields.io/npm/v/@edgegap/sdk)](https://www.npmjs.com/package/@edgegap/sdk)
[![CI](https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeScript SDK for [Edgegap Matchmaking](https://docs.edgegap.com/learn/matchmaking/matchmaker-in-depth). Use it in browser games to find matches and connect to game servers over secure WebSockets, and in Node, Bun, or Deno game servers to read match data and fill empty seats with backfills.

- Zero runtime dependencies, ESM and CommonJS builds, full type definitions.
- A single-file browser build for HTML games without a bundler.
- Retries with backoff on network failures, `429`, and `5xx` responses.
- Typed events for every state change, so handlers branch on an event `code` instead of parsing messages.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Verified sources](#verified-sources)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Events](#events)
- [Updating](#updating)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- **Edgegap:** a [Matchmaker](https://docs.edgegap.com/learn/matchmaking/matchmaker-in-depth) with its URL and auth token, and an app version whose game port uses the `WS` protocol with TLS upgrade enabled, so browsers can connect.
- **Browsers:** any evergreen browser. The page origin must be listed in the Matchmaker's `allowed_cors_origins` (see [CORS](#cors)).
- **Servers:** Node.js 22 or later, Bun, or Deno. The SDK needs the global `fetch` and `AbortController`.
- **TypeScript (optional):** types ship with the package, no `@types` package needed.

## Installation

```sh
npm install @edgegap/sdk
```

Or with another package manager:

```sh
pnpm add @edgegap/sdk
yarn add @edgegap/sdk
bun add @edgegap/sdk
deno add npm:@edgegap/sdk
```

The package has two entry points:

| Import | Contents |
| --- | --- |
| `@edgegap/sdk` | Shared utilities: `getConnectionUrl`, `DeploymentEnvironment`, `Observable`, `Logger`, HTTP helpers |
| `@edgegap/sdk/matchmaking` | `GroupAgent`, `ServerAgent`, `MatchEnvironment`, `Api`, request and response types, `presets` |

### Without a bundler

Load the browser build from a CDN. It exposes everything under the `Edgegap` global, with Matchmaking under `Edgegap.matchmaking`:

```html
<script src="https://cdn.jsdelivr.net/npm/@edgegap/sdk@1.0.0/dist/browser/edgegap.iife.js"></script>
<script>
  const agent = new Edgegap.matchmaking.GroupAgent({ baseUrl: '...', authToken: '...' })
</script>
```

Or as an ES module:

```html
<script type="module">
  import { matchmaking, getConnectionUrl } from 'https://cdn.jsdelivr.net/npm/@edgegap/sdk@1.0.0/dist/browser/edgegap.js'
</script>
```

## Verified sources

Edgegap publishes this SDK only from these places:

| Source | Location |
| --- | --- |
| npm | [`@edgegap/sdk`](https://www.npmjs.com/package/@edgegap/sdk), under the `@edgegap` scope |
| Source code | [github.com/edgegap/sdk-js-sessions-matchmaker-server-browser](https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser) |
| Documentation | [docs.edgegap.com](https://docs.edgegap.com) |
| CDN | jsDelivr and unpkg mirrors of the npm package (`cdn.jsdelivr.net/npm/@edgegap/sdk`, `unpkg.com/@edgegap/sdk`) |

Packages with similar names outside the `@edgegap` scope are not affiliated with Edgegap.

Every release is built and published by [GitHub Actions](.github/workflows/release.yml) with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), which links the published package to the commit and workflow that built it. The npm page shows a "Built and signed on GitHub Actions" badge. To verify the signatures and provenance of your installed packages:

```sh
npm audit signatures
```

When loading the SDK from a CDN, pin an exact version and add a [Subresource Integrity](https://developer.mozilla.org/docs/Web/Security/Subresource_Integrity) hash, so the browser refuses a modified file:

```sh
curl -s https://cdn.jsdelivr.net/npm/@edgegap/sdk@1.0.0/dist/browser/edgegap.iife.js | openssl dgst -sha384 -binary | openssl base64 -A
```

```html
<script
  src="https://cdn.jsdelivr.net/npm/@edgegap/sdk@1.0.0/dist/browser/edgegap.iife.js"
  integrity="sha384-<hash from the command above>"
  crossorigin="anonymous"
></script>
```

## Quick start

A browser client that finds a match and connects to its game server:

```ts
import { getConnectionUrl } from '@edgegap/sdk'
import { GroupAgent } from '@edgegap/sdk/matchmaking'

const agent = new GroupAgent<{ beacons: Record<string, number> }>({
  baseUrl: 'https://<your-matchmaker>.edgegap.net',
  authToken: '<matchmaker client token>',
})

agent.initialize(
  (_monitor, _type, message) => console.log('matchmaker', message),
  (group, _type, _message, event) => {
    if (event.code !== 'updated' || event.status !== 'HOST_ASSIGNED') return

    const socket = new WebSocket(getConnectionUrl(group.current!.assignment!, 'gameport'))
    socket.addEventListener('open', () => socket.send(JSON.stringify({ ticketId: group.current!.ticket_id })))
  },
)

const { beacons } = await agent.beacons()
const latencies = await agent.measureBeaconsRoundTripTime(beacons)

agent.createGroup({ profile: 'my-profile', attributes: { beacons: latencies }, is_ready: true }, true)
```

`profile` and `attributes` must match a profile in your Matchmaker configuration. `gameport` is the port name from your app version.

## Usage

### Matchmaking in the browser

`GroupAgent` creates a group, polls it until the Matchmaker assigns a server, and exposes its state through two observables:

- `agent.monitor` holds the Matchmaker health.
- `agent.group` holds the current group: `group_id`, `member_id`, `ticket_id`, `status` (`SEARCHING`, `TEAM_FOUND`, `MATCH_FOUND`, `HOST_ASSIGNED`, or `CANCELLED`), and the `assignment` once a server is ready.

Call `initialize(onMonitorUpdate, onGroupUpdate)` once before anything else. It checks that `baseUrl` and `authToken` are set, subscribes your callbacks, and requests the Matchmaker status.

| Method | Description |
| --- | --- |
| `createGroup(request, abandon?)` | Creates a group with this player as its owner, then starts polling. |
| `joinGroup(request, groupId, abandon?)` | Joins an existing group, then starts polling. |
| `setReady(isReady)` | Marks this player ready or not ready. The group starts searching once every member is ready. |
| `resumeMatchmaking(group, abandon?)` | Resumes polling a group saved earlier, for example after a page reload. |
| `stopMatchmaking(onCompleted?)` | Leaves the group, or deletes it if this player owns it. A group that already found a match can't be left. |
| `beacons()` | Lists Edgegap ping beacons. |
| `measureBeaconsRoundTripTime(beacons, requests?)` | Returns the latency per beacon city, ready to send as the `beacons` attribute. |
| `dispose()` | Clears timers, aborts requests, and removes subscribers. |

Pass `abandon: true` to replace a group the agent already tracks. Without it, the call fails with a `conflict` error.

After `HOST_ASSIGNED` or `CANCELLED`, polling stops, and the group is cleared with a `removed` event after `removeGroupSeconds` (30 by default).

#### Playing with friends

The group owner creates a group and shares its ID. Every member joins with it, then readies up:

```ts
owner.group.subscribe((group, _type, _message, event) => {
  if (event.code === 'created') shareWithFriends(group.current!.group_id)
})
owner.createGroup({ profile: 'my-profile', attributes, is_ready: false }, true)

// on each friend's device, once they receive the group ID
friend.joinGroup({ profile: 'my-profile', attributes, is_ready: false }, groupId, true)

// on every device, when the player is ready
agent.setReady(true)
```

#### Surviving a page reload

Save the group when it changes, and resume it when the page loads:

```ts
agent.initialize(onMonitorUpdate, (group) => {
  group.current
    ? localStorage.setItem('edgegap-group', JSON.stringify(group.current))
    : localStorage.removeItem('edgegap-group')
})

const saved = localStorage.getItem('edgegap-group')
if (saved) agent.resumeMatchmaking(JSON.parse(saved))
```

#### Latency

Browsers can't send the ICMP, UDP, or TCP pings that Edgegap beacons answer, so the default `measureBeaconsRoundTripTime` reports `0` for every beacon and logs one warning. To measure latency another way, pass your own implementation of the `Ping` interface:

```ts
const agent = new GroupAgent({
  baseUrl,
  authToken,
  ping: { measure: async (beacon, requests) => measureSomehow(beacon, requests) },
})
```

#### Connecting to the game server

`getConnectionUrl(deployment, portName, { tls })` builds a WebSocket URL from an assignment:

| Port protocol | Result |
| --- | --- |
| `WSS`, `HTTPS` | `wss://{link}` |
| `Websocket`, `WS`, `HTTP` | `wss://{link}`, or `ws://{link}` with `tls: false` |
| `TCP`, `UDP`, `TCP/UDP` | Throws, because browsers can't open raw sockets |

The Matchmaker reports a WS port as `Websocket` whether TLS upgrade is on or not, so the default assumes it is. Browsers block `ws://` from `https://` pages, so enable TLS upgrade on the port, and use `tls: false` only for local development.

Game servers can still be starting when the group reaches `HOST_ASSIGNED`. Retry the connection a few times before giving up.

#### Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | required | Matchmaker URL |
| `authToken` | required | Matchmaker client token |
| `requestTimeoutSeconds` | `3` | Timeout for each request |
| `pollingBackoffSeconds` | `1` | Delay between polls |
| `maxConsecutivePollingErrors` | `10` | Polling errors in a row before matchmaking stops |
| `removeGroupSeconds` | `30` | Delay before a finished group is cleared |
| `logGroupUpdates` | `true` | Log group changes to the console |
| `logPollingUpdates` | `false` | Log every poll |
| `ping` | reports `0` | Latency measurement, see [Latency](#latency) |

### Game servers

#### Deployment and match data

Edgegap passes deployment and match details to your game server as environment variables. Parse them with:

```ts
import { DeploymentEnvironment } from '@edgegap/sdk'
import { MatchEnvironment } from '@edgegap/sdk/matchmaking'

const deployment = DeploymentEnvironment.fromEnv(process.env)
const match = MatchEnvironment.fromEnv(process.env)
```

`deployment` holds `requestId`, `fqdn`, `publicIp`, `location`, `portMapping`, `selfStopUrl`, `selfStopToken`, and the host resources. `match` holds `matchProfile`, `matchId`, `tickets` (by ticket ID), `groups`, `teams`, and the matched `equality` and `intersection` values.

Parsing never throws, so the same build runs locally. Missing variables are listed in one warning, and malformed values fall back to `null` or `0`.

To stop the deployment once the match is over:

```ts
await fetch(deployment.selfStopUrl!, { method: 'DELETE', headers: { authorization: deployment.selfStopToken! } })
```

#### Backfill

`ServerAgent` keeps a running server full by creating backfills for empty seats. Players matched into a backfill join the existing server instead of starting a new one.

```ts
import { DeploymentEnvironment } from '@edgegap/sdk'
import { MatchEnvironment, ServerAgent } from '@edgegap/sdk/matchmaking'

const deployment = DeploymentEnvironment.fromEnv(process.env)
const match = MatchEnvironment.fromEnv(process.env)

const agent = new ServerAgent({
  baseUrl: process.env.MATCHMAKER_URL!,
  authToken: process.env.MATCHMAKER_TOKEN!,
  profile: match.matchProfile!,
  targetTeamSize: 4,
  attributes: {
    assignment: {
      request_id: deployment.requestId!,
      fqdn: deployment.fqdn,
      public_ip: deployment.publicIp!,
      ports: deployment.portMapping!,
      location: deployment.location!,
    },
  },
})

agent.initialize(
  match.tickets,
  (_monitor, _type, message) => console.log('matchmaker', message),
  (_backfills, _type, _message, event) => {
    if (event.code === 'assigned') console.log(`ticket ${event.ticketId} is joining`)
  },
)
agent.addBackfills()
```

| Method | Description |
| --- | --- |
| `initialize(tickets, onMonitorUpdate, onBackfillUpdate)` | Registers the players already matched to this server. |
| `addBackfills()` | Creates backfills until assigned players plus open backfills reach `targetTeamSize`. |
| `playerConnected(ticketId)` | Marks a player as connected. Returns the player's ticket, or `null` if the ticket isn't assigned to this server, in which case you should reject the connection. |
| `abandonPlayer(ticketId)` | Frees a player's seat, for example on disconnect, and creates a backfill for it. |
| `abandonBackfill(backfillId, onCompleted?)` | Deletes one backfill. |
| `abandonAllBackfills(onCompleted?)` | Deletes every backfill, for example when the match starts or the server shuts down. |
| `dispose()` | Clears timers, aborts requests, and removes subscribers. |

Players that don't call `playerConnected` within `connectionGracePeriodSeconds` (60 by default) are abandoned automatically. Clients get their ticket ID from `group.current.ticket_id` and should send it when they connect, as in the [Quick start](#quick-start).

`agent.backfills` holds the open backfills by ID, `agent.assignments` the assigned players by ticket ID, and `agent.connectedAt` the time each player connected.

### Tokens

The Matchmaker client token is meant to ship in game clients. Tokens your game servers use must never be included in a browser bundle. Load them from environment variables on the server.

### CORS

Add every origin that serves your game to `allowed_cors_origins` in your Matchmaker configuration. Entries are matched against the full origin, including the scheme and port:

- `https://*.my-game.com` matches every subdomain over HTTPS.
- `localhost` matches nothing. List local dev servers in full, for example `http://localhost:5173`.

### Logging

Agents log state changes to the console with an `Edgegap` prefix. Turn them off with `logGroupUpdates: false` or `logBackfillUpdates: false`, and turn on per-poll logs with `logPollingUpdates: true`.

## Events

Every observable calls its subscribers with `(observable, type, message, event)`:

- `observable.current` and `observable.previous` hold the new and old state, and `observable.error` holds the last error message.
- `type` is an `ObservableActionType`: `Log`, `Update`, `Warn`, or `Error`.
- `message` is a human-readable description.
- `event` is a typed object with a `code` and its details. Branch on `event.code`, since messages may change between versions.

`subscribe` returns an unsubscribe function, so observables also work with React's `useSyncExternalStore`.

### `GroupEvent` (`agent.group`)

| Code | When |
| --- | --- |
| `created`, `joined`, `resumed` | The group was created, joined, or resumed |
| `member_updated` | `setReady` succeeded (`isReady`) |
| `updated` | The group status changed (`status`) |
| `abandoned` | The player left or deleted the group |
| `removed` | A finished group was cleared |
| `conflict` | A group is already tracked and `abandon` wasn't set |
| `not_found` | The group doesn't exist |
| `create_failed`, `join_failed`, `update_failed`, `member_update_failed` | A request failed (`detail`) |
| `abandon_failed`, `restart_skipped` | The group couldn't be left (`reason`), and a follow-up action was skipped |
| `polling`, `polling_stopped`, `polling_failed` | Polling progress and failures (`reason`) |

### `BackfillEvent` (`agent.backfills`)

| Code | When |
| --- | --- |
| `created` | A backfill was created (`backfillId`) |
| `assigned` | A player was matched into a backfill (`backfillId`, `ticketId`) |
| `removed`, `abandoned` | A backfill was removed or deleted (`backfillId`) |
| `capacity_reached` | The server is full, so no backfill was created |
| `create_failed`, `remove_failed`, `abandon_failed` | A request failed |
| `polling`, `polling_stopped`, `polling_failed` | Polling progress and failures |

### `MonitorEvent` (`agent.monitor`)

`healthy`, `unhealthy`, `monitor_failed`, and `beacons_failed`.

## Updating

The SDK follows [semantic versioning](https://semver.org). Minor and patch releases are backward compatible, and breaking changes only ship in a new major version. Release notes are published on [GitHub Releases](https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser/releases).

Check for a newer version:

```sh
npm outdated @edgegap/sdk
```

Update within your current major version, as allowed by the range in your `package.json`:

```sh
npm update @edgegap/sdk
```

Update to the latest version, including a new major version:

```sh
npm install @edgegap/sdk@latest
```

When loading from a CDN, change the version in the URL and regenerate the integrity hash. A range such as `@edgegap/sdk@1` follows new releases automatically, but it can't be combined with an integrity hash.

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser/issues). Planned work is listed in the [roadmap](ROADMAP.md). For larger changes, open an issue first to agree on the approach.

### Setup

Development needs Node.js 22.18 or later, as required by the build and test tools.

```sh
git clone https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser.git
cd sdk-js-sessions-matchmaker-server-browser
npm ci
```

| Script | Description |
| --- | --- |
| `npm run typecheck` | Type-checks the source and tests |
| `npm test` | Runs the unit tests |
| `npm run test:watch` | Runs the unit tests in watch mode |
| `npm run test:integration` | Runs the integration tests against a real Matchmaker |
| `npm run build` | Builds `dist/` |

### Integration tests

Integration tests run against a Matchmaker using the advanced example profile, and are skipped unless these variables are set:

| Variable | Description |
| --- | --- |
| `EDGEGAP_MM_URL` | Matchmaker URL |
| `EDGEGAP_MM_TOKEN` | Matchmaker auth token |
| `EDGEGAP_MM_ALLOW_DEPLOY` | Set to `1` to also run the backfill assignment test, which can start a deployment |

The other tests never ready a full group, so they don't start deployments.

### Guidelines

- Keep the package free of runtime dependencies.
- Write strict TypeScript without `enum`, namespaces, or other TypeScript-only runtime syntax, so the source runs with Node's type stripping.
- Keep request and response types identical to the API's JSON, including snake_case keys.
- Add tests for every behavior change. Unit tests use Vitest with fake timers and a stubbed `fetch`.
- Make sure `npm run typecheck`, `npm test`, and `npm run build` pass before opening a pull request. CI runs them on Node 22 and 24.

### Releasing

Maintainers release from `main`:

1. Bump `version` in `package.json` and commit it.
2. Create a GitHub release with a tag matching the version, for example `v1.0.0`.
3. The [release workflow](.github/workflows/release.yml) checks the tag, runs the checks, and publishes to npm with provenance.

## License

[MIT](LICENSE) © Edgegap Technologies
