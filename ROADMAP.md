# Roadmap

Phase 1 is a faithful port of the [Unity SDK v3.5.6](https://github.com/edgegap/sdk-unity-sessions-matchmaker-server-browser) to JavaScript/TypeScript. Nothing in this file is implemented in phase 1 unless it is listed under "Phase 1 decisions", "Forced by platform", or "Phase 1 additions". Everything else is a candidate for phase 2, to be decided after internal review and testing of the parity release.

References like `GroupClient.cs:350` point to the Unity SDK source at v3.5.6. "OpenAPI spec" means the Matchmaker 3.2.0 spec generated for the simple example configuration.

## Phase 1 decisions

- **Package:** `@edgegap/sdk`, with `matchmaking` and `server-browser` subpath exports.
- **Types mirror the wire JSON.** TypeScript interfaces use the real API keys (`group_id`, `is_ready`, `available_seats`, ...), so responses are used as parsed and requests are sent as built, with no mapping layer. This keeps user-defined `attributes` and `metadata` (whose keys must match the Matchmaker profile and the Server Browser index fields) in the same shape as the SDK-defined fields. The Unity implementation defines which fields exist. Where the OpenAPI spec leaves out a field Unity sends (`attributes.assignment.request_id` in `POST /backfills`, which the Matchmaker 3.3.3 service accepts), the spec is wrong and the field stays. `tickets.*.team_id` is declared on `InjectedTicketDTO` but never sent: `ServerAgent.cs:276,402` copies tickets into assignments without `TeamID`, and `NullValueHandling.Ignore` drops it. The JS agent copies the same five fields. The spec is only used to sharpen value types:
  - Port `internal`/`external` are `number` (`string` in `PortMappingDTO`).
  - Beacon list `count` is `number` (`string` in `BeaconsResponseDTO`).
  - `status` fields are string-literal unions from the spec's enums, for example `'SEARCHING' | 'TEAM_FOUND' | 'MATCH_FOUND' | 'HOST_ASSIGNED' | 'CANCELLED'`.
- **SDK-built objects use camelCase.** Objects with no wire format, like `DeploymentEnvironment.fromEnv(env)` (Unity `DeploymentEnvironmentDTO`), use camelCase fields (`requestId`, `selfStopUrl`, ...). Nested API shapes such as `location` and `portMapping` stay snake_case.
- **Auth tokens are always required.** Every agent throws `AuthToken not declared` without one, as in Unity. Client tokens (Matchmaker, Server Browser) ship in the client build. Keeping the Server Browser client token on a game backend is an optional extension and is out of scope.
- **`GroupClient` is renamed `GroupAgent`.** This mirrors `ServerAgent` and `ClientAgent`. The old name was legacy.
- **The legacy ticket `Client` is not ported.** It is `[Obsolete]` in Unity in favor of the group-up flow, and so are its `Assignment` observable and group-ticket helpers. `TicketsRequestDTO` survives only as the base shape of group-up requests. The matching `Api` methods (`/tickets`, `/group-tickets`) are not ported either.
- **`player_ip` is never sent by `GroupAgent`.** The Matchmaker takes the player's IP from the group create request. The field stays in the request type (it's nullable in the spec) for server-to-server use, but it's omitted when unset, where Newtonsoft would serialize it as `null`.
- **Upstream bugs are reproduced as-is.** Each is pinned by a parity test and listed below for phase 2. Exceptions fixed in phase 1 are checked off in their list.

## Service constraints that shape the design

