import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../server/app.js';
import type { AppConfig } from '../server/config.js';
import { openDatabase, seedNetworks } from '../server/db/client.js';
import type { Endpoint, Network, RunDetail } from '../shared/schemas.js';
import { startMockRpc, type MockServer } from './mock-rpc-server.js';

let app: FastifyInstance;
let mockA: MockServer;
let mockB: MockServer;
let dir: string;
let closeDb: () => void;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-pulse-test-'));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 0,
    databasePath: path.join(dir, 'test.db'),
    allowPrivateNetworks: true,
    secretKey: crypto.randomBytes(32),
    secretKeySource: 'env',
    webDistPath: path.join(dir, 'none'),
  };
  const { db, sqlite } = openDatabase(config.databasePath);
  closeDb = () => sqlite.close();
  seedNetworks(db);
  app = await buildApp({ db, config, logger: false });
  mockA = await startMockRpc({ latencyMs: 2 });
  mockB = await startMockRpc({ latencyMs: 15 });
});

afterAll(async () => {
  await app.close();
  closeDb();
  await mockA.close();
  await mockB.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitForRun(id: string): Promise<RunDetail> {
  for (let i = 0; i < 200; i++) {
    const run = (await app.inject({ url: `/api/runs/${id}` })).json<RunDetail>();
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

describe('API', () => {
  let ethereum: Network;
  const created: Endpoint[] = [];

  it('lists seeded networks', async () => {
    const res = await app.inject({ url: '/api/networks' });
    const networks = res.json<Network[]>();
    ethereum = networks.find((n) => n.slug === 'ethereum')!;
    expect(ethereum.chainId).toBe(1);
  });

  it('creates endpoints without exposing the URL', async () => {
    for (const [name, mock] of [['Alpha', mockA], ['Beta', mockB]] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/endpoints',
        payload: { name, provider: name, networkId: ethereum.id, url: mock.url },
      });
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain('secretkey1234567890abcdef');
      created.push(res.json<Endpoint>());
    }
    expect(created[0]!.urlRedacted).toContain('secr••••');
    const list = await app.inject({ url: '/api/endpoints' });
    expect(list.body).not.toContain('secretkey1234567890abcdef');
  });

  it('validates endpoint input', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/endpoints', payload: { name: 'x', provider: 'x', networkId: ethereum.id, url: 'ftp://x' } });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({ method: 'POST', url: '/api/endpoints', payload: { name: 'x', provider: 'x', networkId: 'nope', url: mockA.url } });
    expect(unknown.statusCode).toBe(400);
  });

  it('tests endpoint connectivity', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/endpoints/${created[0]!.id}/test` });
    expect(res.json()).toMatchObject({ ok: true, chainId: 1, chainIdMatches: true, blockNumber: 1000, clientVersion: 'MockClient/v1.0.0' });
  });

  it('runs a benchmark end to end and persists results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        name: 'API test',
        endpointIds: created.map((e) => e.id),
        methods: ['eth_blockNumber', 'eth_chainId', 'web3_clientVersion'],
        requestsPerEndpoint: 30,
        durationSec: 30,
        concurrency: 3,
        intervalMs: 0,
        timeoutMs: 3000,
        warmup: true,
      },
    });
    expect(res.statusCode).toBe(201);
    const run = await waitForRun(res.json<RunDetail>().id);
    expect(run.status).toBe('completed');
    expect(run.totalRequests).toBe(60);
    expect(run.successRate).toBe(1);
    expect(run.bestEndpoint?.name).toBe('Alpha');
    const alpha = run.endpoints[0]!;
    expect(alpha.latency?.p95).toBeGreaterThan(0);
    expect(alpha.clientVersion).toBe('MockClient/v1.0.0');
    expect(alpha.blockLag).toBe(0);
    expect(JSON.stringify(run)).not.toContain('secretkey1234567890abcdef');

    const samples = await app.inject({ url: `/api/runs/${run.id}/samples?runEndpointId=${alpha.id}` });
    expect(samples.json()).toHaveLength(30);

    const history = await app.inject({ url: '/api/history?range=24h' });
    const h = history.json();
    expect(h.series).toHaveLength(2);
    expect(h.leaderboard[0].endpointName).toBe('Alpha');
    expect(h.leaderboard[0].rank).toBe(1);

    const dash = (await app.inject({ url: '/api/dashboard' })).json();
    expect(dash.counts.runs).toBe(1);
    expect(dash.recentRuns[0].id).toBe(run.id);
  });

  it('rejects invalid benchmark configs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { endpointIds: [], methods: [], requestsPerEndpoint: null, durationSec: null, concurrency: 1, intervalMs: 0, timeoutMs: 1000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses benchmarking disabled endpoints and keeps history after deletion', async () => {
    await app.inject({ method: 'PATCH', url: `/api/endpoints/${created[1]!.id}`, payload: { enabled: false } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { endpointIds: [created[1]!.id], methods: ['eth_chainId'], requestsPerEndpoint: 5, durationSec: null, concurrency: 1, intervalMs: 0, timeoutMs: 1000 },
    });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/endpoints/${created[1]!.id}` })).statusCode).toBe(204);
    const runs = (await app.inject({ url: '/api/runs' })).json();
    const detail = (await app.inject({ url: `/api/runs/${runs.items[0].id}` })).json<RunDetail>();
    expect(detail.endpoints[1]!.endpointName).toBe('Beta');
    expect(detail.endpoints[1]!.endpointId).toBeNull();
  });

  it('cancels a running benchmark', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { endpointIds: [created[0]!.id], methods: ['eth_chainId'], requestsPerEndpoint: null, durationSec: 60, concurrency: 1, intervalMs: 50, timeoutMs: 1000 },
    });
    const id = res.json<RunDetail>().id;
    await new Promise((r) => setTimeout(r, 300));
    expect((await app.inject({ method: 'POST', url: `/api/runs/${id}/cancel` })).statusCode).toBe(200);
    const run = await waitForRun(id);
    expect(run.status).toBe('cancelled');
    expect(run.totalRequests).toBeGreaterThan(0);
  });
});
