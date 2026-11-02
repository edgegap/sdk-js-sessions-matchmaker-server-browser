# Roadmap

Planned and considered work for the Edgegap JavaScript SDK. Nothing here is a commitment or has a date. To request a feature or discuss an item, [open an issue](https://github.com/edgegap/sdk-js-sessions-matchmaker-server-browser/issues).

## Server Browser

- [ ] **Server Browser support** under `@edgegap/sdk/server-browser`: a `ClientAgent` to list, filter, sort, and join server instances from the browser, a `ServerAgent` to register instances and keep their slots up to date from game servers, and filter and sort query builders. Browser access depends on CORS support in the Server Browser service, including `Retry-After` in `Access-Control-Expose-Headers`.

## Latency measurement

Browsers can't send ICMP, UDP, or raw TCP, and Edgegap ping beacons answer only those, so the default `Ping` reports `0` for every beacon.

- [ ] Add an HTTP(S) endpoint to beacons, for example `GET /ping` returning `204`, with `Access-Control-Allow-Origin: *` and `Timing-Allow-Origin: *`.
- [ ] Add an `HttpPing` implementation: one warm-up request to absorb DNS, TCP, and TLS setup, then N timed requests using `PerformanceResourceTiming` (`responseStart - requestStart`), falling back to `performance.now()` deltas.
- [ ] Consider a WebSocket echo variant, which has lower variance after the handshake and matches the transport browser games use.
- [ ] Make HTTP ping the browser default, keeping the current behavior as the fallback when beacons are unreachable.
- [ ] Document that HTTP round-trip times run higher than ICMP. If Matchmaker `latencies` rules assume ICMP, consider calibrating, or put the measurement method in ticket attributes.
- [ ] Decide whether unmeasured beacons should be left out of `beacons` instead of sent as `0`, which the Matchmaker reads as perfect latency.
- [ ] Consider TCP-connect timing on Node, Bun, and Deno.

## API

- [ ] **Promise and async-iterator surface,** such as `await agent.nextAssignment()` and `for await (const event of agent.group)`, for game loops.
- [ ] **Interop adapters** for RxJS, Svelte stores, React `useSyncExternalStore`, and signals.
- [ ] **Immutable state updates everywhere,** so `previous` and `current` can always be diffed.
- [ ] **A single cancellation model,** with one `AbortController` per session or loop instead of internal flags.
- [ ] **Pluggable `fetch`,** for runtimes without a global one and for instrumentation.
- [ ] **Move `presets` out of the package.** The example request builders and profile names (`simple-example`, `backfill-example`, `advanced-example`) belong in samples.
- [ ] **camelCase facade.** Types mirror the API's snake_case JSON so user-defined attributes keep the same shape. Revisit only if users ask for it.

## Reliability

- [ ] **Proportional jitter.** Every delay adds a constant 0 to 100ms today, so clients that start in sync (a lobby readying together, many servers deployed at once, clients retrying after the same `Retry-After`) stay in sync. Scale jitter with the delay, without changing the average request rate:
  - Polling and retries: `base × random(0.8, 1.2)`.
  - `Retry-After`: `base × random(1.0, 1.2)`, so a client never retries earlier than the service asked.
  - Heartbeats: `base × random(0.8, 1.0)`, so jitter never pushes a heartbeat closer to expiry.

## Browser and transport

- [ ] **Abandon on page unload,** using `fetch(..., { keepalive: true })` on `pagehide`.
- [ ] **Reconnect helper** that saves group and member IDs in `localStorage` and resumes matchmaking after a reload.
- [ ] **Connection retry helper** built on `getConnectionUrl`, since game servers may still be starting at `HOST_ASSIGNED`.
- [ ] **Background-tab throttling.** Measure how timer throttling in hidden tabs affects polling and the connection grace period, and consider an opt-in `visibilitychange` resync.
- [ ] **WebTransport** as a lower-latency, UDP-like path for browser games, once Edgegap ports support it.

## Developer experience

- [ ] **Samples:** deployment environment and self-stop, simple matchmaking, region picker, group up, backfill, and Server Browser auto-assign and custom search. Browser clients built with Vite, game servers on Node with `ws`.
- [ ] **Starter templates** for Vite with Phaser, Three.js, and PlayCanvas, plus a Node WebSocket server.
- [ ] **Local mock server** for the Matchmaker and Server Browser, for offline development.
- [ ] **AI-assistant docs:** an `llms.txt` and agent rules, so generated code uses the SDK instead of calling the APIs directly.
- [ ] **Token safety:** detect a server token used in a browser and warn.
- [ ] **Bun and Deno in CI.**

## Matchmaker OpenAPI spec

The Matchmaker accepts these fields, and the SDK sends them, but the OpenAPI spec doesn't declare them on schemas marked `additionalProperties: false`:

- [ ] `request_id` in `TicketAssignmentResponse`, as sent in `attributes.assignment` of `POST /backfills`.
- [ ] `team_id` in `BackfillTicketMember`.
