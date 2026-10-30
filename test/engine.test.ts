import { afterEach, describe, expect, it } from 'vitest';
import { runBenchmark, type BenchmarkTarget, type EngineDeps } from '../server/benchmark/engine.js';
import { JsonRpcHttpClient } from '../server/rpc/json-rpc-client.js';
import type { BenchmarkConfig, Sample } from '../shared/schemas.js';
import { startMockRpc, type MockServer } from './mock-rpc-server.js';

const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function mock(behavior: Parameters<typeof startMockRpc>[0]) {
  const s = await startMockRpc(behavior);
  servers.push(s);
  return s;
}

const deps: EngineDeps = {
  createTransport: (t, connections) => new JsonRpcHttpClient(t.url, { allowPrivateNetworks: true, connections }),
  probeRtt: async () => [1, 1, 1],
};

const baseConfig: BenchmarkConfig = {
  name: '',
  endpointIds: [],
  methods: ['eth_blockNumber', 'eth_chainId'],
  requestsPerEndpoint: 40,
  durationSec: null,
  concurrency: 4,
  intervalMs: 0,
  timeoutMs: 2000,
  warmup: true,
};
const thresholds = { blockLagBlocks: 5, availabilityMin: 0.99 };
const target = (id: string, url: string, expectedChainId: number | null = 1): BenchmarkTarget => ({
  runEndpointId: id,
  networkId: 'net',
  expectedChainId,
  url,
});

describe('JsonRpcHttpClient', () => {
  it('classifies failures', async () => {
    const malformed = await mock({ malformed: true });
    const hang = await mock({ hang: true });
    const redirect = await mock({ redirect: true });
    const limited = await mock({ rateLimitEvery: 1 });
    const call = async (url: string, timeoutMs = 2000) => {
      const c = new JsonRpcHttpClient(url, { allowPrivateNetworks: true });
      try {
        return await c.call('eth_chainId', [], { timeoutMs });
      } finally {
        await c.close();
      }
    };
    expect((await call(malformed.url)).error?.type).toBe('invalid_response');
    const t = await call(hang.url, 300);
    expect(t.error?.type).toBe('timeout');
    expect(t.totalMs).toBeGreaterThanOrEqual(290);
    expect((await call(redirect.url)).error?.type).toBe('http');
    expect((await call(limited.url)).error).toMatchObject({ type: 'rate_limited', httpStatus: 429, retryAfterMs: 0 });
    const refused = await call('http://127.0.0.1:1/');
    expect(refused.error?.type).toBe('network');
  });

  it('refuses private targets when not allowed', () => {
    expect(() => new JsonRpcHttpClient('http://127.0.0.1:8545', { allowPrivateNetworks: false })).toThrow();
  });

  it('blocks hostnames that resolve to private addresses at connect time', async () => {
    const c = new JsonRpcHttpClient('http://localtest.me:1/', { allowPrivateNetworks: false });
    const r = await c.call('eth_chainId', [], { timeoutMs: 3000 });
    await c.close();
    expect(r.ok).toBe(false);
    expect(r.error?.type).toBe('network');
  });

  it('never leaks the URL key in error messages', async () => {
    const c = new JsonRpcHttpClient('http://127.0.0.1:1/v2/supersecretkey123456', { allowPrivateNetworks: true });
    const r = await c.call('eth_chainId', [], { timeoutMs: 1000 });
    await c.close();
    expect(r.error?.message ?? '').not.toContain('supersecretkey123456');
  });
});

describe('runBenchmark', () => {
  it('measures endpoints concurrently and aggregates stats', async () => {
    const fast = await mock({ latencyMs: 5 });
    const slow = await mock({ latencyMs: 40 });
    const samples: Sample[] = [];
    const results = await runBenchmark(
      baseConfig,
      [target('fast', fast.url), target('slow', slow.url)],
      deps,
      { onSamples: (b) => samples.push(...b) },
      thresholds,
      new AbortController().signal,
    );
    const [f, s] = results;
    expect(f!.status).toBe('completed');
    expect(f!.total).toBe(40);
    expect(f!.successRate).toBe(1);
    expect(s!.total).toBe(40);
    expect(f!.latency!.p50).toBeLessThan(s!.latency!.p50);
    expect(s!.latency!.p50).toBeGreaterThanOrEqual(40);
    expect(f!.throughputRps).toBeGreaterThan(s!.throughputRps!);
    expect(f!.methods.map((m) => m.method).sort()).toEqual(['eth_blockNumber', 'eth_chainId']);
    expect(f!.observedChainId).toBe(1);
    expect(samples).toHaveLength(80);
    expect(samples.every((x) => x.startedAt > 1e12)).toBe(true);
    // Warmup (4 per endpoint) + 40 measured + 3 head snapshots.
    expect(fast.requests).toBe(47);
  });

  it('isolates a failing endpoint from healthy ones', async () => {
    const healthy = await mock({});
    const results = await runBenchmark(
      { ...baseConfig, timeoutMs: 500, requestsPerEndpoint: 8 },
      [target('ok', healthy.url), target('dead', 'http://127.0.0.1:1/')],
      deps,
      {},
      thresholds,
      new AbortController().signal,
    );
    expect(results[0]!.successRate).toBe(1);
    expect(results[1]!.success).toBe(0);
    expect(results[1]!.errors.network).toBe(8);
    expect(results[1]!.issues.map((i) => i.code)).toContain('unreachable');
  });

  it('detects block lag, chain mismatch, errors and rate limiting', async () => {
    const ahead = await mock({ blockNumber: () => 1000 });
    const behind = await mock({ blockNumber: () => 980, chainId: 5, rateLimitEvery: 7, errorRate: 0.2 });
    const results = await runBenchmark(
      { ...baseConfig, methods: ['eth_blockNumber', 'net_version', 'eth_chainId'], requestsPerEndpoint: 60 },
      [target('a', ahead.url), target('b', behind.url)],
      deps,
      {},
      thresholds,
      new AbortController().signal,
    );
    const b = results[1]!;
    expect(results[0]!.blockLag).toBe(0);
    expect(b.blockLag).toBe(20);
    const codes = b.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['block_lag', 'chain_id_mismatch', 'net_version_mismatch', 'high_error_rate', 'rate_limited']));
    expect(b.errors.rate_limited).toBeGreaterThan(0);
    expect(b.errors.rpc_error).toBeGreaterThan(0);
  });

  it('stops at the duration limit and honours cancellation', async () => {
    const s = await mock({ latencyMs: 20 });
    const t0 = Date.now();
    const [r] = await runBenchmark(
      { ...baseConfig, requestsPerEndpoint: null, durationSec: 1, concurrency: 2 },
      [target('x', s.url)],
      deps,
      {},
      thresholds,
      new AbortController().signal,
    );
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r!.total).toBeGreaterThan(20);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const [c] = await runBenchmark(
      { ...baseConfig, requestsPerEndpoint: 10_000, concurrency: 2 },
      [target('y', s.url)],
      deps,
      {},
      thresholds,
      controller.signal,
    );
    expect(c!.status).toBe('cancelled');
    expect(c!.total).toBeLessThan(10_000);
  });
});
