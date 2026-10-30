# RPC Pulse

Benchmark and monitor blockchain RPC providers, measuring latency, reliability, and throughput.

RPC Pulse runs controlled, concurrent benchmarks against EVM JSON-RPC endpoints (Chainstack, Alchemy, QuickNode, Ankr, Infura, self-hosted nodes, …), stores every result, and shows which providers perform best per network and how that changes over time.

## Features

- **Endpoint management**: add, edit, enable/disable and delete endpoints per network. URLs (including API keys) are encrypted at rest and only ever displayed masked.
- **Benchmark engine**: configurable request count, duration, concurrency, request interval, timeout and warm-up. All selected endpoints run simultaneously under identical conditions, each with its own connection pool, so one failing endpoint cannot affect the others.
- **Methods**: `eth_chainId`, `eth_blockNumber`, `net_version`, `web3_clientVersion`, `eth_gasPrice`, `eth_getBlockByNumber`. New methods are a single registry entry.
- **Statistics**: min / mean / stddev / max, P50 / P90 / P95 / P99, success rate, throughput (requests per second), error breakdown by type, per-method stats.
- **Timing decomposition**: network RTT (TCP handshake), time to first byte, estimated provider processing time, and total request time.
- **Consistency checks**: synchronized block-height snapshots across endpoints on the same network (block lag), chain ID mismatches, inconsistent chain IDs behind a load balancer, block-number regressions, `net_version` mismatches, rate limiting.
- **Results**: run detail with comparison table, percentile and timing charts, latency-over-time small multiples, error messages, a CSV export of raw samples, side-by-side comparison of up to 4 runs, and re-run / edit-and-re-run.
- **History**: per-network trends (P50 / P95 / mean / throughput, success rate) over 24h / 7d / 30d / 90d, a ranking table, and detected incidents (latency spikes, availability drops, unreachable endpoints, block lag).

## Quick start

Requirements: Node.js ≥ 22, pnpm.

```bash
pnpm install
cp .env.example .env    # optional; see Configuration
pnpm dev                # API on :4000, UI on http://localhost:5173
```

Production:

```bash
pnpm build
pnpm start              # serves API and UI on http://127.0.0.1:4000
```

Other scripts: `pnpm test` (Vitest), `pnpm typecheck`, `pnpm db:generate` (create a migration after editing `server/db/schema.ts`). Migrations are applied automatically on startup.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RPC_PULSE_SECRET_KEY` | *(generated file)* | 32-byte key (base64 or hex) used to encrypt stored RPC URLs. If unset, a key is generated at `data/.secret-key`. **Set this in production** so the key is kept separately from the data. |
| `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `4000` | HTTP port. |
| `DATABASE_PATH` | `./data/rpc-pulse.db` | SQLite database file. |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Allow endpoints on loopback/private/link-local addresses, e.g. a local node. |
| `LOG_LEVEL` | `info` | Server log level. |

Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

> RPC Pulse has no user authentication yet. Keep it bound to localhost, or put it behind an authenticating reverse proxy.

## Architecture

```
shared/            zod schemas and API types shared by server and UI
server/
  rpc/             JSON-RPC HTTP transport, SSRF policy, URL redaction, network RTT probe
  benchmark/       method registry, engine (execution + aggregation), stats, runner (job queue)
  db/              Drizzle schema, migrations, SQLite client
  repositories/    persistence and query logic (endpoints, runs, history, settings)
  api/             Fastify routes
web/src/           React + TanStack Query + Recharts + Tailwind UI
test/              Vitest suites, including a mock JSON-RPC server
```

- **Execution is server-side.** `POST /api/runs` stores a queued run. The in-process `BenchmarkRunner` executes queued runs one at a time, so concurrent benchmarks don't compete for local bandwidth and skew each other's latency. Runs continue when the browser is closed. A run that was in progress when the server stopped is marked `interrupted` on the next start.
- **The engine has no HTTP or database dependencies.** It takes a config, targets and a transport factory, streams samples through hooks, and returns aggregates. This keeps it unit-testable, and it can move to a separate worker process without changes.
- **Runs are reproducible.** Each run stores its full config, and each per-endpoint result stores a snapshot of the endpoint (name, provider, network, expected chain ID, masked URL). History therefore survives endpoint edits and deletion, and "Re-run" repeats the exact configuration.
- **Data model is ready for monitoring.** Runs carry a `trigger` (`manual` / `scheduled`) and a nullable `schedule_id`. A `schedules` table exists, so scheduled benchmarks can create runs through the same runner. Raw samples are subject to a retention policy; aggregates are kept indefinitely.
- **Extensibility.** The engine depends only on the `RpcTransport` interface. Other protocols (WebSocket, Solana, …) plug in as a new transport plus method registry entries.

