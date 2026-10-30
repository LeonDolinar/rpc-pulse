import type {
  BenchmarkConfig,
  ErrorBreakdown,
  ErrorType,
  Issue,
  LatencyStats,
  MethodId,
  MethodStats,
  RunEndpointStatus,
  Sample,
} from '../../shared/schemas.js';
import { CancelledError, type RpcCallOutcome, type RpcTransport } from '../rpc/json-rpc-client.js';
import { sanitizeMessage } from '../rpc/redact.js';
import { METHODS, parseHexNumber } from './methods.js';
import { median, summarize } from './stats.js';

/** Safety cap when a run is bounded only by duration. */
const DURATION_ONLY_REQUEST_CAP = 100_000;
const MAX_BACKOFF_MS = 5_000;
const SAMPLE_FLUSH_SIZE = 250;
const SAMPLE_FLUSH_INTERVAL_MS = 1_000;
const HEAD_SNAPSHOT_ROUNDS = 3;
const HEAD_SNAPSHOT_GAP_MS = 500;

export interface BenchmarkTarget {
  runEndpointId: string;
  networkId: string;
  expectedChainId: number | null;
  /** Secret: used only to build the transport and probe; never stored or logged. */
  url: string;
}

export interface EngineDeps {
  createTransport(target: BenchmarkTarget, connections: number): RpcTransport;
  probeRtt(target: BenchmarkTarget, signal: AbortSignal): Promise<number[]>;
}

export interface EngineHooks {
  onEndpointStart?(runEndpointId: string, startedAt: number): void;
  onSamples?(samples: Sample[]): void;
  onProgress?(completed: number): void;
}

export interface EngineThresholds {
  blockLagBlocks: number;
  availabilityMin: number;
}

/** Engine output for one endpoint; maps onto RunEndpointResult minus snapshot fields. */
export interface EndpointAggregate {
  runEndpointId: string;
  status: RunEndpointStatus;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  windowMs: number | null;
  total: number;
  success: number;
  failed: number;
  successRate: number | null;
  throughputRps: number | null;
  successRps: number | null;
  latency: LatencyStats | null;
  ttfb: LatencyStats | null;
  networkRttMs: number | null;
  providerTimeMs: number | null;
  errors: ErrorBreakdown;
  observedChainId: number | null;
  clientVersion: string | null;
  headBlock: number | null;
  blockLag: number | null;
  issues: Issue[];
  methods: MethodStats[];
}

interface MethodAccumulator {
  total: number;
  success: number;
  latencies: number[];
  errors: ErrorBreakdown;
}

/** Mutable per-endpoint state while the benchmark is running. */
class EndpointState {
  readonly methods = new Map<MethodId, MethodAccumulator>();
  readonly latencies: number[] = [];
  readonly ttfbs: number[] = [];
  readonly errors: ErrorBreakdown = {};
  readonly chainIds = new Set<number>();
  readonly netVersions = new Set<string>();
  total = 0;
  success = 0;
  firstStart = Infinity;
  lastEnd = -Infinity;
  clientVersion: string | null = null;
  maxBlockSeen = -1;
  blockRegressions = 0;
  maxRegression = 0;
  rtts: number[] = [];
  status: RunEndpointStatus = 'pending';
  error: string | null = null;
  startedAt: number | null = null;
  finishedAt: number | null = null;
  heads: (number | null)[] = [];
  lags: number[] = [];

  constructor(readonly target: BenchmarkTarget) {}