- **Matchmaker:** the client token is safe to ship in game clients. Browser access works once the game's origins are whitelisted with `allowed_cors_origins` (exact domains or wildcards) in the Matchmaker configuration. Entries are matched against the full origin: on Matchmaker 3.3.3, `https://*.my-game-server.com` matches, but a bare `localhost` matches neither `http://localhost` nor `http://localhost:5173`. List local dev servers with their full origin, for example `http://localhost:5173`. Preflight requests need no credentials. The Matchmaker never sends `Retry-After`.
- **Server Browser:** CORS support equivalent to the Matchmaker's is being added to the service. It will expose `Retry-After` through `Access-Control-Expose-Headers`, so browser clients can honor it for auto-assigned reservations. `ClientAgent` calls the Server Browser directly from the browser with the client token.
- **Server tokens** (Matchmaker backfill, Server Browser server API, deployment self-stop) belong only in game servers running on Node, Bun, or Deno. They must never ship in a browser bundle.

## Forced by platform (in phase 1)

These deviate from the Unity behavior because the JS platform leaves no reasonable alternative. They are listed here so reviewers know where parity is intentionally broken.

- **No `MonoBehaviour` handler.** Coroutines become `setTimeout`/`fetch`. Unity stops coroutines when the handler is destroyed. JS has no equivalent, so every agent gets a `dispose()` that clears timers, aborts in-flight requests, and removes subscribers.
- **Query strings are URL-encoded.** `ServerBrowser/Api.cs:164` concatenates `$filter`/`$order` raw. Values are encoded with `encodeURIComponent`, and the `$` in parameter names stays literal.
- **Connection state is never serialized.** C# hides `BackfillAssignedTicket.ConnectedAt` with `[JsonIgnore]`. The JS agent keeps connection times in a separate map (`connectedAt`), so tickets sent in `POST /backfills` contain only API fields. The other local-only field, `BackfillResponseDTO.CreatedAt`, is set but never read in Unity, so it's dropped.
- **Response parse failures are reported, not thrown.** In C# (`Api.cs`, every `catch { throw; }`) a parse error escapes into the coroutine runner, and the operation silently stops, which can freeze polling forever. In JS it goes to the error path, so the observable emits the same error message it would for a failed request.
- **Metadata merge skips `undefined`.** `MetadataDTO.Merge` uses reflection with `??`. C# value types (`int`, `bool`) are never null, so an unset `int` field in an update overwrites the existing value with `0`. In JS an unset field is `undefined` and is skipped.- **No ICMP ping in browsers or without privileges.** See [Ping](#ping-beacons-over-http).

## Phase 1 additions

This has no Unity equivalent, but browser games can't work without it.