## Measurement methodology

- **Warm-up** (on by default): before measuring, each endpoint gets one uncounted `eth_chainId` request per concurrency slot. This opens the TCP/TLS connections, so measured latency reflects steady-state requests rather than handshakes.
- **Load model**: `concurrency` workers per endpoint issue requests back to back (plus `intervalMs`), rotating round-robin through the selected methods. The run stops at the request count or the duration, whichever comes first.
- **Per request**, RPC Pulse records: start timestamp (epoch ms), time to first byte (TTFB), total time (body read and parsed), outcome, error type, HTTP status, JSON-RPC error code, sanitized error message, and block number where applicable.
- **Latency statistics** use successful requests only. Failures are counted separately as `timeout`, `network`, `http`, `rate_limited`, `rpc_error`, `invalid_response` (malformed JSON or JSON-RPC envelope) or `unexpected_result` (well-formed but invalid result). Percentiles use linear interpolation.
- **Throughput** = completed requests ÷ measured window, where the window runs from the first request's start to the last request's completion.
- **Network RTT** is the median of 5 TCP connect handshakes to the endpoint host. **Provider time** is estimated as median TTFB − median RTT.
- **Rate limits**: on HTTP 429 or a rate-limit JSON-RPC error, the worker backs off for `Retry-After`, capped at 5 s. Backoff time is not counted as latency.
- **Block lag**: after measuring, every endpoint is queried with `eth_blockNumber` at the same moment, three times, 500 ms apart. Each endpoint's lag is the median of its distance from the highest head reported on its network.

A single request does not tell you much about a provider. For meaningful comparisons, run at least a few hundred requests and repeat runs over time.

## Security

- RPC URLs are encrypted with AES-256-GCM. The API returns only a masked form: path segments that look like keys are truncated, query values and userinfo are masked. The full URL is decrypted only inside the runner and endpoint test.
- Error messages are scrubbed of any part of the URL before being stored or returned. Logs never contain URLs.
- Only `http://` and `https://` URLs are accepted. Redirects are not followed.
- **SSRF protection.** Loopback, private (RFC 1918), CGNAT, link-local (including cloud metadata `169.254.169.254`), multicast, reserved, IPv6 ULA/link-local and IPv4-mapped forms are refused. The check runs when a URL is saved and again inside the DNS lookup of every outbound connection, which prevents DNS rebinding. Local hostnames (`localhost`, `*.local`, `*.internal`, single-label names) are refused too. The env-only `ALLOW_PRIVATE_NETWORKS` flag disables this check, and it can't be changed from the UI.
- Requests have timeouts. Concurrency is capped per endpoint (50), total in-flight requests per run are capped at 250, and response bodies are capped at 4 MiB.

## API

All routes are under `/api`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/dashboard` | Counts, 7-day leaderboard, recent runs, incidents |
| GET/POST | `/networks` | List / create networks |
| GET/POST | `/endpoints` | List / create endpoints |
| PATCH/DELETE | `/endpoints/:id` | Update / delete an endpoint |
| POST | `/endpoints/:id/test` | One-off connectivity check |
| POST | `/endpoints/test` | Check an unsaved URL (`{ url, networkId }`) |
| GET/POST | `/runs` | List runs (`limit`, `offset`, `status`) / start a benchmark |
| GET/DELETE | `/runs/:id` | Run detail with per-endpoint results / delete |
| GET | `/runs/:id/samples` | Raw request samples (`runEndpointId`, `limit`) |
| POST | `/runs/:id/cancel` | Cancel a queued or running run |
| POST | `/runs/:id/rerun` | Re-run with an identical config |
| GET | `/history` | Trends, ranking and incidents (`range`, `networkId`) |
| GET/PUT | `/settings` | Defaults, thresholds, retention |
| GET | `/system` | Version, limits, methods, security mode |

## Roadmap

Done: Phase 1 (endpoint management, EVM JSON-RPC, concurrent benchmarks, latency and success rate, results dashboard, persistent history) and most of Phase 2 (percentiles, throughput and load profiles, block-height consistency, historical charts, configurable scenarios).

Next:
- Scheduled benchmarks: a scheduler that reads the `schedules` table, plus a UI.
- Authentication and multi-user support.
- WebSocket transport and `eth_subscribe` latency.
- Heavier methods: `eth_call`, `eth_getLogs`, archive queries.
- Benchmarking from multiple regions (remote agents).