  method(id: MethodId): MethodAccumulator {
    let acc = this.methods.get(id);
    if (!acc) {
      acc = { total: 0, success: 0, latencies: [], errors: {} };
      this.methods.set(id, acc);
    }
    return acc;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

const bump = (breakdown: ErrorBreakdown, type: ErrorType) => {
  breakdown[type] = (breakdown[type] ?? 0) + 1;
};

/**
 * Executes a benchmark across all targets simultaneously so results are
 * comparable under the same conditions. Each endpoint has an independent
 * transport, worker pool and error handling: one endpoint failing or stalling
 * does not affect measurements of the others.
 */
export async function runBenchmark(
  config: BenchmarkConfig,
  targets: BenchmarkTarget[],
  deps: EngineDeps,
  hooks: EngineHooks,
  thresholds: EngineThresholds,
  signal: AbortSignal,
): Promise<EndpointAggregate[]> {
  const states = targets.map((t) => new EndpointState(t));
  const transports = new Map<string, RpcTransport>();
  let completed = 0;

  let buffer: Sample[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    hooks.onSamples?.(batch);
  };
  const flushTimer = setInterval(flush, SAMPLE_FLUSH_INTERVAL_MS);

  const record = (state: EndpointState, method: MethodId, outcome: RpcCallOutcome) => {
    const def = METHODS[method];
    let ok = outcome.ok;
    let errorType: ErrorType | null = outcome.error?.type ?? null;
    let errorMessage: string | null = outcome.error?.message ?? null;
    let blockNumber: number | null = null;

    if (ok) {
      const validation = def.validate(outcome.result);
      if (validation.ok) {
        blockNumber = validation.blockNumber ?? null;
        observe(state, method, outcome.result, blockNumber, thresholds);
      } else {
        ok = false;
        errorType = 'unexpected_result';
        errorMessage = sanitizeMessage(validation.message, state.target.url);
      }
    }

    const acc = state.method(method);
    acc.total++;
    state.total++;
    state.firstStart = Math.min(state.firstStart, outcome.startedAt);
    state.lastEnd = Math.max(state.lastEnd, outcome.startedAt + outcome.totalMs);
    if (ok) {
      acc.success++;
      state.success++;
      acc.latencies.push(outcome.totalMs);
      state.latencies.push(outcome.totalMs);
      if (outcome.ttfbMs !== null) state.ttfbs.push(outcome.ttfbMs);
    } else if (errorType) {
      bump(acc.errors, errorType);
      bump(state.errors, errorType);
    }

    buffer.push({
      runEndpointId: state.target.runEndpointId,
      method,
      startedAt: outcome.startedAt,
      ttfbMs: outcome.ttfbMs,
      totalMs: outcome.totalMs,
      ok,
      errorType,
      httpStatus: outcome.error?.httpStatus ?? null,
      rpcErrorCode: outcome.error?.rpcCode ?? null,
      errorMessage,
      blockNumber,
    });
    if (buffer.length >= SAMPLE_FLUSH_SIZE) flush();
    completed++;
    hooks.onProgress?.(completed);
    return outcome;
  };

  const runEndpoint = async (state: EndpointState) => {
    const { target } = state;
    state.status = 'running';
    state.startedAt = Date.now();
    hooks.onEndpointStart?.(target.runEndpointId, state.startedAt);
    try {
      const transport = deps.createTransport(target, config.concurrency);
      transports.set(target.runEndpointId, transport);

      state.rtts = await deps.probeRtt(target, signal).catch(() => []);

      if (config.warmup) {
        // Uncounted requests that open the connection pool (TCP + TLS) so the
        // measured phase reflects steady-state request latency.
        await Promise.all(
          Array.from({ length: config.concurrency }, async () => {
            const outcome = await transport.call('eth_chainId', [], { timeoutMs: config.timeoutMs, signal });
            if (outcome.ok && METHODS.eth_chainId.validate(outcome.result).ok) {
              observe(state, 'eth_chainId', outcome.result, null, thresholds);
            }
          }),
        );
      }

      const measureStart = performance.now();
      const deadline = config.durationSec !== null ? measureStart + config.durationSec * 1000 : Infinity;
      const maxRequests = config.requestsPerEndpoint ?? DURATION_ONLY_REQUEST_CAP;
      let issued = 0;

      const worker = async () => {
        while (!signal.aborted && performance.now() < deadline) {
          const seq = issued++;
          if (seq >= maxRequests) return;
          const method = config.methods[seq % config.methods.length]!;
          const def = METHODS[method];
          const outcome = record(
            state,
            method,
            await transport.call(def.rpcMethod, def.params(), { timeoutMs: config.timeoutMs, signal }),
          );
          if (outcome.error?.type === 'rate_limited') {
            const remaining = deadline - performance.now();
            await sleep(Math.min(outcome.error.retryAfterMs ?? 1000, MAX_BACKOFF_MS, remaining), signal);
          }
          if (config.intervalMs > 0) await sleep(Math.min(config.intervalMs, deadline - performance.now()), signal);
        }
      };
      await Promise.all(Array.from({ length: config.concurrency }, worker));
      state.status = signal.aborted ? 'cancelled' : 'completed';
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        state.status = 'cancelled';
      } else {
        state.status = 'failed';
        state.error = sanitizeMessage((err as Error).message ?? String(err), target.url);
      }
    } finally {
      state.finishedAt = Date.now();
    }
  };

  try {
    await Promise.all(states.map(runEndpoint));
    flush();
    if (!signal.aborted) await snapshotHeads(states, transports, config.timeoutMs, signal);
  } finally {
    clearInterval(flushTimer);
    flush();
    await Promise.all([...transports.values()].map((t) => t.close()));
  }

  computeBlockLag(states);
  return states.map((s) => aggregate(s, thresholds));
}

/** Records values used by consistency checks from a validated successful response. */
function observe(
  state: EndpointState,
  method: MethodId,
  result: unknown,
  blockNumber: number | null,
  thresholds: EngineThresholds,
) {
  if (method === 'eth_chainId' && typeof result === 'string') {
    try {
      state.chainIds.add(parseHexNumber(result));
    } catch {
      // Out-of-range chain IDs are reported as unexpected by validation elsewhere.
    }
  } else if (method === 'net_version' && typeof result === 'string') {
    state.netVersions.add(result);
  } else if (method === 'web3_clientVersion' && typeof result === 'string') {
    state.clientVersion = result.slice(0, 200);
  }
  if (blockNumber !== null) {
    const drop = state.maxBlockSeen - blockNumber;
    // Load-balanced providers can legitimately differ by a block; larger drops
    // mean requests are reaching backends that are behind.
    if (drop >= Math.max(2, thresholds.blockLagBlocks)) {
      state.blockRegressions++;
      state.maxRegression = Math.max(state.maxRegression, drop);
    }
    state.maxBlockSeen = Math.max(state.maxBlockSeen, blockNumber);
  }
}

/**
 * Queries eth_blockNumber on every endpoint at the same moment, several times,
 * so heights are compared under the same timing rather than from samples taken
 * at different points of the run.
 */
async function snapshotHeads(
  states: EndpointState[],
  transports: Map<string, RpcTransport>,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const eligible = states.filter((s) => transports.has(s.target.runEndpointId) && s.status === 'completed');
  if (eligible.length === 0) return;
  for (let round = 0; round < HEAD_SNAPSHOT_ROUNDS && !signal.aborted; round++) {
    if (round > 0) await sleep(HEAD_SNAPSHOT_GAP_MS, signal);
    await Promise.all(
      eligible.map(async (state) => {
        const transport = transports.get(state.target.runEndpointId)!;
        try {
          const outcome = await transport.call('eth_blockNumber', [], { timeoutMs: Math.min(timeoutMs, 5000), signal });
          const v = outcome.ok ? METHODS.eth_blockNumber.validate(outcome.result) : null;
          state.heads[round] = v?.ok && v.blockNumber !== undefined ? v.blockNumber : null;
        } catch {
          state.heads[round] = null;
        }
      }),
    );
  }
}

function computeBlockLag(states: EndpointState[]) {
  const byNetwork = new Map<string, EndpointState[]>();
  for (const s of states) {
    const list = byNetwork.get(s.target.networkId) ?? [];
    list.push(s);
    byNetwork.set(s.target.networkId, list);
  }
  for (const group of byNetwork.values()) {
    const rounds = Math.max(0, ...group.map((s) => s.heads.length));
    for (let r = 0; r < rounds; r++) {
      const responders = group.filter((s) => typeof s.heads[r] === 'number');
      if (responders.length < 2) continue;
      const head = Math.max(...responders.map((s) => s.heads[r] as number));
      for (const s of responders) s.lags.push(head - (s.heads[r] as number));
    }
  }
}

function aggregate(state: EndpointState, thresholds: EngineThresholds): EndpointAggregate {
  const latency = summarize(state.latencies);
  const ttfb = summarize(state.ttfbs);
  const rtt = median(state.rtts);
  const windowMs = state.total > 0 ? state.lastEnd - state.firstStart : null;
  const successRate = state.total > 0 ? state.success / state.total : null;
  const seconds = windowMs !== null && windowMs > 0 ? windowMs / 1000 : null;
  const lag = median(state.lags);
  const lastHead = [...state.heads].reverse().find((h): h is number => typeof h === 'number') ?? null;
  const observedChainId = state.chainIds.size > 0 ? [...state.chainIds][0]! : null;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const methods: MethodStats[] = [...state.methods.entries()].map(([method, acc]) => ({
    method,
    total: acc.total,
    success: acc.success,
    failed: acc.total - acc.success,
    successRate: acc.total > 0 ? acc.success / acc.total : 0,
    latency: summarize(acc.latencies),
    errors: acc.errors,
  }));

  const result: EndpointAggregate = {
    runEndpointId: state.target.runEndpointId,
    status: state.status === 'running' || state.status === 'pending' ? 'failed' : state.status,
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    windowMs: windowMs !== null ? round2(windowMs) : null,
    total: state.total,
    success: state.success,
    failed: state.total - state.success,
    successRate,
    throughputRps: seconds ? round2(state.total / seconds) : null,
    successRps: seconds ? round2(state.success / seconds) : null,
    latency,
    ttfb,
    networkRttMs: rtt !== null ? round2(rtt) : null,
    providerTimeMs: rtt !== null && ttfb ? round2(Math.max(0, ttfb.p50 - rtt)) : null,
    errors: state.errors,
    observedChainId,
    clientVersion: state.clientVersion,
    headBlock: lastHead,
    blockLag: lag !== null ? Math.round(lag) : null,
    issues: [],
    methods,
  };
  result.issues = detectIssues(state, result, thresholds);
  return result;
}

function detectIssues(state: EndpointState, r: EndpointAggregate, thresholds: EngineThresholds): Issue[] {
  const issues: Issue[] = [];
  const expected = state.target.expectedChainId;

  if (r.total > 0 && r.success === 0) {
    issues.push({ code: 'unreachable', severity: 'critical', message: 'Every measured request failed' });
  } else if (r.successRate !== null && r.successRate < thresholds.availabilityMin) {
    issues.push({
      code: 'high_error_rate',
      severity: r.successRate < 0.9 ? 'critical' : 'warning',
      message: `Success rate ${(r.successRate * 100).toFixed(1)}% is below ${(thresholds.availabilityMin * 100).toFixed(1)}%`,
    });
  }
  if (state.chainIds.size > 1) {
    issues.push({
      code: 'chain_id_inconsistent',
      severity: 'critical',
      message: `Endpoint returned multiple chain IDs: ${[...state.chainIds].join(', ')}`,
    });
  }
  if (expected !== null && r.observedChainId !== null && !state.chainIds.has(expected)) {
    issues.push({
      code: 'chain_id_mismatch',
      severity: 'critical',
      message: `Chain ID ${r.observedChainId} does not match the network's expected chain ID ${expected}`,
    });
  }
  if (expected !== null && state.netVersions.size > 0 && !state.netVersions.has(String(expected))) {
    issues.push({
      code: 'net_version_mismatch',
      severity: 'info',
      message: `net_version returned ${[...state.netVersions].join(', ')}; chain ID is ${expected}`,
    });
  }
  if (r.blockLag !== null && r.blockLag > thresholds.blockLagBlocks) {
    issues.push({
      code: 'block_lag',
      severity: r.blockLag > thresholds.blockLagBlocks * 10 ? 'critical' : 'warning',
      message: `${r.blockLag} blocks behind the highest head reported by other endpoints on this network`,
    });
  }
  if (state.blockRegressions > 0) {
    issues.push({
      code: 'block_regression',
      severity: 'warning',
      message: `Block number went backwards ${state.blockRegressions}× (up to ${state.maxRegression} blocks); likely load-balanced across out-of-sync nodes`,
    });
  }
  const rateLimited = r.errors.rate_limited ?? 0;
  if (rateLimited > 0) {
    issues.push({
      code: 'rate_limited',
      severity: 'warning',
      message: `${rateLimited} request${rateLimited === 1 ? ' was' : 's were'} rate limited by the provider`,
    });
  }
  return issues;
}
