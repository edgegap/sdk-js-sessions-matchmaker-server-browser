# sdk-js-sessions-matchmaker-server-browser

JavaScript/TypeScript SDK for Edgegap [Matchmaking](https://docs.edgegap.com/learn/matchmaking/matchmaker-in-depth) and [Server Browser](https://docs.edgegap.com/learn/server-browser), ported from the [Unity SDK v3.5.6](https://github.com/edgegap/sdk-unity-sessions-matchmaker-server-browser). It targets browser games (WebSocket over WSS) and their Node, Bun, or Deno game servers.

> **Status:** repo setup, the shared layer, and Matchmaking are done (implementation steps 1 to 3). The Server Browser is implemented on the `server-browser` branch and waits on service-side CORS support. Decisions, known Unity issues, phase 2 candidates, and Unity backports are tracked in [ROADMAP.md](ROADMAP.md).

## Porting plan

### Approach

Phase 1 is a faithful port: the same agents, the same observable callback signature, and the exact event message strings, so the existing docs event tables still apply. The port deviates only where the JS platform forces it (see "Forced by platform" in [ROADMAP.md](ROADMAP.md)). Unity bugs are reproduced as-is and pinned by tests, except the ones already fixed, which are checked off in [ROADMAP.md](ROADMAP.md).

### Scope

| Unity | JS | Runs in |
| --- | --- | --- |
| `Matchmaking.GroupClient` | `GroupAgent` (renamed for symmetry) | browser, Node |
| `Matchmaking.ServerAgent` (backfill) | `ServerAgent` | Node, Bun, Deno |
| `ServerBrowser.ClientAgent` | `ClientAgent` | browser, Node |
| `ServerBrowser.ServerAgent` | `ServerAgent` | Node, Bun, Deno |
| `FilterCompiler`, `SortCompiler` | same names | anywhere |
| `DeploymentEnvironmentDTO`, `MatchEnvironmentDTO` | `fromEnv(process.env)` parsers | Node, Bun, Deno |
| `Observable`, `SafeHttpRequest`, `Ping`, `Logger` | shared layer | anywhere |
| `Matchmaking.Client` (`[Obsolete]`) | not ported | |

New in JS: `getConnectionUrl(assignment, portName)` builds `wss://{link}` or `ws://{link}` from the port `protocol` (`WSS`/`HTTPS` or `WS`/`HTTP`), and throws for `TCP`/`UDP`, which browsers can't open.

### Unity to JS mapping

| Unity | JS |
| --- | --- |
| `MonoBehaviour` handler and coroutines | Plain classes using `setTimeout`, plus `dispose()` to clear timers, abort requests, and drop subscribers |
| `UnityWebRequest` / `SafeHttpRequest` | Global `fetch` with `AbortController` timeouts, using the same retry and backoff rules (`RetryParameters`, `Retry-After`) |
| `UnityEvent` in `Observable<T>` | Built-in observable with `current`, `previous`, `error`, and `subscribe(fn)`, which returns an unsubscribe function |
| `ObservableActionType` enum | `const` object plus a union type (`Log = 0`, `Update = 100`, `Warn = 200`, `Error = 300`) |
| Newtonsoft and `[JsonProperty]` DTO classes | TypeScript interfaces using the real snake_case JSON keys, with no mapping layer |
| Generic DTO parameters (`A`, metadata types) | TypeScript generics for ticket attributes and instance/slot metadata |
| `MetadataDTO.Merge` (reflection) | Shallow merge that skips `undefined` |
| Delegate callbacks (`Beacons`, `MeasureBeaconsRoundTripTime`) | Promises |
| `Environment.GetEnvironmentVariables()` | Any `Record<string, string \| undefined>`, such as `process.env` |
| `Debug.Log` | `console`, using the same message formats |

### Key decisions

- **Package:** `@edgegap/sdk`, with `@edgegap/sdk/matchmaking` and `@edgegap/sdk/server-browser` subpath exports and zero runtime dependencies.
- **Tokens are always required.** Client tokens (Matchmaker, Server Browser) ship in the client build. Server tokens stay on game servers.
- **CORS:** the Matchmaker whitelists origins with `allowed_cors_origins`. The Server Browser is getting the same support, and will expose `Retry-After`.
- **`player_ip` is never sent by `GroupAgent`,** because the Matchmaker takes it from the request.
- **Ping is a stub:** an injectable `Ping` interface whose default returns `0` per city, matching Unity WebGL. HTTP ping waits on beacon support.
- **Polling and retry timing match Unity:** 1s polling, fixed backoff, and up to 0.1s of jitter. Unlike Unity, retries cover network failures and timeouts, and are limited to those, `429`, and `5xx`.

### Packaging and compatibility

- Strict TypeScript source, without `enum` or other TypeScript-only runtime syntax, so it works with Node's built-in type stripping and Vite.
- Build outputs: ESM, CJS, `.d.ts`, and a single-file IIFE/ESM build for HTML games without a bundler.
- Targets ES2020. Requires `fetch` and `AbortController`, so Node 18 or later and all evergreen browsers.

### Testing

- Vitest, with fake timers and a stubbed global `fetch`.
- Scenario tests for each agent, derived from the C# code paths. They assert the exact emitted messages and action types, including the reproduced Unity bugs.
- Opt-in integration tests against a real Matchmaker or Server Browser when tokens are provided as environment variables. For Matchmaking, set `EDGEGAP_MM_URL` and `EDGEGAP_MM_TOKEN` for a matchmaker running the advanced example profile, then run `npm run test:integration`. These tests never ready a full group, so they don't start a deployment. Set `EDGEGAP_MM_ALLOW_DEPLOY=1` to also run the backfill assignment test. That test normally fills the open backfill instead of deploying, but a deployment can still start if the match isn't made through the backfill.

### Samples

The seven Unity samples get JS equivalents: browser clients built with Vite, and Node game servers using `ws`. `ws` is a dev dependency of the samples only.

- Deployment Agent: environment parsing and self-stop
- Matchmaking Simple
- Matchmaking Region Picker
- Matchmaking Group Up
- Matchmaking Backfill
- Server Browser Auto-Assign
- Server Browser Custom Search

### Implementation order

1. Repo setup: package config, TypeScript, build, Vitest, CI.
2. Shared layer: `Observable`, logger, HTTP with retries, ping stub, shared DTOs, environment parsing, `getConnectionUrl`.
3. Matchmaking: API, `GroupAgent`, backfill `ServerAgent`, `MatchEnvironment`.
4. Server Browser: API, filter and sort compilers, `ClientAgent`, `ServerAgent`.
5. Samples, then an internal review against the Unity SDK and the docs event tables.