- **`getConnectionUrl(assignment, portName)`.** It returns a WebSocket URL from an assignment (Matchmaker) or a `server` object (Server Browser). Port mappings have a static shape: `internal`, `external`, `link`, `protocol`. `link` is already `{fqdn}:{external}`, so the helper builds `{scheme}://{link}`, which never uses `public_ip` (TLS certificates don't cover raw IPs). Ports with TLS upgrade enabled report `WSS` or `HTTPS`. The scheme is chosen like this:

  | `protocol` | Result |
  | --- | --- |
  | `WSS`, `HTTPS` | `wss://` |
  | `WS`, `HTTP` | `ws://`, with a warning on `https:` pages, where browsers block mixed content |
  | anything else (`TCP`, `UDP`, `TCP/UDP`) | error naming the port and suggesting `WS` with TLS upgrade. Browsers can't open raw sockets, and game servers can't present a certificate for the deployment FQDN themselves. |

## Ping beacons over HTTP

Browsers can't send ICMP, UDP, or raw TCP. Edgegap ping beacons currently answer only ICMP, UDP, and TCP, so browser clients can't measure latency at all. Unity WebGL builds have the same limit: `Ping.cs:47` returns `-1`, and `MeasureBeaconsRoundTripTime` reports `0` for every city.

Phase 1 ships a stub with the same result:

- `Ping` is an interface (`measure(beacon, requests) => Promise<number>`) that you can inject into `GroupAgent`.
- The default implementation returns `0` for each beacon (Unity WebGL parity) and logs one warning.
- Node uses the same stub. TCP-connect timing would be possible there, but it doesn't match the ICMP semantics in Unity, so it is deferred too.

Phase 2, once beacons support HTTP:

- [ ] Add an HTTP(S) endpoint on beacons, for example `GET /ping` returning `204`, with CORS `Access-Control-Allow-Origin: *` and `Timing-Allow-Origin: *`.
- [ ] Add an `HttpPing` implementation. Do one warm-up request to absorb DNS, TCP, and TLS setup, then take N timed requests using `PerformanceResourceTiming` (`responseStart - requestStart`), falling back to `performance.now()` deltas.
- [ ] Consider a WebSocket echo variant. It gives lower variance after the handshake and matches the WSS transport browser games actually use.
- [ ] Make HTTP ping the browser default, and keep the stub as the fallback when beacons are unreachable.
- [ ] Document that HTTP RTT runs higher than ICMP RTT. If the Matchmaker's `latencies` rules assume ICMP, consider calibrating, or put the measurement method in ticket attributes.
- [ ] Decide whether unmeasured beacons should be omitted from `beacons` rather than sent as `0`. Today `0` means "unreachable", and the Matchmaker reads it as perfect latency.

## Upstream issues found during the port review

These behaviors exist in Unity v3.5.6 and are reproduced as-is in phase 1. Each has a parity test that pins the current behavior, so a fix shows up as a deliberate test change.

### Shared

- [ ] **Request timeouts are not wired through.** `Matchmaking/Api.cs:25` builds `SafeHttpRequest` without a timeout, so `RequestTimeoutSeconds` on `GroupClient`, `ServerAgent`, and `ServerBrowser.ClientAgent` has no effect, and every request uses 3s. `ServerBrowser.ServerAgent` clamps the timeout to the heartbeat interval only after the `Api` is constructed (`ServerAgent.cs:132`), so the clamp does nothing either.
- [ ] **Retries ignore network failures.** `SafeHttpRequest.cs:151` gives up when the response has no headers, for example on DNS errors, connection resets, or timeouts. Those are the failures most worth retrying.
- [ ] **Any status carrying `Retry-After` is retried.** This is intentional for auto-assigned reservations, where the status code reports the policy's scaling state and `Retry-After` the wait while capacity is added. The Matchmaker never sends the header, so only the Server Browser is affected. Low priority: limit it to `429`, `5xx`, and the reservation endpoints, unless other Server Browser endpoints are meant to use it too.
- [ ] **`Retry-After` is parsed only as seconds.** The HTTP-date form is not handled.
- [x] **A custom `BackoffSeconds` is never used for retries.** `SafeHttpRequest.cs:183,193` overwrites `retryParameters.BackoffSeconds` with the default (or the `Retry-After` value) before scheduling each retry, so `new RetryParameters(attempts, backoffSeconds)` only affects the attempt count. Fixed in phase 1: the custom backoff is kept, and `Retry-After` only sets the wait for the retry it came with.
- [ ] **A sample builds `RetryParameters` wrong.** `new RetryParameters { MaxAttempts = 10 }` (`ServerBrowserServerHandler.cs:246`) leaves `RemainingAttempts = 3`. Use the constructor.
- [ ] **`Observable<T>` initializes `Current` to `new T()`, not null.** Guards like `Group.Current is not null && !abandon` (`GroupClient.cs:126,141,168`) therefore fire on the very first call, so `CreateGroup(group)` without `abandon: true` always emits `conflict, abandon and restart`. Every sample passes `abandon: true`, which hides this.

### Matchmaking: `GroupAgent` (Unity `GroupClient`)

- [ ] **Polling loops can overlap.** `StopMatchmaking` sets `Polling = false`, but a pending `DelayPollingGroup` coroutine is not cancelled. If a new group is created within the backoff window (about 1s), `Polling` is `true` again when the old coroutine wakes, and two loops poll at once. A generation counter or one `AbortController` per session would fix this.
- [ ] **A stale expiry can wipe out a new group.** `ExpireGroup` (`GroupClient.cs:399`) unconditionally sets `Group` to `null` after `RemoveGroupSeconds`. A group created in that window gets wiped with `removed`.
- [ ] **`StopMatchmaking` can drop the follow-up action after a `409`.** On `409` it resumes polling but never calls `onCompletedDelegate`, so `CreateGroup(..., abandon: true)` silently does nothing when the old group was just matched. That may be intended, since matched groups can't be deleted. If so, emit a distinct message.

### Matchmaking: `ServerAgent` (backfill)

- [ ] **Backfills can be over-provisioned.** `AddBackfills` uses a re-entrancy guard (`BackfillRunning`/`BackfillPending`), but `StartNewBackfill` is fire-and-forget, so the guard never actually overlaps. Capacity is computed from `Backfills.Current`, which updates only when the `POST` response arrives. Two quick `AbandonPlayer` calls can each schedule the full deficit. Track in-flight creations in the capacity check.
- [ ] **An assignment emits an update with no state change.** `Backfills._Update(Backfills.Current, "assigned [...]")` (`ServerAgent.cs:411`) passes the same reference as both previous and current, so subscribers diffing `previous` against `current` see no change.
- [ ] **Polling keeps running with zero backfills.** Once every backfill is assigned, the loop ticks forever and does nothing until `AbandonAllBackfills` is called.
- [ ] **The max-retries error omits the backfill ID.** `polling failed (reached maximum retries)` has no `[id]` suffix, unlike the documented message.

### Shared DTOs

- [ ] **A missing port mapping crashes environment parsing.** `DeploymentEnvironmentDTO` throws a null-reference error when `ARBITRIUM_PORTS_MAPPING` is absent (`DeploymentEnvironmentDTO.cs:104`), which breaks local runs without a mock environment.
- [ ] **A malformed ticket crashes match parsing.** `MatchEnvironmentDTO` throws a null-reference error when one `MM_TICKET_*` variable fails to parse (`MatchEnvironmentDTO.cs:62`).

### Server Browser: `ClientAgent`

- [ ] **Requesting a page past the end crashes.** `GetNextPage` (`ClientAgent.cs:155`) emits `instance list last page reached` but doesn't return, so it dereferences a null cursor.
- [ ] **Instance details crash on an empty cache.** `GetInstanceDetails` dereferences `Instances.Current`, which is `null` right after `RefreshList` (`cache deleted`).
- [ ] **`GetInstanceDetails` mutates the cached list in place.** This has the same "previous equals current" issue as backfill assignment.

### Server Browser: `ServerAgent`

- [ ] **Queued instance metadata is not sent without a slot update.** When there are no confirmations and no slot updates, `FlushConfirmations` calls `FlushInstanceUpdates`. With `FlushingUpdates == false`, that branch does a `GET` and returns (`ServerAgent.cs:458-487`), so metadata queued by `UpdateInstance` is never `PATCH`ed until some slot update happens. `UpdateMode.Greedy` is affected too.
- [ ] **A slot update failure followed by a recovery `GET` can drop the update.** `FlushingUpdates` is cleared only inside the instance-update callbacks.
- [ ] **`SlotDTO.ApplyUpdate` is unused.** Remove it, or use it for optimistic local updates.
- [ ] **Rediscovery after a `404` heartbeat sends stale state.** It re-sends `Instance.Current`, including slot seat counts that may be out of date.

### Server Browser: query compilers

- [ ] **Filter string values are not escaped.** A `'` inside a `StringFilter` or `LiteralFilter` value breaks the query.
- [ ] **No `or`/grouping.** `FilterCompiler` only joins filters with `and`.

## OpenAPI spec fixes (service side)

The service accepts these fields, and the Unity SDK sends them, but the Matchmaker 3.2.0 OpenAPI spec doesn't declare them, on schemas marked `additionalProperties: false`. The SDK types include them.

- [ ] Add `request_id` to `TicketAssignmentResponse`, as used in `attributes.assignment` of `POST /backfills`.
- [ ] Add `team_id` to `BackfillTicketMember`.

## Documentation drift

The Unity code and the docs ([matchmaking](https://docs.edgegap.com/unity/matchmaking#customization), [server browser](https://docs.edgegap.com/unity/server-browser#customization), [matchmaker in-depth](https://docs.edgegap.com/learn/matchmaking/matchmaker-in-depth)) disagree. Phase 1 emits what the code emits, and the SDK's polling and retry behavior is the reference. Decide whether to fix the code or the docs for event messages:

| Docs | Code |
| --- | --- |
| Action type `Notify` | `ObservableActionType.Log` |
| "Group Client" | `GroupAgent` in the JS SDK |
| `abandon failed (already matched)` (group) | `abandon failed (match found)` |
| `member update failed` as `Error` | `Warn` on `409`, `group update failed` as `Error` otherwise |
| `remove failed [{backfill}]` | `remove failed (not found) [{backfill}]` |
| `polling failed (reached maximum retries) [{backfill}]` | no `[{backfill}]` suffix |
| (undocumented, matchmaking) | `maximum capacity currently reached`, `abandon failed (not found) [{id}]` |
| (undocumented, server browser client) | `instance list retrieval failed`, `cache deleted` |
| Poll memberships every 3–5s (docs update pending) | 1s polling backoff |
| Increasing waits between `429` retries, e.g. 1s, 5s, 10s (docs update pending) | Fixed backoff |

## Jitter

- [ ] **Proportional jitter (approved for phase 2).** Every delay today is `base + random(0, 0.1s)`: polling (1s), retries (1s), backfill polling (1s), heartbeats (10s). The jitter is a constant 100ms, no matter how long the delay is. Clients that start in sync stay in sync: a lobby that readies up together, a scaling policy deploying many servers at once, or every client retrying after the same `Retry-After`. With 100ms jitter on a 10s heartbeat (1%), 50 servers deployed together still send their heartbeats in tight bursts every cycle. Scaling the jitter with the delay spreads them across the interval. The bounds depend on what the delay guarantees:
  - **Polling and generic retries:** `base × random(0.8, 1.2)`, for example 0.8–1.2s on a 1s poll. The average rate stays the same.
  - **`Retry-After`:** `base × random(1.0, 1.2)`, so a client never retries before the server asked it to.
  - **Heartbeats:** `base × random(0.8, 1.0)`, so jitter never pushes a heartbeat closer to the instance expiry.

  This changes only the timing distribution, not the average request rate. It can also be backported to Unity as-is.

## API and abstraction improvements

- [ ] **Structured event codes.** Handlers currently branch on message strings, for example `message.Contains("discovery failed")` and `message.StartsWith("enqueued")`. Emit `{ type, code, message, detail }`, where `code` is a typed union such as `'group.created' | 'group.joined' | ...`, and keep `message` for logs. This also rules out the documentation-drift class of bugs.
- [ ] **TypeScript template-literal message types.** As a cheaper step toward structured codes, type `message` as a union of the known templates, so handlers get autocomplete and typo checking.
- [ ] **Promise and async-iterator surface.** Phase 1 keeps the observer callbacks. Add `await agent.nextAssignment()` and `for await (const ev of agent.group)` for game loops.
- [ ] **Interop adapters.** Offer opt-in adapters for RxJS (`from(observable)`), Svelte stores, React `useSyncExternalStore`, and signals. The observable contract already works with `useSyncExternalStore`, because `subscribe` returns an unsubscribe function.
- [ ] **Immutable state updates.** Never mutate `Current` in place, so `previous`/`current` diffs are always meaningful.
- [ ] **Single cancellation model.** Replace boolean flags (`Polling`, `FlushingUpdates`, `BackfillRunning`) with one `AbortController` per session or loop.
- [ ] **Pluggable `fetch`.** Accept a custom `fetch` for runtimes without a global one, and for instrumentation. Phase 1 tests stub the global `fetch`.
- [ ] **Move sample presets out of the runtime.** `SimpleGroupUpRequestDTO`, `Social*/Cooperative*/Competitive*MetadataDTO`, and the hardcoded profile names (`simple-example`, ...) are sample code shipped in the Unity runtime. Phase 1 mirrors this under a `presets` export.
- [ ] **camelCase facade.** Phase 1 mirrors the wire JSON. A camelCase layer was considered and rejected, because user-defined keys would need to stay snake_case anyway, leaving mixed casing. Revisit only if users ask for it.

## Browser and transport

- [ ] **Abandon on page unload.** `StopMatchmaking` on `pagehide` needs `fetch(..., { keepalive: true })`, because normal requests are cancelled during unload.
- [ ] **Reconnect helper.** Persist group and membership IDs in `localStorage` and auto-call `ResumeMatchmaking` after a reload, as the docs recommend.
- [ ] **Connection retry helper.** Game servers may still be initializing at `HOST_ASSIGNED`, and the docs tell clients to retry the connection several times. Offer a WebSocket connect-with-retry helper built on `getConnectionUrl`.
- [ ] **Background-tab timer throttling.** Browsers throttle `setTimeout` in hidden tabs to 1s or slower. Measure the effect on polling and the connection grace period, and consider an opt-in `visibilitychange` resync.
- [ ] **WebTransport.** Evaluate it as a lower-latency, UDP-like path for browser games, once Edgegap port types support it.

## Packaging and DX

- [ ] **CDN build.** Publish a `<script type="module">` and IIFE build for single-file HTML games. Phase 1 builds it, but publishing is pending.
- [ ] **Starter templates.** Vite with Phaser, Three.js, and PlayCanvas starters, plus a Node WS server starter.
- [ ] **Local mock server.** A mock Matchmaker and Server Browser for offline development, reusing the phase 1 test fixtures.
- [ ] **AI-assistant docs.** Ship an `llms.txt` and agent rules for vibe-coding tools, so generated code uses the SDK and doesn't call raw APIs.
- [ ] **Token safety.** Client tokens ship in client builds by design. Server tokens must not. Detect a server token used in a browser (a heuristic on the token scope or prefix, if one exists) and warn loudly.

## Backport to Unity SDK

Fixes and improvements made here that also apply to the Unity SDK. Check an item off when the Unity change ships, and link the Unity PR.

Already different in JS phase 1, because the platform forced it:

- [ ] **URL-encode `$filter`/`$order` values.** `ServerBrowser/Api.cs:164`. A `&`, `#`, or `+` in a filter value breaks the query in Unity today.
- [ ] **Report response parse failures through the error path.** Unity rethrows inside the coroutine, so polling and flush loops stop silently.
- [ ] **Merge metadata without overwriting with value-type defaults.** In `MetadataDTO.Merge`, an unset `int`/`bool` field in an update resets the stored value to `0`/`false`. Use nullable value types in metadata DTOs, or merge only fields present in the JSON.
- [ ] **Omit `player_ip` when unset,** rather than sending `null`. This is equivalent per the spec, so it's low priority.
- [ ] **Type port `internal`/`external` and beacon `count` as numbers,** to match the API. Today it works only through Newtonsoft's coercion.
- [ ] **Rename `GroupClient` to `GroupAgent`.** Breaking change, so it goes in the next major version, with an `[Obsolete]` alias in the meantime.
- [ ] **Remove the legacy ticket `Client`.** It's already `[Obsolete]`. Next major version.
- [ ] **Keep a custom `BackoffSeconds` across retries.** `SafeHttpRequest.cs:183,193`. Pass the `Retry-After` wait to the next attempt instead of overwriting the delegate.

Phase 2 fixes: when an item under "Upstream issues", "Jitter", or "API and abstraction improvements" ships in JS and applies to Unity, add it here.
